import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestSingle } from '../digest.js';
import { ascErrorText } from '../errors.js';
import { type CollectedPages, formatTable, type JSONAPIResource, paginate } from '../jsonapi.js';
import { AppIdSchema, AppInfoIdSchema, BetaGroupIdSchema, BuildIdSchema } from '../schemas.js';

// Related-resource reads, by-id reads and usage metrics that spec 4.5.1 has
// and ppp did not call (section E, part 2). Most of these are thin GETs, so
// they are driven from tables instead of one hand-written tool per path:
//
//   * RELATED_READS — the long tail of "/v1/{parent}/{id}/{relationship}"
//     GETs (a build's app, a profile's devices, a CI product's repositories…).
//     They share ONE tool, asc_get_related, keyed by "<parent>.<relationship>".
//     Most of them are one hop from data an existing tool already returns, so
//     a tool each would add ~45 near-identical entries to tools/list for very
//     little; one enum-keyed tool keeps them reachable without the noise.
//   * BY_ID_READS — GET /v1/{type}/{id} for resources ppp could list but not
//     fetch singly (analytics reports, CI issues, SCM pull requests…). These
//     get their own asc_get_* tool, next to the existing asc_list_* one.
//
// Contract notes (spec 4.5.1):
//   * A to-one related GET answers 200 with `data: null` when nothing is
//     linked (e.g. a build with no betaAppReviewSubmission). That is not an
//     error; the tool says "none linked".
//   * The six appInfo category slots are six paths with one shape, so they are
//     one tool with a `slot` argument.
//   * Usage metrics are not JSON:API resources — the response is
//     { data: [{ dataPoints, dimensions }], meta, links }, so they pass through
//     as JSON. GET /v1/betaTesters/{id}/metrics/betaTesterUsages REQUIRES
//     filter[apps] (the tester's usage is per app), and `limit` is refused
//     unless groupBy or a filter is sent.
//   * adjustedEqualizations REQUIRES filter[planType], and live (2026-10-24)
//     Apple accepts only MONTHLY there ("Invalid plan type 'UPFRONT'").
//   * GET /v1/apps/{id}/performanceOverviews (new in 4.5) does not serve
//     application/json: it answers application/vnd.apple.xcode-overview+json,
//     the same family as the perfPowerMetrics endpoints.

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const json = (data: unknown): ToolResult => text(JSON.stringify(data, null, 2));
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: ascErrorText(err) }],
  isError: true,
});

const idOf = (what: string) => z.string().min(1).describe(`${what} ID.`);
const MaxItemsSchema = z.number().int().positive().max(2000).default(200);
const RawSchema = z
  .boolean()
  .default(false)
  .describe('Return the full JSON:API response instead of the compact digest.');

// ----- Related reads (asc_get_related) -----

export interface RelatedReadConfig {
  parent: string; // URL collection segment, e.g. 'builds'
  relationship: string; // URL relationship segment, e.g. 'app'
  cardinality: 'one' | 'many';
  version?: 'v1' | 'v2' | 'v3';
  // Filters Apple accepts on this path (the bare name, e.g. 'territory' for
  // filter[territory]). Anything else is refused before the request.
  filters?: readonly string[];
  // Apple 400s `limit` on a few to-many paths although the spec lists it
  // (seen live 2026-10-24: bundleIds/{id}/bundleIdCapabilities).
  noLimit?: boolean;
}

