import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestOfferCodeCustomCodes, digestOfferCodeOneTimeUseBatches } from '../digest.js';
import { ASCError } from '../errors.js';
import { type CollectedPages, type Column, formatTable, paginate } from '../jsonapi.js';
import {
  CustomCodeNumberOfCodesSchema,
  CustomCodeStringSchema,
  ExpirationDateSchema,
  InAppPurchaseIdSchema,
  InAppPurchasePricePointIdSchema,
  OfferCodeEnvironmentSchema,
  TerritoryIdSchema,
  TotalNumberOfCodesSchema,
} from '../schemas.js';
import { relCount } from './product-versions.js';

// In-app purchase offer codes (App Store Connect API 4.2) — offer codes for
// consumables, non-consumables and non-renewing subscriptions. Same three
// layers as the subscription offer codes in offer-codes.ts:
//
//   1. CAMPAIGN (`inAppPurchaseOfferCodes`): name + customerEligibilities +
//      per-territory prices, created inline in `included[]` as
//      `inAppPurchaseOfferPrices` (territory + pricePoint, where pricePoint is
//      an inAppPurchasePricePoints id — NOT subscriptionPricePoint).
//   2. ONE-TIME-USE BATCHES (`inAppPurchaseOfferCodeOneTimeUseCodes`):
//      numberOfCodes + expirationDate (+ environment). The strings live at
//      /values, served as text/csv.
//   3. CUSTOM (multi-use) CODES (`inAppPurchaseOfferCodeCustomCodes`):
//      customCode + numberOfCodes (+ optional expirationDate).
//
// How it differs from the subscription variant:
//   - customerEligibilities are spender cohorts: NON_SPENDER, ACTIVE_SPENDER,
//     CHURNED_SPENDER (subscriptions use NEW / EXISTING / EXPIRED).
//   - No offerMode, duration, numberOfPeriods, offerEligibility or
//     autoRenewEnabled — a one-off purchase has no periods or intro offer.
//   - The read model has no back-link to the IAP; list campaigns through
//     /v2/inAppPurchases/{id}/offerCodes.
//
// Same constraints as subscriptions: PATCH on all three resources takes only
// `active`; there is no DELETE on any of them. ppp mirrors the subscription
// pre-flight (10-campaign cap, name uniqueness) — both are working
// assumptions carried over from the subscription surface; Apple's error
// surfaces verbatim if its rule differs.

const IAP_OFFER_CODE_CAP = 10;

const OFFER_CODE_FIELDS =
  'name,customerEligibilities,active,productionCodeCount,sandboxCodeCount,prices';
const ONE_TIME_USE_FIELDS = 'numberOfCodes,expirationDate,active,createdDate,environment';
const CUSTOM_CODE_FIELDS = 'customCode,numberOfCodes,expirationDate,active,createdDate';
const PRICE_FIELDS = 'territory,pricePoint';

export const IapCustomerEligibilitiesSchema = z
  .array(z.enum(['NON_SPENDER', 'ACTIVE_SPENDER', 'CHURNED_SPENDER']))
  .min(1)
  .describe(
    'Which customers may redeem: NON_SPENDER (never bought in your app), ACTIVE_SPENDER (bought recently), CHURNED_SPENDER (bought before, not recently). At least one; pass all three for anyone. Immutable after creation.',
  );

export const IapOfferCodeIdSchema = z
  .string()
  .min(1)
  .describe(
    'IAP offer code (campaign) ID from asc_list_iap_offer_codes. The campaign is the config; redeemable codes live under it as one-time-use batches or custom codes.',
  );

export const IapOfferCodeOneTimeUseIdSchema = z
  .string()
  .min(1)
  .describe(
    'IAP offer code one-time-use batch ID from asc_list_iap_offer_code_one_time_use_codes.',
  );

export const IapOfferCodeCustomCodeIdSchema = z
  .string()
  .min(1)
  .describe('IAP offer code custom (multi-use) code ID from asc_list_iap_offer_code_custom_codes.');

type IapCustomerEligibility = z.infer<typeof IapCustomerEligibilitiesSchema>[number];

// ----- Body builders -----

interface JSONAPIBody {
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
  // Apple's JSON:API temp-ID convention for unsaved resources: literal `${N}`.
  return `\${${n}}`;
}

