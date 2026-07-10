import { describe, expect, it } from 'vitest';
import {
  buildWinBackOfferBody,
  buildWinBackOfferPatchBody,
  type WinBackOfferCreateInput,
} from '../src/domains/win-back-offers.js';
import {
  IntegerRangeSchema,
  OfferPrioritySchema,
  PromotionIntentSchema,
  SubscriptionPlanTypeSchema,
} from '../src/schemas.js';

// Pin the wire shape for the two writable WinBackOffer endpoints:
//   POST  /v1/winBackOffers            (create — inline prices in included[])
//   PATCH /v1/winBackOffers/{id}       (update — ATTRIBUTES ONLY)
//
// Apple's quirks driving these assertions:
//   1. Inline prices carry type `winBackOfferPrices` with `${N}` temp-IDs,
//      linked from data.relationships.prices — same pattern as promo offers.
//   2. customerEligibilityTimeSinceLastSubscribedInMonths is an IntegerRange
//      object { minimum, maximum? } — maximum must be OMITTED (not null) when
//      absent.
//   3. periodCount is required for every mode; four attrs are optional at
//      create (waitBetween, endDate, promotionIntent, targetSubscriptionPlanType)
//      and must be OMITTED when undefined, not sent as null.
//   4. PATCH is attributes-only: no relationships block, no included[], and
//      prices/offerId/duration/offerMode/periodCount are never patchable.

type Body = {
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
};

// Apple's JSON:API temp-ID literal `${N}`, built via a template literal (as the
// source's tempId does) so biome's noTemplateCurlyInString rule doesn't flag the
// assertion strings.
const temp = (n: number) => `\${${n}}`;

const baseInput: WinBackOfferCreateInput = {
  subscriptionId: 'SUB123',
  referenceName: 'Winter win-back',
  offerId: 'winback_winter',
  duration: 'ONE_MONTH',
  offerMode: 'PAY_AS_YOU_GO',
  periodCount: 3,
  customerEligibilityPaidSubscriptionDurationInMonths: 6,
  customerEligibilityTimeSinceLastSubscribedInMonths: { minimum: 1, maximum: 6 },
  startDate: '2026-08-01',
  priority: 'HIGH',
  prices: [{ territoryId: 'USA', pricePointId: 'PP_USA_1' }],
};

describe('buildWinBackOfferBody', () => {
  it('creates a winBackOffers resource with required attributes', () => {
    const body = buildWinBackOfferBody(baseInput) as Body;
    expect(body.data.type).toBe('winBackOffers');
    const attrs = body.data.attributes ?? {};
    expect(attrs).toMatchObject({
      referenceName: 'Winter win-back',
      offerId: 'winback_winter',
      duration: 'ONE_MONTH',
      offerMode: 'PAY_AS_YOU_GO',
      periodCount: 3,
      customerEligibilityPaidSubscriptionDurationInMonths: 6,
      customerEligibilityTimeSinceLastSubscribedInMonths: { minimum: 1, maximum: 6 },
      startDate: '2026-08-01',
      priority: 'HIGH',
    });
  });

  it('omits optional attributes when not provided', () => {
    const attrs = (buildWinBackOfferBody(baseInput) as Body).data.attributes ?? {};
    expect(attrs).not.toHaveProperty('endDate');
    expect(attrs).not.toHaveProperty('promotionIntent');
    expect(attrs).not.toHaveProperty('targetSubscriptionPlanType');
    expect(attrs).not.toHaveProperty('customerEligibilityWaitBetweenOffersInMonths');
  });

  it('includes optional attributes when provided', () => {
    const body = buildWinBackOfferBody({
      ...baseInput,
      endDate: '2026-09-01',
      promotionIntent: 'USE_AUTO_GENERATED_ASSETS',
      targetSubscriptionPlanType: 'MONTHLY',
      customerEligibilityWaitBetweenOffersInMonths: 12,
    }) as Body;
    expect(body.data.attributes).toMatchObject({
      endDate: '2026-09-01',
      promotionIntent: 'USE_AUTO_GENERATED_ASSETS',
      targetSubscriptionPlanType: 'MONTHLY',
      customerEligibilityWaitBetweenOffersInMonths: 12,
    });
  });

  it('omits maximum from the eligibility range when open-ended', () => {
    const body = buildWinBackOfferBody({
      ...baseInput,
      customerEligibilityTimeSinceLastSubscribedInMonths: { minimum: 2 },
    }) as Body;
    expect(body.data.attributes?.customerEligibilityTimeSinceLastSubscribedInMonths).toEqual({
      minimum: 2,
    });
  });

  it('links the subscription relationship', () => {
    const body = buildWinBackOfferBody(baseInput) as Body;
    expect(body.data.relationships?.subscription).toEqual({
      data: { type: 'subscriptions', id: 'SUB123' },
    });
  });

  it('builds inline winBackOfferPrices with placeholder temp-IDs linked from data.relationships.prices', () => {
    const body = buildWinBackOfferBody({
      ...baseInput,
      prices: [
        { territoryId: 'USA', pricePointId: 'PP_USA_1' },
        { territoryId: 'JPN', pricePointId: 'PP_JPN_1' },
      ],
    }) as Body;

    expect(body.included).toHaveLength(2);
    expect(body.included?.[0]).toEqual({
      type: 'winBackOfferPrices',
      id: temp(1),
      relationships: {
        territory: { data: { type: 'territories', id: 'USA' } },
        subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'PP_USA_1' } },
      },
    });
    expect(body.included?.[1]?.id).toBe(temp(2));
    expect(body.data.relationships?.prices).toEqual({
      data: [
        { type: 'winBackOfferPrices', id: temp(1) },
        { type: 'winBackOfferPrices', id: temp(2) },
      ],
    });
  });
});

