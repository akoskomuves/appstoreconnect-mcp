import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestOfferCodeOneTimeUseBatches, digestOfferCodes } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  CustomerEligibilitiesSchema,
  ExpirationDateSchema,
  NumberOfPeriodsSchema,
  OfferCodeNameSchema,
  OfferEligibilitySchema,
  OfferModeSchema,
  PricePointIdSchema,
  SubscriptionIdSchema,
  SubscriptionOfferCodeIdSchema,
  SubscriptionOfferCodeOneTimeUseCodesIdSchema,
  SubscriptionOfferDurationSchema,
  TerritoryIdSchema,
  TotalNumberOfCodesSchema,
} from '../schemas.js';

// Subscription offer codes are App Store Connect's "Offer Codes" feature
// (the third subscription-discount mechanism alongside intro offers and
// promotional offers). Unlike promo offers — which target existing/lapsed
// subscribers via an in-app SubscriptionOffer redemption — offer codes are
// user-facing redemption strings the customer enters in the App Store.
//
// Apple's model has three layers:
//
//   1. The CAMPAIGN (`subscriptionOfferCodes`). Carries name,
//      customerEligibilities (NEW/EXISTING/EXPIRED), offerMode, duration,
//      numberOfPeriods, active, and per-territory prices (relationship,
//      modeled the same way as promo-offer prices).
//
//   2. ONE-TIME-USE BATCHES (`subscriptionOfferCodeOneTimeUseCodes`). Each
//      batch is a chunk of unique strings, one redemption per string. The
//      string values are NOT in the batch resource — they live at
//      /v1/subscriptionOfferCodeOneTimeUseCodes/{id}/values and are
//      retrieved by asc_export_subscription_offer_code_one_time_use_values.
//
//   3. CUSTOM (MULTI-USE) CODES — a single string redeemable by many people.
//      DEFERRED to v0.8.1. Not in this file.
//
// Key constraints (mirrors the promo-offer wire shape where it's the same):
//   - Apple caps active campaigns at 10 per subscription (working
//     assumption — surface Apple's error if the cap differs).
//   - Campaign `name` must be unique within the subscription and is
//     immutable post-create (same as offer-code uniqueness on promo offers,
//     except here it's the human-readable `name` that's the lookup key).
//   - PATCH on the campaign only mutates `active` (everything else
//     immutable). Per-territory prices are set at create and cannot be
//     patched. Apple does NOT expose DELETE on this resource — the only
//     way to retire a campaign is PATCH active=false, which leaves the
//     row in ASC permanently (still counts against the cap).
//   - One-time-use batches: `numberOfCodes` and `expirationDate` set at
//     create, immutable. PATCH only toggles `active` (deactivates the batch
//     so unredeemed codes can no longer be used).
//   - The /values endpoint returns the raw code strings. Returned size
//     scales with batch size; the export tool caps per-call output.

const OFFER_CODE_FIELDS =
  'name,customerEligibilities,offerEligibility,offerMode,duration,numberOfPeriods,active,totalNumberOfCodes';
const ONE_TIME_USE_FIELDS = 'numberOfCodes,expirationDate,active,createdDate';

type OfferMode = z.infer<typeof OfferModeSchema>;
type OfferDuration = z.infer<typeof SubscriptionOfferDurationSchema>;
type CustomerEligibility = z.infer<typeof CustomerEligibilitiesSchema>[number];
type OfferEligibility = z.infer<typeof OfferEligibilitySchema>;

interface OfferCodePriceEntry {
  territoryId: string;
  // Optional because FREE_TRIAL offer codes don't carry a price point —
  // each price row's subscriptionPricePoint relationship must serialize as
  // { data: null }. For PAY_AS_YOU_GO / PAY_UP_FRONT this is required; the
  // tool handler validates that before calling the body builder.
  pricePointId?: string | undefined;
}