export const RELATED_READS: readonly RelatedReadConfig[] = [
  { parent: 'appCategories', relationship: 'parent', cardinality: 'one' },
  { parent: 'appCategories', relationship: 'subcategories', cardinality: 'many' },
  {
    parent: 'appCustomProductPageLocalizations',
    relationship: 'searchKeywords',
    cardinality: 'many',
    filters: ['platform', 'locale'],
  },
  {
    parent: 'appEncryptionDeclarations',
    relationship: 'appEncryptionDeclarationDocument',
    cardinality: 'one',
  },
  { parent: 'appPriceSchedules', relationship: 'baseTerritory', cardinality: 'one' },
  {
    parent: 'appStoreVersionLocalizations',
    relationship: 'searchKeywords',
    cardinality: 'many',
    filters: ['platform', 'locale'],
  },
  {
    parent: 'appStoreVersions',
    relationship: 'appStoreVersionExperimentsV2',
    cardinality: 'many',
    filters: ['state'],
  },
  { parent: 'appStoreVersions', relationship: 'build', cardinality: 'one' },
  { parent: 'appTags', relationship: 'territories', cardinality: 'many' },
  { parent: 'apps', relationship: 'ciProduct', cardinality: 'one' },
  { parent: 'betaAppLocalizations', relationship: 'app', cardinality: 'one' },
  { parent: 'betaAppReviewDetails', relationship: 'app', cardinality: 'one' },
  { parent: 'betaAppReviewSubmissions', relationship: 'build', cardinality: 'one' },
  { parent: 'betaBuildLocalizations', relationship: 'build', cardinality: 'one' },
  { parent: 'betaGroups', relationship: 'app', cardinality: 'one' },
  { parent: 'betaGroups', relationship: 'builds', cardinality: 'many' },
  { parent: 'betaTesters', relationship: 'apps', cardinality: 'many' },
  { parent: 'betaTesters', relationship: 'betaGroups', cardinality: 'many' },
  { parent: 'betaTesters', relationship: 'builds', cardinality: 'many' },
  { parent: 'buildBetaDetails', relationship: 'build', cardinality: 'one' },
  { parent: 'builds', relationship: 'app', cardinality: 'one' },
  { parent: 'builds', relationship: 'appStoreVersion', cardinality: 'one' },
  { parent: 'builds', relationship: 'betaAppReviewSubmission', cardinality: 'one' },
  { parent: 'builds', relationship: 'buildBetaDetail', cardinality: 'one' },
  { parent: 'builds', relationship: 'icons', cardinality: 'many' },
  { parent: 'builds', relationship: 'individualTesters', cardinality: 'many' },
  { parent: 'builds', relationship: 'preReleaseVersion', cardinality: 'one' },
  { parent: 'bundleIds', relationship: 'app', cardinality: 'one' },
  {
    parent: 'bundleIds',
    relationship: 'bundleIdCapabilities',
    cardinality: 'many',
    noLimit: true,
  },
  { parent: 'bundleIds', relationship: 'profiles', cardinality: 'many' },
  { parent: 'ciBuildActions', relationship: 'buildRun', cardinality: 'one' },
  { parent: 'ciMacOsVersions', relationship: 'xcodeVersions', cardinality: 'many' },
  {
    parent: 'ciProducts',
    relationship: 'additionalRepositories',
    cardinality: 'many',
    filters: ['id'],
  },
  { parent: 'ciProducts', relationship: 'app', cardinality: 'one' },
  {
    parent: 'ciProducts',
    relationship: 'primaryRepositories',
    cardinality: 'many',
    filters: ['id'],
  },
  { parent: 'ciWorkflows', relationship: 'repository', cardinality: 'one' },
  { parent: 'ciXcodeVersions', relationship: 'macOsVersions', cardinality: 'many' },
  { parent: 'inAppPurchasePriceSchedules', relationship: 'baseTerritory', cardinality: 'one' },
  { parent: 'inAppPurchases', relationship: 'content', cardinality: 'one', version: 'v2' },
  {
    parent: 'inAppPurchases',
    relationship: 'promotedPurchase',
    cardinality: 'one',
    version: 'v2',
  },
  { parent: 'preReleaseVersions', relationship: 'app', cardinality: 'one' },
  { parent: 'preReleaseVersions', relationship: 'builds', cardinality: 'many' },
  { parent: 'profiles', relationship: 'bundleId', cardinality: 'one' },
  { parent: 'profiles', relationship: 'certificates', cardinality: 'many' },
  { parent: 'profiles', relationship: 'devices', cardinality: 'many' },
  { parent: 'reviewSubmissions', relationship: 'items', cardinality: 'many' },
  {
    parent: 'subscriptionOfferCodes',
    relationship: 'prices',
    cardinality: 'many',
    filters: ['territory'],
  },
  { parent: 'subscriptions', relationship: 'promotedPurchase', cardinality: 'one' },
];

export const relatedKey = (c: RelatedReadConfig): string => `${c.parent}.${c.relationship}`;

