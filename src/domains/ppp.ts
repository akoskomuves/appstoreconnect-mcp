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
import { SubscriptionIdSchema } from '../schemas.js';

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

export function registerPpp(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'ppp_load_index',
    {
      title: 'Load Apple Music PPP index',
      description:
        'Returns the bundled Apple Music Individual plan price snapshot used by ppp_compute_proposal. Refresh by editing data/apple-music-prices.json upstream.',
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
        'Compute a proposed per-territory price schedule for a subscription, using the bundled Apple Music index as the PPP signal. Read-only — does not write to App Store Connect. Drives an `apply` step via asc_post_subscription_price.',
      inputSchema: {
        subscriptionId: SubscriptionIdSchema,
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
      const {
        subscriptionId,
        basePriceAnchor,
        anchorTerritory,
        roundStrategy,
        floorFactor,
        skipUnchanged,
        territories,
        skipMissingIndex,
        raw,
      } = args;

      const index = loadIndex();
      const indexMap = indexAsMap(index);
      const anchorEntry = indexMap.get(anchorTerritory);
      if (!anchorEntry) {
        throw new Error(
          `Anchor territory ${anchorTerritory} is not in the Apple Music index. Add it to data/apple-music-prices.json.`,
        );
      }

      const currentPriceMap = await fetchCurrentPriceMap(client, subscriptionId);

      const targetTerritories = territories
        ? territories.map((t) => t.toUpperCase())
        : Array.from(currentPriceMap.keys());

      // Pre-compute targets and identify which territories need a price-points
      // fetch (skipping no-index ones up-front to save round-trips).
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
          if (skipMissingIndex) continue;
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
        const factor = computeFactor(indexEntry.individualPrice, anchorEntry.individualPrice);
        const target = computeTarget(basePriceAnchor, factor);
        const flooredTarget = applyFloor(target, current.amount, floorFactor);
        pending.push({
          territoryId,
          targetLocal: flooredTarget,
          current: current.amount,
          currency: current.currency,
          factor,
        });
      }

      // Fetch price points in parallel for every pending territory.
      const pricePointResults = await Promise.allSettled(
        pending.map((p) =>
          fetchPricePointsForTerritory(client, subscriptionId, p.territoryId).then((pts) => ({
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
          roundStrategy as RoundStrategy,
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
        if (unchanged && skipUnchanged) continue;
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

      if (raw) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  snapshot: index.snapshot,
                  anchor: anchorTerritory,
                  basePriceAnchor,
                  roundStrategy,
                  floorFactor,
                  rows,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const columns: Column[] = [
        { header: 'TERR' },
        { header: 'CCY' },
        { header: 'CURRENT', align: 'right' },
        { header: 'TARGET', align: 'right' },
        { header: 'SNAPPED', align: 'right' },
        { header: 'Δ', align: 'right' },
        { header: 'FACTOR', align: 'right' },
        { header: 'POINT_ID' },
        { header: 'NOTE' },
      ];
      const tableRows = rows.map((r) => [
        r.territory,
        r.currency,
        fmtMoney(r.currentLocal),
        fmtMoney(r.targetLocal),
        fmtMoney(r.snappedAmount),
        fmtPct(r.changePct),
        r.factor !== undefined ? r.factor.toFixed(3) : '',
        r.snappedPointId ?? '',
        r.reason === 'change' ? '' : r.reason,
      ]);

      const changes = rows.filter((r) => r.reason === 'change').length;
      const drops = rows.filter((r) => (r.changePct ?? 0) < 0).length;
      const lifts = rows.filter((r) => (r.changePct ?? 0) > 0).length;
      const summary = `Proposal for subscription ${subscriptionId}: ${changes} change${changes === 1 ? '' : 's'} (${drops} drops, ${lifts} lifts), anchor ${anchorTerritory}=${basePriceAnchor}, round=${roundStrategy}, floor=${floorFactor}, snapshot=${index.snapshot}`;

      const text = `${summary}\n\n${formatTable(columns, tableRows)}\n\nDry-run only. To apply, call asc_post_subscription_price for each row above with subscriptionId, territoryId, and the POINT_ID. Always pass preserveCurrentPrice=true and a startDate ≥ today + 7 days.`;
      return { content: [{ type: 'text', text }] };
    },
  );
}
