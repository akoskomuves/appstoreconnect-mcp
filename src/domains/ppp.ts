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
import {
  AppIdSchema,
  CustomerEligibilitiesSchema,
  InAppPurchaseIdSchema,
  NumberOfPeriodsSchema,
  OfferCodeNameSchema,
  OfferCodeSchema,
  OfferModeSchema,
  OfferNameSchema,
  StartDateSchema,
  SubscriptionIdSchema,
  SubscriptionOfferDurationSchema,
} from '../schemas.js';
import { buildOfferCodeBody } from './offer-codes.js';
import { buildPromoOfferBody } from './promo-offers.js';

type ResourceType =
  | 'subscription'
  | 'app'
  | 'iap'
  | 'introductoryOffer'
  | 'promotionalOffer'
  | 'offerCode';

interface PricePointInfo {
  id: string;
  amount: number;
}

// Current-price record carries pointId so the apply path can build the
// active-now base-territory entry without a second read. Compute ignores it.
interface CurrentPrice {
  amount: number;
  territory: string;
  currency: string;
  pointId: string;
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
): Promise<Map<string, CurrentPrice>> {
  const path = `/v1/subscriptions/${encodeURIComponent(
    subscriptionId,
  )}/prices?include=subscriptionPricePoint,territory`;
  const pages = await paginate(client, path, 2000);
  const index = buildIncludedIndex(pages.included);
  const out = new Map<string, CurrentPrice>();
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
    out.set(territoryId, { amount, territory: territoryId, currency, pointId });
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
): Promise<Map<string, CurrentPrice>> {
  return fetchCurrentScheduleMap(client, {
    schedulePath: `/v1/apps/${encodeURIComponent(appId)}/appPriceSchedule`,
    pricesType: 'appPrices',
    pricePointRelKey: 'appPricePoint',
    fetchPoints: (t) => fetchAppPricePointsForTerritoryWithCurrency(client, appId, t),
  });
}

async function fetchCurrentIapPriceMap(
  client: ASCClient,
  iapId: string,
): Promise<Map<string, CurrentPrice>> {
  return fetchCurrentScheduleMap(client, {
    schedulePath: `/v2/inAppPurchases/${encodeURIComponent(iapId)}/iapPriceSchedule`,
    pricesType: 'inAppPurchasePrices',
    pricePointRelKey: 'inAppPurchasePricePoint',
    fetchPoints: (t) => fetchIapPricePointsForTerritoryWithCurrency(client, iapId, t),
  });
}

