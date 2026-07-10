import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestWinBackOfferPrices, digestWinBackOffers } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  IntegerRangeSchema,
  OfferModeSchema,
  OfferNameSchema,
  OfferPrioritySchema,
  PricePointIdSchema,
  PromotionIntentSchema,
  SubscriptionIdSchema,
  SubscriptionOfferDurationSchema,
  SubscriptionPlanTypeSchema,
  TerritoryIdSchema,
  WinBackOfferIdentifierSchema,
  WinBackOfferIdSchema,
} from '../schemas.js';

// Win-back offers are the THIRD subscription offer type, after intro offers
// (target NEW subscribers) and promotional offers (target EXISTING/lapsed subs
// via a redeemed offerCode). Win-back offers target LAPSED subscribers and are
// surfaced AUTOMATICALLY by Apple to eligible churned customers (subject to the
// customerEligibility* rules), or through your own StoreKit messaging.
//
// How Apple's win-back API differs from promotional offers:
//   - Richer attributes: eligibility targeting (three customerEligibility*
//     fields, one of which is an IntegerRange), a schedule (startDate + optional
//     endDate), priority (HIGH/NORMAL) and promotionIntent (whether Apple
//     auto-generates assets), plus an optional targetSubscriptionPlanType.
//   - periodCount is UNCONDITIONALLY required (promo's numberOfPeriods was only
//     required for PAY_AS_YOU_GO).
//   - Per-territory prices are created inline in `included[]` (type
//     `winBackOfferPrices`) — same pattern as promo offers.
//   - PATCH is ATTRIBUTES-ONLY: eligibility, startDate, endDate, priority and
//     promotionIntent are mutable in place. referenceName, offerId, duration,
//     offerMode, periodCount, targetSubscriptionPlanType and the PRICES are all
//     immutable post-create — to change a price, delete and re-create the offer.
//
// JWT signing for in-app redemption is unchanged and lives in offer-signing.ts.

type OfferMode = z.infer<typeof OfferModeSchema>;
type OfferDuration = z.infer<typeof SubscriptionOfferDurationSchema>;
type Priority = z.infer<typeof OfferPrioritySchema>;
type PromotionIntent = z.infer<typeof PromotionIntentSchema>;
type PlanType = z.infer<typeof SubscriptionPlanTypeSchema>;
type IntegerRange = z.infer<typeof IntegerRangeSchema>;

interface WinBackOfferPriceEntry {
  territoryId: string;
  pricePointId: string;
}

export interface WinBackOfferCreateInput {
  subscriptionId: string;
  referenceName: string;
  offerId: string;
  duration: OfferDuration;
  offerMode: OfferMode;
  periodCount: number;
  customerEligibilityPaidSubscriptionDurationInMonths: number;
  customerEligibilityTimeSinceLastSubscribedInMonths: IntegerRange;
  customerEligibilityWaitBetweenOffersInMonths?: number | undefined;
  startDate: string;
  endDate?: string | undefined;
  priority: Priority;
  promotionIntent?: PromotionIntent | undefined;
  targetSubscriptionPlanType?: PlanType | undefined;
  prices: WinBackOfferPriceEntry[];
}

export interface WinBackOfferPatchInput {
  customerEligibilityPaidSubscriptionDurationInMonths?: number | undefined;
  customerEligibilityTimeSinceLastSubscribedInMonths?: IntegerRange | undefined;
  customerEligibilityWaitBetweenOffersInMonths?: number | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  priority?: Priority | undefined;
  promotionIntent?: PromotionIntent | undefined;
}

interface WinBackOfferBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
  included?: Array<{
    type: string;
    id: string;
    relationships: Record<string, { data: { type: string; id: string } }>;
  }>;
}

function tempId(n: number): string {
  // Apple's JSON:API temp-ID convention for unsaved resources: literal `${N}`
  // strings on the wire. Built via concatenation so biome's
  // noTemplateCurlyInString rule doesn't false-flag it.
  return `\${${n}}`;
}

function buildRange(r: IntegerRange): Record<string, number> {
  const out: Record<string, number> = { minimum: r.minimum };
  if (r.maximum !== undefined) out.maximum = r.maximum;
  return out;
}

