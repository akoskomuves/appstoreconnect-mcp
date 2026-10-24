import { describe, expect, it } from 'vitest';
import {
  buildIapCustomCodeBody,
  buildIapOfferCodeActivePatchBody,
  buildIapOfferCodeBody,
  buildIapOneTimeUseBody,
  checkIapOfferCodePreflight,
  IapCustomerEligibilitiesSchema,
} from '../src/domains/iap-offer-codes.js';
import type { CollectedPages } from '../src/jsonapi.js';

// Pin the wire shape of the IAP offer-code family (API 4.2). Differences from
// the subscription family that these assertions guard:
//   - inline price type `inAppPurchaseOfferPrices`, relationship `pricePoint`
//     → `inAppPurchasePricePoints` (subscriptions: subscriptionPricePoint).
//   - the parent relationship key is `inAppPurchase`.
//   - attributes are only name + customerEligibilities (no mode/duration/periods).
//   - spender cohorts, not NEW/EXISTING/EXPIRED.

// Apple's literal temp-id strings, built without a template-looking literal.
const T1 = `\${1}`;
const T2 = `\${2}`;

function pages(names: string[]): CollectedPages {
  return {
    data: names.map((name, i) => ({
      type: 'inAppPurchaseOfferCodes',
      id: `oc${i}`,
      attributes: { name },
    })),
    included: [],
    pagesFetched: 1,
    truncated: false,
  };
}

describe('buildIapOfferCodeBody', () => {
  const body = buildIapOfferCodeBody({
    inAppPurchaseId: 'IAP1',
    name: 'Launch',
    customerEligibilities: ['NON_SPENDER', 'CHURNED_SPENDER'],
    prices: [
      { territoryId: 'USA', pricePointId: 'pp-usa' },
      { territoryId: 'HUN', pricePointId: 'pp-hun' },
    ],
  });

  it('carries only name + customerEligibilities', () => {
    expect(body.data.type).toBe('inAppPurchaseOfferCodes');
    expect(body.data.attributes).toEqual({
      name: 'Launch',
      customerEligibilities: ['NON_SPENDER', 'CHURNED_SPENDER'],
    });
  });

  it('relates to the IAP and links inline prices by temp id', () => {
    expect(body.data.relationships).toEqual({
      inAppPurchase: { data: { type: 'inAppPurchases', id: 'IAP1' } },
      prices: {
        data: [
          { type: 'inAppPurchaseOfferPrices', id: T1 },
          { type: 'inAppPurchaseOfferPrices', id: T2 },
        ],
      },
    });
  });

  it('inline prices use pricePoint → inAppPurchasePricePoints', () => {
    expect(body.included?.[0]).toEqual({
      type: 'inAppPurchaseOfferPrices',
      id: T1,
      relationships: {
        territory: { data: { type: 'territories', id: 'USA' } },
        pricePoint: { data: { type: 'inAppPurchasePricePoints', id: 'pp-usa' } },
      },
    });
    expect(JSON.stringify(body)).not.toContain('subscriptionPricePoint');
  });
});

describe('active-only PATCH bodies', () => {
  it('is attributes-only with a single active key', () => {
    for (const type of [
      'inAppPurchaseOfferCodes',
      'inAppPurchaseOfferCodeOneTimeUseCodes',
      'inAppPurchaseOfferCodeCustomCodes',
    ] as const) {
      expect(buildIapOfferCodeActivePatchBody(type, 'id1', false)).toEqual({
        data: { type, id: 'id1', attributes: { active: false } },
      });
    }
  });
});

describe('one-time-use + custom code bodies', () => {
  it('one-time-use omits environment when unset and never sends active', () => {
    const b = buildIapOneTimeUseBody({
      offerCodeId: 'OC',
      numberOfCodes: 100,
      expirationDate: '2026-12-31',
    });
    expect(b).toEqual({
      data: {
        type: 'inAppPurchaseOfferCodeOneTimeUseCodes',
        attributes: { numberOfCodes: 100, expirationDate: '2026-12-31' },
        relationships: { offerCode: { data: { type: 'inAppPurchaseOfferCodes', id: 'OC' } } },
      },
    });
    const sbx = buildIapOneTimeUseBody({
      offerCodeId: 'OC',
      numberOfCodes: 5,
      expirationDate: '2026-12-31',
      environment: 'SANDBOX',
    });
    expect(sbx.data.attributes).toEqual({
      numberOfCodes: 5,
      expirationDate: '2026-12-31',
      environment: 'SANDBOX',
    });
  });

  it('custom code omits expirationDate when unset', () => {
    const b = buildIapCustomCodeBody({
      offerCodeId: 'OC',
      customCode: 'GEMS50',
      numberOfCodes: 500,
    });
    expect(b.data.attributes).toEqual({ customCode: 'GEMS50', numberOfCodes: 500 });
    expect(b.data.relationships).toEqual({
      offerCode: { data: { type: 'inAppPurchaseOfferCodes', id: 'OC' } },
    });
  });
});

describe('checkIapOfferCodePreflight', () => {
  it('passes under the cap with a fresh name', () => {
    expect(checkIapOfferCodePreflight(pages(['A', 'B']), 'C', 'IAP1')).toEqual({ ok: true });
  });

  it('refuses at the 10-campaign cap', () => {
    const r = checkIapOfferCodePreflight(
      pages(Array.from({ length: 10 }, (_, i) => `n${i}`)),
      'new',
      'IAP1',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cap of 10');
  });

  it('refuses a name collision and names the clashing campaign', () => {
    const r = checkIapOfferCodePreflight(pages(['Launch', 'Other']), 'Launch', 'IAP1');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('oc0');
  });
});

describe('IapCustomerEligibilitiesSchema', () => {
  it('accepts spender cohorts and rejects subscription cohorts', () => {
    expect(IapCustomerEligibilitiesSchema.safeParse(['ACTIVE_SPENDER']).success).toBe(true);
    expect(IapCustomerEligibilitiesSchema.safeParse(['NEW']).success).toBe(false);
    expect(IapCustomerEligibilitiesSchema.safeParse([]).success).toBe(false);
  });
});