export interface IapOfferCodeCreateInput {
  inAppPurchaseId: string;
  name: string;
  customerEligibilities: IapCustomerEligibility[];
  prices: Array<{ territoryId: string; pricePointId: string }>;
}

export function buildIapOfferCodeBody(input: IapOfferCodeCreateInput): JSONAPIBody {
  const included = input.prices.map((p, i) => ({
    type: 'inAppPurchaseOfferPrices',
    id: tempId(i + 1),
    relationships: {
      territory: { data: { type: 'territories', id: p.territoryId } },
      pricePoint: { data: { type: 'inAppPurchasePricePoints', id: p.pricePointId } },
    },
  }));
  return {
    data: {
      type: 'inAppPurchaseOfferCodes',
      attributes: { name: input.name, customerEligibilities: input.customerEligibilities },
      relationships: {
        inAppPurchase: { data: { type: 'inAppPurchases', id: input.inAppPurchaseId } },
        prices: { data: included.map((r) => ({ type: r.type, id: r.id })) },
      },
    },
    included,
  };
}

export type IapOfferCodeResource =
  | 'inAppPurchaseOfferCodes'
  | 'inAppPurchaseOfferCodeOneTimeUseCodes'
  | 'inAppPurchaseOfferCodeCustomCodes';

export function buildIapOfferCodeActivePatchBody(
  type: IapOfferCodeResource,
  id: string,
  active: boolean,
): JSONAPIBody {
  // All three update schemas are attributes-only with a single `active`.
  return { data: { type, id, attributes: { active } } };
}

export interface IapOneTimeUseCreateInput {
  offerCodeId: string;
  numberOfCodes: number;
  expirationDate: string;
  environment?: 'SANDBOX' | 'PRODUCTION' | undefined;
}

export function buildIapOneTimeUseBody(input: IapOneTimeUseCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    numberOfCodes: input.numberOfCodes,
    expirationDate: input.expirationDate,
  };
  if (input.environment !== undefined) attributes.environment = input.environment;
  return {
    data: {
      type: 'inAppPurchaseOfferCodeOneTimeUseCodes',
      attributes,
      relationships: {
        offerCode: { data: { type: 'inAppPurchaseOfferCodes', id: input.offerCodeId } },
      },
    },
  };
}

export interface IapCustomCodeCreateInput {
  offerCodeId: string;
  customCode: string;
  numberOfCodes: number;
  expirationDate?: string | undefined;
}

export function buildIapCustomCodeBody(input: IapCustomCodeCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    customCode: input.customCode,
    numberOfCodes: input.numberOfCodes,
  };
  if (input.expirationDate !== undefined) attributes.expirationDate = input.expirationDate;
  return {
    data: {
      type: 'inAppPurchaseOfferCodeCustomCodes',
      attributes,
      relationships: {
        offerCode: { data: { type: 'inAppPurchaseOfferCodes', id: input.offerCodeId } },
      },
    },
  };
}

// ----- Pre-flight -----

export interface IapOfferCodePreflight {
  ok: boolean;
  reason?: string;
}

/** The cap + name-collision check, pure so tests can pin it. */
export function checkIapOfferCodePreflight(
  existing: CollectedPages,
  name: string,
  inAppPurchaseId: string,
): IapOfferCodePreflight {
  if (existing.data.length >= IAP_OFFER_CODE_CAP) {
    return {
      ok: false,
      reason: `Refused: in-app purchase ${inAppPurchaseId} already has ${existing.data.length} offer-code campaigns, at the cap of ${IAP_OFFER_CODE_CAP} (the subscription cap; assumed to hold for IAPs). Apple exposes no DELETE on offer-code campaigns, and deactivated ones still count.`,
    };
  }
  const clash = existing.data.find((o) => o.attributes?.['name'] === name);
  if (clash) {
    return {
      ok: false,
      reason: `Refused: campaign name "${name}" is already used by offer code ${clash.id} on this in-app purchase. Names are unique per product and immutable, and campaigns cannot be deleted; pick another name (e.g. add a date suffix).`,
    };
  }
  return { ok: true };
}

// ----- Digests -----

