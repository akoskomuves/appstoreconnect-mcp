import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  buildIncludedIndex,
  type Column,
  formatTable,
  lookupIncluded,
  paginate,
} from '../jsonapi.js';
import {
  applyFloor,
  computeFactor,
  computeTarget,
  indexAsMap,
  loadIndex,
  parseDecimal,
  percentChange,
  type RoundStrategy,
  snapToTier,
} from '../ppp/index.js';
import { AppIdSchema, SubscriptionIdSchema } from '../schemas.js';

type ResourceType = 'subscription' | 'app';

interface PricePointInfo {
  id: string;
  amount: number;
}

interface ProposalRow {
  territory: string;
  currency: string;
  currentLocal: number | undefined;
  factor: number | undefined;
  targetLocal: number | undefined;
  snappedAmount: number | undefined;
  snappedPointId: string | undefined;
  changePct: number | undefined;
  reason: string;
}

interface ProposalContext {
  rows: ProposalRow[];
  snapshot: string;
  anchorTerritory: string;
  basePriceAnchor: number;
  roundStrategy: RoundStrategy;
  floorFactor: number;
}

function fmtMoney(n: number | undefined): string {
  if (n === undefined) return '';
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}

function fmtPct(n: number | undefined): string {
  if (n === undefined) return '';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(0)}%`;
}

function todayPlusDaysISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchCurrentPriceMap(
  client: ASCClient,
  subscriptionId: string,
): Promise<Map<string, { amount: number; territory: string; currency: string }>> {
  const path = `/v1/subscriptions/${encodeURIComponent(
    subscriptionId,
  )}/prices?include=subscriptionPricePoint,territory`;
  const pages = await paginate(client, path, 2000);
  const index = buildIncludedIndex(pages.included);
  const out = new Map<string, { amount: number; territory: string; currency: string }>();
  for (const price of pages.data) {
    const territoryRel = price.relationships?.['territory']?.data;
    const pointRel = price.relationships?.['subscriptionPricePoint']?.data;
    const territoryId = territoryRel && !Array.isArray(territoryRel) ? territoryRel.id : undefined;
    const pointId = pointRel && !Array.isArray(pointRel) ? pointRel.id : undefined;
    if (!territoryId || !pointId) continue;
    const point = lookupIncluded(index, 'subscriptionPricePoints', pointId);
    const territory = lookupIncluded(index, 'territories', territoryId);
    const amount = parseDecimal(point?.attributes?.['customerPrice'] as string | undefined);
    const currency = (territory?.attributes?.['currency'] as string | undefined) ?? '';
    if (amount === undefined) continue;
    out.set(territoryId, { amount, territory: territoryId, currency });
  }
  return out;
}

async function fetchPricePointsForTerritory(
  client: ASCClient,
  subscriptionId: string,
  territoryId: string,
): Promise<PricePointInfo[]> {
  const params = new URLSearchParams();
  params.set('filter[territory]', territoryId);
  params.set('limit', '200');
  const pages = await paginate(
    client,
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/pricePoints?${params.toString()}`,
    5000,
  );
  const out: PricePointInfo[] = [];
  for (const p of pages.data) {
    const amt = parseDecimal(p.attributes?.['customerPrice'] as string | undefined);
    if (amt === undefined) continue;
    out.push({ id: p.id, amount: amt });
  }
  return out;
}

