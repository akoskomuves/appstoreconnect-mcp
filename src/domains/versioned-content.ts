import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ascErrorText } from '../errors.js';
import {
  FileNameSchema,
  FileSizeSchema,
  IapLocalizationDescriptionSchema,
  IapLocalizationNameSchema,
  InAppPurchaseImageIdSchema,
  InAppPurchaseLocalizationIdSchema,
  LocaleSchema,
  LocalFilePathSchema,
  SubscriptionCustomAppNameSchema,
  SubscriptionGroupLocalizationIdSchema,
  SubscriptionGroupLocalizationNameSchema,
  SubscriptionImageIdSchema,
  SubscriptionLocalizationDescriptionSchema,
  SubscriptionLocalizationIdSchema,
  SubscriptionLocalizationNameSchema,
} from '../schemas.js';
import {
  type AssetReserveResponse,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// The /v2 content endpoints for IAPs, subscriptions and subscription groups:
//
//   /v2/inAppPurchaseLocalizations      /v2/inAppPurchaseImages
//   /v2/subscriptionLocalizations       /v2/subscriptionImages
//   /v2/subscriptionGroupLocalizations
//
// These are ADDITIVE, not a replacement for the /v1 calls ppp already makes.
// Compared against spec 4.5.1:
//
//   * Same resource types and the same attributes as /v1 — but the create
//     relationship is `version` (inAppPurchaseVersions / subscriptionVersions /
//     subscriptionGroupVersions) instead of the parent product. The v2 copy is
//     attached to a VERSION of the product, the v1 copy to the product itself.
//   * /v1 is not deprecated. Switching the existing tools would make every
//     caller look up a version id first, for no gain, so they stay on /v1.
//   * V2 image commit takes `uploaded` ONLY. The v1 commit also takes
//     sourceFileChecksum; InAppPurchaseImageV2UpdateRequest and
//     SubscriptionImageV2UpdateRequest do not have it, so the builder never
//     sends it.
//
// Version ids come from the product's versions list (the IAP/subscription
// versions tools). Listing the localizations/images of a version is a version
// read and lives with those tools.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Pure body builders (unit-tested) -----

export interface VersionedCreateParams {
  resourceType: string;
  versionType: string;
  versionId: string;
  attributes: Record<string, unknown>;
}

export function buildVersionedCreateBody(p: VersionedCreateParams): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.attributes)) if (v !== undefined) attributes[k] = v;
  return {
    data: {
      type: p.resourceType,
      attributes,
      relationships: { version: { data: { type: p.versionType, id: p.versionId } } },
    },
  };
}

export function buildVersionedPatchBody(
  resourceType: string,
  id: string,
  attributes: Record<string, unknown>,
): JSONAPIBody {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attributes)) if (v !== undefined) attrs[k] = v;
  return { data: { type: resourceType, id, attributes: attrs } };
}

// ----- Configs -----

interface LocalizationConfig {
  kind: 'localization';
  resourceType: string;
  versionType: string;
  toolBase: string; // asc_<verb>_<toolBase>
  label: string;
  parentLabel: string;
  idSchema: z.ZodType<string>;
  nameSchema: z.ZodType<string>;
  // The second text attribute: description (IAP / subscription) or
  // customAppName (subscription group).
  extraKey: 'description' | 'customAppName';
  extraSchema: z.ZodType<string>;
}

interface ImageConfig {
  kind: 'image';
  resourceType: string;
  versionType: string;
  toolBase: string;
  label: string;
  parentLabel: string;
  idSchema: z.ZodType<string>;
}

const versionIdSchema = (versionLabel: string) =>
  z
    .string()
    .min(1)
    .describe(
      `${versionLabel} id — the version of the product this content belongs to. Get it from the product's versions list.`,
    );

export const LOCALIZATION_CONFIGS: LocalizationConfig[] = [
  {
    kind: 'localization',
    resourceType: 'inAppPurchaseLocalizations',
    versionType: 'inAppPurchaseVersions',
    toolBase: 'iap_version_localization',
    label: 'IAP version localization',
    parentLabel: 'in-app purchase version',
    idSchema: InAppPurchaseLocalizationIdSchema,
    nameSchema: IapLocalizationNameSchema,
    extraKey: 'description',
    extraSchema: IapLocalizationDescriptionSchema,
  },
  {
    kind: 'localization',
    resourceType: 'subscriptionLocalizations',
    versionType: 'subscriptionVersions',
    toolBase: 'subscription_version_localization',
    label: 'subscription version localization',
    parentLabel: 'subscription version',
    idSchema: SubscriptionLocalizationIdSchema,
    nameSchema: SubscriptionLocalizationNameSchema,
    extraKey: 'description',
    extraSchema: SubscriptionLocalizationDescriptionSchema,
  },
  {
    kind: 'localization',
    resourceType: 'subscriptionGroupLocalizations',
    versionType: 'subscriptionGroupVersions',
    toolBase: 'subscription_group_version_localization',
    label: 'subscription group version localization',
    parentLabel: 'subscription group version',
    idSchema: SubscriptionGroupLocalizationIdSchema,
    nameSchema: SubscriptionGroupLocalizationNameSchema,
    extraKey: 'customAppName',
    extraSchema: SubscriptionCustomAppNameSchema,
  },
];