// Shared implementation behind fetchCurrentAppPriceMap / fetchCurrentIapPriceMap.
// Both Apple endpoints reject chained includes on the schedule resource, so
// price-point amounts have to be resolved via one fetch per unique territory.
async function fetchCurrentScheduleMap(
  client: ASCClient,
  cfg: {
    schedulePath: string;
    pricesType: string;
    pricePointRelKey: string;
    fetchPoints: (
      territoryId: string,
    ) => Promise<Map<string, { amount: number; currency: string }>>;
  },
): Promise<Map<string, CurrentPrice>> {
  const params = new URLSearchParams();
  params.set('include', 'manualPrices,automaticPrices,baseTerritory');
  const pages = await paginate(client, `${cfg.schedulePath}?${params.toString()}`, 2000);

  const priceResources = pages.included.filter((r) => r.type === cfg.pricesType);
  type Entry = { territoryId: string; pricePointId: string };
  const entries: Entry[] = [];
  for (const price of priceResources) {
    const territoryRel = price.relationships?.['territory']?.data;
    const pointRel = price.relationships?.[cfg.pricePointRelKey]?.data;
    const territoryId = territoryRel && !Array.isArray(territoryRel) ? territoryRel.id : undefined;
    const pricePointId = pointRel && !Array.isArray(pointRel) ? pointRel.id : undefined;
    if (!territoryId || !pricePointId) continue;
    entries.push({ territoryId, pricePointId });
  }

  const uniqueTerritories = Array.from(new Set(entries.map((e) => e.territoryId)));
  const pointsByTerritory = new Map<string, Map<string, { amount: number; currency: string }>>();
  const fetched = await Promise.allSettled(uniqueTerritories.map((t) => cfg.fetchPoints(t)));
  for (let i = 0; i < uniqueTerritories.length; i++) {
    const res = fetched[i];
    if (!res || res.status !== 'fulfilled') continue;
    const territoryId = uniqueTerritories[i];
    if (!territoryId) continue;
    pointsByTerritory.set(territoryId, res.value);
  }

  const out = new Map<string, CurrentPrice>();
  for (const e of entries) {
    const points = pointsByTerritory.get(e.territoryId);
    const point = points?.get(e.pricePointId);
    if (!point) continue;
    out.set(e.territoryId, {
      amount: point.amount,
      territory: e.territoryId,
      currency: point.currency,
      pointId: e.pricePointId,
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

// IAP analog of fetchAppPricePointsForTerritoryWithCurrency. Apple's IAP v2
// price-points endpoint sits at /v2/inAppPurchases/{id}/pricePoints and uses
// `inAppPurchasePricePoints` as the field-selector type name.
async function fetchIapPricePointsForTerritoryWithCurrency(
  client: ASCClient,
  iapId: string,
  territoryId: string,
): Promise<Map<string, { amount: number; currency: string }>> {
  const params = new URLSearchParams();
  params.set('filter[territory]', territoryId);
  params.set('include', 'territory');
  params.set('fields[inAppPurchasePricePoints]', 'customerPrice');
  params.set('fields[territories]', 'currency');
  params.set('limit', '200');
  const pages = await paginate(
    client,
    `/v2/inAppPurchases/${encodeURIComponent(iapId)}/pricePoints?${params.toString()}`,
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

async function fetchIapPricePointsForTerritory(
  client: ASCClient,
  iapId: string,
  territoryId: string,
): Promise<PricePointInfo[]> {
  const map = await fetchIapPricePointsForTerritoryWithCurrency(client, iapId, territoryId);
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

  // Dispatch the resource-specific fetchers. Subs, apps, and IAPs use different
  // ASC endpoints and relationship names; we hide that behind these closures so
  // the rest of the pipeline doesn't care which it's pricing.
  // Intro offers attach to a subscription, use the same per-territory price
  // points, and only make sense in territories where the parent sub is already
  // priced — so the fetchers are the subscription fetchers, parameterized on
  // the same resourceId (a subscriptionId in disguise). The Δ column then
  // reads "offer vs current sub price", which is the relevant comparison.
  const fetchCurrent = (() => {
    switch (args.resourceType) {
      case 'subscription':
      case 'introductoryOffer':
      case 'promotionalOffer':
      case 'offerCode':
        return () => fetchCurrentPriceMap(client, args.resourceId);
      case 'app':
        return () => fetchCurrentAppPriceMap(client, args.resourceId);
      case 'iap':
        return () => fetchCurrentIapPriceMap(client, args.resourceId);
    }
  })();
  const fetchPoints = (() => {
    switch (args.resourceType) {
      case 'subscription':
      case 'introductoryOffer':
      case 'promotionalOffer':
      case 'offerCode':
        return (t: string) => fetchPricePointsForTerritory(client, args.resourceId, t);
      case 'app':
        return (t: string) => fetchAppPricePointsForTerritory(client, args.resourceId, t);
      case 'iap':
        return (t: string) => fetchIapPricePointsForTerritory(client, args.resourceId, t);
    }
  })();

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

async function postIntroOffer(
  client: ASCClient,
  args: {
    subscriptionId: string;
    territoryId: string;
    pricePointId: string;
    offerMode: 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT';
    duration: string;
    startDate: string;
    endDate: string | undefined;
    numberOfPeriods: number | undefined;
  },
): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  const attributes: Record<string, unknown> = {
    startDate: args.startDate,
    duration: args.duration,
    offerMode: args.offerMode,
  };
  if (args.endDate !== undefined) attributes.endDate = args.endDate;
  if (args.offerMode === 'PAY_AS_YOU_GO' && args.numberOfPeriods !== undefined) {
    attributes.numberOfPeriods = args.numberOfPeriods;
  }
  const body = {
    data: {
      type: 'subscriptionIntroductoryOffers',
      attributes,
      relationships: {
        subscription: { data: { type: 'subscriptions', id: args.subscriptionId } },
        territory: { data: { type: 'territories', id: args.territoryId } },
        subscriptionPricePoint: {
          data: { type: 'subscriptionPricePoints', id: args.pricePointId },
        },
      },
    },
  };
  try {
    const res = await client.request<{ data?: { id?: string } }>(
      '/v1/subscriptionIntroductoryOffers',
      { method: 'POST', body: JSON.stringify(body) },
    );
    return res?.data?.id ? { ok: true, id: res.data.id } : { ok: true };
  } catch (err) {
    const e = err as { message?: string };
    return { ok: false, error: e.message ?? String(err) };
  }
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

// JSON:API wire names that differ between app and IAP price schedules. Keeping
// them in one config object so the body-builder reads as one shape.
interface ScheduleResourceConfig {
  // Endpoint to POST the schedule to (one shot, whole-schedule replace).
  postEndpoint: string;
  // Endpoint to GET the current schedule (to detect base-territory change).
  schedulePath: string;
  // JSON:API type of the schedule resource itself.
  scheduleType: string;
  // JSON:API type of the individual price rows.
  priceType: string;
  // JSON:API type for the price-point relationship.
  pointType: string;
  // Relationship name on the schedule pointing back at its owning resource
  // (`app` for appPriceSchedule, `inAppPurchase` for iapPriceSchedule).
  resourceRel: string;
  // JSON:API type of the owning resource.
  resourceType: string;
  // Relationship name on the inline price row pointing at the owning resource.
  // GOTCHA: IAPs use `inAppPurchaseV2` here even though the top-level rel on the
  // schedule is `inAppPurchase` (Apple's own spec inconsistency).
  priceResourceRel: string;
  // Relationship name on the inline price row pointing at the price-point.
  pricePointRel: string;
}

export const APP_SCHEDULE_CONFIG: ScheduleResourceConfig = {
  postEndpoint: '/v1/appPriceSchedules',
  schedulePath: '/v1/apps/{id}/appPriceSchedule',
  scheduleType: 'appPriceSchedules',
  priceType: 'appPrices',
  pointType: 'appPricePoints',
  resourceRel: 'app',
  resourceType: 'apps',
  priceResourceRel: 'app',
  pricePointRel: 'appPricePoint',
};

export const IAP_SCHEDULE_CONFIG: ScheduleResourceConfig = {
  postEndpoint: '/v1/inAppPurchasePriceSchedules',
  schedulePath: '/v2/inAppPurchases/{id}/iapPriceSchedule',
  scheduleType: 'inAppPurchasePriceSchedules',
  priceType: 'inAppPurchasePrices',
  pointType: 'inAppPurchasePricePoints',
  resourceRel: 'inAppPurchase',
  resourceType: 'inAppPurchases',
  priceResourceRel: 'inAppPurchaseV2',
  pricePointRel: 'inAppPurchasePricePoint',
};

interface SchedulePriceEntry {
  territory: string;
  pricePointId: string;
  startDate?: string;
}

// Build the JSON:API body for a whole-schedule replace POST. Apple expects the
// new price rows in `included[]` with temp IDs (`${1}`-style placeholders are
// the documented convention for unsaved resources); each is referenced by the
// schedule's `manualPrices` relationship array.
export function buildScheduleBody(
  cfg: ScheduleResourceConfig,
  resourceId: string,
  baseTerritory: string,
  prices: SchedulePriceEntry[],
): unknown {
  const included = prices.map((p, i) => ({
    type: cfg.priceType,
    id: `\${${i + 1}}`,
    attributes: {
      ...(p.startDate ? { startDate: p.startDate } : {}),
    },
    relationships: {
      [cfg.priceResourceRel]: { data: { type: cfg.resourceType, id: resourceId } },
      [cfg.pricePointRel]: { data: { type: cfg.pointType, id: p.pricePointId } },
      territory: { data: { type: 'territories', id: p.territory } },
    },
  }));
  return {
    data: {
      type: cfg.scheduleType,
      attributes: {},
      relationships: {
        [cfg.resourceRel]: { data: { type: cfg.resourceType, id: resourceId } },
        baseTerritory: { data: { type: 'territories', id: baseTerritory } },
        manualPrices: {
          data: included.map((r) => ({ type: cfg.priceType, id: r.id })),
        },
      },
    },
    included,
  };
}

async function fetchCurrentBaseTerritory(
  client: ASCClient,
  cfg: ScheduleResourceConfig,
  resourceId: string,
): Promise<string | undefined> {
  const path = `${cfg.schedulePath.replace('{id}', encodeURIComponent(resourceId))}?include=baseTerritory`;
  const current = await client.request<{
    data: { relationships?: { baseTerritory?: { data?: { id?: string } } } };
  }>(path);
  return current.data.relationships?.baseTerritory?.data?.id;
}

interface ApplyScheduleArgs {
  resourceType: 'app' | 'iap';
  resourceId: string;
  basePriceAnchor: number;
  anchorTerritory: string;
  baseTerritory: string;
  roundStrategy: RoundStrategy;
  floorFactor: number;
  territories?: string[];
  skipMissingIndex: boolean;
  startDate: string;
  maxDropPct: number;
  confirm: boolean;
  acknowledgeDeletesScheduledIfBaseChanges: boolean;
}

async function applyWholeSchedule(server: McpServer, client: ASCClient, args: ApplyScheduleArgs) {
  const cfg = args.resourceType === 'app' ? APP_SCHEDULE_CONFIG : IAP_SCHEDULE_CONFIG;
  const label = `${args.resourceType} ${args.resourceId}`;

  // The proposal already pulls the current price map. We need it again below to
  // resolve the active-now base-territory entry's price-point ID when the base
  // isn't part of `writable` (typical case: the anchor price didn't change).
  const fetchCurrent =
    args.resourceType === 'app'
      ? () => fetchCurrentAppPriceMap(client, args.resourceId)
      : () => fetchCurrentIapPriceMap(client, args.resourceId);
  const currentPriceMap = await fetchCurrent();

  const ctx = await computeProposal(client, {
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    basePriceAnchor: args.basePriceAnchor,
    anchorTerritory: args.anchorTerritory,
    roundStrategy: args.roundStrategy,
    floorFactor: args.floorFactor,
    skipUnchanged: true,
    ...(args.territories ? { territories: args.territories } : {}),
    skipMissingIndex: args.skipMissingIndex,
  });

  const writable = ctx.rows.filter((r) => r.reason === 'change' && r.snappedPointId !== undefined);
  if (writable.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nNothing to apply — no eligible rows.`,
        },
      ],
    };
  }

  // maxDropPct guardrail (same as subs).
  const maxDropRow = writable.reduce<ProposalRow | undefined>((acc, r) => {
    if ((r.changePct ?? 0) >= 0) return acc;
    if (!acc || (r.changePct ?? 0) < (acc.changePct ?? 0)) return r;
    return acc;
  }, undefined);
  if (maxDropRow && Math.abs(maxDropRow.changePct ?? 0) > args.maxDropPct) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nRefused to apply: ${maxDropRow.territory} drops by ${fmtPct(maxDropRow.changePct)}, which exceeds maxDropPct=${args.maxDropPct}. Either raise maxDropPct, restrict the run to specific territories, or refresh the Apple Music snapshot.`,
        },
      ],
    };
  }

  // Base-territory change detection. Apple wipes pending scheduled price
  // changes when the base territory changes — a footgun this tool exists to
  // prevent, so we require explicit acknowledgement.
  let currentBaseId: string | undefined;
  try {
    currentBaseId = await fetchCurrentBaseTerritory(client, cfg, args.resourceId);
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nPre-flight failed: couldn't read current schedule to check baseTerritory.\n\n${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
  if (
    currentBaseId &&
    currentBaseId !== args.baseTerritory &&
    !args.acknowledgeDeletesScheduledIfBaseChanges
  ) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nRefused to apply: changing baseTerritory from ${currentBaseId} → ${args.baseTerritory} deletes any pending scheduled price changes (Apple behavior). Pass acknowledgeDeletesScheduledIfBaseChanges: true to proceed.`,
        },
      ],
      isError: true,
    };
  }

  // Build the schedule payload. Apple requires an active-now (no startDate)
  // entry for baseTerritory. If the base is in the proposal as a change, use
  // the snapped point with no startDate; otherwise pull its current point ID
  // from the schedule and keep the current price.
  const baseProposalRow = writable.find((r) => r.territory === args.baseTerritory);
  let basePricePointId: string | undefined;
  if (baseProposalRow) {
    basePricePointId = baseProposalRow.snappedPointId;
  } else {
    basePricePointId = currentPriceMap.get(args.baseTerritory)?.pointId;
  }
  if (!basePricePointId) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nRefused to apply: couldn't resolve a price-point ID for baseTerritory=${args.baseTerritory}. The base territory must either be in the proposal (as a change) or have a current price in the schedule. Pass a different baseTerritory or set basePriceAnchor so the base territory is included.`,
        },
      ],
      isError: true,
    };
  }
  const scheduleEntries: SchedulePriceEntry[] = [];
  // Active-now base entry first.
  scheduleEntries.push({
    territory: args.baseTerritory,
    pricePointId: basePricePointId,
  });
  // All other writable rows, with startDate.
  for (const r of writable) {
    if (r.territory === args.baseTerritory) continue;
    scheduleEntries.push({
      territory: r.territory,
      pricePointId: r.snappedPointId as string,
      startDate: args.startDate,
    });
  }

  const changes = writable.length;
  const drops = writable.filter((r) => (r.changePct ?? 0) < 0).length;
  const lifts = writable.filter((r) => (r.changePct ?? 0) > 0).length;

  // Confirmation flow mirrors the subscription path. Try elicitation; fall
  // back to confirm:true; otherwise tell the caller to re-run.
  let confirmed = args.confirm;
  let confirmationSource: 'arg' | 'elicitation' = args.confirm ? 'arg' : 'arg';
  if (!confirmed) {
    try {
      const elicit = await server.server.elicitInput({
        message: `Replace the entire ${args.resourceType} price schedule for ${args.resourceId} with ${scheduleEntries.length} entries (${changes} change${
          changes === 1 ? '' : 's'
        }: ${drops} drop${drops === 1 ? '' : 's'}, ${lifts} lift${lifts === 1 ? '' : 's'})?\n\nBase territory:  ${args.baseTerritory}${currentBaseId && currentBaseId !== args.baseTerritory ? ` (was ${currentBaseId} — pending changes will be deleted)` : ''}\nStart date:      ${args.startDate}\nLargest drop:    ${maxDropRow ? `${maxDropRow.territory} ${fmtPct(maxDropRow.changePct)}` : 'none'}\n\nWARNING: this REPLACES the entire schedule. Any manual override or pending price change not in the proposal will be wiped. ${args.resourceType === 'app' ? 'Apps' : 'IAPs'} have no grandfather mechanism — new prices activate atomically at each entry's startDate.\n\n${renderProposalTable(ctx, label, { pointIdMode: 'none' })}`,
        requestedSchema: {
          type: 'object',
          properties: {
            acknowledge: {
              type: 'boolean',
              title:
                'I have reviewed the proposal above and understand it REPLACES the entire schedule',
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
              type: 'text' as const,
              text: `${renderProposalTable(ctx, label)}\n\nCancelled by user (${elicit.action}). No writes performed.`,
            },
          ],
        };
      }
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${renderProposalTable(ctx, label)}\n\nClient does not support MCP elicitation. To apply, re-run with confirm: true (and the same args) — only after a human has reviewed the table above.`,
          },
        ],
      };
    }
  }

  // Single POST to the schedule endpoint. Apps and IAPs both fail or succeed
  // atomically — no partial writes to clean up.
  const body = buildScheduleBody(cfg, args.resourceId, args.baseTerritory, scheduleEntries);
  try {
    await client.request<unknown>(cfg.postEndpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nApply failed: ${msg}`,
        },
      ],
      isError: true,
    };
  }

  const summary = `Replaced ${args.resourceType} price schedule for ${args.resourceId}. ${scheduleEntries.length} entries written (${changes} from the proposal + 1 active-now base if separate), start ${args.startDate}, confirmation via ${confirmationSource}.`;
  return {
    content: [
      {
        type: 'text' as const,
        text: `${summary}\n\n${renderProposalTable(ctx, label)}\n\nVerify with ${args.resourceType === 'app' ? 'asc_list_app_prices' : 'asc_list_iap_prices'} — pending entries will have a non-null START_DATE.`,
      },
    ],
  };
}