// App pricing equivalent. Apple's appPriceSchedule endpoint does NOT support
// chained includes, so price-point amounts are not inline — we fetch them
// per-territory and cross-reference. More expensive than subs (one fetch per
// unique territory in the schedule), but no other path: chained includes,
// fields[appPricePoints] selectors, and bulk price-point lookups are all
// rejected on the schedule endpoint.
async function fetchCurrentAppPriceMap(
  client: ASCClient,
  appId: string,
): Promise<Map<string, { amount: number; territory: string; currency: string }>> {
  const params = new URLSearchParams();
  params.set('include', 'manualPrices,automaticPrices,baseTerritory');
  const pages = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/appPriceSchedule?${params.toString()}`,
    2000,
  );

  // Collect (territoryId, pricePointId) pairs from the included AppPrice rows.
  const appPrices = pages.included.filter((r) => r.type === 'appPrices');
  type Entry = { territoryId: string; pricePointId: string };
  const entries: Entry[] = [];
  for (const price of appPrices) {
    const territoryRel = price.relationships?.['territory']?.data;
    const pointRel = price.relationships?.['appPricePoint']?.data;
    const territoryId = territoryRel && !Array.isArray(territoryRel) ? territoryRel.id : undefined;
    const pricePointId = pointRel && !Array.isArray(pointRel) ? pointRel.id : undefined;
    if (!territoryId || !pricePointId) continue;
    entries.push({ territoryId, pricePointId });
  }

  // Fan out: one fetch per unique territory to resolve point amounts. Apple's
  // appPriceSchedule endpoint won't return the amounts inline so we have to.
  const uniqueTerritories = Array.from(new Set(entries.map((e) => e.territoryId)));
  const pointsByTerritory = new Map<string, Map<string, { amount: number; currency: string }>>();
  const fetched = await Promise.allSettled(
    uniqueTerritories.map((t) => fetchAppPricePointsForTerritoryWithCurrency(client, appId, t)),
  );
  for (let i = 0; i < uniqueTerritories.length; i++) {
    const res = fetched[i];
    if (!res || res.status !== 'fulfilled') continue;
    const territoryId = uniqueTerritories[i];
    if (!territoryId) continue;
    pointsByTerritory.set(territoryId, res.value);
  }

  const out = new Map<string, { amount: number; territory: string; currency: string }>();
  for (const e of entries) {
    const points = pointsByTerritory.get(e.territoryId);
    const point = points?.get(e.pricePointId);
    if (!point) continue;
    out.set(e.territoryId, {
      amount: point.amount,
      territory: e.territoryId,
      currency: point.currency,
    });
  }
  return out;
}

// Returns a (pricePointId → {amount, currency}) map for one territory. Used
// both by fetchCurrentAppPriceMap (to resolve current amounts) and by the
// pending phase (to find the snap targets).
async function fetchAppPricePointsForTerritoryWithCurrency(
  client: ASCClient,
  appId: string,
  territoryId: string,
): Promise<Map<string, { amount: number; currency: string }>> {
  const params = new URLSearchParams();
  params.set('filter[territory]', territoryId);
  params.set('include', 'territory');
  params.set('fields[appPricePoints]', 'customerPrice');
  params.set('fields[territories]', 'currency');
  params.set('limit', '200');
  const pages = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/appPricePoints?${params.toString()}`,
    5000,
  );
  const territoryResource = pages.included.find(
    (r) => r.type === 'territories' && r.id === territoryId,
  );
  const currency = (territoryResource?.attributes?.['currency'] as string | undefined) ?? '';
  const out = new Map<string, { amount: number; currency: string }>();
  for (const p of pages.data) {
    const amt = parseDecimal(p.attributes?.['customerPrice'] as string | undefined);
    if (amt === undefined) continue;
    out.set(p.id, { amount: amt, currency });
  }
  return out;
}

async function fetchAppPricePointsForTerritory(
  client: ASCClient,
  appId: string,
  territoryId: string,
): Promise<PricePointInfo[]> {
  const map = await fetchAppPricePointsForTerritoryWithCurrency(client, appId, territoryId);
  return Array.from(map.entries()).map(([id, { amount }]) => ({ id, amount }));
}

interface ComputeArgs {
  resourceType: ResourceType;
  resourceId: string;
  basePriceAnchor: number;
  anchorTerritory: string;
  roundStrategy: RoundStrategy;
  floorFactor: number;
  skipUnchanged: boolean;
  territories?: string[];
  skipMissingIndex: boolean;
}