const RELATED_BY_KEY = new Map(RELATED_READS.map((c) => [relatedKey(c), c]));

export function findRelatedRead(key: string): RelatedReadConfig | undefined {
  return RELATED_BY_KEY.get(key);
}

export interface RelatedPathResult {
  path?: string;
  error?: string;
}

export function buildRelatedPath(
  cfg: RelatedReadConfig,
  id: string,
  filters: Record<string, string> = {},
): RelatedPathResult {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (!cfg.filters?.includes(name)) {
      const allowed = cfg.filters?.length ? cfg.filters.join(', ') : 'none';
      return {
        error: `Refused: ${relatedKey(cfg)} does not take filter "${name}" (allowed: ${allowed}).`,
      };
    }
    params.set(`filter[${name}]`, value);
  }
  if (cfg.cardinality === 'many' && !cfg.noLimit) params.set('limit', '200');
  const qs = params.toString();
  const base = `/${cfg.version ?? 'v1'}/${cfg.parent}/${encodeURIComponent(id)}/${cfg.relationship}`;
  return { path: qs ? `${base}?${qs}` : base };
}

// Compact table for any to-many related list: id + type + the first few
// scalar attributes. The related resources are of ~20 different types, so a
// per-type digest is not worth it; raw:true has everything.
export function digestRelatedMany(pages: CollectedPages, label: string): string {
  if (pages.data.length === 0) return `No ${label} found.`;
  const attrKeys: string[] = [];
  for (const r of pages.data) {
    for (const [k, v] of Object.entries(r.attributes ?? {})) {
      if (attrKeys.length >= 4) break;
      if (attrKeys.includes(k) || v === null || typeof v === 'object') continue;
      attrKeys.push(k);
    }
  }
  const columns = [{ header: 'ID' }, { header: 'TYPE' }, ...attrKeys.map((k) => ({ header: k }))];
  const rows = pages.data.map((r) => [
    r.id,
    r.type,
    ...attrKeys.map((k) => {
      const v = r.attributes?.[k];
      return v === undefined || v === null ? '' : String(v);
    }),
  ]);
  const more = pages.truncated ? ' (truncated — raise maxItems)' : '';
  return `${pages.data.length} ${label}${more}\n\n${formatTable(columns, rows)}`;
}

// ----- By-id reads -----

export interface ByIdReadConfig {
  tool: string;
  resourceType: string;
  version?: 'v1' | 'v2' | 'v3';
  label: string;
  hint: string;
}