describe('buildWinBackOfferPatchBody', () => {
  it('patches only the provided mutable attributes', () => {
    const body = buildWinBackOfferPatchBody('OFFER1', {
      priority: 'NORMAL',
      endDate: '2026-10-01',
    }) as Body;
    expect(body.data.type).toBe('winBackOffers');
    expect(body.data.id).toBe('OFFER1');
    expect(body.data.attributes).toEqual({ priority: 'NORMAL', endDate: '2026-10-01' });
  });

  it('carries no relationships block and no included[] (attributes-only update)', () => {
    const body = buildWinBackOfferPatchBody('OFFER1', { priority: 'HIGH' }) as Body;
    expect(body.data).not.toHaveProperty('relationships');
    expect(body).not.toHaveProperty('included');
  });

  it('serializes an eligibility-range change with an omitted maximum', () => {
    const body = buildWinBackOfferPatchBody('OFFER1', {
      customerEligibilityTimeSinceLastSubscribedInMonths: { minimum: 3 },
    }) as Body;
    expect(body.data.attributes).toEqual({
      customerEligibilityTimeSinceLastSubscribedInMonths: { minimum: 3 },
    });
  });
});

describe('win-back schemas', () => {
  it.each(['HIGH', 'NORMAL'])('OfferPrioritySchema accepts %s', (v) => {
    expect(() => OfferPrioritySchema.parse(v)).not.toThrow();
  });
  it.each(['LOW', 'high', ''])('OfferPrioritySchema rejects %s', (v) => {
    expect(() => OfferPrioritySchema.parse(v)).toThrow();
  });

  it.each([
    'NOT_PROMOTED',
    'USE_AUTO_GENERATED_ASSETS',
  ])('PromotionIntentSchema accepts %s', (v) => {
    expect(() => PromotionIntentSchema.parse(v)).not.toThrow();
  });

  it.each(['MONTHLY', 'UPFRONT'])('SubscriptionPlanTypeSchema accepts %s', (v) => {
    expect(() => SubscriptionPlanTypeSchema.parse(v)).not.toThrow();
  });

  it('IntegerRangeSchema accepts { minimum } and { minimum, maximum }', () => {
    expect(() => IntegerRangeSchema.parse({ minimum: 0 })).not.toThrow();
    expect(() => IntegerRangeSchema.parse({ minimum: 1, maximum: 6 })).not.toThrow();
  });
  it('IntegerRangeSchema rejects missing minimum, negatives and non-integers', () => {
    expect(() => IntegerRangeSchema.parse({ maximum: 6 })).toThrow();
    expect(() => IntegerRangeSchema.parse({ minimum: -1 })).toThrow();
    expect(() => IntegerRangeSchema.parse({ minimum: 1.5 })).toThrow();
  });
});
