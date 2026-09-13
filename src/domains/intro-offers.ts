import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestIntroOffers } from '../digest.js';
import { ASCError } from '../errors.js';
import {
  FULL_TERRITORY_SCAN,
  filterPagesByTerritory,
  paginate,
  territoryFilterNote,
} from '../jsonapi.js';
import {
  NumberOfPeriodsSchema,
  OfferModeSchema,
  PricePointIdSchema,
  StartDateSchema,
  SubscriptionIdSchema,
  SubscriptionIntroductoryOfferIdSchema,
  SubscriptionOfferDurationSchema,
  TerritoryIdSchema,
} from '../schemas.js';

// Subscription introductory offers add a discounted "first window" on top of an
// auto-renewable subscription. Three modes:
//   - FREE_TRIAL — no price; redeem and get the sub for `duration` free.
//   - PAY_AS_YOU_GO — discounted price each period for `numberOfPeriods` periods.
//   - PAY_UP_FRONT — single charge at the offer price for the whole window.
//     Apple still requires numberOfPeriods here (409 ENTITY_ERROR.ATTRIBUTE.
//     REQUIRED without it); the single up-front period means 1.
// Per (subscription, territory) cell you can have at most one active offer.
// A null territory = Apple's "all territories" wildcard, but the price point
// is then literal (no auto-FX). For PPP-aware per-territory pricing you must
// create one offer row per territory.

type OfferMode = z.infer<typeof OfferModeSchema>;
type OfferDuration = z.infer<typeof SubscriptionOfferDurationSchema>;

export interface IntroOfferInput {
  subscriptionId: string;
  // Optional key (not just `string | undefined`): zod ≥4.2 infers `.optional()`
  // fields as optional properties, and the builder already guards on
  // `!== undefined` before emitting the territory relationship.
  territoryId?: string | undefined;
  offerMode: OfferMode;
  duration: OfferDuration;
  startDate: string;
  endDate?: string | undefined;
  pricePointId?: string | undefined;
  numberOfPeriods?: number | undefined;
}

interface JSONAPIBody {
  data: {
    type: string;
    attributes: Record<string, unknown>;
    relationships: Record<string, { data: { type: string; id: string } }>;
  };
}

export function buildIntroOfferBody(input: IntroOfferInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    startDate: input.startDate,
    duration: input.duration,
    offerMode: input.offerMode,
  };
  if (input.endDate !== undefined) attributes.endDate = input.endDate;
  // numberOfPeriods is required for both paid modes, not just PAY_AS_YOU_GO —
  // Apple 409s a PAY_UP_FRONT create without it (ENTITY_ERROR.ATTRIBUTE.
  // REQUIRED). PAY_UP_FRONT is one up-front charge, so default to 1 when the
  // caller omits it. FREE_TRIAL keeps the legacy omit (whether Apple enforces
  // the attribute there too is unverified — UI-created trials store periods=1).
  const numberOfPeriods =
    input.numberOfPeriods ?? (input.offerMode === 'PAY_UP_FRONT' ? 1 : undefined);
  if (numberOfPeriods !== undefined) attributes.numberOfPeriods = numberOfPeriods;

  const relationships: Record<string, { data: { type: string; id: string } }> = {
    subscription: { data: { type: 'subscriptions', id: input.subscriptionId } },
  };
  if (input.territoryId !== undefined) {
    relationships.territory = { data: { type: 'territories', id: input.territoryId } };
  }
  if (input.offerMode !== 'FREE_TRIAL' && input.pricePointId !== undefined) {
    relationships.subscriptionPricePoint = {
      data: { type: 'subscriptionPricePoints', id: input.pricePointId },
    };
  }

  return {
    data: {
      type: 'subscriptionIntroductoryOffers',
      attributes,
      relationships,
    },
  };
}

interface IntroOfferPatchInput {
  startDate?: string | undefined;
  endDate?: string | undefined;
  pricePointId?: string | undefined;
}