export const BY_ID_READS: readonly ByIdReadConfig[] = [
  {
    tool: 'asc_get_alternative_distribution_package_delta',
    resourceType: 'alternativeDistributionPackageDeltas',
    label: 'alternative distribution package delta',
    hint: 'One delta (download URL + checksum) of an alternative-distribution package version. Ids come from asc_list_alternative_distribution_package_deltas.',
  },
  {
    tool: 'asc_get_alternative_distribution_package_variant',
    resourceType: 'alternativeDistributionPackageVariants',
    label: 'alternative distribution package variant',
    hint: 'One variant (per-device download) of an alternative-distribution package version. Ids come from asc_list_alternative_distribution_package_variants.',
  },
  {
    tool: 'asc_get_alternative_distribution_package_version',
    resourceType: 'alternativeDistributionPackageVersions',
    label: 'alternative distribution package version',
    hint: 'One version of an alternative-distribution package (url, urlExpirationDate, version, fileChecksum, state). Ids come from asc_list_alternative_distribution_package_versions.',
  },
  {
    tool: 'asc_get_analytics_report',
    resourceType: 'analyticsReports',
    label: 'analytics report',
    hint: 'One report (name + category) of an analytics report request. Ids come from asc_list_analytics_reports.',
  },
  {
    tool: 'asc_get_analytics_report_instance',
    resourceType: 'analyticsReportInstances',
    label: 'analytics report instance',
    hint: 'One dated instance (granularity + processingDate) of an analytics report. Ids come from asc_list_analytics_report_instances.',
  },
  {
    tool: 'asc_get_analytics_report_segment',
    resourceType: 'analyticsReportSegments',
    label: 'analytics report segment',
    hint: 'One downloadable segment (url, checksum, sizeInBytes) of a report instance. The url is short-lived — download it with asc_download_analytics_report_segment.',
  },
  {
    tool: 'asc_get_ci_product',
    resourceType: 'ciProducts',
    label: 'Xcode Cloud product',
    hint: 'One Xcode Cloud product (name, createdDate, productType APP|FRAMEWORK). Ids come from asc_list_ci_products, or asc_get_related with apps.ciProduct.',
  },
  {
    tool: 'asc_get_ci_build_action',
    resourceType: 'ciBuildActions',
    label: 'Xcode Cloud build action',
    hint: 'One action of a build run (BUILD / ANALYZE / TEST / ARCHIVE) with its status, completion and issueCounts. Ids come from asc_list_ci_build_actions.',
  },
  {
    tool: 'asc_get_ci_issue',
    resourceType: 'ciIssues',
    label: 'Xcode Cloud issue',
    hint: 'One error / warning / analyzer issue from a build action, with message and fileSource. Ids come from asc_list_ci_issues.',
  },
  {
    tool: 'asc_get_ci_test_result',
    resourceType: 'ciTestResults',
    label: 'Xcode Cloud test result',
    hint: 'One test result (className, name, status, destinationTestResults). Ids come from asc_list_ci_test_results.',
  },
  {
    tool: 'asc_get_scm_provider',
    resourceType: 'scmProviders',
    label: 'SCM provider',
    hint: 'One source-control provider connected to Xcode Cloud (scmProviderType + url). Ids come from asc_list_scm_providers.',
  },
  {
    tool: 'asc_get_scm_pull_request',
    resourceType: 'scmPullRequests',
    label: 'SCM pull request',
    hint: 'One pull request Xcode Cloud can build (title, number, source/destination branch, isClosed). Ids come from asc_list_scm_pull_requests.',
  },
  {
    tool: 'asc_get_iap_content',
    resourceType: 'inAppPurchaseContents',
    label: 'IAP hosted content',
    hint: 'Apple-hosted content of a non-consumable IAP (fileName, fileSize, url, lastModifiedDate). Find the id with asc_get_related inAppPurchases.content.',
  },
  {
    tool: 'asc_get_app_price_point_v3',
    version: 'v3',
    resourceType: 'appPricePoints',
    label: 'app price point',
    hint: 'One app price point (customerPrice + proceeds for one territory). Ids come from asc_list_app_price_points.',
  },
];

export function buildByIdPath(cfg: ByIdReadConfig, id: string): string {
  return `/${cfg.version ?? 'v1'}/${cfg.resourceType}/${encodeURIComponent(id)}`;
}

// ----- App info categories -----

export const APP_INFO_CATEGORY_SLOTS = [
  'primaryCategory',
  'primarySubcategoryOne',
  'primarySubcategoryTwo',
  'secondaryCategory',
  'secondarySubcategoryOne',
  'secondarySubcategoryTwo',
] as const;

// ----- Price lists -----

export type PriceKind = 'manual' | 'automatic';

export function buildPriceSchedulePricesPath(
  scheduleType: 'appPriceSchedules' | 'inAppPurchasePriceSchedules',
  scheduleId: string,
  kind: PriceKind,
  filters: {
    territory?: string | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
  },
): string {
  const params = new URLSearchParams();
  if (filters.territory) params.set('filter[territory]', filters.territory);
  // startDate / endDate filters exist on the app schedule only.
  if (scheduleType === 'appPriceSchedules') {
    if (filters.startDate) params.set('filter[startDate]', filters.startDate);
    if (filters.endDate) params.set('filter[endDate]', filters.endDate);
  }
  params.set('limit', '200');
  const rel = kind === 'manual' ? 'manualPrices' : 'automaticPrices';
  return `/v1/${scheduleType}/${encodeURIComponent(scheduleId)}/${rel}?${params.toString()}`;
}

export interface EqualizationPathInput {
  kind: 'app' | 'iap' | 'subscription';
  pricePointId: string;
  territory?: string | undefined;
  adjusted?: boolean | undefined;
  planType?: 'MONTHLY' | 'UPFRONT' | undefined;
}