async function computeProposal(client: ASCClient, args: ComputeArgs): Promise<ProposalContext> {
  const index = loadIndex();
  const indexMap = indexAsMap(index);
  const anchorEntry = indexMap.get(args.anchorTerritory);
  if (!anchorEntry) {
    throw new Error(
      `Anchor territory ${args.anchorTerritory} is not in the Apple Music index. Add it to data/apple-music-prices.json.`,
    );
  }

  // Dispatch the resource-specific fetchers. Subs and apps use different ASC
  // endpoints and different relationship names; we hide that behind these
  // closures so the rest of the pipeline doesn't care which it's pricing.
  const fetchCurrent =
    args.resourceType === 'subscription'
      ? () => fetchCurrentPriceMap(client, args.resourceId)
      : () => fetchCurrentAppPriceMap(client, args.resourceId);
  const fetchPoints =
    args.resourceType === 'subscription'
      ? (t: string) => fetchPricePointsForTerritory(client, args.resourceId, t)
      : (t: string) => fetchAppPricePointsForTerritory(client, args.resourceId, t);

  const currentPriceMap = await fetchCurrent();

  const targetTerritories = args.territories
    ? args.territories.map((t) => t.toUpperCase())
    : Array.from(currentPriceMap.keys());

  type Pending = {
    territoryId: string;
    targetLocal: number;
    current: number;
    currency: string;
    factor: number;
  };
  const pending: Pending[] = [];
  const rows: ProposalRow[] = [];

  for (const territoryId of targetTerritories) {
    const current = currentPriceMap.get(territoryId);
    if (!current) {
      rows.push({
        territory: territoryId,
        currency: '',
        currentLocal: undefined,
        factor: undefined,
        targetLocal: undefined,
        snappedAmount: undefined,
        snappedPointId: undefined,
        changePct: undefined,
        reason: 'no-current-price',
      });
      continue;
    }
    const indexEntry = indexMap.get(territoryId);
    if (!indexEntry) {
      if (args.skipMissingIndex) continue;
      rows.push({
        territory: territoryId,
        currency: current.currency,
        currentLocal: current.amount,
        factor: undefined,
        targetLocal: undefined,
        snappedAmount: undefined,
        snappedPointId: undefined,
        changePct: undefined,
        reason: 'no-index',
      });
      continue;
    }
    // Currency-mismatch guard. The Apple Music ratio is only a valid
    // PPP-FX signal when its denominator and the ASC billing currency
    // are the same — otherwise we'd multiply $X by a (foreign-currency
    // / USD) ratio and write the result back as USD, which is
    // dimensionally wrong. (Hit by USD-billed Gulf markets where Apple
    // Music is sold in BHD/KWD/OMR.)
    if (current.currency && indexEntry.currency && current.currency !== indexEntry.currency) {
      rows.push({
        territory: territoryId,
        currency: current.currency,
        currentLocal: current.amount,
        factor: undefined,
        targetLocal: undefined,
        snappedAmount: undefined,
        snappedPointId: undefined,
        changePct: undefined,
        reason: `currency-mismatch (asc=${current.currency}, am=${indexEntry.currency})`,
      });
      continue;
    }
    const factor = computeFactor(indexEntry.individualPrice, anchorEntry.individualPrice);
    const target = computeTarget(args.basePriceAnchor, factor);
    const flooredTarget = applyFloor(target, current.amount, args.floorFactor);
    pending.push({
      territoryId,
      targetLocal: flooredTarget,
      current: current.amount,
      currency: current.currency,
      factor,
    });
  }

  const pricePointResults = await Promise.allSettled(
    pending.map((p) =>
      fetchPoints(p.territoryId).then((pts) => ({
        territoryId: p.territoryId,
        points: pts,
      })),
    ),
  );

  const pointsByTerritory = new Map<string, PricePointInfo[]>();
  for (const result of pricePointResults) {
    if (result.status === 'fulfilled') {
      pointsByTerritory.set(result.value.territoryId, result.value.points);
    }
  }

  for (const p of pending) {
    const points = pointsByTerritory.get(p.territoryId) ?? [];
    if (points.length === 0) {
      rows.push({
        territory: p.territoryId,
        currency: p.currency,
        currentLocal: p.current,
        factor: p.factor,
        targetLocal: p.targetLocal,
        snappedAmount: undefined,
        snappedPointId: undefined,
        changePct: undefined,
        reason: 'no-price-points',
      });
      continue;
    }
    const snapped = snapToTier(
      p.targetLocal,
      points.map((pt) => pt.amount),
      args.roundStrategy,
    );
    if (snapped === undefined) {
      rows.push({
        territory: p.territoryId,
        currency: p.currency,
        currentLocal: p.current,
        factor: p.factor,
        targetLocal: p.targetLocal,
        snappedAmount: undefined,
        snappedPointId: undefined,
        changePct: undefined,
        reason: 'snap-failed',
      });
      continue;
    }
    const snappedPoint = points.find((pt) => pt.amount === snapped);
    const changePct = percentChange(p.current, snapped);
    const unchanged = snapped === p.current;
    if (unchanged && args.skipUnchanged) continue;
    rows.push({
      territory: p.territoryId,
      currency: p.currency,
      currentLocal: p.current,
      factor: p.factor,
      targetLocal: p.targetLocal,
      snappedAmount: snapped,
      snappedPointId: snappedPoint?.id,
      changePct,
      reason: unchanged ? 'unchanged' : 'change',
    });
  }

  rows.sort((a, b) => {
    const ai = a.changePct ?? 0;
    const bi = b.changePct ?? 0;
    return ai - bi;
  });

  return {
    rows,
    snapshot: index.snapshot,
    anchorTerritory: args.anchorTerritory,
    basePriceAnchor: args.basePriceAnchor,
    roundStrategy: args.roundStrategy,
    floorFactor: args.floorFactor,
  };
}

