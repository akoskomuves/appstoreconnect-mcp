import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import {
  type CollectedPages,
  type Column,
  formatTable,
  type JSONAPIRelationship,
  type JSONAPIResource,
  paginate,
} from '../jsonapi.js';
import {
  InAppPurchaseIdSchema,
  SubscriptionGroupIdSchema,
  SubscriptionIdSchema,
} from '../schemas.js';

// Versioned in-app products (App Store Connect API 4.4.1).
//
// Apple split each in-app product into two layers:
//
//   * The PRODUCT — inAppPurchases (v2), subscriptions, subscriptionGroups.
//     Identity and commerce: productId, type, reference name, prices,
//     availability, offers. The existing asc_*_iap / asc_*_subscription /
//     asc_*_subscription_group tools work on this layer and are unchanged.
//
//   * The VERSION — inAppPurchaseVersions, subscriptionVersions,
//     subscriptionGroupVersions. The customer-facing metadata that App Review
//     approves: localizations, and (IAP / subscription only) images. Each
//     version has an integer `version` and a `state` (PREPARE_FOR_SUBMISSION →
//     … → APPROVED, or REPLACED_WITH_NEW_VERSION once a newer one is approved).
//     To change approved metadata you create a new version, edit its
//     localizations / images, and submit THAT version, not the product.
//
// What moved where:
//   - Localizations and images are now scoped to a version. Apple deprecated
//     the product-scoped v1 endpoints (/v1/inAppPurchaseLocalizations,
//     /v1/subscriptionLocalizations, /v1/subscriptionGroupLocalizations,
//     /v1/inAppPurchaseImages, /v1/subscriptionImages) in favour of /v2 ones
//     whose create body relates to `version`. The v1 tools still work.
//   - Submission moved to reviewSubmissions: a reviewSubmissionItem with an
//     inAppPurchaseVersion / subscriptionVersion / subscriptionGroupVersion
//     relationship. The standalone inAppPurchaseSubmissions /
//     subscriptionSubmissions / subscriptionGroupSubmissions are deprecated.
//
// The create body is relationships-only: the parent product, nothing else.
// There is no PATCH and no DELETE on any of the three version resources.

const VERSION_STATES = [
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'ACCEPTED',
  'APPROVED',
  'REPLACED_WITH_NEW_VERSION',
  'REJECTED',
  'DEVELOPER_REJECTED',
] as const;

export const ProductVersionStateSchema = z
  .enum(VERSION_STATES)
  .describe(
    'Version state. PREPARE_FOR_SUBMISSION = editable draft; READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW = on its way through App Review; APPROVED = live metadata; REPLACED_WITH_NEW_VERSION = an older version a newer approved one superseded; REJECTED / DEVELOPER_REJECTED = sent back.',
  );

// A version in this state is an editable draft. ppp refuses to create a
// second one while it exists — edit the open draft instead. Other states
// (REJECTED, DEVELOPER_REJECTED, …) are left to Apple to accept or refuse.
const OPEN_STATES = new Set<string>(['PREPARE_FOR_SUBMISSION']);

export type ProductVersionKind = 'iap' | 'subscription' | 'subscriptionGroup';

interface KindConfig {
  label: string;
  // Resource type of the version on the wire.
  type: string;
  path: string;
  // Parent relationship key + type on the create body.
  parentKey: string;
  parentType: string;
  // Collection path for "versions of product X".
  listPath: (parentId: string) => string;
  includes: readonly string[];
  hasImages: boolean;
  localizationType: string;
  localizationFields: string;
  imageType?: string;
}