interface ApplyIntroOfferArgs {
  subscriptionId: string;
  offerMode: 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT';
  duration: string;
  numberOfPeriods: number | undefined;
  endDate: string | undefined;
  basePriceAnchor: number;
  anchorTerritory: string;
  roundStrategy: RoundStrategy;
  floorFactor: number;
  territories?: string[];
  skipMissingIndex: boolean;
  startDate: string;
  maxConcurrency: number;
  maxDropPct: number;
  confirm: boolean;
}

async function applyIntroOfferProposal(
  server: McpServer,
  client: ASCClient,
  args: ApplyIntroOfferArgs,
) {
  const label = `${args.offerMode} introductory offer on subscription ${args.subscriptionId} (duration=${args.duration}${
    args.numberOfPeriods ? `, periods=${args.numberOfPeriods}` : ''
  })`;
  const ctx = await computeProposal(client, {
    resourceType: 'introductoryOffer',
    resourceId: args.subscriptionId,
    basePriceAnchor: args.basePriceAnchor,
    anchorTerritory: args.anchorTerritory,
    roundStrategy: args.roundStrategy,
    floorFactor: args.floorFactor,
    skipUnchanged: true,
    ...(args.territories ? { territories: args.territories } : {}),
    skipMissingIndex: args.skipMissingIndex,
  });

  const writable = ctx.rows.filter((r) => r.reason === 'change' && r.snappedPointId !== undefined);
  if (writable.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nNothing to apply — no eligible rows.`,
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
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nRefused to apply: ${maxDropRow.territory} drops by ${fmtPct(maxDropRow.changePct)}, which exceeds maxDropPct=${args.maxDropPct}. Either raise maxDropPct, restrict the run to specific territories, or refresh the Apple Music snapshot.`,
        },
      ],
    };
  }

  const changes = writable.length;
  const drops = writable.filter((r) => (r.changePct ?? 0) < 0).length;
  const lifts = writable.filter((r) => (r.changePct ?? 0) > 0).length;

  let confirmed = args.confirm;
  let confirmationSource: 'arg' | 'elicitation' = args.confirm ? 'arg' : 'arg';
  if (!confirmed) {
    try {
      const elicit = await server.server.elicitInput({
        message: `Create ${changes} introductory offer${
          changes === 1 ? '' : 's'
        } (${drops} cheaper-than-sub, ${lifts} pricier-than-sub vs current base sub price)?\n\nSubscription:    ${args.subscriptionId}\nMode:            ${args.offerMode}\nDuration:        ${args.duration}${args.numberOfPeriods ? ` × ${args.numberOfPeriods} periods` : ''}\nStart date:      ${args.startDate}${args.endDate ? `\nEnd date:        ${args.endDate}` : ''}\nLargest Δ:       ${maxDropRow ? `${maxDropRow.territory} ${fmtPct(maxDropRow.changePct)}` : 'none'}\n\nNote: each row creates a new offer. Apple returns 409 if an active offer already exists for the (sub, territory) cell — those will show as failed in the result table; pre-existing offers are not modified.\n\n${renderProposalTable(ctx, label, { pointIdMode: 'none' })}`,
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
              type: 'text' as const,
              text: `${renderProposalTable(ctx, label)}\n\nCancelled by user (${elicit.action}). No writes performed.`,
            },
          ],
        };
      }
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${renderProposalTable(ctx, label)}\n\nClient does not support MCP elicitation. To apply, re-run with confirm: true (and the same args) — only after a human has reviewed the table above.`,
          },
        ],
      };
    }
  }

  const applyResults = await concurrentMap(
    writable,
    args.maxConcurrency,
    async (row): Promise<ApplyResult> => {
      const result = await postIntroOffer(client, {
        subscriptionId: args.subscriptionId,
        territoryId: row.territory,
        pricePointId: row.snappedPointId as string,
        offerMode: args.offerMode,
        duration: args.duration,
        startDate: args.startDate,
        endDate: args.endDate,
        numberOfPeriods: args.numberOfPeriods,
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
    { header: 'OFFER_ID_OR_ERROR' },
  ];
  const resultRows = applyResults.map((r) => [
    r.territory,
    r.status,
    r.status === 'applied' ? (r.newPriceId ?? '') : (r.error ?? ''),
  ]);

  const summary = `Created ${succeeded.length}/${changes} introductory offer${
    changes === 1 ? '' : 's'
  } (failed ${failed.length}). Subscription ${args.subscriptionId}, mode ${args.offerMode}, start ${args.startDate}, confirmation via ${confirmationSource}.`;
  const text = `${summary}\n\n${formatTable(resultColumns, resultRows)}\n\nVerify with asc_list_subscription_introductory_offers ${args.subscriptionId}.`;
  return { content: [{ type: 'text' as const, text }] };
}

interface ApplyPromoOfferArgs {
  subscriptionId: string;
  offerMode: 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT';
  duration: string;
  numberOfPeriods: number | undefined;
  promoOfferName: string;
  promoOfferCode: string;
  basePriceAnchor: number;
  anchorTerritory: string;
  roundStrategy: RoundStrategy;
  floorFactor: number;
  territories?: string[];
  skipMissingIndex: boolean;
  maxDropPct: number;
  confirm: boolean;
}

async function applyPromoOfferProposal(
  server: McpServer,
  client: ASCClient,
  args: ApplyPromoOfferArgs,
) {
  const label = `${args.offerMode} promotional offer "${args.promoOfferCode}" on subscription ${args.subscriptionId} (duration=${args.duration}${
    args.numberOfPeriods ? `, periods=${args.numberOfPeriods}` : ''
  })`;

  // Pre-flight: refuse early if at the 10-offer cap or if offerCode collides.
  // Doing this before the compute saves the user from waiting for a PPP
  // proposal we're going to refuse to apply anyway. The fields[] selector
  // pins `offerCode` so the collision check can't silently no-op.
  try {
    const listParams = new URLSearchParams();
    listParams.set(
      'fields[subscriptionPromotionalOffers]',
      'offerCode,name,offerMode,duration,numberOfPeriods',
    );
    listParams.set('limit', '200');
    const existing = await paginate(
      client,
      `/v1/subscriptions/${encodeURIComponent(
        args.subscriptionId,
      )}/promotionalOffers?${listParams.toString()}`,
      200,
    );
    if (existing.data.length >= 10) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Refused: subscription ${args.subscriptionId} already has ${existing.data.length} promotional offers, at Apple's cap of 10. Delete an existing offer with asc_delete_subscription_promotional_offer before re-running PPP.`,
          },
        ],
        isError: true,
      };
    }
    const codeCollision = existing.data.find(
      (o) => o.attributes?.['offerCode'] === args.promoOfferCode,
    );
    if (codeCollision) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Refused: offerCode "${args.promoOfferCode}" is already in use by promo offer ${codeCollision.id} on this subscription. PPP for promotional offers is create-only — to rebalance an existing offer, delete it with asc_delete_subscription_promotional_offer and re-run, or pick a different offerCode.`,
          },
        ],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Pre-flight failed (could not list existing promo offers): ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }

  const ctx = await computeProposal(client, {
    resourceType: 'promotionalOffer',
    resourceId: args.subscriptionId,
    basePriceAnchor: args.basePriceAnchor,
    anchorTerritory: args.anchorTerritory,
    roundStrategy: args.roundStrategy,
    floorFactor: args.floorFactor,
    skipUnchanged: false, // a "no Δ" row is still a price the new offer needs
    ...(args.territories ? { territories: args.territories } : {}),
    skipMissingIndex: args.skipMissingIndex,
  });

  // Writable here = rows we have a snapped price-point for. Unlike subs/intro
  // offers, "no change" rows still need to be written (the new offer has no
  // existing prices — every territory in the proposal is a creation).
  const writable = ctx.rows.filter((r) => r.snappedPointId !== undefined);
  if (writable.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nNothing to create — no eligible rows had a resolvable price point.`,
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
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nRefused to apply: ${maxDropRow.territory} drops by ${fmtPct(maxDropRow.changePct)}, which exceeds maxDropPct=${args.maxDropPct}. Either raise maxDropPct, restrict the run to specific territories, or refresh the Apple Music snapshot.`,
        },
      ],
    };
  }

  const drops = writable.filter((r) => (r.changePct ?? 0) < 0).length;
  const lifts = writable.filter((r) => (r.changePct ?? 0) > 0).length;

  let confirmed = args.confirm;
  let confirmationSource: 'arg' | 'elicitation' = args.confirm ? 'arg' : 'arg';
  if (!confirmed) {
    try {
      const elicit = await server.server.elicitInput({
        message: `Create promotional offer "${args.promoOfferCode}" (${args.promoOfferName}) with ${writable.length} per-territory price${
          writable.length === 1 ? '' : 's'
        } (${drops} cheaper-than-sub, ${lifts} pricier-than-sub vs current base sub price)?\n\nSubscription:    ${args.subscriptionId}\nMode:            ${args.offerMode}\nDuration:        ${args.duration}${args.numberOfPeriods ? ` × ${args.numberOfPeriods} periods` : ''}\nLargest Δ:       ${maxDropRow ? `${maxDropRow.territory} ${fmtPct(maxDropRow.changePct)}` : 'none'}\n\nNote: this is one atomic POST. The offer + all listed prices either all land or none do. After creation, only the prices can be PATCHed — name/code/mode/duration are immutable.\n\n${renderProposalTable(ctx, label, { pointIdMode: 'none' })}`,
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
              type: 'text' as const,
              text: `${renderProposalTable(ctx, label)}\n\nCancelled by user (${elicit.action}). No writes performed.`,
            },
          ],
        };
      }
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${renderProposalTable(ctx, label)}\n\nClient does not support MCP elicitation. To apply, re-run with confirm: true (and the same args) — only after a human has reviewed the table above.`,
          },
        ],
      };
    }
  }

  // Build and send the single atomic POST.
  const body = buildPromoOfferBody({
    subscriptionId: args.subscriptionId,
    name: args.promoOfferName,
    offerCode: args.promoOfferCode,
    offerMode: args.offerMode,
    duration: args.duration as Parameters<typeof buildPromoOfferBody>[0]['duration'],
    numberOfPeriods: args.numberOfPeriods,
    prices: writable.map((r) => ({
      territoryId: r.territory,
      pricePointId: r.snappedPointId as string,
    })),
  });

  let createdOfferId: string | undefined;
  try {
    const res = await client.request<{ data?: { id?: string } }>(
      '/v1/subscriptionPromotionalOffers',
      { method: 'POST', body: JSON.stringify(body) },
    );
    createdOfferId = res?.data?.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nApply failed: ${msg}`,
        },
      ],
      isError: true,
    };
  }

  const summary = `Created promotional offer ${createdOfferId ?? '(id unknown)'} on subscription ${args.subscriptionId}: code="${args.promoOfferCode}", name="${args.promoOfferName}", ${writable.length} per-territory price${
    writable.length === 1 ? '' : 's'
  }, confirmation via ${confirmationSource}.`;
  return {
    content: [
      {
        type: 'text' as const,
        text: `${summary}\n\n${renderProposalTable(ctx, label)}\n\nVerify with asc_get_subscription_promotional_offer ${createdOfferId ?? '<id>'} or asc_list_subscription_promotional_offer_prices ${createdOfferId ?? '<id>'}.`,
      },
    ],
  };
}

interface ApplyOfferCodeArgs {
  subscriptionId: string;
  offerCodeName: string;
  customerEligibilities: Array<'NEW' | 'EXISTING' | 'EXPIRED'>;
  offerMode: 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT';
  duration: string;
  numberOfPeriods: number | undefined;
  basePriceAnchor: number;
  anchorTerritory: string;
  roundStrategy: RoundStrategy;
  floorFactor: number;
  territories?: string[];
  skipMissingIndex: boolean;
  maxDropPct: number;
  confirm: boolean;
}

async function applyOfferCodeProposal(
  server: McpServer,
  client: ASCClient,
  args: ApplyOfferCodeArgs,
) {
  const label = `${args.offerMode} offer-code campaign "${args.offerCodeName}" on subscription ${args.subscriptionId} (duration=${args.duration}${
    args.numberOfPeriods ? `, periods=${args.numberOfPeriods}` : ''
  }, eligibilities=${args.customerEligibilities.join('+')})`;

  // Pre-flight: refuse at the 10-campaign cap or on a name collision. Same
  // shape as promo offers, except the uniqueness key on offer codes is
  // `name` rather than `offerCode`. Pinning fields[] keeps the collision
  // check honest against sparse-fieldset defaults shifting.
  try {
    const listParams = new URLSearchParams();
    listParams.set(
      'fields[subscriptionOfferCodes]',
      'name,customerEligibilities,offerMode,duration,numberOfPeriods,active',
    );
    listParams.set('limit', '200');
    const existing = await paginate(
      client,
      `/v1/subscriptions/${encodeURIComponent(
        args.subscriptionId,
      )}/subscriptionOfferCodes?${listParams.toString()}`,
      200,
    );
    if (existing.data.length >= 10) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Refused: subscription ${args.subscriptionId} already has ${existing.data.length} offer-code campaigns, at Apple's cap of 10. Delete an existing campaign with asc_delete_subscription_offer_code before re-running PPP.`,
          },
        ],
        isError: true,
      };
    }
    const nameCollision = existing.data.find((o) => o.attributes?.['name'] === args.offerCodeName);
    if (nameCollision) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Refused: campaign name "${args.offerCodeName}" is already in use by offer code ${nameCollision.id} on this subscription. PPP for offer codes is create-only (per-territory prices are immutable post-create) — to rebalance, delete the existing campaign with asc_delete_subscription_offer_code and re-run, or pick a different name.`,
          },
        ],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Pre-flight failed (could not list existing offer-code campaigns): ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }

  const ctx = await computeProposal(client, {
    resourceType: 'offerCode',
    resourceId: args.subscriptionId,
    basePriceAnchor: args.basePriceAnchor,
    anchorTerritory: args.anchorTerritory,
    roundStrategy: args.roundStrategy,
    floorFactor: args.floorFactor,
    skipUnchanged: false, // a "no Δ" row is still a price the new campaign needs
    ...(args.territories ? { territories: args.territories } : {}),
    skipMissingIndex: args.skipMissingIndex,
  });

  // Like promo offers: every snappable row is a creation, since the
  // campaign starts with no prices.
  const writable = ctx.rows.filter((r) => r.snappedPointId !== undefined);
  if (writable.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nNothing to create — no eligible rows had a resolvable price point.`,
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
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nRefused to apply: ${maxDropRow.territory} drops by ${fmtPct(maxDropRow.changePct)}, which exceeds maxDropPct=${args.maxDropPct}. Either raise maxDropPct, restrict the run to specific territories, or refresh the Apple Music snapshot.`,
        },
      ],
    };
  }

  const drops = writable.filter((r) => (r.changePct ?? 0) < 0).length;
  const lifts = writable.filter((r) => (r.changePct ?? 0) > 0).length;

  let confirmed = args.confirm;
  let confirmationSource: 'arg' | 'elicitation' = args.confirm ? 'arg' : 'arg';
  if (!confirmed) {
    try {
      const elicit = await server.server.elicitInput({
        message: `Create offer-code campaign "${args.offerCodeName}" with ${writable.length} per-territory price${
          writable.length === 1 ? '' : 's'
        } (${drops} cheaper-than-sub, ${lifts} pricier-than-sub vs current base sub price)?\n\nSubscription:    ${args.subscriptionId}\nEligibilities:   ${args.customerEligibilities.join(', ')}\nMode:            ${args.offerMode}\nDuration:        ${args.duration}${args.numberOfPeriods ? ` × ${args.numberOfPeriods} periods` : ''}\nLargest Δ:       ${maxDropRow ? `${maxDropRow.territory} ${fmtPct(maxDropRow.changePct)}` : 'none'}\n\nNote: one atomic POST. The campaign + all listed prices either all land or none do. After creation, name/eligibilities/mode/duration/prices are all immutable — only the active flag can be PATCHed. Generate redeemable codes afterwards with asc_post_subscription_offer_code_one_time_use_codes.\n\n${renderProposalTable(ctx, label, { pointIdMode: 'none' })}`,
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
              type: 'text' as const,
              text: `${renderProposalTable(ctx, label)}\n\nCancelled by user (${elicit.action}). No writes performed.`,
            },
          ],
        };
      }
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${renderProposalTable(ctx, label)}\n\nClient does not support MCP elicitation. To apply, re-run with confirm: true (and the same args) — only after a human has reviewed the table above.`,
          },
        ],
      };
    }
  }

  const body = buildOfferCodeBody({
    subscriptionId: args.subscriptionId,
    name: args.offerCodeName,
    customerEligibilities: args.customerEligibilities,
    offerMode: args.offerMode,
    duration: args.duration as Parameters<typeof buildOfferCodeBody>[0]['duration'],
    numberOfPeriods: args.numberOfPeriods,
    prices: writable.map((r) => ({
      territoryId: r.territory,
      pricePointId: r.snappedPointId as string,
    })),
  });

  let createdId: string | undefined;
  try {
    const res = await client.request<{ data?: { id?: string } }>('/v1/subscriptionOfferCodes', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    createdId = res?.data?.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text' as const,
          text: `${renderProposalTable(ctx, label)}\n\nApply failed: ${msg}`,
        },
      ],
      isError: true,
    };
  }

  const summary = `Created offer-code campaign ${createdId ?? '(id unknown)'} on subscription ${args.subscriptionId}: name="${args.offerCodeName}", eligibilities=${args.customerEligibilities.join('+')}, ${writable.length} per-territory price${
    writable.length === 1 ? '' : 's'
  }, confirmation via ${confirmationSource}.`;
  return {
    content: [
      {
        type: 'text' as const,
        text: `${summary}\n\n${renderProposalTable(ctx, label)}\n\nNext: generate redeemable codes with asc_post_subscription_offer_code_one_time_use_codes ${createdId ?? '<id>'} <numberOfCodes> <expirationDate>.`,
      },
    ],
  };
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
        'Works for subscriptions (resourceType: "subscription", default), paid apps (resourceType: "app"), IAPs (resourceType: "iap"), subscription introductory offers (resourceType: "introductoryOffer" — pass subscriptionId, offerMode, duration; PAY_AS_YOU_GO also needs numberOfPeriods), subscription promotional offers (resourceType: "promotionalOffer" — also needs promoOfferName and promoOfferCode), and subscription offer-code campaigns (resourceType: "offerCode" — also needs offerCodeName and customerEligibilities). FREE_TRIAL is rejected for offer types since there is no price to compute. ' +
        'Pair with ppp_apply_proposal to schedule changes.',
      inputSchema: {
        resourceType: z
          .enum([
            'subscription',
            'app',
            'iap',
            'introductoryOffer',
            'promotionalOffer',
            'offerCode',
          ])
          .default('subscription')
          .describe(
            '"subscription" (default), "app" (paid non-subscription app), "iap", "introductoryOffer" (PPP-aware per-territory introductory offers on a subscription), "promotionalOffer" (PPP-aware per-territory promotional offers — targets existing/lapsed subscribers), or "offerCode" (PPP-aware per-territory offer-code campaigns — customer-redeemed strings).',
          ),
        subscriptionId: SubscriptionIdSchema.optional().describe(
          'Required when resourceType="subscription", "introductoryOffer", "promotionalOffer", or "offerCode".',
        ),
        appId: AppIdSchema.optional().describe(
          'Required when resourceType="app". App pricing fetches one HTTP call per unique territory in the schedule to resolve current amounts; expect ~30s wall time for a paid app with all territories materialized.',
        ),
        iapId: InAppPurchaseIdSchema.optional().describe(
          'Required when resourceType="iap". Same fetch shape as apps — one HTTP call per unique territory to resolve current amounts.',
        ),
        offerMode: OfferModeSchema.optional().describe(
          'Required when resourceType="introductoryOffer" or "promotionalOffer". FREE_TRIAL is rejected for both — no price to compute. Use PAY_AS_YOU_GO or PAY_UP_FRONT.',
        ),
        duration: SubscriptionOfferDurationSchema.optional().describe(
          'Required when resourceType="introductoryOffer" or "promotionalOffer". The offer period length.',
        ),
        numberOfPeriods: NumberOfPeriodsSchema.optional().describe(
          'Required when offerMode="PAY_AS_YOU_GO" (for either offer type). Ignored otherwise.',
        ),
        promoOfferName: OfferNameSchema.optional().describe(
          'Required when resourceType="promotionalOffer". Display name in App Store Connect (immutable post-create).',
        ),
        promoOfferCode: OfferCodeSchema.optional().describe(
          'Required when resourceType="promotionalOffer". Unique per subscription; used by StoreKit as SubscriptionOffer.id. Immutable post-create.',
        ),
        offerCodeName: OfferCodeNameSchema.optional().describe(
          'Required when resourceType="offerCode". Campaign name (display + lookup key on the subscription). Immutable post-create.',
        ),
        customerEligibilities: CustomerEligibilitiesSchema.optional().describe(
          'Required when resourceType="offerCode". Subscriber cohorts allowed to redeem (NEW/EXISTING/EXPIRED). At least one. Immutable post-create.',
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
      const subBased =
        args.resourceType === 'subscription' ||
        args.resourceType === 'introductoryOffer' ||
        args.resourceType === 'promotionalOffer' ||
        args.resourceType === 'offerCode';
      const resourceId = subBased
        ? args.subscriptionId
        : args.resourceType === 'app'
          ? args.appId
          : args.iapId;
      if (!resourceId) {
        const expected = subBased
          ? 'subscriptionId'
          : args.resourceType === 'app'
            ? 'appId'
            : 'iapId';
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
      if (args.resourceType === 'offerCode') {
        if (!args.offerMode || !args.duration) {
          return {
            content: [
              {
                type: 'text',
                text: 'For resourceType="offerCode", pass offerMode and duration.',
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'FREE_TRIAL') {
          return {
            content: [
              {
                type: 'text',
                text: 'FREE_TRIAL has no price — PPP does not apply. Use asc_post_subscription_offer_code directly to create a free-trial offer-code campaign.',
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'PAY_AS_YOU_GO' && args.numberOfPeriods === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: 'numberOfPeriods is required when offerMode=PAY_AS_YOU_GO.',
              },
            ],
            isError: true,
          };
        }
        if (!args.offerCodeName || !args.customerEligibilities) {
          return {
            content: [
              {
                type: 'text',
                text: 'For resourceType="offerCode", pass offerCodeName and customerEligibilities (non-empty subset of NEW/EXISTING/EXPIRED).',
              },
            ],
            isError: true,
          };
        }
      }
      if (args.resourceType === 'introductoryOffer' || args.resourceType === 'promotionalOffer') {
        if (!args.offerMode || !args.duration) {
          return {
            content: [
              {
                type: 'text',
                text: `For resourceType="${args.resourceType}", pass offerMode and duration.`,
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'FREE_TRIAL') {
          const remedy =
            args.resourceType === 'introductoryOffer'
              ? 'Use asc_post_subscription_introductory_offer with territoryId omitted to create a single global free trial.'
              : 'Use asc_post_subscription_promotional_offer directly to create a free-trial promo offer.';
          return {
            content: [
              {
                type: 'text',
                text: `FREE_TRIAL has no price — PPP does not apply. ${remedy}`,
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'PAY_AS_YOU_GO' && args.numberOfPeriods === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: 'numberOfPeriods is required when offerMode=PAY_AS_YOU_GO.',
              },
            ],
            isError: true,
          };
        }
        if (
          args.resourceType === 'promotionalOffer' &&
          (!args.promoOfferName || !args.promoOfferCode)
        ) {
          return {
            content: [
              {
                type: 'text',
                text: 'For resourceType="promotionalOffer", pass promoOfferName and promoOfferCode.',
              },
            ],
            isError: true,
          };
        }
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
      const offerSuffix =
        args.numberOfPeriods !== undefined ? `, periods=${args.numberOfPeriods}` : '';
      const label =
        args.resourceType === 'introductoryOffer'
          ? `${args.offerMode} introductory offer on subscription ${resourceId} (duration=${args.duration}${offerSuffix})`
          : args.resourceType === 'promotionalOffer'
            ? `${args.offerMode} promotional offer "${args.promoOfferCode}" on subscription ${resourceId} (duration=${args.duration}${offerSuffix})`
            : args.resourceType === 'offerCode'
              ? `${args.offerMode} offer-code campaign "${args.offerCodeName}" on subscription ${resourceId} (duration=${args.duration}${offerSuffix}, eligibilities=${args.customerEligibilities?.join('+') ?? ''})`
              : `${args.resourceType} ${resourceId}`;
      const table = renderProposalTable(ctx, label);
      const footer =
        args.resourceType === 'introductoryOffer'
          ? '\n\nDry-run only. To apply: call ppp_apply_proposal with the same args (resourceType="introductoryOffer", subscriptionId, offerMode, duration, numberOfPeriods if PAY_AS_YOU_GO). One POST to /v1/subscriptionIntroductoryOffers per change row. The Δ column compares the snapped offer price to the current regular sub price, so a -50% Δ means the offer is half off.'
          : args.resourceType === 'promotionalOffer'
            ? '\n\nDry-run only. To apply: call ppp_apply_proposal with the same args (resourceType="promotionalOffer", subscriptionId, offerMode, duration, numberOfPeriods if PAY_AS_YOU_GO, promoOfferName, promoOfferCode). One atomic POST to /v1/subscriptionPromotionalOffers creates the offer + all per-territory prices. Refuses if offerCode collides with an existing offer or if the subscription is at Apple\'s 10-offer cap. The Δ column compares the snapped offer price to the current regular sub price.'
            : args.resourceType === 'offerCode'
              ? '\n\nDry-run only. To apply: call ppp_apply_proposal with the same args (resourceType="offerCode", subscriptionId, offerCodeName, customerEligibilities, offerMode, duration, numberOfPeriods if PAY_AS_YOU_GO). One atomic POST to /v1/subscriptionOfferCodes creates the campaign + all per-territory prices. Refuses if campaign name collides on the subscription or if at Apple\'s 10-campaign cap. After apply, generate redeemable strings with asc_post_subscription_offer_code_one_time_use_codes against the new campaign.'
              : '\n\nDry-run only. To apply: call ppp_apply_proposal with the same args. Subscriptions write per-row with preserveCurrentPrice; apps and IAPs do a single whole-schedule-replace POST.';
      return { content: [{ type: 'text', text: `${table}${footer}` }] };
    },
  );

  server.registerTool(
    'ppp_apply_proposal',
    {
      title: 'Apply PPP rebalance proposal',
      description:
        'Compute a PPP rebalance proposal, then schedule the price changes against App Store Connect. ' +
        'Works for subscriptions (per-territory POSTs with preserveCurrentPrice grandfathering), paid apps (one whole-schedule-replace POST — wipes any manual override or pending change not in the proposal), IAPs (same whole-schedule-replace semantics as apps), subscription introductory offers (one POST to /v1/subscriptionIntroductoryOffers per change row, paced at maxConcurrency), subscription promotional offers (single atomic POST to /v1/subscriptionPromotionalOffers creating the offer + all per-territory prices in one request), and subscription offer-code campaigns (single atomic POST to /v1/subscriptionOfferCodes creating the campaign + all per-territory prices). ' +
        "Apps and IAPs have NO grandfather mechanism — new prices activate atomically at each entry's startDate. " +
        'Intro offers are additions, not replacements — Apple may return 409 if an active offer already exists for a (sub, territory) cell. ' +
        'Promotional offers are create-only — refuses if offerCode collides with an existing offer on the sub. ' +
        'Offer-code campaigns are create-only — per-territory prices are immutable post-create; refuses if campaign name collides on the subscription or if at the 10-campaign cap. ' +
        'By default, asks the user to confirm via MCP elicitation before any write. Pass confirm:true to bypass elicitation (useful in automation, or when the client lacks elicitation support).',
      inputSchema: {
        resourceType: z
          .enum([
            'subscription',
            'app',
            'iap',
            'introductoryOffer',
            'promotionalOffer',
            'offerCode',
          ])
          .default('subscription'),
        subscriptionId: SubscriptionIdSchema.optional(),
        appId: AppIdSchema.optional(),
        iapId: InAppPurchaseIdSchema.optional(),
        offerMode: OfferModeSchema.optional().describe(
          'Required when resourceType="introductoryOffer", "promotionalOffer", or "offerCode". FREE_TRIAL is rejected.',
        ),
        duration: SubscriptionOfferDurationSchema.optional().describe(
          'Required when resourceType="introductoryOffer", "promotionalOffer", or "offerCode".',
        ),
        numberOfPeriods: NumberOfPeriodsSchema.optional().describe(
          'Required when offerMode="PAY_AS_YOU_GO" (for any offer type).',
        ),
        endDate: StartDateSchema.optional().describe(
          'Optional endDate (YYYY-MM-DD) for the introductory offers. Omit for open-ended. resourceType="introductoryOffer" only.',
        ),
        promoOfferName: OfferNameSchema.optional().describe(
          'Required when resourceType="promotionalOffer". Display name in ASC. Immutable post-create.',
        ),
        promoOfferCode: OfferCodeSchema.optional().describe(
          'Required when resourceType="promotionalOffer". Unique per subscription; StoreKit redemption identifier. Immutable post-create.',
        ),
        offerCodeName: OfferCodeNameSchema.optional().describe(
          'Required when resourceType="offerCode". Campaign name (display + uniqueness key on the subscription). Immutable post-create.',
        ),
        customerEligibilities: CustomerEligibilitiesSchema.optional().describe(
          'Required when resourceType="offerCode". Subscriber cohorts allowed to redeem (subset of NEW/EXISTING/EXPIRED). Immutable post-create.',
        ),
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
          .describe(
            'Subscriptions only — grandfather existing subscribers at their current price. Ignored for apps and IAPs (no Apple-side equivalent).',
          ),
        maxConcurrency: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(2)
          .describe(
            'Subscriptions only — parallel POSTs. Apple throttles writes (~50/min) and the client retries 429s with backoff, so a low value avoids piling up retries. Apps/IAPs always issue a single whole-schedule POST and ignore this.',
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
        baseTerritory: z
          .string()
          .length(3)
          .optional()
          .describe(
            "Apps/IAPs only — territory used as the active-now base in the new schedule. Defaults to anchorTerritory. If this differs from the resource's current base territory, you must also pass acknowledgeDeletesScheduledIfBaseChanges:true (Apple wipes pending scheduled changes on base-change).",
          ),
        acknowledgeDeletesScheduledIfBaseChanges: z
          .boolean()
          .default(false)
          .describe(
            "Apps/IAPs only — required true if baseTerritory differs from the resource's current base territory.",
          ),
      },
    },
    async (args) => {
      // Offer-code campaigns are atomic: one POST creates the campaign +
      // all per-territory prices in /v1/subscriptionOfferCodes. Per-territory
      // prices are immutable post-create (unlike promo offers, which permit a
      // PATCH on prices), so this is strictly create-only and there's no
      // "rebalance" path — to change prices, delete and re-run.
      if (args.resourceType === 'offerCode') {
        if (!args.subscriptionId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Missing subscriptionId. For resourceType="offerCode", pass subscriptionId.',
              },
            ],
            isError: true,
          };
        }
        if (
          !args.offerMode ||
          !args.duration ||
          !args.offerCodeName ||
          !args.customerEligibilities
        ) {
          return {
            content: [
              {
                type: 'text',
                text: 'For resourceType="offerCode", pass offerMode, duration, offerCodeName, and customerEligibilities.',
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'FREE_TRIAL') {
          return {
            content: [
              {
                type: 'text',
                text: 'FREE_TRIAL has no price — PPP does not apply. Use asc_post_subscription_offer_code directly for a free-trial offer-code campaign.',
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'PAY_AS_YOU_GO' && args.numberOfPeriods === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: 'numberOfPeriods is required when offerMode=PAY_AS_YOU_GO.',
              },
            ],
            isError: true,
          };
        }
        return applyOfferCodeProposal(server, client, {
          subscriptionId: args.subscriptionId,
          offerCodeName: args.offerCodeName,
          customerEligibilities: args.customerEligibilities,
          offerMode: args.offerMode,
          duration: args.duration,
          numberOfPeriods: args.numberOfPeriods,
          basePriceAnchor: args.basePriceAnchor,
          anchorTerritory: args.anchorTerritory,
          roundStrategy: args.roundStrategy as RoundStrategy,
          floorFactor: args.floorFactor,
          ...(args.territories ? { territories: args.territories } : {}),
          skipMissingIndex: args.skipMissingIndex,
          maxDropPct: args.maxDropPct,
          confirm: args.confirm,
        });
      }

      // Promotional offers are atomic: one POST creates the offer + all its
      // per-territory prices in /v1/subscriptionPromotionalOffers. No per-row
      // pacing because the whole offer succeeds or fails as a unit. Pre-flight
      // checks the 10-offer cap and refuses offerCode collisions before any
      // PPP work runs.
      if (args.resourceType === 'promotionalOffer') {
        if (!args.subscriptionId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Missing subscriptionId. For resourceType="promotionalOffer", pass subscriptionId.',
              },
            ],
            isError: true,
          };
        }
        if (!args.offerMode || !args.duration || !args.promoOfferName || !args.promoOfferCode) {
          return {
            content: [
              {
                type: 'text',
                text: 'For resourceType="promotionalOffer", pass offerMode, duration, promoOfferName, and promoOfferCode.',
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'FREE_TRIAL') {
          return {
            content: [
              {
                type: 'text',
                text: 'FREE_TRIAL has no price — PPP does not apply. Use asc_post_subscription_promotional_offer directly for a free-trial promo.',
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'PAY_AS_YOU_GO' && args.numberOfPeriods === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: 'numberOfPeriods is required when offerMode=PAY_AS_YOU_GO.',
              },
            ],
            isError: true,
          };
        }
        return applyPromoOfferProposal(server, client, {
          subscriptionId: args.subscriptionId,
          offerMode: args.offerMode,
          duration: args.duration,
          numberOfPeriods: args.numberOfPeriods,
          promoOfferName: args.promoOfferName,
          promoOfferCode: args.promoOfferCode,
          basePriceAnchor: args.basePriceAnchor,
          anchorTerritory: args.anchorTerritory,
          roundStrategy: args.roundStrategy as RoundStrategy,
          floorFactor: args.floorFactor,
          ...(args.territories ? { territories: args.territories } : {}),
          skipMissingIndex: args.skipMissingIndex,
          maxDropPct: args.maxDropPct,
          confirm: args.confirm,
        });
      }

      // Introductory offers attach to a subscription and use the per-row POST
      // pattern (one HTTP call per (sub, territory)), but to a different
      // endpoint — /v1/subscriptionIntroductoryOffers, not /subscriptionPrices.
      // No preserveCurrentPrice (doesn't apply); same 429-retry behaviour comes
      // from the underlying client.
      if (args.resourceType === 'introductoryOffer') {
        if (!args.subscriptionId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Missing subscriptionId. For resourceType="introductoryOffer", pass subscriptionId.',
              },
            ],
            isError: true,
          };
        }
        if (!args.offerMode || !args.duration) {
          return {
            content: [
              {
                type: 'text',
                text: 'For resourceType="introductoryOffer", pass offerMode and duration.',
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'FREE_TRIAL') {
          return {
            content: [
              {
                type: 'text',
                text: 'FREE_TRIAL has no price — PPP does not apply. Use asc_post_subscription_introductory_offer with territoryId omitted for a single global free trial.',
              },
            ],
            isError: true,
          };
        }
        if (args.offerMode === 'PAY_AS_YOU_GO' && args.numberOfPeriods === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: 'numberOfPeriods is required when offerMode=PAY_AS_YOU_GO.',
              },
            ],
            isError: true,
          };
        }
        return applyIntroOfferProposal(server, client, {
          subscriptionId: args.subscriptionId,
          offerMode: args.offerMode,
          duration: args.duration,
          numberOfPeriods: args.numberOfPeriods,
          endDate: args.endDate,
          basePriceAnchor: args.basePriceAnchor,
          anchorTerritory: args.anchorTerritory,
          roundStrategy: args.roundStrategy as RoundStrategy,
          floorFactor: args.floorFactor,
          ...(args.territories ? { territories: args.territories } : {}),
          skipMissingIndex: args.skipMissingIndex,
          startDate: args.startDate ?? todayPlusDaysISO(7),
          maxConcurrency: args.maxConcurrency,
          maxDropPct: args.maxDropPct,
          confirm: args.confirm,
        });
      }

      // Apps and IAPs share whole-schedule-replace semantics — one POST that
      // replaces the entire schedule, no per-row writes, no grandfather flag.
      if (args.resourceType === 'app' || args.resourceType === 'iap') {
        const isApp = args.resourceType === 'app';
        const resourceId = isApp ? args.appId : args.iapId;
        if (!resourceId) {
          const expected = isApp ? 'appId' : 'iapId';
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
        return applyWholeSchedule(server, client, {
          resourceType: args.resourceType,
          resourceId,
          basePriceAnchor: args.basePriceAnchor,
          anchorTerritory: args.anchorTerritory,
          baseTerritory: args.baseTerritory ?? args.anchorTerritory,
          roundStrategy: args.roundStrategy as RoundStrategy,
          floorFactor: args.floorFactor,
          ...(args.territories ? { territories: args.territories } : {}),
          skipMissingIndex: args.skipMissingIndex,
          startDate: args.startDate ?? todayPlusDaysISO(7),
          maxDropPct: args.maxDropPct,
          confirm: args.confirm,
          acknowledgeDeletesScheduledIfBaseChanges: args.acknowledgeDeletesScheduledIfBaseChanges,
        });
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