type PointIdMode = 'short' | 'full' | 'none';

function shortPointId(id: string | undefined): string {
  if (!id) return '';
  return id.length <= 10 ? id : `…${id.slice(-8)}`;
}

function renderProposalTable(
  ctx: ProposalContext,
  resourceLabel: string,
  options: { pointIdMode?: PointIdMode } = {},
): string {
  const pointIdMode = options.pointIdMode ?? 'short';
  const showPointId = pointIdMode !== 'none';

  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'CCY' },
    { header: 'CURRENT', align: 'right' },
    { header: 'TARGET', align: 'right' },
    { header: 'SNAPPED', align: 'right' },
    { header: 'Δ', align: 'right' },
    { header: 'FACTOR', align: 'right' },
    ...(showPointId ? [{ header: 'POINT_ID' } as Column] : []),
    { header: 'NOTE' },
  ];
  const tableRows = ctx.rows.map((r) => {
    const pointIdCell =
      pointIdMode === 'full' ? (r.snappedPointId ?? '') : shortPointId(r.snappedPointId);
    return [
      r.territory,
      r.currency,
      fmtMoney(r.currentLocal),
      fmtMoney(r.targetLocal),
      fmtMoney(r.snappedAmount),
      fmtPct(r.changePct),
      r.factor !== undefined ? r.factor.toFixed(3) : '',
      ...(showPointId ? [pointIdCell] : []),
      r.reason === 'change' ? '' : r.reason,
    ];
  });

  const changes = ctx.rows.filter((r) => r.reason === 'change').length;
  const drops = ctx.rows.filter((r) => (r.changePct ?? 0) < 0).length;
  const lifts = ctx.rows.filter((r) => (r.changePct ?? 0) > 0).length;
  const summary = `Proposal for ${resourceLabel}: ${changes} change${
    changes === 1 ? '' : 's'
  } (${drops} drops, ${lifts} lifts), anchor ${ctx.anchorTerritory}=${ctx.basePriceAnchor}, round=${
    ctx.roundStrategy
  }, floor=${ctx.floorFactor}, snapshot=${ctx.snapshot}`;
  return `${summary}\n\n${formatTable(columns, tableRows)}`;
}