function attr(r: { attributes?: Record<string, unknown> }, key: string): string {
  const v = r.attributes?.[key];
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function footer(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ' (truncated — pass maxItems to fetch more)' : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

const ELIG_SHORT: Record<string, string> = {
  NON_SPENDER: 'N',
  ACTIVE_SPENDER: 'A',
  CHURNED_SPENDER: 'C',
};

export function digestIapOfferCodes(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'CUST_ELIG' },
    { header: 'ACTIVE' },
    { header: 'CODES', align: 'right' },
    { header: 'PRICES', align: 'right' },
    { header: 'CAMPAIGN_ID' },
  ];
  const rows = pages.data.map((c) => {
    const elig = (c.attributes?.['customerEligibilities'] as string[] | undefined) ?? [];
    const prod = c.attributes?.['productionCodeCount'];
    const sbx = c.attributes?.['sandboxCodeCount'];
    return [
      attr(c, 'name'),
      elig.map((e) => ELIG_SHORT[e] ?? e).join(''),
      attr(c, 'active'),
      prod === undefined && sbx === undefined ? '' : `${prod ?? 0}/${sbx ?? 0}`,
      relCount(c, 'prices'),
      c.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${footer(pages, 'IAP offer code campaigns')} (CUST_ELIG: N=NON_SPENDER A=ACTIVE_SPENDER C=CHURNED_SPENDER · CODES: prod/sbx)\n\n${formatTable(columns, rows)}`;
}

export function digestIapOfferPrices(pages: CollectedPages): string {
  const included = new Map(pages.included.map((r) => [`${r.type}/${r.id}`, r]));
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'CUSTOMER_PRICE', align: 'right' },
    { header: 'PROCEEDS', align: 'right' },
    { header: 'PRICE_POINT_ID' },
  ];
  const rows = pages.data.map((p) => {
    const terr = p.relationships?.['territory']?.data;
    const pp = p.relationships?.['pricePoint']?.data;
    const terrId = terr && !Array.isArray(terr) ? terr.id : '';
    const point = pp && !Array.isArray(pp) ? included.get(`${pp.type}/${pp.id}`) : undefined;
    return [
      terrId,
      point ? attr(point, 'customerPrice') : '',
      point ? attr(point, 'proceeds') : '',
      pp && !Array.isArray(pp) ? pp.id : '',
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${footer(pages, 'offer prices')}\n\n${formatTable(columns, rows)}`;
}

// ----- Helpers -----

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function errorResult(err: unknown) {
  return { content: [{ type: 'text' as const, text: formatASCError(err) }], isError: true };
}

function refused(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

const MaxItems = (n: number) => z.number().int().positive().max(2000).default(n);

export function registerIapOfferCodes(server: McpServer, client: ASCClient): void {
  // ----- Campaigns -----

  server.registerTool(
    'asc_list_iap_offer_codes',
    {
      title: 'List IAP offer code campaigns',
      description:
        'List offer-code campaigns of an in-app purchase (consumable, non-consumable or non-renewing subscription). Each row: name, customer eligibility (NON_SPENDER / ACTIVE_SPENDER / CHURNED_SPENDER), active flag, production/sandbox code counts, number of territory prices. Auto-renewable subscriptions use asc_list_subscription_offer_codes instead. Pass territoryId to keep only campaigns priced in that territory.',
      inputSchema: z.object({
        inAppPurchaseId: InAppPurchaseIdSchema,
        territoryId: TerritoryIdSchema.optional(),
        maxItems: MaxItems(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ inAppPurchaseId, territoryId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[inAppPurchaseOfferCodes]', OFFER_CODE_FIELDS);
      // Price linkage is only returned for included resources; keep it small.
      params.set('include', 'prices');
      params.set('fields[inAppPurchaseOfferPrices]', 'territory');
      params.set('limit[prices]', '50');
      if (territoryId) params.set('filter[territory]', territoryId);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v2/inAppPurchases/${encodeURIComponent(inAppPurchaseId)}/offerCodes?${params}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestIapOfferCodes(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_iap_offer_code',
    {
      title: 'Get an IAP offer code campaign',
      description:
        'Fetch one IAP offer-code campaign with its prices, one-time-use batches and custom codes included.',
      inputSchema: z.object({ offerCodeId: IapOfferCodeIdSchema }),
    },
    async ({ offerCodeId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/inAppPurchaseOfferCodes/${encodeURIComponent(
            offerCodeId,
          )}?include=prices,oneTimeUseCodes,customCodes`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_list_iap_offer_code_prices',
    {
      title: 'List IAP offer code prices',
      description:
        'List the per-territory prices of an IAP offer-code campaign: territory, customer price, proceeds and the inAppPurchasePricePoints id. Prices are set at create and cannot be changed.',
      inputSchema: z.object({
        offerCodeId: IapOfferCodeIdSchema,
        territoryId: TerritoryIdSchema.optional(),
        maxItems: MaxItems(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ offerCodeId, territoryId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[inAppPurchaseOfferPrices]', PRICE_FIELDS);
      params.set('include', 'pricePoint');
      params.set('fields[inAppPurchasePricePoints]', 'customerPrice,proceeds');
      if (territoryId) params.set('filter[territory]', territoryId);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/inAppPurchaseOfferCodes/${encodeURIComponent(offerCodeId)}/prices?${params}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestIapOfferPrices(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_iap_offer_code',
    {
      title: 'Create an IAP offer code campaign',
      description:
        'Create an offer-code campaign on an in-app purchase: name + customer eligibility + every territory price in one POST. Name, eligibility and prices are immutable afterwards, PATCH only flips `active`, and Apple has no DELETE, so the campaign stays forever. ppp pre-flights a 10-campaign cap and name uniqueness on the product and refuses with a remedy. Then generate codes with asc_post_iap_offer_code_one_time_use_codes or asc_post_iap_offer_code_custom_code. For auto-renewable subscriptions use asc_post_subscription_offer_code.',
      inputSchema: z.object({
        inAppPurchaseId: InAppPurchaseIdSchema,
        name: z
          .string()
          .min(1)
          .describe(
            'Reference name shown in App Store Connect. Unique per in-app purchase; immutable.',
          ),
        customerEligibilities: IapCustomerEligibilitiesSchema,
        prices: z
          .array(
            z.object({
              territoryId: TerritoryIdSchema,
              pricePointId: InAppPurchasePricePointIdSchema,
            }),
          )
          .min(1)
          .describe(
            'Offer price per territory. Pick IAP price points with asc_list_iap_price_points (nearAmount narrows to a target). A free offer uses the territory’s 0.00 price point.',
          ),
      }),
    },
    async (input) => {
      const seen = new Set<string>();
      for (const p of input.prices) {
        if (seen.has(p.territoryId)) {
          return refused(`Refused: territory ${p.territoryId} appears twice in prices.`);
        }
        seen.add(p.territoryId);
      }
      try {
        const params = new URLSearchParams();
        params.set('fields[inAppPurchaseOfferCodes]', 'name');
        params.set('limit', '200');
        const existing = await paginate(
          client,
          `/v2/inAppPurchases/${encodeURIComponent(input.inAppPurchaseId)}/offerCodes?${params}`,
          200,
        );
        const check = checkIapOfferCodePreflight(existing, input.name, input.inAppPurchaseId);
        if (!check.ok) return refused(check.reason ?? 'Refused by pre-flight.');
      } catch (err) {
        return refused(
          `Pre-flight failed (could not list existing IAP offer-code campaigns): ${formatASCError(err)}`,
        );
      }
      try {
        const data = await client.request<unknown>('/v1/inAppPurchaseOfferCodes', {
          method: 'POST',
          body: JSON.stringify(buildIapOfferCodeBody(input)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_iap_offer_code',
    {
      title: 'Toggle an IAP offer code campaign active flag',
      description:
        'Activate or deactivate an IAP offer-code campaign — the only mutable attribute. Deactivating stops redemption of every batch and custom code under it; completed redemptions are kept. On subscriptions deactivation is one-way (Apple refuses reactivation) and the same is expected here.',
      inputSchema: z.object({ offerCodeId: IapOfferCodeIdSchema, active: z.boolean() }),
    },
    async ({ offerCodeId, active }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/inAppPurchaseOfferCodes/${encodeURIComponent(offerCodeId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(
              buildIapOfferCodeActivePatchBody('inAppPurchaseOfferCodes', offerCodeId, active),
            ),
          },
        );
        return textResult(
          `Set active=${active} on IAP offer code ${offerCodeId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ----- One-time-use batches -----

  server.registerTool(
    'asc_list_iap_offer_code_one_time_use_codes',
    {
      title: 'List one-time-use batches of an IAP offer code',
      description:
        'List the one-time-use code batches under an IAP offer-code campaign (size, environment, expiry, active, created). The code strings come from asc_export_iap_offer_code_one_time_use_values.',
      inputSchema: z.object({
        offerCodeId: IapOfferCodeIdSchema,
        maxItems: MaxItems(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ offerCodeId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[inAppPurchaseOfferCodeOneTimeUseCodes]', ONE_TIME_USE_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/inAppPurchaseOfferCodes/${encodeURIComponent(offerCodeId)}/oneTimeUseCodes?${params}`,
          maxItems,
        );
        return textResult(
          raw ? JSON.stringify(pages, null, 2) : digestOfferCodeOneTimeUseBatches(pages),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_iap_offer_code_one_time_use_codes',
    {
      title: 'Get an IAP one-time-use code batch',
      description: 'Fetch one one-time-use code batch of an IAP offer code by ID.',
      inputSchema: z.object({ oneTimeUseId: IapOfferCodeOneTimeUseIdSchema }),
    },
    async ({ oneTimeUseId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/inAppPurchaseOfferCodeOneTimeUseCodes/${encodeURIComponent(oneTimeUseId)}`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_iap_offer_code_one_time_use_codes',
    {
      title: 'Generate a batch of IAP one-time-use offer codes',
      description:
        'Generate a batch of single-redemption codes under an IAP offer-code campaign. Apple creates the strings; fetch them with asc_export_iap_offer_code_one_time_use_values. numberOfCodes, expirationDate and environment are immutable; PATCH only flips `active`. Use environment SANDBOX for test accounts.',
      inputSchema: z.object({
        offerCodeId: IapOfferCodeIdSchema,
        numberOfCodes: TotalNumberOfCodesSchema,
        expirationDate: ExpirationDateSchema,
        environment: OfferCodeEnvironmentSchema.optional(),
      }),
    },
    async (input) => {
      try {
        const data = await client.request<unknown>('/v1/inAppPurchaseOfferCodeOneTimeUseCodes', {
          method: 'POST',
          body: JSON.stringify(buildIapOneTimeUseBody(input)),
        });
        const env = input.environment ? ` [${input.environment}]` : '';
        return textResult(
          `Generated ${input.numberOfCodes} one-time-use codes${env} for IAP offer code ${input.offerCodeId} (expires ${input.expirationDate}).\n\n${JSON.stringify(data, null, 2)}\n\nFetch the strings with asc_export_iap_offer_code_one_time_use_values.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_iap_offer_code_one_time_use_codes',
    {
      title: 'Toggle an IAP one-time-use batch active flag',
      description:
        'Activate or deactivate a one-time-use batch of an IAP offer code. Deactivating revokes its unredeemed codes without touching the campaign — the way to kill a leaked batch.',
      inputSchema: z.object({ oneTimeUseId: IapOfferCodeOneTimeUseIdSchema, active: z.boolean() }),
    },
    async ({ oneTimeUseId, active }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/inAppPurchaseOfferCodeOneTimeUseCodes/${encodeURIComponent(oneTimeUseId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(
              buildIapOfferCodeActivePatchBody(
                'inAppPurchaseOfferCodeOneTimeUseCodes',
                oneTimeUseId,
                active,
              ),
            ),
          },
        );
        return textResult(
          `Set active=${active} on IAP one-time-use batch ${oneTimeUseId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_export_iap_offer_code_one_time_use_values',
    {
      title: 'Export IAP one-time-use code values as CSV',
      description:
        'Fetch the redeemable strings of an IAP one-time-use batch. Apple serves text/csv; passed through verbatim. Treat them as secrets. raw: true drops the summary line.',
      inputSchema: z.object({
        oneTimeUseId: IapOfferCodeOneTimeUseIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ oneTimeUseId, raw }) => {
      try {
        const csv = await client.requestText(
          `/v1/inAppPurchaseOfferCodeOneTimeUseCodes/${encodeURIComponent(oneTimeUseId)}/values`,
          { method: 'GET' },
        );
        if (raw) return textResult(csv);
        return textResult(
          `Exported one-time-use code values for IAP batch ${oneTimeUseId}. These strings are redeemable secrets.\n\n${csv}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ----- Custom (multi-use) codes -----

  server.registerTool(
    'asc_list_iap_offer_code_custom_codes',
    {
      title: 'List custom codes of an IAP offer code',
      description:
        'List the custom multi-use codes under an IAP offer-code campaign: the string itself, redemption cap, expiry, active, created.',
      inputSchema: z.object({
        offerCodeId: IapOfferCodeIdSchema,
        maxItems: MaxItems(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ offerCodeId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[inAppPurchaseOfferCodeCustomCodes]', CUSTOM_CODE_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/inAppPurchaseOfferCodes/${encodeURIComponent(offerCodeId)}/customCodes?${params}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestOfferCodeCustomCodes(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_iap_offer_code_custom_code',
    {
      title: 'Get an IAP custom offer code',
      description: 'Fetch one custom (multi-use) code of an IAP offer code by ID.',
      inputSchema: z.object({ customCodeId: IapOfferCodeCustomCodeIdSchema }),
    },
    async ({ customCodeId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/inAppPurchaseOfferCodeCustomCodes/${encodeURIComponent(customCodeId)}`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_iap_offer_code_custom_code',
    {
      title: 'Create an IAP custom (multi-use) offer code',
      description:
        'Create a developer-chosen code string under an IAP offer-code campaign, redeemable by up to numberOfCodes customers (min 500, max 25,000 on subscriptions; assumed the same here). Optional expirationDate; omit for no expiry. Immutable; PATCH only flips `active`; no DELETE. ppp refuses if the campaign already has a custom code with the same string.',
      inputSchema: z.object({
        offerCodeId: IapOfferCodeIdSchema,
        customCode: CustomCodeStringSchema,
        numberOfCodes: CustomCodeNumberOfCodesSchema,
        expirationDate: ExpirationDateSchema.optional(),
      }),
    },
    async (input) => {
      try {
        const existing = await paginate(
          client,
          `/v1/inAppPurchaseOfferCodes/${encodeURIComponent(
            input.offerCodeId,
          )}/customCodes?fields[inAppPurchaseOfferCodeCustomCodes]=customCode&limit=200`,
          2000,
        );
        const clash = existing.data.find(
          (c) =>
            String(c.attributes?.['customCode'] ?? '').toUpperCase() ===
            input.customCode.toUpperCase(),
        );
        if (clash) {
          return refused(
            `Refused: custom code "${input.customCode}" already exists on this campaign (${clash.id}). Custom codes cannot be deleted; pick another string.`,
          );
        }
      } catch (err) {
        return refused(
          `Pre-flight failed (could not list existing custom codes): ${formatASCError(err)}`,
        );
      }
      try {
        const data = await client.request<unknown>('/v1/inAppPurchaseOfferCodeCustomCodes', {
          method: 'POST',
          body: JSON.stringify(buildIapCustomCodeBody(input)),
        });
        const exp = input.expirationDate ? `, expires ${input.expirationDate}` : ', no expiration';
        return textResult(
          `Created custom code "${input.customCode}" (cap ${input.numberOfCodes}${exp}) for IAP offer code ${input.offerCodeId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_iap_offer_code_custom_code',
    {
      title: 'Toggle an IAP custom offer code active flag',
      description:
        'Activate or deactivate a custom (multi-use) code of an IAP offer code. Deactivating stops further redemptions of the string; on subscriptions this is one-way and Apple stamps today into expirationDate, and the same is expected here.',
      inputSchema: z.object({ customCodeId: IapOfferCodeCustomCodeIdSchema, active: z.boolean() }),
    },
    async ({ customCodeId, active }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/inAppPurchaseOfferCodeCustomCodes/${encodeURIComponent(customCodeId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(
              buildIapOfferCodeActivePatchBody(
                'inAppPurchaseOfferCodeCustomCodes',
                customCodeId,
                active,
              ),
            ),
          },
        );
        return textResult(
          `Set active=${active} on IAP custom code ${customCodeId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
