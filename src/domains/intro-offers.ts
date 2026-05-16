import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestIntroOffers } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
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
// Per (subscription, territory) cell you can have at most one active offer.
// A null territory = Apple's "all territories" wildcard, but the price point
// is then literal (no auto-FX). For PPP-aware per-territory pricing you must
// create one offer row per territory.

type OfferMode = z.infer<typeof OfferModeSchema>;
type OfferDuration = z.infer<typeof SubscriptionOfferDurationSchema>;

export interface IntroOfferInput {
  subscriptionId: string;
  territoryId: string | undefined;
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
  if (input.offerMode === 'PAY_AS_YOU_GO' && input.numberOfPeriods !== undefined) {
    attributes.numberOfPeriods = input.numberOfPeriods;
  }

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
        'List introductory offers (free trial / pay-as-you-go / pay-up-front) configured for a subscription, across territories. ' +
        'Auto-paginates; pass raw:true for the full JSON:API payload. Wildcard offers (Apple\'s "all territories") show TERR as "(all)".',
      inputSchema: {
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ subscriptionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'territory,subscriptionPricePoint');
      params.set('limit', '200');
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/introductoryOffers?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestIntroOffers(pages);
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
      inputSchema: {
        offerId: SubscriptionIntroductoryOfferIdSchema,
        raw: z.boolean().default(false),
      },
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
        'Create an introductory offer on a subscription. Server-side checks: pricePointId required unless offerMode=FREE_TRIAL; numberOfPeriods required when offerMode=PAY_AS_YOU_GO; ' +
        'territoryId omitted = Apple\'s "all territories" wildcard (uses the literal price point in every market — for PPP-aware multi-territory offers, create one per territory). ' +
        'startDate must be ≥ today+24h (Apple); ≥7 days recommended.',
      inputSchema: {
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
        numberOfPeriods: NumberOfPeriodsSchema.optional(),
      },
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
      inputSchema: {
        offerId: SubscriptionIntroductoryOfferIdSchema,
        startDate: StartDateSchema.optional(),
        endDate: StartDateSchema.optional(),
        pricePointId: PricePointIdSchema.optional(),
      },
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
      inputSchema: {
        offerId: SubscriptionIntroductoryOfferIdSchema,
      },
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