export interface OfferCodeCreateInput {
  subscriptionId: string;
  name: string;
  customerEligibilities: CustomerEligibility[];
  offerEligibility: OfferEligibility;
  offerMode: OfferMode;
  duration: OfferDuration;
  // Apple requires numberOfPeriods on every offerMode, including FREE_TRIAL
  // and PAY_UP_FRONT — even though it's logically only meaningful for
  // PAY_AS_YOU_GO. v0.8.0 shipped with it conditional; the post then 409'd.
  numberOfPeriods: number;
  prices: OfferCodePriceEntry[];
}

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
  included?: Array<{
    type: string;
    id: string;
    attributes?: Record<string, unknown>;
    // Some relationships are conditional (e.g. FREE_TRIAL offer-code prices
    // omit subscriptionPricePoint entirely — the key is absent, not null).
    // Record's index signature already permits missing keys.
    relationships: Record<string, { data: { type: string; id: string } }>;
  }>;
}

function tempId(n: number): string {
  // Apple's JSON:API temp-ID convention for unsaved resources — literal
  // `${N}` strings on the wire. Built via concatenation so biome's
  // noTemplateCurlyInString rule doesn't false-flag template literals.
  return `\${${n}}`;
}

function buildIncludedPrices(prices: OfferCodePriceEntry[], offerMode: OfferMode) {
  // FREE_TRIAL is the only mode without a price-point. Apple's validator
  // surfaces it as "subscriptionPricePoint must be null", but the
  // persistence layer 500s if you send the key explicitly as { data: null }
  // — the Swift SDK uses encodeIfPresent (Swift's omit-when-nil idiom), so
  // the correct wire form is to OMIT the subscriptionPricePoint key
  // entirely. Live smoke caught both bugs: v0.8.0 sent { data: { type, id } }
  // (415-class); the first fix sent { data: null } (500); this is the
  // spec-compliant version.
  const isFreeTrial = offerMode === 'FREE_TRIAL';
  return prices.map((p, i) => {
    const relationships: Record<string, { data: { type: string; id: string } }> = {
      territory: { data: { type: 'territories', id: p.territoryId } },
    };
    if (!isFreeTrial) {
      relationships.subscriptionPricePoint = {
        data: { type: 'subscriptionPricePoints', id: p.pricePointId as string },
      };
    }
    return {
      type: 'subscriptionOfferCodePrices',
      id: tempId(i + 1),
      relationships,
    };
  });
}

