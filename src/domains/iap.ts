import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestIapPricePoints, digestIapPrices, digestIaps, digestSingle } from '../digest.js';
import { ASCError } from '../errors.js';
import type { JSONAPIResource, JSONAPIResponse } from '../jsonapi.js';
import { filterPagesByNearAmount, paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  InAppPurchaseIdSchema,
  InAppPurchasePricePointIdSchema,
  StartDateSchema,
  TerritoryIdSchema,
} from '../schemas.js';

// In-app purchases use the v2 surface — the v1 inAppPurchases endpoints are
// deprecated and not exposed here. Three quirks worth knowing before reading
// the code:
// 1. The LIST endpoint is on the /v1/ prefix: /v1/apps/{id}/inAppPurchasesV2
//    but the IAP detail, schedule, and price-points endpoints are on /v2/.
// 2. IAP v2 covers CONSUMABLE, NON_CONSUMABLE, NON_RENEWING_SUBSCRIPTION only.
//    Auto-renewable subs live on /v1/subscriptions and are handled by the
//    subscriptions domain.
// 3. Price schedule is whole-schedule replace (same as apps), with `manualPrices`
//    + `automaticPrices` + required `baseTerritory`. NO preserveCurrentPrice.
//    Inline-create payloads use relationship name `inAppPurchaseV2` (not
//    `inAppPurchase`) — easy to typo. The write tool lives in a separate spike.

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const IAP_FIELDS =
  'name,productId,inAppPurchaseType,state,reviewNote,familySharable,contentHosting';
const IAP_PRICE_POINT_FIELDS = 'customerPrice,proceeds';
const TERRITORY_FIELDS = 'currency';

