import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppPricePoints, digestAppPrices } from '../digest.js';
import { ASCError } from '../errors.js';
import type { JSONAPIResponse } from '../jsonapi.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AppPricePointIdSchema,
  StartDateSchema,
  TerritoryIdSchema,
} from '../schemas.js';

// Surface Apple's error body (which carries `errors[].detail` text pointing at
// the offending field/param) so the LLM can self-correct without a roundtrip.
function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// App pricing differs from subscription pricing in three load-bearing ways:
// 1. The schedule is one object per app, not one row per (sub, territory).
// 2. Apple distinguishes `manualPrices` (per-territory overrides) from
//    `automaticPrices` (derived from baseTerritory by Apple's auto-conversion).
// 3. Writes replace the whole schedule via POST /v1/appPriceSchedules — there is
//    no DELETE on individual app price rows. This file covers reads only;
//    `asc_post_app_price_schedule` lives in the write spike.

const APP_PRICE_POINT_FIELDS = 'customerPrice,proceeds';
const TERRITORY_FIELDS = 'currency';

export function registerAppPricing(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_app_prices',
    {
      title: 'List app prices',
      description:
        'List the current price schedule for a paid app across territories. Returns both manual (per-territory) overrides and automatic prices derived from the base territory. Auto-paginates; pass raw:true for the full JSON:API payload.',
      inputSchema: {
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, maxItems, raw }) => {
      // Apple's /apps/{id}/appPriceSchedule rejects:
      //   - chained includes (manualPrices.appPricePoint etc.) — only top-level
      //   - fields[appPricePoints] selector — that type name isn't queryable here
      // So we ask only for the top-level relationships. Result: the digest gets
      // the AppPrice rows (with startDate / manual flag / territory ID / price
      // point ID) but NOT the price-point amounts. Use asc_list_app_price_points
      // separately to resolve a specific territory's amount.
      const params = new URLSearchParams();
      params.set('include', 'manualPrices,automaticPrices,baseTerritory');
      const path = `/v1/apps/${encodeURIComponent(appId)}/appPriceSchedule?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppPrices(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_app_price_points',
    {
      title: 'List app price points',
      description:
        'List the valid price points a paid app can be set to in a given territory. Apple rotates these IDs; cache only within a single run.',
      inputSchema: {
        appId: AppIdSchema,
        territoryId: TerritoryIdSchema,
        maxItems: z.number().int().positive().max(5000).default(1000),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, territoryId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('filter[territory]', territoryId);
      params.set('include', 'territory');
      params.set('fields[appPricePoints]', APP_PRICE_POINT_FIELDS);
      params.set('fields[territories]', TERRITORY_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/apps/${encodeURIComponent(appId)}/appPricePoints?${params.toString()}`,
          maxItems,
        );
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppPricePoints(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_price_schedule',
    {
      title: 'Replace the entire app price schedule',
      description:
        'Replace the price schedule for a paid app. ' +
        'IMPORTANT: this is REPLACE, not merge — any manual override or scheduled change not in `prices[]` is wiped. ' +
        'At least one entry MUST target `baseTerritory` with no startDate (= active now). ' +
        'Changing `baseTerritory` from the current value deletes any pending scheduled price changes (Apple behavior); ' +
        'set `acknowledgeDeletesScheduledIfBaseChanges: true` if you intend that. ' +
        "Apps have NO grandfather mechanism — new prices activate atomically at each entry's startDate.",
      inputSchema: {
        appId: AppIdSchema,
        baseTerritory: TerritoryIdSchema,
        prices: z
          .array(
            z.object({
              territory: TerritoryIdSchema,
              pricePointId: AppPricePointIdSchema,
              startDate: StartDateSchema.optional().describe(
                'Absent = active now. Apple requires ≥24h in the future; ≥7 days recommended.',
              ),
              endDate: StartDateSchema.optional().describe(
                'Optional. Used for time-bounded regional overrides (e.g., a 3-day promo in one country).',
              ),
            }),
          )
          .min(1)
          .describe(
            'The COMPLETE new schedule. Include every territory you want priced. Omitted territories fall back to the Apple-computed automatic price from `baseTerritory`.',
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
            "Required `true` if `baseTerritory` differs from the app's current base territory. Apple deletes pending scheduled changes when the base changes.",
          ),
      },
    },
    async ({ appId, baseTerritory, prices, acknowledgeDeletesScheduledIfBaseChanges }) => {
      // Pre-flight: the new schedule must include at least one entry for
      // baseTerritory with no startDate (Apple requires the base territory to
      // have an "active now" price; future-only schedules are rejected).
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
              text: `Pre-flight failed: baseTerritory=${baseTerritory} has no active-now entry (all base-territory entries have a startDate). Include one entry for ${baseTerritory} without a startDate to represent the current price.`,
            },
          ],
          isError: true,
        };
      }

      // Detect base-territory change to enforce the ack flag. One extra GET, but
      // worth the cost — silently wiping pending scheduled changes is the kind
      // of footgun this skill is here to prevent.
      try {
        const current = await client.request<JSONAPIResponse>(
          `/v1/apps/${encodeURIComponent(appId)}/appPriceSchedule?include=baseTerritory`,
        );
        const currentBaseId = (
          current.data as { relationships?: { baseTerritory?: { data?: { id?: string } } } }
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
                  `Pre-flight failed: changing baseTerritory from ${currentBaseId} → ${baseTerritory} deletes any pending scheduled price changes. ` +
                  `Pass acknowledgeDeletesScheduledIfBaseChanges: true to proceed.`,
              },
            ],
            isError: true,
          };
        }
      } catch (err) {
        // If we can't read the current schedule, surface that — don't silently
        // proceed with a write whose preconditions we couldn't verify.
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

      // Build the JSON:API payload. Apple expects the new AppPrice resources
      // in `included[]` with temp IDs (`${1}`-style placeholders are the
      // documented convention for unsaved resources in the AppPriceSchedule
      // POST). Each included resource has the same temp ID it's referenced by
      // in the schedule's `manualPrices` relationship array.
      const included = prices.map((p, i) => ({
        type: 'appPrices',
        id: `\${${i + 1}}`,
        attributes: {
          ...(p.startDate ? { startDate: p.startDate } : {}),
          ...(p.endDate ? { endDate: p.endDate } : {}),
        },
        relationships: {
          appPricePoint: { data: { type: 'appPricePoints', id: p.pricePointId } },
          territory: { data: { type: 'territories', id: p.territory } },
        },
      }));
      const body = {
        data: {
          type: 'appPriceSchedules',
          attributes: {},
          relationships: {
            app: { data: { type: 'apps', id: appId } },
            baseTerritory: { data: { type: 'territories', id: baseTerritory } },
            manualPrices: {
              data: included.map((r) => ({ type: 'appPrices', id: r.id })),
            },
          },
        },
        included,
      };
      try {
        const data = await client.request<unknown>('/v1/appPriceSchedules', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Replaced app price schedule for ${appId}. New schedule has ${prices.length} manual entries; baseTerritory=${baseTerritory}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