function buildIntroOfferPatchBody(offerId: string, patch: IntroOfferPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (patch.startDate !== undefined) attributes.startDate = patch.startDate;
  if (patch.endDate !== undefined) attributes.endDate = patch.endDate;

  const relationships: Record<string, { data: { type: string; id: string } }> = {};
  if (patch.pricePointId !== undefined) {
    relationships.subscriptionPricePoint = {
      data: { type: 'subscriptionPricePoints', id: patch.pricePointId },
    };
  }

  return {
    data: {
      type: 'subscriptionIntroductoryOffers',
      // Apple's PATCH requires the resource ID in the body even though it's
      // also in the URL — match `id` here or it returns 409.
      ...({ id: offerId } as { id: string }),
      attributes,
      relationships,
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

export function registerIntroOffers(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_introductory_offers',
    {
      title: 'List subscription introductory offers',
      description:
        'List introductory offers (free trial / pay-as-you-go / pay-up-front) configured for a subscription. ' +
        'A PPP-aware offer is created one-per-territory, so an unfiltered call can return ~175 rows — pass territoryId (e.g. "USA") when you care about a single market, or the response can blow a tool-result token cap. ' +
        'Auto-paginates; pass raw:true for the full JSON:API payload. Wildcard offers (Apple\'s "all territories") show TERR as "(all)" and are ALWAYS kept when territoryId is set — a wildcard offer is live in every market, so hiding it would misreport the territory.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema.optional().describe(
          'Narrow the response to one territory (ISO-3 code, e.g. "USA"), plus any all-territories wildcard offers. Omit for every territory.',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, territoryId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'territory,subscriptionPricePoint');
      params.set('limit', '200');
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/introductoryOffers?${params.toString()}`;
      // As on the prices lister, maxItems caps what comes BACK, not how far to
      // look — an offer list can run to ~350 rows (a plan type per territory),
      // so a small maxItems would stop before the requested territory and
      // report it as having no offer.
      const fetchCeiling =
        territoryId === undefined ? maxItems : Math.max(maxItems, FULL_TERRITORY_SCAN);
      try {
        const fetched = await paginate(client, path, fetchCeiling);
        // keepWildcard: an offer created without a territory applies to EVERY
        // market, so it belongs in a single-territory view. This is also why
        // Apple's documented server-side filter[territory] is NOT used here —
        // its handling of territory-less wildcard rows is unverified, and
        // silently dropping one would hide an offer live in the requested market.
        const pages =
          territoryId === undefined ? fetched : filterPagesByTerritory(fetched, territoryId, true);
        const note =
          territoryId === undefined
            ? ''
            : territoryFilterNote(
                territoryId,
                pages.data.length,
                fetched.data.length,
                fetched.truncated,
                true,
              );
        const text = raw
          ? `${note}${JSON.stringify(pages, null, 2)}`
          : `${note}${digestIntroOffers(pages)}`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_subscription_introductory_offer',
    {
      title: 'Get a subscription introductory offer',
      description: 'Fetch a single introductory offer by ID.',
      inputSchema: z.object({
        offerId: SubscriptionIntroductoryOfferIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ offerId, raw }) => {
      const path = `/v1/subscriptionIntroductoryOffers/${encodeURIComponent(
        offerId,
      )}?include=territory,subscriptionPricePoint,subscription`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        if (raw) {
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        // Single-resource path: paginate's CollectedPages shape doesn't fit, so
        // we render JSON here. The list digest handles the table case.
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_introductory_offer',
    {
      title: 'Create a subscription introductory offer',
      description:
        'Create an introductory offer on a subscription. Server-side checks: pricePointId required unless offerMode=FREE_TRIAL; numberOfPeriods required when offerMode=PAY_AS_YOU_GO, and sent for PAY_UP_FRONT too (Apple requires it — defaults to 1, the single up-front period); ' +
        'territoryId omitted = Apple\'s "all territories" wildcard (uses the literal price point in every market — for PPP-aware multi-territory offers, create one per territory). ' +
        'startDate must be ≥ today+24h (Apple); ≥7 days recommended.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema.optional().describe(
          'Target territory. Omit for Apple\'s "all territories" wildcard (literal price point in every market — no auto-FX).',
        ),
        offerMode: OfferModeSchema,
        duration: SubscriptionOfferDurationSchema,
        startDate: StartDateSchema,
        endDate: StartDateSchema.optional().describe(
          'Optional end date (YYYY-MM-DD). When omitted, the offer runs open-ended until replaced. Must be after startDate.',
        ),
        pricePointId: PricePointIdSchema.optional().describe(
          'Required for PAY_AS_YOU_GO and PAY_UP_FRONT. Omit for FREE_TRIAL. Use asc_list_subscription_price_points (with nearAmount) to pick.',
        ),
        numberOfPeriods: NumberOfPeriodsSchema.optional().describe(
          'Required for PAY_AS_YOU_GO (how many periods the discounted price repeats). PAY_UP_FRONT: Apple requires the attribute too — defaults to 1 when omitted. Not sent for FREE_TRIAL.',
        ),
      }),
    },
    async (input) => {
      if (input.offerMode !== 'FREE_TRIAL' && !input.pricePointId) {
        return {
          content: [
            {
              type: 'text',
              text: `pricePointId is required when offerMode=${input.offerMode}. Use asc_list_subscription_price_points to pick one (pass nearAmount to narrow to the target price).`,
            },
          ],
          isError: true,
        };
      }
      if (input.offerMode === 'PAY_AS_YOU_GO' && input.numberOfPeriods === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'numberOfPeriods is required when offerMode=PAY_AS_YOU_GO (e.g. duration=ONE_MONTH × periods=3 = promo price for 3 months).',
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
              text: `endDate (${input.endDate}) must be after startDate (${input.startDate}).`,
            },
          ],
          isError: true,
        };
      }
      const body = buildIntroOfferBody(input);
      try {
        const data = await client.request<unknown>('/v1/subscriptionIntroductoryOffers', {
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
    'asc_patch_subscription_introductory_offer',
    {
      title: 'Patch a subscription introductory offer',
      description:
        "Update an introductory offer's window or price point. Apple's PATCH is narrow: only startDate, endDate, and pricePointId can change. " +
        'To change offerMode / duration / numberOfPeriods, delete the offer and create a new one. Most common use: extending endDate to keep a campaign running.',
      inputSchema: z.object({
        offerId: SubscriptionIntroductoryOfferIdSchema,
        startDate: StartDateSchema.optional(),
        endDate: StartDateSchema.optional(),
        pricePointId: PricePointIdSchema.optional(),
      }),
    },
    async ({ offerId, startDate, endDate, pricePointId }) => {
      if (startDate === undefined && endDate === undefined && pricePointId === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Pass at least one of startDate, endDate, pricePointId. Apple PATCH does not support changing offerMode, duration, or numberOfPeriods — delete and re-create instead.',
            },
          ],
          isError: true,
        };
      }
      if (startDate !== undefined && endDate !== undefined && endDate <= startDate) {
        return {
          content: [
            {
              type: 'text',
              text: `endDate (${endDate}) must be after startDate (${startDate}).`,
            },
          ],
          isError: true,
        };
      }
      const body = buildIntroOfferPatchBody(offerId, { startDate, endDate, pricePointId });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionIntroductoryOffers/${encodeURIComponent(offerId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_subscription_introductory_offer',
    {
      title: 'Delete a subscription introductory offer',
      description:
        'Delete a pending or active introductory offer by ID. Apple refuses to delete an offer that is currently redeemable by users — to stop an active offer, PATCH endDate to today instead.',
      inputSchema: z.object({
        offerId: SubscriptionIntroductoryOfferIdSchema,
      }),
    },
    async ({ offerId }) => {
      try {
        await client.request<void>(
          `/v1/subscriptionIntroductoryOffers/${encodeURIComponent(offerId)}`,
          { method: 'DELETE' },
        );
        return { content: [{ type: 'text', text: `Deleted introductory offer ${offerId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