export function buildEqualizationsPath(input: EqualizationPathInput): string {
  const params = new URLSearchParams();
  if (input.territory) params.set('filter[territory]', input.territory);
  // Subscription only. REQUIRED by Apple on adjustedEqualizations.
  if (input.kind === 'subscription' && input.planType)
    params.set('filter[planType]', input.planType);
  params.set('limit', '200');
  const id = encodeURIComponent(input.pricePointId);
  const qs = params.toString();
  switch (input.kind) {
    case 'app':
      return `/v3/appPricePoints/${id}/equalizations?${qs}`;
    case 'iap':
      return `/v1/inAppPurchasePricePoints/${id}/equalizations?${qs}`;
    case 'subscription':
      return `/v1/subscriptionPricePoints/${id}/${input.adjusted ? 'adjustedEqualizations' : 'equalizations'}?${qs}`;
  }
}

// ----- Usage metrics -----

export const METRIC_PERIODS = ['P7D', 'P30D', 'P90D', 'P365D'] as const;

export interface TesterUsageInput {
  appId?: string | undefined;
  betaGroupId?: string | undefined;
  betaTesterId?: string | undefined;
  period?: (typeof METRIC_PERIODS)[number] | undefined;
  groupByTester?: boolean | undefined;
  betaTesterFilter?: string | undefined;
}

// Three paths share the betaTesterUsages metric. Exactly one scope (app, beta
// group, or tester) is walked; the tester scope REQUIRES an app (filter[apps]).
export function buildTesterUsagePath(input: TesterUsageInput): RelatedPathResult {
  const params = new URLSearchParams();
  if (input.period) params.set('period', input.period);
  let base: string;
  if (input.betaTesterId) {
    if (input.betaGroupId) {
      return { error: 'Refused: pass betaTesterId OR betaGroupId, not both.' };
    }
    if (!input.appId) {
      return {
        error:
          'Refused: a tester usage read needs appId too — Apple requires filter[apps] on /v1/betaTesters/{id}/metrics/betaTesterUsages.',
      };
    }
    if (input.groupByTester || input.betaTesterFilter) {
      return {
        error: 'Refused: groupByTester / betaTesterFilter apply to app or group scope only.',
      };
    }
    params.set('filter[apps]', input.appId);
    base = `/v1/betaTesters/${encodeURIComponent(input.betaTesterId)}/metrics/betaTesterUsages`;
  } else if (input.betaGroupId) {
    if (input.appId) return { error: 'Refused: pass betaGroupId OR appId, not both.' };
    base = `/v1/betaGroups/${encodeURIComponent(input.betaGroupId)}/metrics/betaTesterUsages`;
  } else if (input.appId) {
    base = `/v1/apps/${encodeURIComponent(input.appId)}/metrics/betaTesterUsages`;
  } else {
    return { error: 'Refused: pass one of appId, betaGroupId, or betaTesterId (+ appId).' };
  }
  if (!input.betaTesterId) {
    // Apple REQUIRES groupBy or a filter here (400 PARAMETER_ERROR.REQUIRED,
    // live 2026-10-24), so group per tester unless one tester is filtered.
    if (input.groupByTester !== false || !input.betaTesterFilter)
      params.set('groupBy', 'betaTesters');
    if (input.betaTesterFilter) params.set('filter[betaTesters]', input.betaTesterFilter);
  }
  // Apple 400s `limit` unless a groupBy or filter is present ("The parameter
  // 'limit' can only be used together with 'groupBy' or 'filter'"). The
  // ungrouped answer is one aggregate row anyway.
  if ([...params.keys()].some((k) => k === 'groupBy' || k.startsWith('filter['))) {
    params.set('limit', '200');
  }
  const qs = params.toString();
  return { path: qs ? `${base}?${qs}` : base };
}

export function buildPerformanceOverviewPath(appId: string, deviceTypes?: string[]): string {
  const params = new URLSearchParams();
  if (deviceTypes && deviceTypes.length > 0)
    params.set('filter[deviceType]', deviceTypes.join(','));
  const qs = params.toString();
  const base = `/v1/apps/${encodeURIComponent(appId)}/performanceOverviews`;
  return qs ? `${base}?${qs}` : base;
}

export const XCODE_OVERVIEW_ACCEPT = 'application/vnd.apple.xcode-overview+json';

