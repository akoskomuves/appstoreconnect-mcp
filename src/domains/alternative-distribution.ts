import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestAlternativeDistributionDomains,
  digestAlternativeDistributionPackageVersions,
  digestMarketplaceWebhooks,
  digestWebhooks,
} from '../digest.js';
import { ASCError, ascErrorText } from '../errors.js';
import { type JSONAPIResource, paginate } from '../jsonapi.js';
import {
  AlternativeDistributionDomainIdSchema,
  AlternativeDistributionKeyIdSchema,
  AlternativeDistributionPackageIdSchema,
  AlternativeDistributionPackageVersionIdSchema,
  AppIdSchema,
  AppStoreVersionIdSchema,
  MarketplaceSearchDetailIdSchema,
  MarketplaceWebhookIdSchema,
  WebhookSecretSchema,
} from '../schemas.js';
import { buildWebhookCreateBody, buildWebhookPatchBody } from './webhooks.js';

// EU DMA / alternative distribution — the surfaces for distributing iOS
// apps outside the App Store in the EU: from your own website (web
// distribution) or through an alternative marketplace.
//
// ENTITLEMENT-GATED: every endpoint here 403s unless the account holds the
// relevant alternative-distribution / marketplace entitlement from Apple.
// A 403 on these tools means "account not enrolled", not a bug.
//
// Sub-surfaces:
//   - Domains: registered websites for web distribution. Create/list/delete
//     (no patch — re-create to change).
//   - Keys: the PUBLIC half (PEM) of your signing key. The private key
//     never goes to Apple. To-one per app.
//   - Packages: per-AppStoreVersion signed install packages. Created
//     against a version; its VERSIONS carry PRE-SIGNED TIME-LIMITED
//     download URLs (state COMPLETED/REPLACED) with variants + deltas
//     beneath. Same download hygiene as v0.18 analytics segments: fetch
//     promptly, re-list for fresh URLs, never send the ASC bearer to the
//     pre-signed hosts.
//   - MarketplaceSearchDetail: catalogUrl for MARKETPLACE apps. Wire-key
//     strip: Swift `catalogURL` → wire `catalogUrl`.
//   - MarketplaceWebhooks: team-level webhooks for marketplace apps. Wire
//     strip: Swift `endpointURL` → wire `endpointUrl`; `secret` is
//     WRITE-ONLY (same treatment as v0.17 app webhooks).
//     DEPRECATED by Apple (all four /v1/marketplaceWebhooks operations). The
//     replacement is the regular per-app webhook (/v1/webhooks) on the
//     MARKETPLACE app, subscribed to the three ALTERNATIVE_DISTRIBUTION_*
//     event types — Apple's webhook-events doc describes those as the
//     notifications that "inform a marketplace about changes to apps it
//     distributes". The four asc_*_marketplace_webhook tools keep their names
//     and now drive /v1/webhooks; `legacy: true` reaches the old team-level
//     records (list / patch / delete) so existing ones can be cleaned up.

const DOMAIN_FIELDS = 'domain,referenceName,createdDate';
const PACKAGE_VERSION_FIELDS = 'url,urlExpirationDate,version,fileChecksum,state';
const VARIANT_FIELDS = 'url,urlExpirationDate,alternativeDistributionKeyBlob,fileChecksum';
const DELTA_FIELDS = 'url,urlExpirationDate,alternativeDistributionKeyBlob,fileChecksum';
const MARKETPLACE_WEBHOOK_FIELDS = 'endpointUrl';
const WEBHOOK_FIELDS = 'enabled,eventTypes,name,url,app';

// The webhook event types that replace the deprecated marketplace webhook.
export const MARKETPLACE_EVENT_TYPES = [
  'ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED',
  'ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED',
  'ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED',
] as const;

const MarketplaceEventTypeSchema = z.enum(MARKETPLACE_EVENT_TYPES);