const KINDS: Record<ProductVersionKind, KindConfig> = {
  iap: {
    label: 'in-app purchase',
    type: 'inAppPurchaseVersions',
    path: '/v1/inAppPurchaseVersions',
    parentKey: 'inAppPurchase',
    parentType: 'inAppPurchases',
    listPath: (id) => `/v2/inAppPurchases/${encodeURIComponent(id)}/versions`,
    includes: ['inAppPurchase', 'image', 'images', 'localizations'],
    hasImages: true,
    localizationType: 'inAppPurchaseLocalizations',
    localizationFields: 'name,locale,description',
    imageType: 'inAppPurchaseImages',
  },
  subscription: {
    label: 'subscription',
    type: 'subscriptionVersions',
    path: '/v1/subscriptionVersions',
    parentKey: 'subscription',
    parentType: 'subscriptions',
    listPath: (id) => `/v1/subscriptions/${encodeURIComponent(id)}/versions`,
    includes: ['subscription', 'image', 'images', 'localizations'],
    hasImages: true,
    localizationType: 'subscriptionLocalizations',
    localizationFields: 'name,locale,description',
    imageType: 'subscriptionImages',
  },
  subscriptionGroup: {
    label: 'subscription group',
    type: 'subscriptionGroupVersions',
    path: '/v1/subscriptionGroupVersions',
    parentKey: 'subscriptionGroup',
    parentType: 'subscriptionGroups',
    listPath: (id) => `/v1/subscriptionGroups/${encodeURIComponent(id)}/versions`,
    includes: ['subscriptionGroup', 'localizations'],
    hasImages: false,
    localizationType: 'subscriptionGroupLocalizations',
    localizationFields: 'name,customAppName,locale',
  },
};

const VERSION_FIELDS = 'version,state,localizations';
// The version-scoped (v2) localization and image schemas differ from v1:
// localizations carry no `state`, and images report `assetDeliveryState`
// (a struct) instead of `state`. Sending the v1 names 400s (live 2026-10-24).
const IMAGE_FIELDS = 'fileName,fileSize,assetDeliveryState,imageAsset,assetToken';

// ----- Body + query builders -----

export interface ProductVersionCreateBody {
  data: {
    type: string;
    relationships: Record<string, { data: { type: string; id: string } }>;
  };
}

export function buildProductVersionCreateBody(
  kind: ProductVersionKind,
  parentId: string,
): ProductVersionCreateBody {
  const k = KINDS[kind];
  return {
    data: {
      type: k.type,
      relationships: { [k.parentKey]: { data: { type: k.parentType, id: parentId } } },
    },
  };
}

export function buildProductVersionListQuery(
  kind: ProductVersionKind,
  states?: string[] | undefined,
): URLSearchParams {
  const params = new URLSearchParams();
  const k = KINDS[kind];
  params.set(`fields[${k.type}]`, VERSION_FIELDS);
  // Include just the localization linkage (locale only) so the digest can
  // count them; relationship data is only returned for included resources.
  params.set('include', 'localizations');
  params.set(`fields[${k.localizationType}]`, 'locale');
  params.set('limit[localizations]', '50');
  if (states?.length) params.set('filter[state]', states.join(','));
  params.set('limit', '200');
  return params;
}

export function productVersionListPath(kind: ProductVersionKind, parentId: string): string {
  return KINDS[kind].listPath(parentId);
}

// ----- Digests -----