/** Run async tasks with a fixed concurrency limit. Returns results in order. */
export async function concurrentMap<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function runWorker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await worker(item, i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runWorker);
  await Promise.all(workers);
  return results;
}

async function postSubscriptionPrice(
  client: ASCClient,
  args: {
    subscriptionId: string;
    territoryId: string;
    pricePointId: string;
    startDate: string;
    preserveCurrentPrice: boolean;
  },
): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  const body = {
    data: {
      type: 'subscriptionPrices',
      attributes: {
        startDate: args.startDate,
        preserveCurrentPrice: args.preserveCurrentPrice,
      },
      relationships: {
        subscription: { data: { type: 'subscriptions', id: args.subscriptionId } },
        subscriptionPricePoint: {
          data: { type: 'subscriptionPricePoints', id: args.pricePointId },
        },
        territory: { data: { type: 'territories', id: args.territoryId } },
      },
    },
  };
  try {
    const res = await client.request<{ data?: { id?: string } }>('/v1/subscriptionPrices', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res?.data?.id ? { ok: true, id: res.data.id } : { ok: true };
  } catch (err) {
    const e = err as { message?: string };
    return { ok: false, error: e.message ?? String(err) };
  }
}

interface ApplyResult {
  territory: string;
  pricePointId: string;
  status: 'applied' | 'failed';
  newPriceId?: string;
  error?: string;
}