// A webhook counts as a marketplace webhook when it subscribes to at least one
// ALTERNATIVE_DISTRIBUTION_* event. Used to narrow the app's webhook list.
export function isMarketplaceWebhook(resource: JSONAPIResource): boolean {
  const events = resource.attributes?.eventTypes;
  return (
    Array.isArray(events) &&
    events.some((e) => (MARKETPLACE_EVENT_TYPES as readonly string[]).includes(String(e)))
  );
}

export interface MarketplaceWebhookCreateInput {
  marketplaceAppId: string;
  endpointUrl: string;
  secret: string;
  name?: string | undefined;
  eventTypes?: string[] | undefined;
  enabled?: boolean | undefined;
}

// The replacement create: a regular Webhook on the marketplace app, all three
// marketplace event types by default.
export function buildMarketplaceWebhookV2CreateBody(input: MarketplaceWebhookCreateInput) {
  return buildWebhookCreateBody({
    appId: input.marketplaceAppId,
    name: input.name ?? 'marketplace',
    url: input.endpointUrl,
    secret: input.secret,
    eventTypes: input.eventTypes ?? [...MARKETPLACE_EVENT_TYPES],
    enabled: input.enabled ?? true,
  });
}

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export function buildAltDomainCreateBody(input: {
  domain: string;
  referenceName: string;
}): JSONAPIBody {
  return {
    data: {
      type: 'alternativeDistributionDomains',
      attributes: { domain: input.domain, referenceName: input.referenceName },
    },
  };
}

export function buildAltKeyCreateBody(input: {
  publicKey: string;
  appId?: string | undefined;
}): JSONAPIBody {
  return {
    data: {
      type: 'alternativeDistributionKeys',
      attributes: { publicKey: input.publicKey },
      ...(input.appId !== undefined
        ? { relationships: { app: { data: { type: 'apps', id: input.appId } } } }
        : {}),
    },
  };
}

export function buildAltPackageCreateBody(input: { appStoreVersionId: string }): JSONAPIBody {
  // Relationships-only create (no attributes block) — same family as
  // BuildBetaNotification / webhook redelivery.
  return {
    data: {
      type: 'alternativeDistributionPackages',
      relationships: {
        appStoreVersion: {
          data: { type: 'appStoreVersions', id: input.appStoreVersionId },
        },
      },
    },
  };
}