export function registerIaps(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_iaps',
    {
      title: 'List in-app purchases',
      description:
        'List in-app purchases for an app (v2 surface — consumables, non-consumables, non-renewing subscriptions). ' +
        'Auto-renewable subscriptions are NOT listed here; use asc_list_subscriptions instead. ' +
        'Returns a compact table by default; pass raw:true for the full JSON:API payload. ' +
        'If this returns zero rows for an app you know has IAPs, the IAPs may be legacy-only (v1, deprecated) — migrate via the App Store Connect web UI.',
      inputSchema: {
        appId: AppIdSchema,
        filterType: z
          .enum(['CONSUMABLE', 'NON_CONSUMABLE', 'NON_RENEWING_SUBSCRIPTION'])
          .optional()
          .describe('Restrict by IAP type.'),
        filterState: z
          .string()
          .optional()
          .describe('Restrict by ASC state, e.g. APPROVED, READY_TO_SUBMIT.'),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, filterType, filterState, maxItems, raw }) => {
      const params = new URLSearchParams();
      if (filterType) params.set('filter[inAppPurchaseType]', filterType);
      if (filterState) params.set('filter[state]', filterState);
      params.set('fields[inAppPurchases]', IAP_FIELDS);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/inAppPurchasesV2?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestIaps(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_iap',
    {
      title: 'Get an in-app purchase',
      description: 'Fetch a single in-app purchase (v2) by its ASC ID.',
      inputSchema: {
        iapId: InAppPurchaseIdSchema,
        raw: z.boolean().default(false),
      },
    },
    async ({ iapId, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[inAppPurchases]', IAP_FIELDS);
      try {
        // NOTE: this is the /v2/ prefix — the IAP detail endpoint moved there
        // even though list lives on /v1/. Apple has been inconsistent here.
        const data = await client.request<JSONAPIResponse<JSONAPIResource>>(
          `/v2/inAppPurchases/${encodeURIComponent(iapId)}?${params.toString()}`,
        );
        const text = raw ? JSON.stringify(data, null, 2) : digestSingle(data.data, 'IAP');
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_iap_prices',
    {
      title: 'List IAP prices',
      description:
        'List the current price schedule for an in-app purchase across territories. Like apps (and unlike subs), the schedule is one object with manual + automatic price children. ' +
        'Apple may reject chained includes or fields[inAppPurchasePricePoints] selectors on this endpoint (matches the appPriceSchedule pattern); we ask only for top-level relationships and resolve amounts separately via asc_list_iap_price_points.',
      inputSchema: {
        iapId: InAppPurchaseIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ iapId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'manualPrices,automaticPrices,baseTerritory');
      // /v2/ prefix on this endpoint (per OpenAPI spec).
      const path = `/v2/inAppPurchases/${encodeURIComponent(iapId)}/iapPriceSchedule?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestIapPrices(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_iap_price_points',
    {
      title: 'List IAP price points',
      description:
        'List the valid Apple price tiers for an in-app purchase in a given territory. Apple rotates these IDs; cache only within a single run. ' +
        'Pass nearAmount when you already know the target price — the response is narrowed to the nearest tiers client-side (Apple does not support a near-amount filter server-side, so the full list is still paginated but only the nearest tiers are surfaced).',
      inputSchema: {
        iapId: InAppPurchaseIdSchema,
        territoryId: TerritoryIdSchema,
        maxItems: z.number().int().positive().max(5000).default(1000),
        nearAmount: z
          .number()
          .positive()
          .optional()
          .describe(
            'Target customer price (in the territory currency). The response is filtered to the nearest tiers.',
          ),
        nearCount: z
          .number()
          .int()
          .positive()
          .max(100)
          .default(10)
          .describe('Max tiers to return when nearAmount is set.'),
        raw: z.boolean().default(false),
      },
    },
    async ({ iapId, territoryId, maxItems, nearAmount, nearCount, raw }) => {
      const params = new URLSearchParams();
      params.set('filter[territory]', territoryId);
      params.set('include', 'territory');
      params.set('fields[inAppPurchasePricePoints]', IAP_PRICE_POINT_FIELDS);
      params.set('fields[territories]', TERRITORY_FIELDS);
      params.set('limit', '200');
      try {
        // /v2/ prefix again.
        const fetched = await paginate(
          client,
          `/v2/inAppPurchases/${encodeURIComponent(iapId)}/pricePoints?${params.toString()}`,
          maxItems,
        );
        const pages =
          nearAmount !== undefined
            ? filterPagesByNearAmount(fetched, nearAmount, nearCount)
            : fetched;
        const text = raw ? JSON.stringify(pages, null, 2) : digestIapPricePoints(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_iap_price_schedule',
    {
      title: 'Replace the entire IAP price schedule',
      description:
        'Replace the price schedule for an in-app purchase (v2 IAPs only — consumables, non-consumables, non-renewing subs). ' +
        'IMPORTANT: this is REPLACE, not merge — any manual override or scheduled change not in `prices[]` is wiped. ' +
        'At least one entry MUST target `baseTerritory` with no startDate (= active now). ' +
        "IAPs have NO grandfather mechanism (no preserveCurrentPrice analog) — new prices activate atomically at each entry's startDate. " +
        'For auto-renewable subscriptions use asc_post_subscription_price instead.',
      inputSchema: {
        iapId: InAppPurchaseIdSchema,
        baseTerritory: TerritoryIdSchema,
        prices: z
          .array(
            z.object({
              territory: TerritoryIdSchema,
              pricePointId: InAppPurchasePricePointIdSchema,
              startDate: StartDateSchema.optional().describe(
                'Absent = active now. Apple requires ≥24h in the future; ≥7 days recommended.',
              ),
              endDate: StartDateSchema.optional().describe(
                'Optional. Used for time-bounded regional overrides.',
              ),
            }),
          )
          .min(1)
          .describe(
            'The COMPLETE new schedule. Include every territory you want priced; omitted territories fall back to the Apple-computed automatic price from baseTerritory.',
          ),
        acknowledgeReplacesAll: z
          .literal(true)
          .describe(
            'You must pass `true` to acknowledge that this REPLACES the entire schedule and wipes any manual override or scheduled change not in `prices[]`.',
          ),
        acknowledgeDeletesScheduledIfBaseChanges: z
          .boolean()
          .optional()
          .describe(
            "Required `true` if `baseTerritory` differs from the IAP's current base territory.",
          ),
      },
    },
    async ({ iapId, baseTerritory, prices, acknowledgeDeletesScheduledIfBaseChanges }) => {
      // Pre-flight: baseTerritory must appear in prices[] with no startDate.
      const baseEntries = prices.filter((p) => p.territory === baseTerritory);
      if (baseEntries.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Pre-flight failed: prices[] contains no entry for baseTerritory=${baseTerritory}. Apple requires the base territory to have at least one price (with no startDate = active now).`,
            },
          ],
          isError: true,
        };
      }
      if (!baseEntries.some((p) => !p.startDate)) {
        return {
          content: [
            {
              type: 'text',
              text: `Pre-flight failed: baseTerritory=${baseTerritory} has no active-now entry (all base-territory entries have a startDate). Include one entry for ${baseTerritory} without a startDate.`,
            },
          ],
          isError: true,
        };
      }

      // Detect base-territory change against the current schedule. One extra
      // GET, worth the cost — silently wiping scheduled changes is exactly the
      // footgun this tool is here to prevent.
      try {
        const current = await client.request<JSONAPIResponse>(
          `/v2/inAppPurchases/${encodeURIComponent(iapId)}/iapPriceSchedule?include=baseTerritory`,
        );
        const currentBaseId = (
          current.data as {
            relationships?: { baseTerritory?: { data?: { id?: string } } };
          }
        ).relationships?.baseTerritory?.data?.id;
        if (
          currentBaseId &&
          currentBaseId !== baseTerritory &&
          !acknowledgeDeletesScheduledIfBaseChanges
        ) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Pre-flight failed: changing baseTerritory from ${currentBaseId} → ${baseTerritory}. ` +
                  `Pass acknowledgeDeletesScheduledIfBaseChanges: true to proceed.`,
              },
            ],
            isError: true,
          };
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Pre-flight failed: couldn't read current schedule to check baseTerritory.\n\n${formatASCError(err)}`,
            },
          ],
          isError: true,
        };
      }

      // GOTCHA: the inline-create relationship name on InAppPurchasePrice is
      // `inAppPurchaseV2` (per the OpenAPI spec), not `inAppPurchase`. Easy to
      // typo from the schedule's manualPrices relationship.
      const included = prices.map((p, i) => ({
        type: 'inAppPurchasePrices',
        id: `\${${i + 1}}`,
        attributes: {
          ...(p.startDate ? { startDate: p.startDate } : {}),
          ...(p.endDate ? { endDate: p.endDate } : {}),
        },
        relationships: {
          inAppPurchaseV2: { data: { type: 'inAppPurchases', id: iapId } },
          inAppPurchasePricePoint: {
            data: { type: 'inAppPurchasePricePoints', id: p.pricePointId },
          },
          territory: { data: { type: 'territories', id: p.territory } },
        },
      }));
      const body = {
        data: {
          type: 'inAppPurchasePriceSchedules',
          attributes: {},
          relationships: {
            inAppPurchase: { data: { type: 'inAppPurchases', id: iapId } },
            baseTerritory: { data: { type: 'territories', id: baseTerritory } },
            manualPrices: {
              data: included.map((r) => ({ type: 'inAppPurchasePrices', id: r.id })),
            },
          },
        },
        included,
      };
      try {
        const data = await client.request<unknown>('/v1/inAppPurchasePriceSchedules', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Replaced IAP price schedule for ${iapId}. New schedule has ${prices.length} manual entries; baseTerritory=${baseTerritory}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
