import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestPromotionalOfferPrices, digestPromotionalOffers } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  NumberOfPeriodsSchema,
  OfferCodeSchema,
  OfferModeSchema,
  OfferNameSchema,
  PricePointIdSchema,
  SubscriptionIdSchema,
  SubscriptionOfferDurationSchema,
  SubscriptionPromotionalOfferIdSchema,
  TerritoryIdSchema,
} from '../schemas.js';

// Explicit attribute selector for SubscriptionPromotionalOffer reads. Without
// this, Apple's default JSON:API response shape *should* include all
// attributes — but we depend on `offerCode` for collision detection in the
// post pre-flight, and a silent omission there (sparse-fieldset defaults
// change between OpenAPI revisions) would cause the duplicate check to
// silently no-op against existing offers. Pinning the selector hardens both
// the digest and the pre-flight against that drift.
const PROMO_OFFER_FIELDS = 'offerCode,name,offerMode,duration,numberOfPeriods';

// Subscription promotional offers are discounts targeted at EXISTING or LAPSED
// subscribers (opposite eligibility from intro offers, which target NEW subs).
// Apple's API splits the data differently than intro offers:
//   - The offer carries name, offerCode, mode, duration, numberOfPeriods —
//     but NO startDate, NO endDate, NO eligibility field (eligibility is
//     fixed by the resource type itself).
//   - Per-territory prices live in `included[]` on the offer's POST/PATCH,
//     not on a standalone /prices endpoint. There's no way to create or
//     delete a single price row in isolation.
//   - PATCH only permits changing the prices relationship — name, offerCode,
//     offerMode, duration, numberOfPeriods are all immutable after creation.
//   - Apple caps active promo offers at 10 per subscription.
//
// JWT signing for in-app redemption (a separate .p8 / different key from the
// ASC API key) lives in offer-signing.ts (added in v0.7.0).

type OfferMode = z.infer<typeof OfferModeSchema>;
type OfferDuration = z.infer<typeof SubscriptionOfferDurationSchema>;

interface PromoOfferPriceEntry {
  territoryId: string;
  pricePointId: string;
}

export interface PromoOfferCreateInput {
  subscriptionId: string;
  name: string;
  offerCode: string;
  offerMode: OfferMode;
  duration: OfferDuration;
  numberOfPeriods?: number | undefined;
  prices: PromoOfferPriceEntry[];
}

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
  included: Array<{
    type: string;
    id: string;
    relationships: Record<string, { data: { type: string; id: string } }>;
  }>;
}

function tempId(n: number): string {
  // Apple's JSON:API temp-ID convention for unsaved resources: literal
  // `${N}` strings on the wire. Built via concatenation so biome's
  // noTemplateCurlyInString rule doesn't false-flag template literals.
  return `\${${n}}`;
}

function buildIncludedPrices(prices: PromoOfferPriceEntry[]) {
  return prices.map((p, i) => ({
    type: 'subscriptionPromotionalOfferPrices',
    id: tempId(i + 1),
    relationships: {
      territory: { data: { type: 'territories', id: p.territoryId } },
      subscriptionPricePoint: {
        data: { type: 'subscriptionPricePoints', id: p.pricePointId },
      },
    },
  }));
}

export function buildPromoOfferBody(input: PromoOfferCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    name: input.name,
    offerCode: input.offerCode,
    offerMode: input.offerMode,
    duration: input.duration,
  };
  // Same rule as intro offers: Apple requires numberOfPeriods for paid modes,
  // not just PAY_AS_YOU_GO (the intro-offer endpoint 409s a PAY_UP_FRONT
  // create without it — ENTITY_ERROR.ATTRIBUTE.REQUIRED). Default PAY_UP_FRONT
  // to 1 (single up-front charge) when the caller omits it.
  const numberOfPeriods =
    input.numberOfPeriods ?? (input.offerMode === 'PAY_UP_FRONT' ? 1 : undefined);
  if (numberOfPeriods !== undefined) attributes.numberOfPeriods = numberOfPeriods;

  const included = buildIncludedPrices(input.prices);
  return {
    data: {
      type: 'subscriptionPromotionalOffers',
      attributes,
      relationships: {
        subscription: { data: { type: 'subscriptions', id: input.subscriptionId } },
        prices: {
          data: included.map((r) => ({ type: r.type, id: r.id })),
        },
      },
    },
    included,
  };
}