export function buildMarketplaceSearchDetailCreateBody(input: {
  appId: string;
  catalogUrl: string;
}): JSONAPIBody {
  // Wire key `catalogUrl` — NOT Swift's `catalogURL`.
  return {
    data: {
      type: 'marketplaceSearchDetails',
      attributes: { catalogUrl: input.catalogUrl },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export function buildMarketplaceSearchDetailPatchBody(input: {
  searchDetailId: string;
  catalogUrl: string;
}): JSONAPIBody {
  return {
    data: {
      type: 'marketplaceSearchDetails',
      id: input.searchDetailId,
      attributes: { catalogUrl: input.catalogUrl },
    },
  };
}

export function buildMarketplaceWebhookCreateBody(input: {
  endpointUrl: string;
  secret: string;
}): JSONAPIBody {
  // Wire key `endpointUrl` — NOT Swift's `endpointURL`. Secret write-only.
  return {
    data: {
      type: 'marketplaceWebhooks',
      attributes: { endpointUrl: input.endpointUrl, secret: input.secret },
    },
  };
}

export function buildMarketplaceWebhookPatchBody(input: {
  webhookId: string;
  endpointUrl?: string | undefined;
  secret?: string | undefined;
}): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.endpointUrl !== undefined) attributes.endpointUrl = input.endpointUrl;
  if (input.secret !== undefined) attributes.secret = input.secret;
  return {
    data: {
      type: 'marketplaceWebhooks',
      id: input.webhookId,
      attributes,
    },
  };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    const gate =
      err.status === 403
        ? '\n\n(403 on alternative-distribution endpoints usually means the account lacks the EU alternative-distribution / marketplace entitlement — not a bug.)'
        : '';
    return `${err.message}\n\n${detail}${gate}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// Live (2026-10-24): on an app that is not a marketplace app, Apple 409s the
// create with "ALTERNATIVE_DISTRIBUTION_… event types cannot be added to the
// webhook". Say what that means instead of leaving the caller to guess.
export function explainMarketplaceWebhookError(err: unknown): string {
  const text = formatASCError(err);
  if (/ALTERNATIVE_DISTRIBUTION_\w+ event types cannot be added/.test(ascErrorText(err))) {
    return `${text}\n\nApple only accepts marketplace event types on a MARKETPLACE app (an alternative app store app with the marketplace entitlement). Check marketplaceAppId — it must be that app, not one of the apps it distributes.`;
  }
  return text;
}

// A 404 on a regular-webhook path is often an id from the old team-level list.
function legacyHint(err: unknown, legacy: boolean): string {
  const text = formatASCError(err);
  if (!legacy && err instanceof ASCError && err.status === 404) {
    return `${text}\n\nIf this id came from the old team-level list, retry with legacy:true.`;
  }
  return text;
}

export function registerAlternativeDistribution(server: McpServer, client: ASCClient): void {
  // ----- Domains (web distribution) -----

  server.registerTool(
    'asc_list_alternative_distribution_domains',
    {
      title: 'List alternative distribution domains',
      description:
        'GET /v1/alternativeDistributionDomains — team-level registered website domains for EU web distribution. Entitlement-gated (403 = account not enrolled).',
      inputSchema: z.object({
        raw: z.boolean().default(false),
      }),
    },
    async ({ raw }) => {
      const params = new URLSearchParams();
      params.set('fields[alternativeDistributionDomains]', DOMAIN_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/alternativeDistributionDomains?${params.toString()}`,
          200,
        );
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestAlternativeDistributionDomains(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_alternative_distribution_domain',
    {
      title: 'Register an alternative distribution domain',
      description:
        'POST /v1/alternativeDistributionDomains — register a website domain (e.g. "example.com") for EU web distribution. Both attributes required: domain + referenceName. Apple verifies domain ownership out-of-band (apple-developer-domain-association file). No PATCH exists — delete + re-create to change.',
      inputSchema: z.object({
        domain: z.string().min(1).describe('The website domain, e.g. "example.com".'),
        referenceName: z.string().min(1).describe('Internal display name.'),
      }),
    },
    async ({ domain, referenceName }) => {
      const body = buildAltDomainCreateBody({ domain, referenceName });
      try {
        const data = await client.request<unknown>('/v1/alternativeDistributionDomains', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Registered domain ${domain}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_alternative_distribution_domain',
    {
      title: 'Delete an alternative distribution domain',
      description:
        '⚠️ DELETE /v1/alternativeDistributionDomains/{id} — apps distributed from this domain stop being installable from it. Confirm intent first.',
      inputSchema: z.object({
        domainId: AlternativeDistributionDomainIdSchema,
      }),
    },
    async ({ domainId }) => {
      try {
        await client.request<unknown>(
          `/v1/alternativeDistributionDomains/${encodeURIComponent(domainId)}`,
          { method: 'DELETE' },
        );
        return { content: [{ type: 'text', text: `Deleted domain ${domainId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Keys -----

  server.registerTool(
    'asc_list_alternative_distribution_keys',
    {
      title: 'List alternative distribution keys',
      description:
        'GET /v1/alternativeDistributionKeys — the PUBLIC signing keys registered with Apple (the private halves never leave your infrastructure). Use asc_get_app_alternative_distribution_key for the to-one app linkage.',
      inputSchema: z.object({
        raw: z.boolean().default(false),
      }),
    },
    async ({ raw }) => {
      const params = new URLSearchParams();
      params.set('fields[alternativeDistributionKeys]', 'publicKey');
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/alternativeDistributionKeys?${params.toString()}`,
          200,
        );
        return {
          content: [
            {
              type: 'text',
              text: raw
                ? JSON.stringify(pages, null, 2)
                : `${pages.data.length} keys\n\n${pages.data.map((k) => `- ${k.id}`).join('\n')}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_alternative_distribution_key',
    {
      title: "Get an app's alternative distribution key",
      description:
        "GET /v1/apps/{id}/alternativeDistributionKey — the app's registered public key (to-one).",
      inputSchema: z.object({
        appId: AppIdSchema,
      }),
    },
    async ({ appId }) => {
      try {
        const data = await client.request<{ data?: unknown }>(
          `/v1/apps/${encodeURIComponent(appId)}/alternativeDistributionKey`,
          { method: 'GET' },
        );
        // LIVE-SMOKE FINDING (2026-06-12): absent to-one returns 200 +
        // data:null (the v0.19 review-response pattern).
        if (data && 'data' in data && data.data === null) {
          return {
            content: [
              {
                type: 'text',
                text: `App ${appId} has no alternative distribution key registered. Register one with asc_post_alternative_distribution_key.`,
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_alternative_distribution_key',
    {
      title: 'Register an alternative distribution key',
      description:
        'POST /v1/alternativeDistributionKeys — register the PUBLIC key (PEM string) used to verify your signed alternative-distribution artifacts. Optionally scope to one app via appId. The private key stays with you — never paste it anywhere; this tool takes the PUBLIC half only.',
      inputSchema: z.object({
        publicKey: z.string().min(1).describe('PEM-encoded PUBLIC key. (Never the private key.)'),
        appId: AppIdSchema.optional(),
      }),
    },
    async ({ publicKey, appId }) => {
      const body = buildAltKeyCreateBody({
        publicKey,
        ...(appId !== undefined ? { appId } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/alternativeDistributionKeys', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: 'text', text: `Registered key.\n\n${JSON.stringify(data, null, 2)}` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_alternative_distribution_key',
    {
      title: 'Delete an alternative distribution key',
      description:
        '⚠️ DELETE /v1/alternativeDistributionKeys/{id} — artifacts signed against this key stop validating. Confirm intent first.',
      inputSchema: z.object({
        keyId: AlternativeDistributionKeyIdSchema,
      }),
    },
    async ({ keyId }) => {
      try {
        await client.request<unknown>(
          `/v1/alternativeDistributionKeys/${encodeURIComponent(keyId)}`,
          { method: 'DELETE' },
        );
        return { content: [{ type: 'text', text: `Deleted key ${keyId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Packages -----

  server.registerTool(
    'asc_post_alternative_distribution_package',
    {
      title: 'Create an alternative distribution package',
      description:
        'POST /v1/alternativeDistributionPackages — start packaging an App Store Version for alternative distribution. Relationships-only body (appStoreVersion). Apple builds the signed package asynchronously; poll asc_list_alternative_distribution_package_versions until a version reaches COMPLETED.',
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
      }),
    },
    async ({ appStoreVersionId }) => {
      const body = buildAltPackageCreateBody({ appStoreVersionId });
      try {
        const data = await client.request<unknown>('/v1/alternativeDistributionPackages', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Package requested for version ${appStoreVersionId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_version_alternative_distribution_package',
    {
      title: "Get a version's alternative distribution package",
      description:
        'GET /v1/appStoreVersions/{id}/alternativeDistributionPackage — the to-one package record for a version (or an error when none was created).',
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
      }),
    },
    async ({ appStoreVersionId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/appStoreVersions/${encodeURIComponent(appStoreVersionId)}/alternativeDistributionPackage`,
          { method: 'GET' },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_alternative_distribution_package_versions',
    {
      title: 'List versions of an alternative distribution package',
      description:
        'GET /v1/alternativeDistributionPackages/{id}/versions — the dated builds of a package. State COMPLETED = downloadable via the pre-signed url (time-limited per urlExpirationDate — download promptly, re-list for fresh URLs, and NEVER send the ASC bearer to the download host). Variants/deltas per version via the dedicated list tools.',
      inputSchema: z.object({
        packageId: AlternativeDistributionPackageIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ packageId, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[alternativeDistributionPackageVersions]', PACKAGE_VERSION_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/alternativeDistributionPackages/${encodeURIComponent(packageId)}/versions?${params.toString()}`,
          200,
        );
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestAlternativeDistributionPackageVersions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_alternative_distribution_package_variants',
    {
      title: 'List variants of a package version',
      description:
        'GET /v1/alternativeDistributionPackageVersions/{id}/variants — per-device-thinning variants with pre-signed download URLs + key blobs. Raw JSON (URLs verbatim).',
      inputSchema: z.object({
        packageVersionId: AlternativeDistributionPackageVersionIdSchema,
      }),
    },
    async ({ packageVersionId }) => {
      const params = new URLSearchParams();
      params.set('fields[alternativeDistributionPackageVariants]', VARIANT_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/alternativeDistributionPackageVersions/${encodeURIComponent(packageVersionId)}/variants?${params.toString()}`,
          200,
        );
        return { content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_alternative_distribution_package_deltas',
    {
      title: 'List deltas of a package version',
      description:
        'GET /v1/alternativeDistributionPackageVersions/{id}/deltas — update deltas (smaller downloads from prior versions) with pre-signed URLs. Raw JSON (URLs verbatim).',
      inputSchema: z.object({
        packageVersionId: AlternativeDistributionPackageVersionIdSchema,
      }),
    },
    async ({ packageVersionId }) => {
      const params = new URLSearchParams();
      params.set('fields[alternativeDistributionPackageDeltas]', DELTA_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/alternativeDistributionPackageVersions/${encodeURIComponent(packageVersionId)}/deltas?${params.toString()}`,
          200,
        );
        return { content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Marketplace search detail -----

  server.registerTool(
    'asc_get_marketplace_search_detail',
    {
      title: "Get an app's marketplace search detail",
      description:
        'GET /v1/apps/{id}/marketplaceSearchDetail — the catalogUrl for a MARKETPLACE app (alternative app store). Observed live: calling this on a NON-marketplace app returns an Apple-side 500 UNEXPECTED_ERROR rather than a clean 404 — that 500 means "not a marketplace app", not an outage.',
      inputSchema: z.object({
        appId: AppIdSchema,
      }),
    },
    async ({ appId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/apps/${encodeURIComponent(appId)}/marketplaceSearchDetail`,
          { method: 'GET' },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_marketplace_search_detail',
    {
      title: 'Create a marketplace search detail',
      description:
        "POST /v1/marketplaceSearchDetails — set a MARKETPLACE app's catalogUrl (the catalog Apple's MarketplaceKit queries). Wire key catalogUrl (Swift catalogURL — pinned by tests). One per app; PATCH to change.",
      inputSchema: z.object({
        appId: AppIdSchema,
        catalogUrl: z.string().url().describe('HTTPS catalog URL.'),
      }),
    },
    async ({ appId, catalogUrl }) => {
      const body = buildMarketplaceSearchDetailCreateBody({ appId, catalogUrl });
      try {
        const data = await client.request<unknown>('/v1/marketplaceSearchDetails', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created search detail for app ${appId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_marketplace_search_detail',
    {
      title: 'Patch a marketplace search detail',
      description: 'PATCH /v1/marketplaceSearchDetails/{id} — update the catalogUrl.',
      inputSchema: z.object({
        searchDetailId: MarketplaceSearchDetailIdSchema,
        catalogUrl: z.string().url(),
      }),
    },
    async ({ searchDetailId, catalogUrl }) => {
      const body = buildMarketplaceSearchDetailPatchBody({ searchDetailId, catalogUrl });
      try {
        const data = await client.request<unknown>(
          `/v1/marketplaceSearchDetails/${encodeURIComponent(searchDetailId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched search detail ${searchDetailId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_marketplace_search_detail',
    {
      title: 'Delete a marketplace search detail',
      description: 'DELETE /v1/marketplaceSearchDetails/{id}.',
      inputSchema: z.object({
        searchDetailId: MarketplaceSearchDetailIdSchema,
      }),
    },
    async ({ searchDetailId }) => {
      try {
        await client.request<unknown>(
          `/v1/marketplaceSearchDetails/${encodeURIComponent(searchDetailId)}`,
          { method: 'DELETE' },
        );
        return { content: [{ type: 'text', text: `Deleted search detail ${searchDetailId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Marketplace webhooks (now regular webhooks on the marketplace app) -----

  const legacyFlag = z
    .boolean()
    .default(false)
    .describe(
      'true = act on the DEPRECATED team-level /v1/marketplaceWebhooks record instead of a regular webhook. Use only to read or clean up webhooks created before the migration.',
    );

  server.registerTool(
    'asc_list_marketplace_webhooks',
    {
      title: 'List marketplace webhooks',
      description:
        "List the webhooks that notify a MARKETPLACE app about apps it distributes: GET /v1/apps/{marketplaceAppId}/webhooks, narrowed to webhooks subscribed to an ALTERNATIVE_DISTRIBUTION_* event (Apple's replacement for the deprecated /v1/marketplaceWebhooks). Pass legacy:true (no app id needed) to list the old team-level records instead. Secret is write-only and never shown.",
      inputSchema: z.object({
        marketplaceAppId: AppIdSchema.optional().describe(
          'The marketplace app (your alternative app store app). Required unless legacy is true.',
        ),
        legacy: legacyFlag,
        raw: z.boolean().default(false),
      }),
    },
    async ({ marketplaceAppId, legacy, raw }) => {
      try {
        if (legacy) {
          const params = new URLSearchParams();
          params.set('fields[marketplaceWebhooks]', MARKETPLACE_WEBHOOK_FIELDS);
          params.set('limit', '200');
          const pages = await paginate(client, `/v1/marketplaceWebhooks?${params.toString()}`, 200);
          const text = raw ? JSON.stringify(pages, null, 2) : digestMarketplaceWebhooks(pages);
          return {
            content: [
              {
                type: 'text',
                text: `${text}\n\n(legacy team-level records — /v1/marketplaceWebhooks is deprecated; recreate them with asc_post_marketplace_webhook and delete these with legacy:true)`,
              },
            ],
          };
        }
        if (!marketplaceAppId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Refused: pass marketplaceAppId (marketplace webhooks are now regular webhooks on the marketplace app), or legacy:true for the deprecated team-level list.',
              },
            ],
            isError: true,
          };
        }
        const params = new URLSearchParams();
        params.set('fields[webhooks]', WEBHOOK_FIELDS);
        params.set('limit', '200');
        const all = await paginate(
          client,
          `/v1/apps/${encodeURIComponent(marketplaceAppId)}/webhooks?${params.toString()}`,
          200,
        );
        const pages = { ...all, data: all.data.filter(isMarketplaceWebhook) };
        delete pages.total;
        const text = raw ? JSON.stringify(pages, null, 2) : digestWebhooks(pages);
        const hidden = all.data.length - pages.data.length;
        return {
          content: [
            {
              type: 'text',
              text: hidden
                ? `${text}\n\n(${hidden} other webhook(s) on this app without marketplace events — see asc_list_webhooks)`
                : text,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_marketplace_webhook',
    {
      title: 'Create a marketplace webhook',
      description:
        "Create the webhook that notifies a MARKETPLACE app about apps it distributes (new version available, remove a version, remove all versions). POST /v1/webhooks on the marketplace app, subscribed to the ALTERNATIVE_DISTRIBUTION_* events (all three by default) — Apple's replacement for the deprecated POST /v1/marketplaceWebhooks, which this tool no longer calls. secret is the HMAC signing key, WRITE-ONLY: store it on the receiving side first; rotatable via PATCH.",
      inputSchema: z.object({
        marketplaceAppId: AppIdSchema.describe(
          'The marketplace app (your alternative app store app) the webhook belongs to.',
        ),
        endpointUrl: z.string().url().describe('HTTPS endpoint Apple POSTs marketplace events to.'),
        secret: WebhookSecretSchema,
        name: z.string().min(1).optional().describe('Webhook name. Default "marketplace".'),
        eventTypes: z
          .array(MarketplaceEventTypeSchema)
          .min(1)
          .optional()
          .describe('Subset of the three marketplace events. Default: all three.'),
        enabled: z.boolean().default(true),
      }),
    },
    async ({ marketplaceAppId, endpointUrl, secret, name, eventTypes, enabled }) => {
      const body = buildMarketplaceWebhookV2CreateBody({
        marketplaceAppId,
        endpointUrl,
        secret,
        name,
        eventTypes,
        enabled,
      });
      try {
        const data = await client.request<unknown>('/v1/webhooks', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created marketplace webhook on app ${marketplaceAppId} (${body.data.attributes?.eventTypes ? (body.data.attributes.eventTypes as string[]).join(', ') : ''}). Test it with asc_post_webhook_ping.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: explainMarketplaceWebhookError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'asc_patch_marketplace_webhook',
    {
      title: 'Patch a marketplace webhook',
      description:
        'Update a marketplace webhook: endpointUrl, rotate the secret (update the receiver first), and — for regular webhooks — name, eventTypes, enabled. PATCH /v1/webhooks/{id} by default; legacy:true PATCHes a deprecated /v1/marketplaceWebhooks record (endpointUrl + secret only). Pass at least one field.',
      inputSchema: z.object({
        webhookId: MarketplaceWebhookIdSchema,
        endpointUrl: z.string().url().optional(),
        secret: WebhookSecretSchema.optional(),
        name: z.string().min(1).optional(),
        eventTypes: z.array(MarketplaceEventTypeSchema).min(1).optional(),
        enabled: z.boolean().optional(),
        legacy: legacyFlag,
      }),
    },
    async ({ webhookId, endpointUrl, secret, name, eventTypes, enabled, legacy }) => {
      if (legacy && (name !== undefined || eventTypes !== undefined || enabled !== undefined)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: legacy marketplace webhooks only take endpointUrl and secret. Recreate it with asc_post_marketplace_webhook to get name/eventTypes/enabled.',
            },
          ],
          isError: true,
        };
      }
      if ([endpointUrl, secret, name, eventTypes, enabled].every((v) => v === undefined)) {
        return {
          content: [{ type: 'text', text: 'Refused: pass at least one field to change.' }],
          isError: true,
        };
      }
      const body = legacy
        ? buildMarketplaceWebhookPatchBody({ webhookId, endpointUrl, secret })
        : buildWebhookPatchBody({ webhookId, url: endpointUrl, secret, name, eventTypes, enabled });
      const path = legacy
        ? `/v1/marketplaceWebhooks/${encodeURIComponent(webhookId)}`
        : `/v1/webhooks/${encodeURIComponent(webhookId)}`;
      try {
        const data = await client.request<unknown>(path, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Patched marketplace webhook ${webhookId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: legacyHint(err, legacy) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_marketplace_webhook',
    {
      title: 'Delete a marketplace webhook',
      description:
        'Stop marketplace update notifications. DELETE /v1/webhooks/{id} by default; legacy:true deletes a deprecated /v1/marketplaceWebhooks record.',
      inputSchema: z.object({
        webhookId: MarketplaceWebhookIdSchema,
        legacy: legacyFlag,
      }),
    },
    async ({ webhookId, legacy }) => {
      const path = legacy
        ? `/v1/marketplaceWebhooks/${encodeURIComponent(webhookId)}`
        : `/v1/webhooks/${encodeURIComponent(webhookId)}`;
      try {
        await client.request<unknown>(path, { method: 'DELETE' });
        return { content: [{ type: 'text', text: `Deleted marketplace webhook ${webhookId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: legacyHint(err, legacy) }], isError: true };
      }
    },
  );
}