export function buildOfferCodeBody(input: OfferCodeCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    name: input.name,
    customerEligibilities: input.customerEligibilities,
    offerEligibility: input.offerEligibility,
    offerMode: input.offerMode,
    duration: input.duration,
    numberOfPeriods: input.numberOfPeriods,
  };

  const included = buildIncludedPrices(input.prices, input.offerMode);
  return {
    data: {
      type: 'subscriptionOfferCodes',
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

export interface OfferCodePatchInput {
  offerCodeId: string;
  active: boolean;
}

export function buildOfferCodePatchBody(input: OfferCodePatchInput): JSONAPIBody {
  // Apple's PATCH schema on this resource only permits `active`. No
  // relationships block — touching prices would 422 since prices are
  // immutable post-create.
  return {
    data: {
      type: 'subscriptionOfferCodes',
      id: input.offerCodeId,
      attributes: { active: input.active },
      relationships: {},
    },
  };
}

export interface OneTimeUseCreateInput {
  offerCodeId: string;
  numberOfCodes: number;
  expirationDate: string;
}

export function buildOneTimeUseBody(input: OneTimeUseCreateInput): JSONAPIBody {
  // Apple's CREATE schema for this resource accepts only numberOfCodes +
  // expirationDate (+ optional environment, deferred to v0.8.1). The `active`
  // flag is PATCH-only — sending it on create surfaces as a validation
  // rejection (live smoke caught this). New batches default to active on
  // Apple's side.
  return {
    data: {
      type: 'subscriptionOfferCodeOneTimeUseCodes',
      attributes: {
        numberOfCodes: input.numberOfCodes,
        expirationDate: input.expirationDate,
      },
      relationships: {
        offerCode: {
          data: { type: 'subscriptionOfferCodes', id: input.offerCodeId },
        },
      },
    },
  };
}

export interface OneTimeUsePatchInput {
  oneTimeUseId: string;
  active: boolean;
}

export function buildOneTimeUsePatchBody(input: OneTimeUsePatchInput): JSONAPIBody {
  return {
    data: {
      type: 'subscriptionOfferCodeOneTimeUseCodes',
      id: input.oneTimeUseId,
      attributes: { active: input.active },
      relationships: {},
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

export function registerOfferCodes(server: McpServer, client: ASCClient): void {
  // ----- Campaign CRUD -----

  server.registerTool(
    'asc_list_subscription_offer_codes',
    {
      title: 'List subscription offer code campaigns',
      description:
        'List offer-code campaigns configured for a subscription. Each campaign carries name, customer-eligibility cohorts (NEW/EXISTING/EXPIRED), offer mode, duration, and an active flag. Per-territory prices are linked via the prices relationship; one-time-use code batches and custom codes hang off the campaign via separate endpoints.',
      inputSchema: {
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ subscriptionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'prices');
      params.set('fields[subscriptionOfferCodes]', OFFER_CODE_FIELDS);
      params.set('limit', '200');
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/offerCodes?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestOfferCodes(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_subscription_offer_code',
    {
      title: 'Get a subscription offer code campaign',
      description:
        'Fetch a single offer-code campaign by ID, including its per-territory prices, one-time-use code batches, and custom codes (if any).',
      inputSchema: {
        offerCodeId: SubscriptionOfferCodeIdSchema,
        raw: z.boolean().default(false),
      },
    },
    async ({ offerCodeId, raw }) => {
      const path = `/v1/subscriptionOfferCodes/${encodeURIComponent(
        offerCodeId,
      )}?include=subscription,prices,oneTimeUseCodes,customCodes`;
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
    'asc_post_subscription_offer_code',
    {
      title: 'Create a subscription offer code campaign',
      description:
        'Create an offer-code campaign atomically: name + customer eligibilities + mode + duration + all per-territory prices in one POST. Apple caps active campaigns at 10 per subscription; this tool pre-flights the count and refuses if at the limit. ' +
        'Immutability: name, customerEligibilities, offerEligibility, offerMode, duration, numberOfPeriods, and per-territory prices are ALL immutable after creation. PATCH only toggles `active`. Apple does NOT expose DELETE on this resource — the only retirement path is PATCH active=false, which renders the campaign inert but leaves the row in App Store Connect (still counts against the per-subscription cap). Pick `name` and prices carefully on first creation. ' +
        'After creation, generate redeemable code strings with asc_post_subscription_offer_code_one_time_use_codes (bulk batches). Custom multi-use codes will land in v0.8.1.',
      inputSchema: {
        subscriptionId: SubscriptionIdSchema,
        name: OfferCodeNameSchema,
        customerEligibilities: CustomerEligibilitiesSchema,
        offerEligibility: OfferEligibilitySchema,
        offerMode: OfferModeSchema,
        duration: SubscriptionOfferDurationSchema,
        numberOfPeriods: NumberOfPeriodsSchema.describe(
          "Required for every offerMode (FREE_TRIAL/PAY_UP_FRONT/PAY_AS_YOU_GO) — Apple's create endpoint rejects requests without it, even though logically it only governs the PAY_AS_YOU_GO period count. Set to 1 for one-shot modes.",
        ),
        prices: z
          .array(
            z.object({
              territoryId: TerritoryIdSchema,
              pricePointId: PricePointIdSchema.optional().describe(
                'Required for PAY_AS_YOU_GO and PAY_UP_FRONT modes. Omit (or leave undefined) for FREE_TRIAL — Apple wants the per-territory price-point relationship serialized as null, since free trials have no charge.',
              ),
            }),
          )
          .min(1)
          .describe(
            'Per-territory prices. Each entry is (territoryId, pricePointId). At least one required. For FREE_TRIAL, pricePointId is omitted per territory (Apple rejects requests that pass a price point for free trials). For other modes, use asc_list_subscription_price_points to pick price points per territory (nearAmount narrows to a target band).',
          ),
      },
    },
    async (input) => {
      // Mode/price-point consistency check. For FREE_TRIAL, pricePointId must
      // not be set (Apple rejects). For other modes, every entry must carry
      // one. Both directions are footguns — the only safe place to catch
      // them is here before the body builder, since Apple's error pointers
      // are at the relationships layer and hard to map back.
      if (input.offerMode === 'FREE_TRIAL') {
        const stray = input.prices.find((p) => p.pricePointId !== undefined);
        if (stray) {
          return {
            content: [
              {
                type: 'text',
                text: `Refused: FREE_TRIAL offer codes must not carry pricePointId on any price entry (Apple rejects with a relationship validation error). Drop pricePointId from the entry for territory ${stray.territoryId}.`,
              },
            ],
            isError: true,
          };
        }
      } else {
        const missing = input.prices.find((p) => !p.pricePointId);
        if (missing) {
          return {
            content: [
              {
                type: 'text',
                text: `Refused: offerMode=${input.offerMode} requires pricePointId on every price entry. Missing on territory ${missing.territoryId}.`,
              },
            ],
            isError: true,
          };
        }
      }
      // Pre-flight: refuse if at the 10-campaign cap or if the campaign
      // name collides with an existing one. Mirrors the promo-offer
      // pattern — Apple's error message is fine, but giving the caller a
      // clear remedy saves a round-trip.
      try {
        const listParams = new URLSearchParams();
        listParams.set('fields[subscriptionOfferCodes]', OFFER_CODE_FIELDS);
        listParams.set('limit', '200');
        const existing = await paginate(
          client,
          `/v1/subscriptions/${encodeURIComponent(
            input.subscriptionId,
          )}/offerCodes?${listParams.toString()}`,
          200,
        );
        if (existing.data.length >= 10) {
          return {
            content: [
              {
                type: 'text',
                text: `Refused: subscription ${input.subscriptionId} already has ${existing.data.length} offer-code campaigns, at Apple's cap of 10. Apple's API does not expose DELETE on offer-code campaigns — old campaigns can only be deactivated (asc_patch_subscription_offer_code with active=false), and deactivated campaigns still count against the cap. To free a slot, deactivate one and request manual removal in App Store Connect UI.`,
              },
            ],
            isError: true,
          };
        }
        const nameCollision = existing.data.find((o) => o.attributes?.['name'] === input.name);
        if (nameCollision) {
          return {
            content: [
              {
                type: 'text',
                text: `Refused: campaign name "${input.name}" is already in use by offer code ${nameCollision.id} on this subscription. Campaign name must be unique per subscription and is immutable after creation. Apple has no DELETE on this resource — pick a different name (e.g. append a date or version suffix).`,
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
              text: `Pre-flight failed (could not list existing offer-code campaigns): ${formatASCError(err)}`,
            },
          ],
          isError: true,
        };
      }
      const body = buildOfferCodeBody(input);
      try {
        const data = await client.request<unknown>('/v1/subscriptionOfferCodes', {
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
    'asc_patch_subscription_offer_code',
    {
      title: 'Toggle a subscription offer code campaign active flag',
      description:
        'Activate or deactivate an offer-code campaign. Apple PATCH on this resource only permits flipping `active` — name, eligibilities, mode, duration, numberOfPeriods, and prices are all immutable. Deactivating a campaign stops new redemptions across every batch and custom code under it; existing subscribers who already redeemed keep their offer.',
      inputSchema: {
        offerCodeId: SubscriptionOfferCodeIdSchema,
        active: z
          .boolean()
          .describe('true to activate, false to deactivate. Toggle is reversible.'),
      },
    },
    async ({ offerCodeId, active }) => {
      const body = buildOfferCodePatchBody({ offerCodeId, active });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionOfferCodes/${encodeURIComponent(offerCodeId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Set active=${active} on offer code ${offerCodeId}.\n\n${JSON.stringify(
                data,
                null,
                2,
              )}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // No delete tool: Apple's API does NOT expose DELETE on
  // /v1/subscriptionOfferCodes. Campaigns can only be deactivated (PATCH
  // active=false), which stops further redemption but leaves the row in
  // App Store Connect. Deactivated campaigns are inert but still count
  // against the per-subscription cap. Live smoke confirmed this — the
  // earlier asc_delete_subscription_offer_code tool was removed in
  // v0.8.0's bugfix cycle.

  // ----- One-time-use code batches -----

  server.registerTool(
    'asc_list_subscription_offer_code_one_time_use_codes',
    {
      title: 'List one-time-use code batches for an offer code campaign',
      description:
        'List one-time-use code batches under an offer-code campaign. Each batch carries numberOfCodes, expirationDate, active, and createdDate — the actual redeemable strings are retrieved with asc_export_subscription_offer_code_one_time_use_values against a specific batch.',
      inputSchema: {
        offerCodeId: SubscriptionOfferCodeIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ offerCodeId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptionOfferCodeOneTimeUseCodes]', ONE_TIME_USE_FIELDS);
      params.set('limit', '200');
      const path = `/v1/subscriptionOfferCodes/${encodeURIComponent(
        offerCodeId,
      )}/oneTimeUseCodes?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestOfferCodeOneTimeUseBatches(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_offer_code_one_time_use_codes',
    {
      title: 'Generate a batch of one-time-use offer codes',
      description:
        'Create a batch of unique single-redemption codes against an existing offer-code campaign. Apple generates the code strings server-side — retrieve them with asc_export_subscription_offer_code_one_time_use_values. ' +
        "numberOfCodes and expirationDate are immutable after creation; PATCH only toggles `active` (deactivating revokes unredeemed codes in the batch). Apple's per-batch cap is 25,000 codes (working assumption; if Apple disagrees, the error surfaces verbatim).",
      inputSchema: {
        offerCodeId: SubscriptionOfferCodeIdSchema,
        numberOfCodes: TotalNumberOfCodesSchema,
        expirationDate: ExpirationDateSchema,
      },
    },
    async (input) => {
      const body = buildOneTimeUseBody(input);
      try {
        const data = await client.request<unknown>('/v1/subscriptionOfferCodeOneTimeUseCodes', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Generated ${input.numberOfCodes} one-time-use codes for offer code ${input.offerCodeId} (expires ${input.expirationDate}).\n\n${JSON.stringify(
                data,
                null,
                2,
              )}\n\nRetrieve the code strings with asc_export_subscription_offer_code_one_time_use_values <batchId>.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription_offer_code_one_time_use_codes',
    {
      title: 'Toggle a one-time-use code batch active flag',
      description:
        'Activate or deactivate a one-time-use code batch. Apple PATCH on this resource only permits flipping `active` — numberOfCodes and expirationDate are immutable. Deactivating a batch stops further redemption of any unredeemed code in the batch; redemptions already completed are untouched. Use this to kill a leaked batch without nuking the parent campaign.',
      inputSchema: {
        oneTimeUseId: SubscriptionOfferCodeOneTimeUseCodesIdSchema,
        active: z.boolean(),
      },
    },
    async ({ oneTimeUseId, active }) => {
      const body = buildOneTimeUsePatchBody({ oneTimeUseId, active });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionOfferCodeOneTimeUseCodes/${encodeURIComponent(oneTimeUseId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Set active=${active} on one-time-use batch ${oneTimeUseId}.\n\n${JSON.stringify(
                data,
                null,
                2,
              )}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- CSV export -----

  server.registerTool(
    'asc_export_subscription_offer_code_one_time_use_values',
    {
      title: 'Export one-time-use code values as CSV',
      description:
        'Fetch the redeemable code strings inside a one-time-use batch. Apple serves the response as text/csv directly — this tool passes it through verbatim. These are the strings to hand to customers; treat them as secrets. ' +
        'Use `raw: true` to skip the leading summary line and return only the CSV body, suitable for piping to a file.',
      inputSchema: {
        oneTimeUseId: SubscriptionOfferCodeOneTimeUseCodesIdSchema,
        raw: z.boolean().default(false),
      },
    },
    async ({ oneTimeUseId, raw }) => {
      const path = `/v1/subscriptionOfferCodeOneTimeUseCodes/${encodeURIComponent(
        oneTimeUseId,
      )}/values`;
      try {
        // Apple returns this endpoint as text/csv, not JSON. requestText
        // sends Accept: text/csv and returns the body unparsed.
        const csv = await client.requestText(path, { method: 'GET' });
        if (raw) {
          return { content: [{ type: 'text', text: csv }] };
        }
        const summary = `Exported one-time-use code values for batch ${oneTimeUseId}. These strings are redeemable secrets — handle accordingly.\n\n`;
        return { content: [{ type: 'text', text: `${summary}${csv}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
