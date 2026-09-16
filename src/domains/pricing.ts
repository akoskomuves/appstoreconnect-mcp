import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError, ascErrorText } from '../errors.js';
import {
  PricePointIdSchema,
  StartDateSchema,
  SubscriptionIdSchema,
  SubscriptionPriceIdSchema,
  TerritoryIdSchema,
} from '../schemas.js';

interface JSONAPIBody {
  data: {
    type: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface SubscriptionPriceCreateInput {
  subscriptionId: string;
  territoryId: string;
  pricePointId: string;
  /**
   * Omit entirely to open the schedule with the BASELINE price. See the note
   * below — Apple rejects a dated first price with a 409.
   */
  startDate?: string | undefined;
  preserveCurrentPrice?: boolean | undefined;
}

/**
 * Body for POST /v1/subscriptionPrices.
 *
 * ⚠️ TWO preconditions, both confirmed live on 2026-09-16 against a
 * throwaway subscription (see scripts/smoke-subscription-products.ts):
 *
 *   1. Territory AVAILABILITY must exist first. Without it, even a correctly
 *      shaped undated POST fails — and the error points at the wrong thing:
 *        409 ENTITY_ERROR.RELATIONSHIP.INVALID
 *        detail:  "An error occurred while processing the pricing information."
 *        pointer: /data/relationships/subscriptionPricePoint/id
 *      Nothing is wrong with the price point. Apple cannot price a territory
 *      the subscription is not available in, and says so by blaming the ID.
 *
 *   2. The FIRST price must be UNDATED. Apple states this outright:
 *        409 ENTITY_ERROR.ATTRIBUTE.INVALID
 *        detail:  "Invalid startDate. Create a starting price before creating
 *                  future prices."
 *        pointer: /data/attributes/startDate
 *      Reproduced at 1, 8 and 29 days out with `preserveCurrentPrice` both
 *      true and false: the date's PRESENCE is the problem, not its distance.
 *
 * The contract backs this — SubscriptionPriceCreateRequest requires only
 * `type` + `relationships`, `attributes` as a whole is optional, and both
 * `startDate` and `preserveCurrentPrice` are `nullable: true` (spec 4.4.1).
 * A dated row is a price *change*, which presupposes a price to change FROM.
 *
 * Correct order: availability -> undated baseline -> dated changes.
 *
 * `preserveCurrentPrice` means "grandfather the existing cohort at the price
 * they subscribed under". On a baseline there is no existing cohort and no
 * previous price, so it is omitted unless the caller sets it explicitly. It
 * still defaults to true for dated changes, where it is the safe choice.
 */
export function buildSubscriptionPriceCreateBody(input: SubscriptionPriceCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.startDate !== undefined) {
    attributes.startDate = input.startDate;
    attributes.preserveCurrentPrice = input.preserveCurrentPrice ?? true;
  } else if (input.preserveCurrentPrice !== undefined) {
    attributes.preserveCurrentPrice = input.preserveCurrentPrice;
  }
  const body: JSONAPIBody = {
    data: {
      type: 'subscriptionPrices',
      relationships: {
        subscription: { data: { type: 'subscriptions', id: input.subscriptionId } },
        subscriptionPricePoint: {
          data: { type: 'subscriptionPricePoints', id: input.pricePointId },
        },
        territory: { data: { type: 'territories', id: input.territoryId } },
      },
    },
  };
  // Apple accepts a body with no attributes block at all; sending an empty
  // object is the shape most likely to trip a validator, so omit it.
  if (Object.keys(attributes).length > 0) body.data.attributes = attributes;
  return body;
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerPricing(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_post_subscription_price',
    {
      title: 'Schedule a subscription price change',
      description:
        'Set the price of a single (subscription, territory) — either the initial price or a scheduled change. ' +
        '** ORDER MATTERS (both steps confirmed live): territory availability -> undated baseline price -> dated changes. ** ' +
        '(1) The subscription must already be AVAILABLE in the territory (asc_post_subscription_availability). If it is not, this call 409s with ENTITY_ERROR.RELATIONSHIP.INVALID pointing at the price point — misleading, since the price point is fine; Apple just cannot price a territory the product is not sold in. ' +
        '(2) ** OMIT startDate for a subscription\'s FIRST price in a territory. ** The opening price is the undated baseline; a date makes it a price *change*, which presupposes a price to change from. Apple says so directly: "Invalid startDate. Create a starting price before creating future prices." Distance does not help — 1, 8 and 29 days out all 409. Pass startDate only once a price exists in that territory. ' +
        'For a dated change, always leave preserveCurrentPrice at true unless you intend to re-price existing subscribers. Apple requires startDate ≥ today + 24h; ≥7 days is the safer habit (not enforced here — Apple validates it). ' +
        'preserveCurrentPrice is omitted entirely on a baseline, where there is no existing cohort to grandfather. ' +
        'READING THE RESULT: the created row comes back with `preserved: false`, and keeps reading false in the price schedule for as long as it is the newest row. That is correct and expected — it does NOT mean preserveCurrentPrice was ignored. `preserved` means "this row is held for the cohort that subscribed under it", so it only flips true once a NEWER price supersedes it.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema,
        pricePointId: PricePointIdSchema,
        startDate: StartDateSchema.optional().describe(
          'Date a price CHANGE takes effect, YYYY-MM-DD. OMIT this for the first price on a subscription — the opening price must be the undated baseline, and Apple 409s a dated first price. Apple requires a change date ≥ today + 24h.',
        ),
        preserveCurrentPrice: z
          .boolean()
          .optional()
          .describe(
            'Grandfather existing subscribers at their current price. Strongly recommended for a dated change, where it defaults to true. Ignored on a baseline price (no existing cohort), so it is omitted from the request unless set explicitly.',
          ),
      }),
    },
    async ({ subscriptionId, territoryId, pricePointId, startDate, preserveCurrentPrice }) => {
      const body = buildSubscriptionPriceCreateBody({
        subscriptionId,
        territoryId,
        pricePointId,
        ...(startDate !== undefined ? { startDate } : {}),
        ...(preserveCurrentPrice !== undefined ? { preserveCurrentPrice } : {}),
      });
      let data: unknown;
      try {
        data = await client.request<unknown>('/v1/subscriptionPrices', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Both 409s here are confusing enough on their own that the tool
        // translates them. Match the FLATTENED text: Apple's `detail` lives in
        // ASCError.details, never in .message.
        const text = ascErrorText(err);
        if (text.includes('Create a starting price before creating future prices')) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Refused by Apple: this subscription has no price yet in ${territoryId}, so a DATED price cannot be created.\n\n` +
                  'The opening price of a schedule must be the undated baseline. Re-run this tool WITHOUT startDate to set it, then schedule changes on top.\n\n' +
                  formatASCError(err),
              },
            ],
            isError: true,
          };
        }
        if (
          text.includes('ENTITY_ERROR.RELATIONSHIP.INVALID') &&
          text.includes('subscriptionPricePoint')
        ) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Apple rejected this price and blamed the price point, but the price point is usually fine — this is what a MISSING TERRITORY AVAILABILITY looks like.\n\n` +
                  `A subscription cannot be priced in a territory it is not available in. Check asc_get_subscription_availability, and add ${territoryId} with asc_post_subscription_availability (⚠️ POST-only full replace — send the COMPLETE territory list, since omitted territories go off sale). Then retry this price.\n\n` +
                  'If availability already covers this territory, then the price point ID really is wrong or stale — Apple rotates them, so re-read asc_list_subscription_price_points and use a fresh ID.\n\n' +
                  formatASCError(err),
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
      // Apple echoes `preserved: false` on every freshly-created row (it is the
      // newest one, so nothing supersedes it yet). Without this note the
      // response reads as a silent grandfathering failure — a caller has
      // already deleted and re-created a row through the raw API chasing it.
      const note =
        startDate === undefined
          ? 'Set the BASELINE price for this territory (no start date) — this is the price the subscription opens at.\n\n' +
            'NOTE: the row below reads `preserved: false`. That is expected on any newly created row, not a failure — `preserved` flips true only once a NEWER price supersedes this one.\n\n'
          : preserveCurrentPrice !== false
            ? 'Scheduled with preserveCurrentPrice=true — existing subscribers are grandfathered.\n\n' +
              'NOTE: the row below reads `preserved: false`, and will keep reading false for as long as it is the newest price. That is expected, not a failure — `preserved` flips true only once a NEWER price supersedes this row.\n\n'
            : 'Scheduled with preserveCurrentPrice=false — EXISTING SUBSCRIBERS WILL BE RE-PRICED at the next renewal on or after the start date.\n\n';
      return { content: [{ type: 'text', text: `${note}${JSON.stringify(data, null, 2)}` }] };
    },
  );

  server.registerTool(
    'asc_delete_subscription_price',
    {
      title: 'Cancel a pending subscription price change',
      description:
        'Delete a pending scheduled subscription price by ID. Use this to roll back a change that has not yet activated.',
      inputSchema: z.object({
        subscriptionPriceId: SubscriptionPriceIdSchema,
      }),
    },
    async ({ subscriptionPriceId }) => {
      await client.request<void>(
        `/v1/subscriptionPrices/${encodeURIComponent(subscriptionPriceId)}`,
        { method: 'DELETE' },
      );
      return {
        content: [{ type: 'text', text: `Deleted scheduled price ${subscriptionPriceId}.` }],
      };
    },
  );
}