function buildIncludedPrices(prices: WinBackOfferPriceEntry[]) {
  return prices.map((p, i) => ({
    type: 'winBackOfferPrices',
    id: tempId(i + 1),
    relationships: {
      territory: { data: { type: 'territories', id: p.territoryId } },
      subscriptionPricePoint: {
        data: { type: 'subscriptionPricePoints', id: p.pricePointId },
      },
    },
  }));
}

export function buildWinBackOfferBody(input: WinBackOfferCreateInput): WinBackOfferBody {
  const attributes: Record<string, unknown> = {
    referenceName: input.referenceName,
    offerId: input.offerId,
    duration: input.duration,
    offerMode: input.offerMode,
    periodCount: input.periodCount,
    customerEligibilityPaidSubscriptionDurationInMonths:
      input.customerEligibilityPaidSubscriptionDurationInMonths,
    customerEligibilityTimeSinceLastSubscribedInMonths: buildRange(
      input.customerEligibilityTimeSinceLastSubscribedInMonths,
    ),
    startDate: input.startDate,
    priority: input.priority,
  };
  if (input.customerEligibilityWaitBetweenOffersInMonths !== undefined) {
    attributes.customerEligibilityWaitBetweenOffersInMonths =
      input.customerEligibilityWaitBetweenOffersInMonths;
  }
  if (input.endDate !== undefined) attributes.endDate = input.endDate;
  if (input.promotionIntent !== undefined) attributes.promotionIntent = input.promotionIntent;
  if (input.targetSubscriptionPlanType !== undefined) {
    attributes.targetSubscriptionPlanType = input.targetSubscriptionPlanType;
  }

  const included = buildIncludedPrices(input.prices);
  return {
    data: {
      type: 'winBackOffers',
      attributes,
      relationships: {
        subscription: { data: { type: 'subscriptions', id: input.subscriptionId } },
        prices: { data: included.map((r) => ({ type: r.type, id: r.id })) },
      },
    },
    included,
  };
}