function attr(r: { attributes?: Record<string, unknown> }, key: string): string {
  const v = r.attributes?.[key];
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function footer(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ' (truncated — pass maxItems to fetch more)' : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

/** To-many relationship size: Apple's paging total when given, else the linkage length. */
export function relCount(r: JSONAPIResource, key: string): string {
  const rel = r.relationships?.[key] as
    | (JSONAPIRelationship & { meta?: { paging?: { total?: number } } })
    | undefined;
  const total = rel?.meta?.paging?.total;
  if (typeof total === 'number') return String(total);
  return Array.isArray(rel?.data) ? String(rel.data.length) : '';
}

export function digestProductVersions(pages: CollectedPages, label: string): string {
  const columns: Column[] = [
    { header: 'VERSION', align: 'right' },
    { header: 'STATE' },
    { header: 'LOCS', align: 'right' },
    { header: 'VERSION_ID' },
  ];
  const rows = pages.data.map((v) => {
    return [attr(v, 'version'), attr(v, 'state'), relCount(v, 'localizations'), v.id];
  });
  // Newest version first.
  rows.sort((a, b) => Number(b[0] || 0) - Number(a[0] || 0));
  return `${footer(pages, label)}\n\n${formatTable(columns, rows)}`;
}

export function digestVersionLocalizations(
  pages: CollectedPages,
  thirdField: 'description' | 'customAppName' = 'description',
): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'NAME' },
    { header: thirdField === 'customAppName' ? 'CUSTOM_APP_NAME' : 'DESCRIPTION' },
    { header: 'LOCALIZATION_ID' },
  ];
  const rows = pages.data.map((l) => [
    attr(l, 'locale'),
    attr(l, 'name'),
    attr(l, thirdField),
    l.id,
  ]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${footer(pages, 'localizations')}\n\n${formatTable(columns, rows)}`;
}

export function digestVersionImages(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'FILE' },
    { header: 'BYTES', align: 'right' },
    { header: 'DELIVERY' },
    { header: 'IMAGE_ID' },
  ];
  const rows = pages.data.map((img) => {
    // assetDeliveryState is a struct { state, errors[], warnings[] }.
    const delivery = img.attributes?.['assetDeliveryState'] as
      | { state?: string; errors?: unknown[] }
      | undefined;
    const cell = delivery
      ? `${delivery.state ?? ''}${delivery.errors?.length ? ` · ${delivery.errors.length} err` : ''}`
      : '';
    return [attr(img, 'fileName'), attr(img, 'fileSize'), cell, img.id];
  });
  return `${footer(pages, 'images')}\n\n${formatTable(columns, rows)}`;
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function errorResult(err: unknown) {
  return { content: [{ type: 'text' as const, text: formatASCError(err) }], isError: true };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

const VersionIdSchema = (kind: ProductVersionKind) =>
  z
    .string()
    .min(1)
    .describe(
      `${KINDS[kind].label} version ID (${KINDS[kind].type}), from asc_list_${TOOL_PREFIX[kind]}_versions.`,
    );

const TOOL_PREFIX: Record<ProductVersionKind, string> = {
  iap: 'iap',
  subscription: 'subscription',
  subscriptionGroup: 'subscription_group',
};

const MODEL_NOTE =
  'Since API 4.4.1 an in-app product has two layers: the product (identity, prices, availability, offers; the existing asc_*_iap / asc_*_subscription / asc_*_subscription_group tools) and its VERSIONS, which hold the customer-facing metadata App Review approves (localizations, and for IAPs and subscriptions the images). Changing approved metadata means creating a new version, editing it, and submitting the version through a review submission.';

function registerKind(server: McpServer, client: ASCClient, kind: ProductVersionKind): void {
  const k = KINDS[kind];
  const prefix = TOOL_PREFIX[kind];
  const parentSchema =
    kind === 'iap'
      ? InAppPurchaseIdSchema
      : kind === 'subscription'
        ? SubscriptionIdSchema
        : SubscriptionGroupIdSchema;
  const versionId = VersionIdSchema(kind);

  server.registerTool(
    `asc_list_${prefix}_versions`,
    {
      title: `List ${k.label} versions`,
      description: `List the metadata versions of a ${k.label}, newest first, with version number, state and localization count. ${MODEL_NOTE} Filter by state, e.g. PREPARE_FOR_SUBMISSION to find the open draft.`,
      inputSchema: z.object({
        parentId: parentSchema,
        state: z.array(ProductVersionStateSchema).min(1).optional(),
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ parentId, state, maxItems, raw }) => {
      const params = buildProductVersionListQuery(kind, state);
      try {
        const pages = await paginate(client, `${k.listPath(parentId)}?${params}`, maxItems);
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestProductVersions(pages, `${k.label} versions`);
        return textResult(text);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    `asc_get_${prefix}_version`,
    {
      title: `Get a ${k.label} version`,
      description: `Fetch one ${k.label} version with its parent ${k.label} and its localizations${k.hasImages ? ' and images' : ''} included.`,
      inputSchema: z.object({ versionId }),
    },
    async ({ versionId: id }) => {
      const params = new URLSearchParams();
      params.set('include', k.includes.join(','));
      params.set(`fields[${k.localizationType}]`, k.localizationFields);
      try {
        const data = await client.request<unknown>(
          `${k.path}/${encodeURIComponent(id)}?${params}`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    `asc_post_${prefix}_version`,
    {
      title: `Create a ${k.label} version`,
      description: `Create a new metadata version of a ${k.label}. The body is just the parent ${k.label}; Apple assigns the version number and starts it in PREPARE_FOR_SUBMISSION. Next: add or edit its localizations${k.hasImages ? ' and images' : ''}, then submit it through a review submission. There is no PATCH or DELETE on versions, so a stray draft stays. ppp refuses if the ${k.label} already has a version in PREPARE_FOR_SUBMISSION and names it, since that draft is the one to edit. dryRun returns the body and the existing versions without writing.`,
      inputSchema: z.object({
        parentId: parentSchema,
        dryRun: z.boolean().default(false),
      }),
    },
    async ({ parentId, dryRun }) => {
      const body = buildProductVersionCreateBody(kind, parentId);
      let existing: CollectedPages;
      try {
        existing = await paginate(
          client,
          `${k.listPath(parentId)}?${buildProductVersionListQuery(kind)}`,
          200,
        );
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Pre-flight failed (could not list existing ${k.label} versions): ${formatASCError(err)}`,
            },
          ],
          isError: true,
        };
      }
      const open = existing.data.find((v) => OPEN_STATES.has(attr(v, 'state')));
      const existingTable = digestProductVersions(existing, `existing ${k.label} versions`);
      if (dryRun) {
        return textResult(
          `Dry run — would POST ${k.path}:\n\n${JSON.stringify(body, null, 2)}\n\n${existingTable}${
            open ? `\n\nA real call would be refused: version ${open.id} is still open.` : ''
          }`,
        );
      }
      if (open) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Refused: ${k.label} ${parentId} already has an open version ${open.id} (version ${attr(open, 'version')}, ${attr(open, 'state')}). Edit that version's localizations instead of creating another; versions cannot be deleted.\n\n${existingTable}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const data = await client.request<unknown>(k.path, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    `asc_list_${prefix}_version_localizations`,
    {
      title: `List a ${k.label} version's localizations`,
      description: `List the localizations of one ${k.label} version (locale, customer-facing name, ${kind === 'subscriptionGroup' ? 'customAppName' : 'description'}). These are the version-scoped localizations that replace the product-scoped v1 ones.`,
      inputSchema: z.object({
        versionId,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ versionId: id, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set(`fields[${k.localizationType}]`, k.localizationFields);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `${k.path}/${encodeURIComponent(id)}/localizations?${params}`,
          maxItems,
        );
        return textResult(
          raw
            ? JSON.stringify(pages, null, 2)
            : digestVersionLocalizations(
                pages,
                kind === 'subscriptionGroup' ? 'customAppName' : 'description',
              ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  if (!k.hasImages || !k.imageType) return;
  const imageType = k.imageType;

  server.registerTool(
    `asc_list_${prefix}_version_images`,
    {
      title: `List a ${k.label} version's images`,
      description: `List the images of one ${k.label} version (file name, size, delivery state). These are the version-scoped images that replace the product-scoped v1 ones.`,
      inputSchema: z.object({
        versionId,
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ versionId: id, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set(`fields[${imageType}]`, IMAGE_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `${k.path}/${encodeURIComponent(id)}/images?${params}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestVersionImages(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    `asc_get_${prefix}_version_image`,
    {
      title: `Get a ${k.label} version's image`,
      description: `Fetch the single image on the to-one \`image\` relationship of a ${k.label} version. Returns { data: null } when none is set. Use asc_list_${prefix}_version_images for the to-many list.`,
      inputSchema: z.object({ versionId }),
    },
    async ({ versionId: id }) => {
      try {
        const data = await client.request<unknown>(
          `${k.path}/${encodeURIComponent(id)}/image?fields[${imageType}]=${IMAGE_FIELDS}`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

export function registerProductVersions(server: McpServer, client: ASCClient): void {
  registerKind(server, client, 'iap');
  registerKind(server, client, 'subscription');
  registerKind(server, client, 'subscriptionGroup');
}