export function buildPromoOfferPatchBody(
  offerId: string,
  prices: PromoOfferPriceEntry[],
): JSONAPIBody {
  const included = buildIncludedPrices(prices);
  // No attributes block: Apple's update schema does not permit attribute
  // changes, and including an empty attributes:{} can still confuse the API.
  return {
    data: {
      type: 'subscriptionPromotionalOffers',
      id: offerId,
      relationships: {
        prices: {
          data: included.map((r) => ({ type: r.type, id: r.id })),
        },
      },
    },
    included,
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

// Read the current prices for an existing offer. Used by patch_prices in
// 'add' / 'remove' modes to construct the right post-state without forcing
// the caller to re-list all territories.
async function fetchCurrentPrices(
  client: ASCClient,
  offerId: string,
): Promise<PromoOfferPriceEntry[]> {
  const path = `/v1/subscriptionPromotionalOffers/${encodeURIComponent(
    offerId,
  )}/prices?include=territory,subscriptionPricePoint`;
  const pages = await paginate(client, path, 2000);
  const out: PromoOfferPriceEntry[] = [];
  for (const price of pages.data) {
    const territoryRel = price.relationships?.['territory']?.data;
    const pointRel = price.relationships?.['subscriptionPricePoint']?.data;
    const territoryId = territoryRel && !Array.isArray(territoryRel) ? territoryRel.id : undefined;
    const pricePointId = pointRel && !Array.isArray(pointRel) ? pointRel.id : undefined;
    if (!territoryId || !pricePointId) continue;
    out.push({ territoryId, pricePointId });
  }
  return out;
}

export function registerPromoOffers(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_promotional_offers',
    {
      title: 'List subscription promotional offers',
      description:
        'List promotional offers (PAY_AS_YOU_GO / PAY_UP_FRONT / FREE_TRIAL) configured for a subscription. Promo offers target existing or lapsed subscribers (intro offers target new subscribers). Apple caps active promo offers at 10 per subscription.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'prices');
      params.set('fields[subscriptionPromotionalOffers]', PROMO_OFFER_FIELDS);
      params.set('limit', '200');
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/promotionalOffers?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestPromotionalOffers(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_subscription_promotional_offer',
    {
      title: 'Get a subscription promotional offer',
      description: 'Fetch a single promotional offer by ID, including its per-territory prices.',
      inputSchema: z.object({
        offerId: SubscriptionPromotionalOfferIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ offerId, raw }) => {
      const path = `/v1/subscriptionPromotionalOffers/${encodeURIComponent(
        offerId,
      )}?include=subscription,prices`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        if (raw) {
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_subscription_promotional_offer_prices',
    {
      title: 'List subscription promotional offer prices',
      description:
        'List the per-territory price rows attached to a promotional offer. Each row is a (territory, subscriptionPricePoint) pair — the price-point amount is resolved via the included subscriptionPricePoints resources.',
      inputSchema: z.object({
        offerId: SubscriptionPromotionalOfferIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ offerId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'territory,subscriptionPricePoint');
      params.set('limit', '200');
      const path = `/v1/subscriptionPromotionalOffers/${encodeURIComponent(
        offerId,
      )}/prices?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestPromotionalOfferPrices(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_promotional_offer',
    {
      title: 'Create a subscription promotional offer',
      description:
        'Create a promotional offer with name + offerCode + mode + duration plus all per-territory prices in one atomic POST. Apple caps active promo offers at 10 per subscription; this tool pre-flights the count and refuses if at the limit. ' +
        'Immutability: name, offerCode, mode, duration, and numberOfPeriods are immutable after creation — to change any of them, delete and re-create. Use asc_patch_subscription_promotional_offer_prices to update prices only. ' +
        'numberOfPeriods is required for PAY_AS_YOU_GO; for PAY_UP_FRONT it defaults to 1 (single up-front period) when omitted. ' +
        'offerCode must be unique within the subscription (used by StoreKit as SubscriptionOffer.id when redeeming).',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        name: OfferNameSchema,
        offerCode: OfferCodeSchema,
        offerMode: OfferModeSchema,
        duration: SubscriptionOfferDurationSchema,
        numberOfPeriods: NumberOfPeriodsSchema.optional().describe(
          'Required for PAY_AS_YOU_GO (how many periods the discounted price repeats). PAY_UP_FRONT: defaults to 1 when omitted. Not sent for FREE_TRIAL.',
        ),
        prices: z
          .array(
            z.object({
              territoryId: TerritoryIdSchema,
              pricePointId: PricePointIdSchema,
            }),
          )
          .min(1)
          .describe(
            'Per-territory prices. Each entry is (territoryId, pricePointId). At least one required. Use asc_list_subscription_price_points to pick price points per territory (nearAmount narrows to a target band).',
          ),
      }),
    },
    async (input) => {
      if (input.offerMode === 'PAY_AS_YOU_GO' && input.numberOfPeriods === undefined) {
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
      // Pre-flight: refuse if already at the 10-offer cap. Saves a roundtrip
      // to Apple for a guaranteed 422 / 409. The fields[] selector pins
      // `offerCode` into the response so the collision check below can't
      // silently no-op on a sparse-fieldset default change.
      try {
        const listParams = new URLSearchParams();
        listParams.set('fields[subscriptionPromotionalOffers]', PROMO_OFFER_FIELDS);
        listParams.set('limit', '200');
        const existing = await paginate(
          client,
          `/v1/subscriptions/${encodeURIComponent(
            input.subscriptionId,
          )}/promotionalOffers?${listParams.toString()}`,
          200,
        );
        if (existing.data.length >= 10) {
          return {
            content: [
              {
                type: 'text',
                text: `Refused: subscription ${input.subscriptionId} already has ${existing.data.length} promotional offers, at Apple's cap of 10. Delete an existing offer with asc_delete_subscription_promotional_offer before creating a new one.`,
              },
            ],
            isError: true,
          };
        }
        const codeCollision = existing.data.find(
          (o) => o.attributes?.['offerCode'] === input.offerCode,
        );
        if (codeCollision) {
          return {
            content: [
              {
                type: 'text',
                text: `Refused: offerCode "${input.offerCode}" is already in use by promo offer ${codeCollision.id} on this subscription. offerCode must be unique per subscription, and is immutable after creation — pick a different code or delete the existing offer first.`,
              },
            ],
            isError: true,
          };
        }
      } catch (err) {
        // Pre-flight failed (network, auth, etc.). Don't proceed blind — the
        // caller deserves the error, and trying the create anyway risks a
        // confusing partial state.
        return {
          content: [
            {
              type: 'text',
              text: `Pre-flight failed (could not list existing promo offers): ${formatASCError(err)}`,
            },
          ],
          isError: true,
        };
      }
      const body = buildPromoOfferBody(input);
      try {
        const data = await client.request<unknown>('/v1/subscriptionPromotionalOffers', {
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
    'asc_patch_subscription_promotional_offer_prices',
    {
      title: 'Replace the prices on a promotional offer',
      description:
        'Update the per-territory prices on an existing promotional offer. Apple PATCH on this resource only permits price changes — name, offerCode, mode, duration, and numberOfPeriods are immutable post-create. ' +
        "FOOTGUN: Apple's wire semantic is REPLACE — the prices array becomes the new post-state, dropping any territory not listed. This tool's mode parameter abstracts that: " +
        "'replace' (raw wire semantic — you pass the full new set), 'add' (reads current prices, appends/overrides your entries by territory, posts the union — safe when extending an offer to new markets without dropping existing ones), 'remove' (reads current, filters out the territories you list, posts the difference).",
      inputSchema: z.object({
        offerId: SubscriptionPromotionalOfferIdSchema,
        mode: z
          .enum(['replace', 'add', 'remove'])
          .default('replace')
          .describe(
            "'replace' (default): the prices array IS the new post-state. 'add': merge into current prices by territory (your entries override existing ones for those territories; territories you don't list are preserved). 'remove': drop the listed territories from current prices (pricePointId is ignored in this mode).",
          ),
        prices: z
          .array(
            z.object({
              territoryId: TerritoryIdSchema,
              pricePointId: PricePointIdSchema.optional().describe(
                "Required for 'replace' and 'add' modes. Ignored for 'remove' mode (only territoryId is used).",
              ),
            }),
          )
          .min(1),
      }),
    },
    async ({ offerId, mode, prices }) => {
      // Validate inputs per mode.
      if (mode !== 'remove') {
        for (const p of prices) {
          if (!p.pricePointId) {
            return {
              content: [
                {
                  type: 'text',
                  text: `pricePointId is required for every price entry when mode="${mode}". Only "remove" mode ignores pricePointId.`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      let finalPrices: PromoOfferPriceEntry[];
      try {
        if (mode === 'replace') {
          finalPrices = prices.map((p) => ({
            territoryId: p.territoryId,
            pricePointId: p.pricePointId as string,
          }));
        } else {
          const current = await fetchCurrentPrices(client, offerId);
          if (mode === 'add') {
            const byTerritory = new Map(current.map((p) => [p.territoryId, p]));
            for (const p of prices) {
              byTerritory.set(p.territoryId, {
                territoryId: p.territoryId,
                pricePointId: p.pricePointId as string,
              });
            }
            finalPrices = Array.from(byTerritory.values());
          } else {
            // remove
            const drop = new Set(prices.map((p) => p.territoryId));
            finalPrices = current.filter((p) => !drop.has(p.territoryId));
            if (finalPrices.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Refused: removing the listed territories would leave the offer with zero prices. An offer must have at least one price row. Use asc_delete_subscription_promotional_offer to delete the offer entirely.',
                  },
                ],
                isError: true,
              };
            }
          }
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Could not resolve current prices for mode="${mode}": ${formatASCError(err)}`,
            },
          ],
          isError: true,
        };
      }

      const body = buildPromoOfferPatchBody(offerId, finalPrices);
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionPromotionalOffers/${encodeURIComponent(offerId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        const summary = `Patched promo offer ${offerId} (mode=${mode}, ${finalPrices.length} price row${
          finalPrices.length === 1 ? '' : 's'
        } in post-state).\n\n`;
        return { content: [{ type: 'text', text: `${summary}${JSON.stringify(data, null, 2)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_subscription_promotional_offer',
    {
      title: 'Delete a subscription promotional offer',
      description:
        'Delete a promotional offer by ID. Returns 204 on success. Apple does not document whether the offerCode is immediately reusable after delete — recommend appending a suffix when rotating campaigns rather than reusing the same code.',
      inputSchema: z.object({
        offerId: SubscriptionPromotionalOfferIdSchema,
      }),
    },
    async ({ offerId }) => {
      try {
        await client.request<void>(
          `/v1/subscriptionPromotionalOffers/${encodeURIComponent(offerId)}`,
          { method: 'DELETE' },
        );
        return { content: [{ type: 'text', text: `Deleted promotional offer ${offerId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