export const IMAGE_CONFIGS: ImageConfig[] = [
  {
    kind: 'image',
    resourceType: 'inAppPurchaseImages',
    versionType: 'inAppPurchaseVersions',
    toolBase: 'iap_version_image',
    label: 'IAP version promotional image',
    parentLabel: 'in-app purchase version',
    idSchema: InAppPurchaseImageIdSchema,
  },
  {
    kind: 'image',
    resourceType: 'subscriptionImages',
    versionType: 'subscriptionVersions',
    toolBase: 'subscription_version_image',
    label: 'subscription version promotional image',
    parentLabel: 'subscription version',
    idSchema: SubscriptionImageIdSchema,
  },
];

// ----- Registration -----

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: ascErrorText(err) }],
  isError: true,
});

const collectionPath = (resourceType: string) => `/v2/${resourceType}`;
const itemPath = (resourceType: string, id: string) =>
  `/v2/${resourceType}/${encodeURIComponent(id)}`;

function registerGetDelete(
  server: McpServer,
  client: ASCClient,
  cfg: LocalizationConfig | ImageConfig,
): void {
  server.registerTool(
    `asc_get_${cfg.toolBase}`,
    {
      title: `Get a ${cfg.label}`,
      description: `GET ${itemPath(cfg.resourceType, '{id}')} — one ${cfg.label} (content attached to a ${cfg.parentLabel}).`,
      inputSchema: z.object({ id: cfg.idSchema }),
    },
    async ({ id }) => {
      try {
        const data = await client.request<unknown>(itemPath(cfg.resourceType, id));
        return ok(JSON.stringify(data, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    `asc_delete_${cfg.toolBase}`,
    {
      title: `Delete a ${cfg.label}`,
      description: `DELETE ${itemPath(cfg.resourceType, '{id}')} → 204. Removes the ${cfg.label} from its ${cfg.parentLabel}.`,
      inputSchema: z.object({ id: cfg.idSchema }),
    },
    async ({ id }) => {
      try {
        await client.request<unknown>(itemPath(cfg.resourceType, id), { method: 'DELETE' });
        return ok(`Deleted ${cfg.label} ${id}.`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

function registerLocalization(server: McpServer, client: ASCClient, cfg: LocalizationConfig) {
  server.registerTool(
    `asc_post_${cfg.toolBase}`,
    {
      title: `Create a ${cfg.label}`,
      description: `POST ${collectionPath(cfg.resourceType)} — customer-facing copy for ONE locale on a ${cfg.parentLabel} (relationship \`version\`). Required: versionId + locale + name; optional ${cfg.extraKey}. Locale is immutable after create. The /v1 tool for the same resource attaches copy to the product itself instead of a version.`,
      inputSchema: z.object({
        versionId: versionIdSchema(cfg.parentLabel),
        locale: LocaleSchema,
        name: cfg.nameSchema,
        [cfg.extraKey]: cfg.extraSchema.optional(),
      }),
    },
    async (input: Record<string, unknown>) => {
      const body = buildVersionedCreateBody({
        resourceType: cfg.resourceType,
        versionType: cfg.versionType,
        versionId: String(input.versionId),
        attributes: {
          name: input.name,
          locale: input.locale,
          [cfg.extraKey]: input[cfg.extraKey],
        },
      });
      try {
        const data = await client.request<unknown>(collectionPath(cfg.resourceType), {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return ok(
          `Created ${cfg.label} (${String(input.locale)}) on ${cfg.parentLabel} ${String(input.versionId)}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    `asc_patch_${cfg.toolBase}`,
    {
      title: `Update a ${cfg.label}`,
      description: `PATCH ${itemPath(cfg.resourceType, '{id}')} — change name and/or ${cfg.extraKey}. Locale cannot change. Pass at least one field.`,
      inputSchema: z.object({
        id: cfg.idSchema,
        name: cfg.nameSchema.optional(),
        [cfg.extraKey]: cfg.extraSchema.optional(),
      }),
    },
    async (input: Record<string, unknown>) => {
      if (input.name === undefined && input[cfg.extraKey] === undefined) {
        return {
          content: [{ type: 'text', text: `Refused: pass name and/or ${cfg.extraKey}.` }],
          isError: true,
        };
      }
      const id = String(input.id);
      const body = buildVersionedPatchBody(cfg.resourceType, id, {
        name: input.name,
        [cfg.extraKey]: input[cfg.extraKey],
      });
      try {
        const data = await client.request<unknown>(itemPath(cfg.resourceType, id), {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        return ok(`Updated ${cfg.label} ${id}.\n\n${JSON.stringify(data, null, 2)}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerGetDelete(server, client, cfg);
}

function registerImage(server: McpServer, client: ASCClient, cfg: ImageConfig) {
  const reserve = async (versionId: string, fileName: string, fileSize: number) =>
    client.request<AssetReserveResponse>(collectionPath(cfg.resourceType), {
      method: 'POST',
      body: JSON.stringify(
        buildVersionedCreateBody({
          resourceType: cfg.resourceType,
          versionType: cfg.versionType,
          versionId,
          attributes: { fileName, fileSize },
        }),
      ),
    });
  const commit = async (id: string) =>
    client.request<unknown>(itemPath(cfg.resourceType, id), {
      method: 'PATCH',
      // V2 commit takes `uploaded` only — no sourceFileChecksum in the contract.
      body: JSON.stringify(buildVersionedPatchBody(cfg.resourceType, id, { uploaded: true })),
    });

  server.registerTool(
    `asc_upload_${cfg.toolBase}`,
    {
      title: `Upload a ${cfg.label} from a local file (composite)`,
      description: `Composite: reserves a ${cfg.label} on a ${cfg.parentLabel} (POST ${collectionPath(cfg.resourceType)}, fileName + fileSize from the file), PUTs every upload chunk to Apple storage, then commits with uploaded=true. Tilde paths are expanded.`,
      inputSchema: z.object({
        versionId: versionIdSchema(cfg.parentLabel),
        localFilePath: LocalFilePathSchema,
        fileName: FileNameSchema.optional().describe(
          'Override the file name sent to Apple. Defaults to basename(localFilePath).',
        ),
      }),
    },
    async ({ versionId, localFilePath, fileName }) => {
      const resolved = expandHomePath(localFilePath);
      try {
        const fileSize = await readFileSizeBytes(resolved);
        const name = fileName ?? resolved.split('/').pop() ?? 'image';
        const reserved = await reserve(versionId, name, fileSize);
        const id = reserved.data?.id;
        const operations = reserved.data?.attributes?.uploadOperations ?? [];
        if (!id) throw new Error('Reserve response missing image id');
        if (operations.length === 0) throw new Error('Reserve response has no uploadOperations');
        const executed = await executeAllUploadOperations(operations, resolved);
        const committed = await commit(id);
        return ok(
          `Uploaded ${name} → ${cfg.label} ${id}.\n\n${summarizeUpload(resolved, executed)}\n\nCommit response:\n${JSON.stringify(committed, null, 2)}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    `asc_post_${cfg.toolBase}`,
    {
      title: `Reserve a ${cfg.label} upload (raw step 1)`,
      description: `RAW step 1: POST ${collectionPath(cfg.resourceType)} with fileName + fileSize on a ${cfg.parentLabel}. Returns uploadOperations[] — PUT each with asc_upload_asset_chunk, then commit with asc_patch_${cfg.toolBase}. Most callers want asc_upload_${cfg.toolBase}.`,
      inputSchema: z.object({
        versionId: versionIdSchema(cfg.parentLabel),
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
      }),
    },
    async ({ versionId, fileName, fileSize }) => {
      try {
        const data = await reserve(versionId, fileName, fileSize);
        return ok(
          `Reserved ${cfg.label} for ${fileName} (${fileSize} bytes). Next: PUT each uploadOperation, then commit.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    `asc_patch_${cfg.toolBase}`,
    {
      title: `Commit a ${cfg.label} upload (raw step 3)`,
      description: `RAW step 3: PATCH ${itemPath(cfg.resourceType, '{id}')} with uploaded=true once every chunk is PUT. The v2 contract has no sourceFileChecksum (unlike the /v1 image commit).`,
      inputSchema: z.object({ id: cfg.idSchema }),
    },
    async ({ id }) => {
      try {
        const data = await commit(id);
        return ok(`Committed ${cfg.label} ${id}.\n\n${JSON.stringify(data, null, 2)}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerGetDelete(server, client, cfg);
}

export function registerVersionedContent(server: McpServer, client: ASCClient): void {
  for (const cfg of LOCALIZATION_CONFIGS) registerLocalization(server, client, cfg);
  for (const cfg of IMAGE_CONFIGS) registerImage(server, client, cfg);
}