// ----- Shared runners -----

async function readOne(
  client: ASCClient,
  path: string,
  label: string,
  emptyNote: string,
  raw: boolean,
): Promise<ToolResult> {
  const doc = await client.request<{ data?: JSONAPIResource | null }>(path);
  if (raw) return json(doc);
  if (!doc?.data) return text(emptyNote);
  return text(digestSingle(doc.data, `${label} (${doc.data.type})`));
}

async function readMany(
  client: ASCClient,
  path: string,
  label: string,
  maxItems: number,
  raw: boolean,
): Promise<ToolResult> {
  const pages = await paginate(client, path, maxItems);
  return raw ? json(pages) : text(digestRelatedMany(pages, label));
}

export function registerRelatedReads(server: McpServer, client: ASCClient): void {
  const keys = RELATED_READS.map(relatedKey) as [string, ...string[]];
  const manyKeys = RELATED_READS.filter((c) => c.cardinality === 'many').map(relatedKey);
  const filterKeys = RELATED_READS.filter((c) => c.filters?.length).map(
    (c) => `${relatedKey(c)} (${c.filters?.join(', ')})`,
  );

  server.registerTool(
    'asc_get_related',
    {
      title: 'Read a related resource',
      description: `GET /v1/{parent}/{id}/{relationship} for the long tail of related-resource reads, chosen by \`relationship\` ("<parent>.<relationship>"). To-one reads return the single linked record (or say none is linked); to-many reads are paginated. To-many keys: ${manyKeys.join(', ')}. Everything else is to-one. Keys that take filters: ${filterKeys.join('; ')}. Pass id = the PARENT's id (e.g. a build id for builds.app).`,
      inputSchema: z.object({
        relationship: z
          .enum(keys)
          .describe('"<parent>.<relationship>", e.g. builds.preReleaseVersion.'),
        id: z.string().min(1).describe('ID of the parent resource (the part before the dot).'),
        filters: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Optional filters by bare name, e.g. { "territory": "USA" } → filter[territory]=USA. Only the keys listed in the description take filters.',
          ),
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ relationship, id, filters, maxItems, raw }) => {
      const cfg = findRelatedRead(relationship);
      if (!cfg) return text(`Refused: unknown relationship ${relationship}.`);
      const built = buildRelatedPath(cfg, id, filters);
      if (!built.path) return { ...text(built.error ?? 'Refused.'), isError: true };
      try {
        return cfg.cardinality === 'one'
          ? await readOne(
              client,
              built.path,
              cfg.relationship,
              `No ${cfg.relationship} linked to ${cfg.parent} ${id}.`,
              raw,
            )
          : await readMany(client, built.path, cfg.relationship, maxItems, raw);
      } catch (err) {
        return fail(err);
      }
    },
  );

  for (const cfg of BY_ID_READS) {
    server.registerTool(
      cfg.tool,
      {
        title: `Get a ${cfg.label}`,
        description: `GET /${cfg.version ?? 'v1'}/${cfg.resourceType}/{id} — ${cfg.hint}`,
        inputSchema: z.object({ id: idOf(cfg.label), raw: RawSchema }),
      },
      async ({ id, raw }) => {
        try {
          return await readOne(
            client,
            buildByIdPath(cfg, id),
            cfg.label,
            `No ${cfg.label} ${id}.`,
            raw,
          );
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  server.registerTool(
    'asc_get_app_info_category',
    {
      title: "Get one of an app info's category slots",
      description:
        'GET /v1/appInfos/{id}/{slot} — the category in one slot of an AppInfo: primaryCategory, primarySubcategoryOne/Two, secondaryCategory, secondarySubcategoryOne/Two. Subcategory slots are only used under GAMES / STICKERS. An empty slot is reported as such. To change a slot use asc_patch_app_info; to see all slots at once use asc_get_app_info.',
      inputSchema: z.object({
        appInfoId: AppInfoIdSchema,
        slot: z.enum(APP_INFO_CATEGORY_SLOTS),
        raw: RawSchema,
      }),
    },
    async ({ appInfoId, slot, raw }) => {
      try {
        return await readOne(
          client,
          `/v1/appInfos/${encodeURIComponent(appInfoId)}/${slot}`,
          slot,
          `${slot} is empty on app info ${appInfoId}.`,
          raw,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_list_app_info_territory_age_ratings',
    {
      title: 'List territory age ratings of an app info',
      description:
        'GET /v1/appInfos/{id}/territoryAgeRatings — the age rating Apple shows in each territory, derived from the age rating declaration (appStoreAgeRating + territory). Read-only: change the inputs with asc_patch_age_rating_declaration.',
      inputSchema: z.object({
        appInfoId: AppInfoIdSchema,
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ appInfoId, maxItems, raw }) => {
      try {
        return await readMany(
          client,
          `/v1/appInfos/${encodeURIComponent(appInfoId)}/territoryAgeRatings?limit=200&include=territory`,
          'territory age ratings',
          maxItems,
          raw,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  const PriceKindSchema = z
    .enum(['manual', 'automatic'])
    .default('manual')
    .describe(
      'manual = prices you set (base territory + overrides); automatic = prices Apple derives for the other territories from the base.',
    );
  const TerritoryFilterSchema = z
    .string()
    .min(1)
    .optional()
    .describe('Optional 3-letter territory id, e.g. USA.');

  server.registerTool(
    'asc_list_app_price_schedule_prices',
    {
      title: "List an app price schedule's manual or automatic prices",
      description:
        'GET /v1/appPriceSchedules/{id}/manualPrices | automaticPrices. The schedule id is the app id. Each row is one dated price (startDate/endDate) at a price point. Filter by territory and date window. The base territory is asc_get_related appPriceSchedules.baseTerritory.',
      inputSchema: z.object({
        scheduleId: z
          .string()
          .min(1)
          .describe('App price schedule ID — the same value as the app id.'),
        kind: PriceKindSchema,
        territory: TerritoryFilterSchema,
        startDate: z.string().optional().describe('Optional filter[startDate], YYYY-MM-DD.'),
        endDate: z.string().optional().describe('Optional filter[endDate], YYYY-MM-DD.'),
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ scheduleId, kind, territory, startDate, endDate, maxItems, raw }) => {
      try {
        return await readMany(
          client,
          buildPriceSchedulePricesPath('appPriceSchedules', scheduleId, kind, {
            territory,
            startDate,
            endDate,
          }),
          `${kind} app prices`,
          maxItems,
          raw,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_list_iap_price_schedule_prices',
    {
      title: "List an IAP price schedule's manual or automatic prices",
      description:
        'GET /v1/inAppPurchasePriceSchedules/{id}/manualPrices | automaticPrices. The schedule id is the IAP id. The base territory is asc_get_related inAppPurchasePriceSchedules.baseTerritory.',
      inputSchema: z.object({
        scheduleId: z
          .string()
          .min(1)
          .describe('IAP price schedule ID — the same value as the IAP id.'),
        kind: PriceKindSchema,
        territory: TerritoryFilterSchema,
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ scheduleId, kind, territory, maxItems, raw }) => {
      try {
        return await readMany(
          client,
          buildPriceSchedulePricesPath('inAppPurchasePriceSchedules', scheduleId, kind, {
            territory,
          }),
          `${kind} IAP prices`,
          maxItems,
          raw,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_list_price_point_equalizations',
    {
      title: 'List the equalized price points of a price point',
      description:
        'GET the price points in every other territory that Apple equalizes to one price point: /v3/appPricePoints/{id}/equalizations (kind=app), /v1/inAppPurchasePricePoints/{id}/equalizations (kind=iap), /v1/subscriptionPricePoints/{id}/equalizations or adjustedEqualizations (kind=subscription, adjusted=true). Use it to see what a base price becomes in each territory before setting it.',
      inputSchema: z.object({
        kind: z.enum(['app', 'iap', 'subscription']),
        pricePointId: z.string().min(1).describe('Price point ID of the matching kind.'),
        adjusted: z
          .boolean()
          .optional()
          .describe(
            'Subscription only: read adjustedEqualizations (the equalizations Apple adjusted for the monthly-billed plan). Sent with planType MONTHLY — the only value Apple accepts there.',
          ),
        planType: z
          .enum(['MONTHLY', 'UPFRONT'])
          .optional()
          .describe(
            'Subscription only: which billing plan (MONTHLY = monthly-billed plan, UPFRONT = standard). Defaults to MONTHLY with adjusted=true.',
          ),
        territory: TerritoryFilterSchema,
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ kind, pricePointId, adjusted, planType, territory, maxItems, raw }) => {
      if ((adjusted || planType) && kind !== 'subscription') {
        return {
          ...text('Refused: adjusted / planType apply to kind=subscription only.'),
          isError: true,
        };
      }
      if (adjusted && planType === 'UPFRONT') {
        return {
          ...text(
            'Refused: adjustedEqualizations only accepts planType MONTHLY (Apple: "Invalid plan type \'UPFRONT\'"). Drop adjusted to read the standard equalizations.',
          ),
          isError: true,
        };
      }
      try {
        return await readMany(
          client,
          buildEqualizationsPath({
            kind,
            pricePointId,
            adjusted,
            planType: adjusted ? (planType ?? 'MONTHLY') : planType,
            territory,
          }),
          'equalized price points',
          maxItems,
          raw,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_beta_tester_usages',
    {
      title: 'Get TestFlight tester usage metrics',
      description:
        "GET betaTesterUsages metrics (sessions, crashes, feedback per tester) for one scope: an app (/v1/apps/{id}/metrics/betaTesterUsages), a beta group (/v1/betaGroups/{id}/…), or one tester (/v1/betaTesters/{id}/… — needs appId too, Apple requires filter[apps]). period P7D | P30D | P90D | P365D. App/group results are always grouped per tester (Apple requires groupBy or a filter). Returns Apple's metric JSON (dataPoints + dimensions).",
      inputSchema: z.object({
        appId: AppIdSchema.optional(),
        betaGroupId: BetaGroupIdSchema.optional(),
        betaTesterId: idOf('Beta tester').optional(),
        period: z.enum(METRIC_PERIODS).optional(),
        groupByTester: z.boolean().optional(),
        betaTesterFilter: z
          .string()
          .optional()
          .describe('App/group scope only: limit to one tester id (filter[betaTesters]).'),
      }),
    },
    async (input) => {
      const built = buildTesterUsagePath(input);
      if (!built.path) return { ...text(built.error ?? 'Refused.'), isError: true };
      try {
        return json(await client.request<unknown>(built.path));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_beta_group_public_link_usages',
    {
      title: "Get a beta group's public link usage metrics",
      description:
        "GET /v1/betaGroups/{id}/metrics/publicLinkUsages — how the group's TestFlight public link performs (views, accepted, didNotAccept, didNotMeetCriteria). Only meaningful for external groups with a public link. Returns Apple's metric JSON.",
      inputSchema: z.object({ betaGroupId: BetaGroupIdSchema }),
    },
    async ({ betaGroupId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/metrics/publicLinkUsages?limit=200`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_build_beta_usages',
    {
      title: "Get a build's TestFlight usage metrics",
      description:
        "GET /v1/builds/{id}/metrics/betaBuildUsages — per-build TestFlight usage (installs, sessions, crashes, feedback, invitations). Returns Apple's metric JSON.",
      inputSchema: z.object({ buildId: BuildIdSchema }),
    },
    async ({ buildId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/builds/${encodeURIComponent(buildId)}/metrics/betaBuildUsages?limit=200`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_app_performance_overview',
    {
      title: "Get an app's performance overview",
      description:
        'GET /v1/apps/{id}/performanceOverviews (API 4.5) — the Xcode Organizer-style performance overview for an app (launch, hang, memory, disk, battery and scroll metrics against goals). Apple serves it as application/vnd.apple.xcode-overview+json, not JSON:API. Optional deviceTypes narrows it (e.g. ["iPhone"]). Empty for apps without enough on-device data. For the raw metric series use asc_get_app_perf_power_metrics.',
      inputSchema: z.object({
        appId: AppIdSchema,
        deviceTypes: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional filter[deviceType] values.'),
      }),
    },
    async ({ appId, deviceTypes }) => {
      try {
        return json(
          await client.request<unknown>(buildPerformanceOverviewPath(appId, deviceTypes), {
            headers: { accept: XCODE_OVERVIEW_ACCEPT },
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
