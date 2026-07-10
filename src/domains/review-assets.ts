import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestReviewAssets } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  FileNameSchema,
  FileSizeSchema,
  InAppPurchaseAppStoreReviewScreenshotIdSchema,
  InAppPurchaseIdSchema,
  InAppPurchaseImageIdSchema,
  LocalFilePathSchema,
  SourceFileChecksumSchema,
  SubscriptionAppStoreReviewScreenshotIdSchema,
  SubscriptionIdSchema,
  SubscriptionImageIdSchema,
} from '../schemas.js';
import {
  type AssetReserveResponse,
  computeFileMd5Hex,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// IAP + subscription review assets — the two review SCREENSHOT resources close a
// real correctness gap: Apple requires a review screenshot on an IAP/subscription
// before it can be submitted, and there was no tool to attach one. The two IMAGE
// resources are the promotional-image counterpart.
//
// All four share the v0.13 three-step asset-upload flow (reserve fileName+fileSize
// → PUT chunks to Apple storage → PATCH sourceFileChecksum + uploaded=true), so
// this file drives them from a small config table rather than hand-copying four
// near-identical tool sets. The per-resource Apple quirks live in the configs:
//
//   * WIRE GOTCHA: the IAP image reserve uses relationship key `inAppPurchase`,
//     but the IAP review screenshot uses `inAppPurchaseV2` — SAME target
//     (data.type `inAppPurchases`), different key. Subscriptions use
//     `subscription` for both. Getting this wrong is a silent 4xx.
//   * CARDINALITY: images are to-MANY per parent (list them); review screenshots
//     are to-ONE (get THE one; reserving a second conflicts — the reserve/upload
//     tools pre-flight and refuse with a delete-first remedy).
//   * `uploaded` is the wire key (Swift `isUploaded`) — same strip as screenshots.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Pure body builders (unit-tested) -----

export interface AssetReserveParams {
  resourceType: string;
  relKey: string;
  relType: string;
  parentId: string;
  fileName: string;
  fileSize: number;
}

export function buildAssetReserveBody(p: AssetReserveParams): JSONAPIBody {
  return {
    data: {
      type: p.resourceType,
      attributes: { fileName: p.fileName, fileSize: p.fileSize },
      relationships: {
        [p.relKey]: { data: { type: p.relType, id: p.parentId } },
      },
    },
  };
}

export interface AssetCommitParams {
  resourceType: string;
  id: string;
  sourceFileChecksum?: string | undefined;
  uploaded?: boolean | undefined;
}

export function buildAssetCommitBody(p: AssetCommitParams): JSONAPIBody {
  // Wire-key gotcha: Swift `isUploaded` → wire `uploaded`. Both attrs optional;
  // the tool layer guards against an all-undefined (empty) PATCH.
  const attributes: Record<string, unknown> = {};
  if (p.sourceFileChecksum !== undefined) attributes.sourceFileChecksum = p.sourceFileChecksum;
  if (p.uploaded !== undefined) attributes.uploaded = p.uploaded;
  return { data: { type: p.resourceType, id: p.id, attributes } };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ----- Config-driven registration -----

interface AssetResourceConfig {
  resourceType: string; // e.g. 'inAppPurchaseImages'
  relKey: string; // reserve relationship key — the inAppPurchase vs inAppPurchaseV2 gotcha
  relType: string; // reserve relationship data.type — e.g. 'inAppPurchases'
  cardinality: 'to-many' | 'to-one';
  toolBase: string; // e.g. 'iap_image' → asc_<verb>_iap_image[s]
  singular: string; // human label, e.g. 'IAP promotional image'
  parentLabel: string; // e.g. 'in-app purchase'
  parentIdSchema: z.ZodType<string>;
  resourceIdSchema: z.ZodType<string>;
  // Parent sub-resource path: to-many → the images collection; to-one → the
  // single review-screenshot link. Used by list/get-the-one + the to-one pre-flight.
  parentSubPath: (parentId: string) => string;
}

const LIST_FIELDS = 'fileName,fileSize,sourceFileChecksum,state';

function collectionPath(cfg: AssetResourceConfig): string {
  return `/v1/${cfg.resourceType}`;
}
function itemPath(cfg: AssetResourceConfig, id: string): string {
  return `/v1/${cfg.resourceType}/${encodeURIComponent(id)}`;
}

// Does the to-one parent already have this asset? Returns the existing id or null.
async function existingToOneId(
  client: ASCClient,
  cfg: AssetResourceConfig,
  parentId: string,
): Promise<string | null> {
  const res = await client.request<{ data?: { id?: string } | null }>(cfg.parentSubPath(parentId), {
    method: 'GET',
  });
  return res.data?.id ?? null;
}

function registerReads(server: McpServer, client: ASCClient, cfg: AssetResourceConfig): void {
  if (cfg.cardinality === 'to-many') {
    server.registerTool(
      `asc_list_${cfg.toolBase}s`,
      {
        title: `List ${cfg.singular}s`,
        description: `List the ${cfg.singular}s attached to a ${cfg.parentLabel}. Each row carries fileName, fileSize, upload state, and whether the reservation has been committed (sourceFileChecksum present).`,
        inputSchema: {
          parentId: cfg.parentIdSchema,
          maxItems: z.number().int().positive().max(2000).default(500),
          raw: z.boolean().default(false),
        },
      },
      async ({ parentId, maxItems, raw }) => {
        const params = new URLSearchParams();
        params.set(`fields[${cfg.resourceType}]`, LIST_FIELDS);
        params.set('limit', '200');
        const path = `${cfg.parentSubPath(parentId)}?${params.toString()}`;
        try {
          const pages = await paginate(client, path, maxItems);
          const text = raw
            ? JSON.stringify(pages, null, 2)
            : digestReviewAssets(pages, `${cfg.singular}s`);
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
        }
      },
    );
    server.registerTool(
      `asc_get_${cfg.toolBase}`,
      {
        title: `Get a ${cfg.singular}`,
        description: `Fetch a single ${cfg.singular} by ID. Returns the upload metadata (fileName, fileSize, sourceFileChecksum, state), the processed asset URLs once available, and — if the reservation is not yet committed — the uploadOperations[] needed to PUT chunks to Apple storage.`,
        inputSchema: { assetId: cfg.resourceIdSchema },
      },
      async ({ assetId }) => {
        try {
          const data = await client.request<unknown>(itemPath(cfg, assetId), { method: 'GET' });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
        }
      },
    );
  } else {
    server.registerTool(
      `asc_get_${cfg.toolBase}`,
      {
        title: `Get the ${cfg.singular}`,
        description: `Fetch the single ${cfg.singular} for a ${cfg.parentLabel} (to-one). Returns null data if none is attached yet. Includes the asset id needed for delete/commit.`,
        inputSchema: { parentId: cfg.parentIdSchema },
      },
      async ({ parentId }) => {
        try {
          const data = await client.request<unknown>(cfg.parentSubPath(parentId), {
            method: 'GET',
          });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
        }
      },
    );
  }
}

function registerWrites(server: McpServer, client: ASCClient, cfg: AssetResourceConfig): void {
  const isToOne = cfg.cardinality === 'to-one';

  // Composite upload — the primary write path.
  server.registerTool(
    `asc_upload_${cfg.toolBase}`,
    {
      title: `Upload a ${cfg.singular} from a local file (composite)`,
      description:
        `Composite tool: reads localFilePath, reserves a ${cfg.singular} under the ${cfg.parentLabel} (fileName + fileSize derived from the file), PUTs every upload chunk to Apple storage, then commits with the md5 checksum + uploaded=true. Returns the committed resource + a per-chunk summary. Tilde paths (~/...) are expanded.` +
        (isToOne
          ? ` This asset is to-ONE per ${cfg.parentLabel}; if one already exists the tool refuses — delete it first with asc_delete_${cfg.toolBase}.`
          : ''),
      inputSchema: {
        parentId: cfg.parentIdSchema,
        localFilePath: LocalFilePathSchema,
        fileName: FileNameSchema.optional().describe(
          'Override the file name sent to Apple. Defaults to basename(localFilePath).',
        ),
      },
    },
    async ({ parentId, localFilePath, fileName }) => {
      const resolvedPath = expandHomePath(localFilePath);
      try {
        if (isToOne) {
          const existing = await existingToOneId(client, cfg, parentId);
          if (existing) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Refused: ${cfg.parentLabel} ${parentId} already has a ${cfg.singular} (${existing}). It is to-one — delete it first with asc_delete_${cfg.toolBase}, then re-upload.`,
                },
              ],
              isError: true,
            };
          }
        }
        const fileSize = await readFileSizeBytes(resolvedPath);
        const name = fileName ?? resolvedPath.split('/').pop() ?? 'asset';
        const reserveBody = buildAssetReserveBody({
          resourceType: cfg.resourceType,
          relKey: cfg.relKey,
          relType: cfg.relType,
          parentId,
          fileName: name,
          fileSize,
        });
        const reserve = await client.request<AssetReserveResponse>(collectionPath(cfg), {
          method: 'POST',
          body: JSON.stringify(reserveBody),
        });
        const assetId = reserve.data?.id;
        const operations = reserve.data?.attributes?.uploadOperations ?? [];
        if (!assetId) throw new Error('Reserve response missing asset id');
        if (operations.length === 0) {
          throw new Error('Reserve response missing uploadOperations[] — cannot upload');
        }
        const executed = await executeAllUploadOperations(operations, resolvedPath);
        const checksum = await computeFileMd5Hex(resolvedPath);
        const commit = await client.request<unknown>(itemPath(cfg, assetId), {
          method: 'PATCH',
          body: JSON.stringify(
            buildAssetCommitBody({
              resourceType: cfg.resourceType,
              id: assetId,
              sourceFileChecksum: checksum,
              uploaded: true,
            }),
          ),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Uploaded ${name} → ${cfg.singular} ${assetId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(commit, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // Raw step 1 — reserve.
  server.registerTool(
    `asc_post_${cfg.toolBase}`,
    {
      title: `Reserve a ${cfg.singular} upload (raw step 1)`,
      description:
        `RAW step 1 of the three-step upload. Reserves a ${cfg.singular} under the ${cfg.parentLabel} with fileName + fileSize and returns the resource with uploadOperations[]. PUT each with asc_upload_asset_chunk, then commit with asc_patch_${cfg.toolBase}. Most callers should use the composite asc_upload_${cfg.toolBase} instead.` +
        (isToOne ? ` To-one — refuses if one already exists.` : ''),
      inputSchema: {
        parentId: cfg.parentIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
      },
    },
    async ({ parentId, fileName, fileSize }) => {
      try {
        if (isToOne) {
          const existing = await existingToOneId(client, cfg, parentId);
          if (existing) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Refused: ${cfg.parentLabel} ${parentId} already has a ${cfg.singular} (${existing}). Delete it first with asc_delete_${cfg.toolBase}.`,
                },
              ],
              isError: true,
            };
          }
        }
        const data = await client.request<unknown>(collectionPath(cfg), {
          method: 'POST',
          body: JSON.stringify(
            buildAssetReserveBody({
              resourceType: cfg.resourceType,
              relKey: cfg.relKey,
              relType: cfg.relType,
              parentId,
              fileName,
              fileSize,
            }),
          ),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Reserved ${cfg.singular} under ${cfg.parentLabel} ${parentId} for ${fileName} (${fileSize} bytes). Next: PUT each uploadOperation, then commit.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // Raw step 3 — commit.
  server.registerTool(
    `asc_patch_${cfg.toolBase}`,
    {
      title: `Commit a ${cfg.singular} upload (raw step 3)`,
      description: `RAW step 3 of the three-step upload. PATCH the ${cfg.singular} with sourceFileChecksum (lowercase hex MD5 of the full file) + uploaded=true to commit. Wire-key gotcha: Swift \`isUploaded\` → wire \`uploaded\`. Pass at least one field — empty PATCH is refused. The composite asc_upload_${cfg.toolBase} handles this automatically.`,
      inputSchema: {
        assetId: cfg.resourceIdSchema,
        sourceFileChecksum: SourceFileChecksumSchema.optional(),
        uploaded: z.boolean().optional(),
      },
    },
    async ({ assetId, sourceFileChecksum, uploaded }) => {
      if (sourceFileChecksum === undefined && uploaded === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of sourceFileChecksum or uploaded. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      try {
        const data = await client.request<unknown>(itemPath(cfg, assetId), {
          method: 'PATCH',
          body: JSON.stringify(
            buildAssetCommitBody({
              resourceType: cfg.resourceType,
              id: assetId,
              ...(sourceFileChecksum !== undefined ? { sourceFileChecksum } : {}),
              ...(uploaded !== undefined ? { uploaded } : {}),
            }),
          ),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Committed ${cfg.singular} ${assetId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // Delete.
  server.registerTool(
    `asc_delete_${cfg.toolBase}`,
    {
      title: `Delete a ${cfg.singular}`,
      description: `DELETE a ${cfg.singular} by ID → 204. ${isToOne ? `Removes the ${cfg.parentLabel}'s single review screenshot — the ${cfg.parentLabel} then needs a new one before it can be submitted.` : `Removes one image from the ${cfg.parentLabel}'s set.`}`,
      inputSchema: { assetId: cfg.resourceIdSchema },
    },
    async ({ assetId }) => {
      try {
        await client.request<void>(itemPath(cfg, assetId), { method: 'DELETE' });
        return { content: [{ type: 'text', text: `Deleted ${cfg.singular} ${assetId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}

const CONFIGS: AssetResourceConfig[] = [
  {
    resourceType: 'inAppPurchaseImages',
    relKey: 'inAppPurchase',
    relType: 'inAppPurchases',
    cardinality: 'to-many',
    toolBase: 'iap_image',
    singular: 'IAP promotional image',
    parentLabel: 'in-app purchase',
    parentIdSchema: InAppPurchaseIdSchema,
    resourceIdSchema: InAppPurchaseImageIdSchema,
    parentSubPath: (id) => `/v2/inAppPurchases/${encodeURIComponent(id)}/images`,
  },
  {
    resourceType: 'inAppPurchaseAppStoreReviewScreenshots',
    // GOTCHA: image uses `inAppPurchase`, the review screenshot uses `inAppPurchaseV2`.
    relKey: 'inAppPurchaseV2',
    relType: 'inAppPurchases',
    cardinality: 'to-one',
    toolBase: 'iap_review_screenshot',
    singular: 'IAP App Store review screenshot',
    parentLabel: 'in-app purchase',
    parentIdSchema: InAppPurchaseIdSchema,
    resourceIdSchema: InAppPurchaseAppStoreReviewScreenshotIdSchema,
    parentSubPath: (id) => `/v2/inAppPurchases/${encodeURIComponent(id)}/appStoreReviewScreenshot`,
  },
  {
    resourceType: 'subscriptionImages',
    relKey: 'subscription',
    relType: 'subscriptions',
    cardinality: 'to-many',
    toolBase: 'subscription_image',
    singular: 'subscription promotional image',
    parentLabel: 'subscription',
    parentIdSchema: SubscriptionIdSchema,
    resourceIdSchema: SubscriptionImageIdSchema,
    parentSubPath: (id) => `/v1/subscriptions/${encodeURIComponent(id)}/images`,
  },
  {
    resourceType: 'subscriptionAppStoreReviewScreenshots',
    relKey: 'subscription',
    relType: 'subscriptions',
    cardinality: 'to-one',
    toolBase: 'subscription_review_screenshot',
    singular: 'subscription App Store review screenshot',
    parentLabel: 'subscription',
    parentIdSchema: SubscriptionIdSchema,
    resourceIdSchema: SubscriptionAppStoreReviewScreenshotIdSchema,
    parentSubPath: (id) => `/v1/subscriptions/${encodeURIComponent(id)}/appStoreReviewScreenshot`,
  },
];

export function registerReviewAssets(server: McpServer, client: ASCClient): void {
  for (const cfg of CONFIGS) {
    registerReads(server, client, cfg);
    registerWrites(server, client, cfg);
  }
}