export function registerPpp(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'ppp_load_index',
    {
      title: 'Load Apple Music PPP index',
      description:
        'Returns the bundled Apple Music Individual plan price snapshot used by the ppp_* tools. Refresh by editing data/apple-music-prices.json upstream.',
      inputSchema: {
        raw: z.boolean().default(false),
      },
    },
    async ({ raw }) => {
      const index = loadIndex();
      if (raw) {
        return { content: [{ type: 'text', text: JSON.stringify(index, null, 2) }] };
      }
      const columns: Column[] = [
        { header: 'TERR' },
        { header: 'CCY' },
        { header: 'AM_PRICE', align: 'right' },
      ];
      const rows = [...index.prices]
        .sort((a, b) => a.territory.localeCompare(b.territory))
        .map((p) => [p.territory, p.currency, fmtMoney(p.individualPrice)]);
      const text = `Apple Music index — snapshot ${index.snapshot}, anchor ${index.anchor}, ${index.prices.length} territories\n\n${formatTable(columns, rows)}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'ppp_compute_proposal',
    {
      title: 'Compute PPP rebalance proposal',
      description:
        'Compute a proposed per-territory price schedule using the bundled Apple Music index as the PPP signal. Read-only — does not write to App Store Connect. ' +
        'Works for subscriptions (resourceType: "subscription", default) and paid apps (resourceType: "app"). ' +
        'Pair with ppp_apply_proposal to schedule subscription changes; for apps, the proposed prices feed asc_post_app_price_schedule.',
      inputSchema: {
        resourceType: z
          .enum(['subscription', 'app'])
          .default('subscription')
          .describe('"subscription" (default) or "app" (paid non-subscription app).'),
        subscriptionId: SubscriptionIdSchema.optional().describe(
          'Required when resourceType="subscription".',
        ),
        appId: AppIdSchema.optional().describe(
          'Required when resourceType="app". App pricing fetches one HTTP call per unique territory in the schedule to resolve current amounts; expect ~30s wall time for a paid app with all territories materialized.',
        ),
        basePriceAnchor: z
          .number()
          .positive()
          .describe('Anchor-territory base price (e.g. 29.99 USD).'),
        anchorTerritory: z.string().length(3).default('USA'),
        roundStrategy: z.enum(['nearest', 'down', 'up']).default('nearest'),
        floorFactor: z
          .number()
          .min(0)
          .max(1)
          .default(0.15)
          .describe('Lower bound on the proposed price as a fraction of current. 0 disables.'),
        skipUnchanged: z
          .boolean()
          .default(true)
          .describe('Hide rows where the snapped target equals the current price.'),
        territories: z
          .array(z.string().length(3))
          .optional()
          .describe('Restrict the proposal to a subset of territories. Omit to compute all.'),
        skipMissingIndex: z
          .boolean()
          .default(true)
          .describe(
            'Skip territories for which Apple Music data is not in the bundled index. Set false to surface them as `no-index`.',
          ),
        raw: z.boolean().default(false),
      },
    },
    async (args) => {
      const resourceId = args.resourceType === 'subscription' ? args.subscriptionId : args.appId;
      if (!resourceId) {
        const expected = args.resourceType === 'subscription' ? 'subscriptionId' : 'appId';
        return {
          content: [
            {
              type: 'text',
              text: `Missing ${expected}. For resourceType="${args.resourceType}", pass ${expected}.`,
            },
          ],
          isError: true,
        };
      }
      const ctx = await computeProposal(client, {
        resourceType: args.resourceType,
        resourceId,
        basePriceAnchor: args.basePriceAnchor,
        anchorTerritory: args.anchorTerritory,
        roundStrategy: args.roundStrategy as RoundStrategy,
        floorFactor: args.floorFactor,
        skipUnchanged: args.skipUnchanged,
        ...(args.territories ? { territories: args.territories } : {}),
        skipMissingIndex: args.skipMissingIndex,
      });
      if (args.raw) {
        return {
          content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }],
        };
      }
      const label =
        args.resourceType === 'subscription' ? `subscription ${resourceId}` : `app ${resourceId}`;
      const table = renderProposalTable(ctx, label);
      const footer =
        args.resourceType === 'subscription'
          ? '\n\nDry-run only. To apply: call ppp_apply_proposal with the same args, or call asc_post_subscription_price per row using the POINT_IDs above.'
          : '\n\nDry-run only. To apply for apps: call asc_post_app_price_schedule with the appId, anchorTerritory as baseTerritory, and one price entry per row above (territory + POINT_ID). ppp_apply_proposal does not yet auto-apply for apps.';
      return { content: [{ type: 'text', text: `${table}${footer}` }] };
    },
  );

  server.registerTool(
    'ppp_apply_proposal',
    {
      title: 'Apply PPP rebalance proposal',
      description:
        'Compute a PPP rebalance proposal, then schedule the price changes against App Store Connect. ' +
        'Subscription-only for now — for apps, use ppp_compute_proposal({resourceType: "app", ...}) to get the table, then pass the rows to asc_post_app_price_schedule. ' +
        'By default, asks the user to confirm via MCP elicitation before any write. Pass confirm:true to bypass elicitation (useful when running under automation, or when the client does not support elicitation).',
      inputSchema: {
        resourceType: z
          .enum(['subscription', 'app'])
          .default('subscription')
          .describe(
            'Currently only "subscription" can be applied through this tool. "app" returns a pointer to asc_post_app_price_schedule.',
          ),
        subscriptionId: SubscriptionIdSchema.optional(),
        appId: AppIdSchema.optional(),
        basePriceAnchor: z.number().positive(),
        anchorTerritory: z.string().length(3).default('USA'),
        roundStrategy: z.enum(['nearest', 'down', 'up']).default('nearest'),
        floorFactor: z.number().min(0).max(1).default(0.15),
        territories: z.array(z.string().length(3)).optional(),
        skipMissingIndex: z.boolean().default(true),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
          .optional()
          .describe('Start date YYYY-MM-DD. Defaults to today + 7 days.'),
        preserveCurrentPrice: z
          .boolean()
          .default(true)
          .describe('Grandfather existing subscribers. Strongly recommended.'),
        maxConcurrency: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(2)
          .describe(
            'Parallel POSTs. Apple throttles writes globally (~50/min); the client retries on 429 with exponential backoff, so a low value avoids piling up retries.',
          ),
        maxDropPct: z
          .number()
          .min(0)
          .max(100)
          .default(90)
          .describe(
            'Refuse to apply if any row drops by more than this percentage. Sanity guard against bad index data.',
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            'Skip MCP elicitation and apply directly. Use only when the client lacks elicitation support, or in automation.',
          ),
      },
    },
    async (args) => {
      // App applies aren't automated yet — the whole-schedule-replace semantics
      // need a different code path (one POST vs N) and currency-mismatch +
      // base-territory-change guard rails. Until that ships, compute the
      // proposal here and return prices in a shape the user can pass directly
      // to asc_post_app_price_schedule.
      if (args.resourceType === 'app') {
        if (!args.appId) {
          return {
            content: [{ type: 'text', text: 'Missing appId. For resourceType="app", pass appId.' }],
            isError: true,
          };
        }
        const ctx = await computeProposal(client, {
          resourceType: 'app',
          resourceId: args.appId,
          basePriceAnchor: args.basePriceAnchor,
          anchorTerritory: args.anchorTerritory,
          roundStrategy: args.roundStrategy as RoundStrategy,
          floorFactor: args.floorFactor,
          skipUnchanged: true,
          ...(args.territories ? { territories: args.territories } : {}),
          skipMissingIndex: args.skipMissingIndex,
        });
        const writableRows = ctx.rows.filter(
          (r) => r.reason === 'change' && r.snappedPointId !== undefined,
        );
        const pricesPayload = writableRows.map((r) => ({
          territory: r.territory,
          pricePointId: r.snappedPointId as string,
        }));
        const table = renderProposalTable(ctx, `app ${args.appId}`);
        const apply = JSON.stringify(
          {
            appId: args.appId,
            baseTerritory: args.anchorTerritory,
            prices: pricesPayload,
            acknowledgeReplacesAll: true,
          },
          null,
          2,
        );
        return {
          content: [
            {
              type: 'text',
              text:
                `${table}\n\n` +
                `App PPP auto-apply not yet implemented. To schedule these prices, call asc_post_app_price_schedule with:\n\n${apply}\n\n` +
                `IMPORTANT: ${args.anchorTerritory} (used as baseTerritory) must appear in prices[] with no startDate, AND must currently be your app's base territory — otherwise add acknowledgeDeletesScheduledIfBaseChanges: true.`,
            },
          ],
        };
      }

      if (!args.subscriptionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'Missing subscriptionId. For resourceType="subscription", pass subscriptionId.',
            },
          ],
          isError: true,
        };
      }
      const subscriptionId = args.subscriptionId;
      const startDate = args.startDate ?? todayPlusDaysISO(7);
      const ctx = await computeProposal(client, {
        resourceType: 'subscription',
        resourceId: subscriptionId,
        basePriceAnchor: args.basePriceAnchor,
        anchorTerritory: args.anchorTerritory,
        roundStrategy: args.roundStrategy as RoundStrategy,
        floorFactor: args.floorFactor,
        skipUnchanged: true,
        ...(args.territories ? { territories: args.territories } : {}),
        skipMissingIndex: args.skipMissingIndex,
      });
      const writable = ctx.rows.filter(
        (r) => r.reason === 'change' && r.snappedPointId !== undefined,
      );

      if (writable.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${renderProposalTable(ctx, subscriptionId)}\n\nNothing to apply — no eligible rows. (Skipped: no-current-price, no-index, no-price-points, snap-failed, unchanged.)`,
            },
          ],
        };
      }

      const maxDropRow = writable.reduce<ProposalRow | undefined>((acc, r) => {
        if ((r.changePct ?? 0) >= 0) return acc;
        if (!acc || (r.changePct ?? 0) < (acc.changePct ?? 0)) return r;
        return acc;
      }, undefined);
      if (maxDropRow && Math.abs(maxDropRow.changePct ?? 0) > args.maxDropPct) {
        return {
          content: [
            {
              type: 'text',
              text: `${renderProposalTable(ctx, subscriptionId)}\n\nRefused to apply: ${maxDropRow.territory} drops by ${fmtPct(maxDropRow.changePct)}, which exceeds maxDropPct=${args.maxDropPct}. Either raise maxDropPct, restrict the run to specific territories, or refresh the Apple Music snapshot.`,
            },
          ],
        };
      }

      const changes = writable.length;
      const drops = writable.filter((r) => (r.changePct ?? 0) < 0).length;
      const lifts = writable.filter((r) => (r.changePct ?? 0) > 0).length;

      // Confirmation: try MCP elicitation first; if it fails or returns
      // !accept, honour the user's choice. confirm:true bypasses entirely.
      let confirmed = args.confirm;
      let confirmationSource: 'arg' | 'elicitation' | 'auto-fallback' = args.confirm
        ? 'arg'
        : 'auto-fallback';

      if (!confirmed) {
        try {
          const elicit = await server.server.elicitInput({
            message: `Apply ${changes} subscription price change${
              changes === 1 ? '' : 's'
            } (${drops} drop${drops === 1 ? '' : 's'}, ${lifts} lift${lifts === 1 ? '' : 's'})?\n\nSubscription: ${subscriptionId}\nStart date:    ${startDate}\nPreserve:      ${args.preserveCurrentPrice}\nLargest drop:  ${maxDropRow ? `${maxDropRow.territory} ${fmtPct(maxDropRow.changePct)}` : 'none'}\n\n${renderProposalTable(ctx, subscriptionId, { pointIdMode: 'none' })}`,
            requestedSchema: {
              type: 'object',
              properties: {
                acknowledge: {
                  type: 'boolean',
                  title: 'I have reviewed the proposal above',
                  description: 'Tick to enable Apply.',
                },
              },
              required: ['acknowledge'],
            },
          });
          if (elicit.action === 'accept' && elicit.content?.['acknowledge'] === true) {
            confirmed = true;
            confirmationSource = 'elicitation';
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: `${renderProposalTable(ctx, subscriptionId)}\n\nCancelled by user (${elicit.action}). No writes performed.`,
                },
              ],
            };
          }
        } catch {
          // Client doesn't support elicitation — surface the proposal and
          // tell the caller to re-run with confirm:true.
          return {
            content: [
              {
                type: 'text',
                text: `${renderProposalTable(ctx, subscriptionId)}\n\nClient does not support MCP elicitation. To apply, re-run with confirm: true (and the same args) — only after a human has reviewed the table above.`,
              },
            ],
          };
        }
      }

      // Apply.
      const applyResults = await concurrentMap(
        writable,
        args.maxConcurrency,
        async (row): Promise<ApplyResult> => {
          const result = await postSubscriptionPrice(client, {
            subscriptionId: subscriptionId,
            territoryId: row.territory,
            pricePointId: row.snappedPointId as string,
            startDate,
            preserveCurrentPrice: args.preserveCurrentPrice,
          });
          if (result.ok) {
            return {
              territory: row.territory,
              pricePointId: row.snappedPointId as string,
              status: 'applied',
              ...(result.id ? { newPriceId: result.id } : {}),
            };
          }
          return {
            territory: row.territory,
            pricePointId: row.snappedPointId as string,
            status: 'failed',
            error: result.error,
          };
        },
      );

      const succeeded = applyResults.filter((r) => r.status === 'applied');
      const failed = applyResults.filter((r) => r.status === 'failed');

      const resultColumns: Column[] = [
        { header: 'TERR' },
        { header: 'STATUS' },
        { header: 'PRICE_ID_OR_ERROR' },
      ];
      const resultRows = applyResults.map((r) => [
        r.territory,
        r.status,
        r.status === 'applied' ? (r.newPriceId ?? '') : (r.error ?? ''),
      ]);

      const summary = `Applied ${succeeded.length}/${changes} (failed ${failed.length}). Subscription ${subscriptionId}, start ${startDate}, confirmation via ${confirmationSource}.`;
      const text = `${summary}\n\n${formatTable(resultColumns, resultRows)}\n\nVerify with asc_list_subscription_prices — pending entries will have a non-null START_DATE.`;
      return { content: [{ type: 'text', text }] };
    },
  );
}