export function buildWinBackOfferPatchBody(
  offerId: string,
  changes: WinBackOfferPatchInput,
): WinBackOfferBody {
  const attributes: Record<string, unknown> = {};
  if (changes.customerEligibilityPaidSubscriptionDurationInMonths !== undefined) {
    attributes.customerEligibilityPaidSubscriptionDurationInMonths =
      changes.customerEligibilityPaidSubscriptionDurationInMonths;
  }
  if (changes.customerEligibilityTimeSinceLastSubscribedInMonths !== undefined) {
    attributes.customerEligibilityTimeSinceLastSubscribedInMonths = buildRange(
      changes.customerEligibilityTimeSinceLastSubscribedInMonths,
    );
  }
  if (changes.customerEligibilityWaitBetweenOffersInMonths !== undefined) {
    attributes.customerEligibilityWaitBetweenOffersInMonths =
      changes.customerEligibilityWaitBetweenOffersInMonths;
  }
  if (changes.startDate !== undefined) attributes.startDate = changes.startDate;
  if (changes.endDate !== undefined) attributes.endDate = changes.endDate;
  if (changes.priority !== undefined) attributes.priority = changes.priority;
  if (changes.promotionIntent !== undefined) attributes.promotionIntent = changes.promotionIntent;
  // No relationships block: Apple's win-back update schema is attributes-only.
  return {
    data: {
      type: 'winBackOffers',
      id: offerId,
      attributes,
    },
  };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const WinBackDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a calendar date in YYYY-MM-DD form.');

// Field selector pinning the attributes the digest + collision pre-flight rely
// on, so a sparse-fieldset default change between OpenAPI revisions can't
// silently blank a column or no-op the offerId uniqueness check.
const WIN_BACK_FIELDS =
  'offerId,referenceName,offerMode,duration,periodCount,priority,startDate,endDate';

export function registerWinBackOffers(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_win_back_offers',
    {
      title: 'List subscription win-back offers',
      description:
        "List win-back offers configured for a subscription. Win-back offers target LAPSED subscribers (intro offers target new subscribers; promo offers target existing/lapsed subscribers via a redeemed code). Apple surfaces win-back offers automatically to eligible churned customers based on the offer's customerEligibility* rules.",
      inputSchema: {
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ subscriptionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'prices');
      params.set('fields[winBackOffers]', WIN_BACK_FIELDS);
      params.set('limit', '200');
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/winBackOffers?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestWinBackOffers(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_subscription_win_back_offer',
    {
      title: 'Get a subscription win-back offer',
      description:
        'Fetch a single win-back offer by its Apple resource ID, including its subscription and per-territory prices.',
      inputSchema: {
        winBackOfferId: WinBackOfferIdSchema,
      },
    },
    async ({ winBackOfferId }) => {
      const path = `/v1/winBackOffers/${encodeURIComponent(
        winBackOfferId,
      )}?include=subscription,prices`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_subscription_win_back_offer_prices',
    {
      title: 'List subscription win-back offer prices',
      description:
        'List the per-territory price rows attached to a win-back offer. Each row is a (territory, subscriptionPricePoint) pair — the price-point amount is resolved via the included subscriptionPricePoints resources. Prices are immutable after creation.',
      inputSchema: {
        winBackOfferId: WinBackOfferIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ winBackOfferId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'territory,subscriptionPricePoint');
      params.set('limit', '200');
      const path = `/v1/winBackOffers/${encodeURIComponent(winBackOfferId)}/prices?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestWinBackOfferPrices(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_win_back_offer',
    {
      title: 'Create a subscription win-back offer',
      description:
        'Create a win-back offer targeting lapsed subscribers, with eligibility rules + schedule + all per-territory prices in one atomic POST. ' +
        'Immutability: referenceName, offerId, duration, offerMode, periodCount, targetSubscriptionPlanType and the PRICES are immutable post-create — to change any of them, delete and re-create (use asc_patch_subscription_win_back_offer to change eligibility, dates, priority, or promotionIntent). ' +
        'offerId must be unique within the subscription (StoreKit offer identifier); this tool pre-flights for a collision and refuses on a duplicate. periodCount is required for every mode.',
      inputSchema: {
        subscriptionId: SubscriptionIdSchema,
        referenceName: OfferNameSchema,
        offerId: WinBackOfferIdentifierSchema,
        duration: SubscriptionOfferDurationSchema,
        offerMode: OfferModeSchema,
        periodCount: z
          .number()
          .int()
          .positive()
          .describe(
            'Number of billing periods the offer price applies for (duration × periodCount = total offer length). Required for every offer mode.',
          ),
        customerEligibilityPaidSubscriptionDurationInMonths: z
          .number()
          .int()
          .nonnegative()
          .describe(
            'Eligibility: how many months the customer must have been a paid subscriber (cumulatively) to qualify.',
          ),
        customerEligibilityTimeSinceLastSubscribedInMonths: IntegerRangeSchema.describe(
          'Eligibility window: months since the customer last had an active subscription, as { minimum, maximum? }. e.g. { minimum: 1, maximum: 6 } = churned 1–6 months ago.',
        ),
        customerEligibilityWaitBetweenOffersInMonths: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Eligibility: minimum months between successive win-back offers to the same customer.',
          ),
        startDate: WinBackDateSchema.describe('Date the offer becomes active (YYYY-MM-DD).'),
        endDate: WinBackDateSchema.optional().describe(
          'Optional date the offer stops being active (YYYY-MM-DD). Omit for open-ended.',
        ),
        priority: OfferPrioritySchema,
        promotionIntent: PromotionIntentSchema.optional(),
        targetSubscriptionPlanType: SubscriptionPlanTypeSchema.optional(),
        prices: z
          .array(
            z.object({
              territoryId: TerritoryIdSchema,
              pricePointId: PricePointIdSchema,
            }),
          )
          .min(1)
          .describe(
            'Per-territory prices (immutable after creation). Each entry is (territoryId, pricePointId). At least one required. Use asc_list_subscription_price_points to pick price points per territory.',
          ),
      },
    },
    async (input) => {
      // Local validations that Apple would otherwise reject with an opaque 4xx.
      const range = input.customerEligibilityTimeSinceLastSubscribedInMonths;
      if (range.maximum !== undefined && range.maximum < range.minimum) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid eligibility range: maximum (${range.maximum}) is less than minimum (${range.minimum}).`,
            },
          ],
          isError: true,
        };
      }
      if (input.endDate !== undefined && input.endDate <= input.startDate) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid schedule: endDate (${input.endDate}) must be after startDate (${input.startDate}).`,
            },
          ],
          isError: true,
        };
      }

      // Pre-flight: refuse on an offerId collision. offerId is immutable and
      // must be unique per subscription; the fields[] selector pins it into the
      // response so this check can't silently no-op on a sparse-fieldset default.
      try {
        const listParams = new URLSearchParams();
        listParams.set('fields[winBackOffers]', 'offerId');
        listParams.set('limit', '200');
        const existing = await paginate(
          client,
          `/v1/subscriptions/${encodeURIComponent(
            input.subscriptionId,
          )}/winBackOffers?${listParams.toString()}`,
          200,
        );
        const collision = existing.data.find((o) => o.attributes?.['offerId'] === input.offerId);
        if (collision) {
          return {
            content: [
              {
                type: 'text',
                text: `Refused: offerId "${input.offerId}" is already in use by win-back offer ${collision.id} on this subscription. offerId must be unique per subscription and is immutable after creation — pick a different identifier or delete the existing offer first.`,
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
              text: `Pre-flight failed (could not list existing win-back offers): ${formatASCError(err)}`,
            },
          ],
          isError: true,
        };
      }

      const body = buildWinBackOfferBody(input);
      try {
        const data = await client.request<unknown>('/v1/winBackOffers', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription_win_back_offer',
    {
      title: 'Update a subscription win-back offer',
      description:
        'Update the mutable attributes of an existing win-back offer: eligibility (customerEligibility* fields), schedule (startDate/endDate), priority, and promotionIntent. ' +
        'referenceName, offerId, duration, offerMode, periodCount, targetSubscriptionPlanType and the prices are IMMUTABLE — to change any of those, delete and re-create the offer. Pass only the fields you want to change; at least one is required.',
      inputSchema: {
        winBackOfferId: WinBackOfferIdSchema,
        customerEligibilityPaidSubscriptionDurationInMonths: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        customerEligibilityTimeSinceLastSubscribedInMonths: IntegerRangeSchema.optional(),
        customerEligibilityWaitBetweenOffersInMonths: z.number().int().nonnegative().optional(),
        startDate: WinBackDateSchema.optional(),
        endDate: WinBackDateSchema.optional(),
        priority: OfferPrioritySchema.optional(),
        promotionIntent: PromotionIntentSchema.optional(),
      },
    },
    async ({ winBackOfferId, ...changes }) => {
      const hasChange = Object.values(changes).some((v) => v !== undefined);
      if (!hasChange) {
        return {
          content: [
            {
              type: 'text',
              text: 'No changes provided. Pass at least one of: customerEligibilityPaidSubscriptionDurationInMonths, customerEligibilityTimeSinceLastSubscribedInMonths, customerEligibilityWaitBetweenOffersInMonths, startDate, endDate, priority, promotionIntent.',
            },
          ],
          isError: true,
        };
      }
      const range = changes.customerEligibilityTimeSinceLastSubscribedInMonths;
      if (range?.maximum !== undefined && range.maximum < range.minimum) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid eligibility range: maximum (${range.maximum}) is less than minimum (${range.minimum}).`,
            },
          ],
          isError: true,
        };
      }
      if (
        changes.startDate !== undefined &&
        changes.endDate !== undefined &&
        changes.endDate <= changes.startDate
      ) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid schedule: endDate (${changes.endDate}) must be after startDate (${changes.startDate}).`,
            },
          ],
          isError: true,
        };
      }

      const body = buildWinBackOfferPatchBody(winBackOfferId, changes);
      try {
        const data = await client.request<unknown>(
          `/v1/winBackOffers/${encodeURIComponent(winBackOfferId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_subscription_win_back_offer',
    {
      title: 'Delete a subscription win-back offer',
      description:
        'Delete a win-back offer by its Apple resource ID. Returns 204 on success. This is the only way to change an immutable attribute (offerId, duration, offerMode, periodCount) or the prices — delete and re-create.',
      inputSchema: {
        winBackOfferId: WinBackOfferIdSchema,
      },
    },
    async ({ winBackOfferId }) => {
      try {
        await client.request<void>(`/v1/winBackOffers/${encodeURIComponent(winBackOfferId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Deleted win-back offer ${winBackOfferId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
