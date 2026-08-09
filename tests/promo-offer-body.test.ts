import { describe, expect, it } from 'vitest';
import { buildPromoOfferBody, buildPromoOfferPatchBody } from '../src/domains/promo-offers.js';

// These tests pin the JSON:API wire shape for POST /v1/subscriptionPromotionalOffers
// and PATCH /v1/subscriptionPromotionalOffers/{id}.
//
// Apple's spec quirks that drive these assertions:
//   1. Prices live in `included[]` with temp IDs (`${1}`-style strings, same
//      convention as app/IAP price schedules). The to-many `prices` relationship
//      on the offer references each by ID.
//   2. SubscriptionPromotionalOfferPrice has NO attributes — only two
//      relationships (territory + subscriptionPricePoint). Easy to typo into a
//      `customerPrice` field that gets silently ignored.
//   3. PATCH only permits changing the prices relationship. Attempts to set
//      name/offerCode/offerMode/duration/numberOfPeriods on the patch body must
//      not appear in the wire output — Apple 422s if they're present.
//   4. numberOfPeriods is carried for BOTH paid modes (same rule as intro
//      offers, where Apple 409s a PAY_UP_FRONT create without it);
//      PAY_UP_FRONT defaults to 1 when omitted.
//   5. FREE_TRIAL is permitted by Apple's enum but rejected at our domain
//      layer (no price to compute, promo offers target existing subscribers);
//      that's a validator concern, not a body-builder one — body builder
//      stays generic.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
  included: Array<{
    type: string;
    id: string;
    attributes?: Record<string, unknown>;
    relationships: Record<string, { data: { type: string; id: string } }>;
  }>;
};

const tempId = (n: number) => `$${'{'}${n}${'}'}`;

describe('buildPromoOfferBody (create)', () => {
  const body = buildPromoOfferBody({
    subscriptionId: 'SUB-1',
    name: 'Winter Sale',
    offerCode: 'WINTER2026',
    offerMode: 'PAY_AS_YOU_GO',
    duration: 'ONE_MONTH',
    numberOfPeriods: 3,
    prices: [
      { territoryId: 'USA', pricePointId: 'POINT-USA' },
      { territoryId: 'BRA', pricePointId: 'POINT-BRA' },
    ],
  }) as Body;

  it('uses subscriptionPromotionalOffers as the type', () => {
    expect(body.data.type).toBe('subscriptionPromotionalOffers');
  });

  it('carries name, offerCode, mode, duration, numberOfPeriods in attributes', () => {
    expect(body.data.attributes).toEqual({
      name: 'Winter Sale',
      offerCode: 'WINTER2026',
      offerMode: 'PAY_AS_YOU_GO',
      duration: 'ONE_MONTH',
      numberOfPeriods: 3,
    });
  });

  it('points at the owning subscription', () => {
    const subRel = (
      body.data.relationships as { subscription: { data: { type: string; id: string } } }
    ).subscription;
    expect(subRel.data).toEqual({ type: 'subscriptions', id: 'SUB-1' });
  });

  it('prices relationship is a to-many array of temp-ID references', () => {
    const pricesRel = (
      body.data.relationships as {
        prices: { data: Array<{ type: string; id: string }> };
      }
    ).prices;
    expect(pricesRel.data).toEqual([
      { type: 'subscriptionPromotionalOfferPrices', id: tempId(1) },
      { type: 'subscriptionPromotionalOfferPrices', id: tempId(2) },
    ]);
  });

  it('included[] has one row per price with no attributes', () => {
    expect(body.included).toHaveLength(2);
    for (const row of body.included) {
      expect(row.type).toBe('subscriptionPromotionalOfferPrices');
      // Apple's schema for this resource has NO attributes block. Sending
      // attributes:{} or any keys here gets the request 422'd.
      expect(row.attributes).toBeUndefined();
    }
  });

  it('each included row carries territory + subscriptionPricePoint relationships', () => {
    expect(body.included[0]?.relationships.territory?.data).toEqual({
      type: 'territories',
      id: 'USA',
    });
    expect(body.included[0]?.relationships.subscriptionPricePoint?.data).toEqual({
      type: 'subscriptionPricePoints',
      id: 'POINT-USA',
    });
    expect(body.included[1]?.relationships.territory?.data).toEqual({
      type: 'territories',
      id: 'BRA',
    });
  });

  describe('PAY_UP_FRONT', () => {
    const body2 = buildPromoOfferBody({
      subscriptionId: 'SUB-1',
      name: 'Winter Sale',
      offerCode: 'WINTER2026',
      offerMode: 'PAY_UP_FRONT',
      duration: 'THREE_MONTHS',
      numberOfPeriods: 1,
      prices: [{ territoryId: 'USA', pricePointId: 'POINT-USA' }],
    }) as Body;

    it('carries numberOfPeriods when passed', () => {
      expect((body2.data.attributes as Record<string, unknown>).numberOfPeriods).toBe(1);
    });

    it('defaults numberOfPeriods to 1 when omitted (single up-front charge)', () => {
      const defaulted = buildPromoOfferBody({
        subscriptionId: 'SUB-1',
        name: 'Winter Sale',
        offerCode: 'WINTER2026',
        offerMode: 'PAY_UP_FRONT',
        duration: 'THREE_MONTHS',
        prices: [{ territoryId: 'USA', pricePointId: 'POINT-USA' }],
      }) as Body;
      expect((defaulted.data.attributes as Record<string, unknown>).numberOfPeriods).toBe(1);
    });
  });

  describe('FREE_TRIAL', () => {
    const body2 = buildPromoOfferBody({
      subscriptionId: 'SUB-1',
      name: 'Sample',
      offerCode: 'SAMPLE2026',
      offerMode: 'FREE_TRIAL',
      duration: 'ONE_WEEK',
      // Free trials have no prices in the conceptual sense, but Apple still
      // requires the prices array (one row per territory the offer covers,
      // with the lowest available price point — Apple ignores the amount for
      // FREE_TRIAL). The body builder forwards whatever prices it's given.
      prices: [{ territoryId: 'USA', pricePointId: 'POINT-USA' }],
    }) as Body;

    it('does not carry numberOfPeriods', () => {
      expect((body2.data.attributes as Record<string, unknown>).numberOfPeriods).toBeUndefined();
    });
  });
});

describe('buildPromoOfferPatchBody', () => {
  const body = buildPromoOfferPatchBody('PROMO-OFFER-1', [
    { territoryId: 'USA', pricePointId: 'POINT-USA-NEW' },
    { territoryId: 'JPN', pricePointId: 'POINT-JPN-NEW' },
  ]) as Body;

  it('uses subscriptionPromotionalOffers as the type and includes the offer ID', () => {
    expect(body.data.type).toBe('subscriptionPromotionalOffers');
    expect(body.data.id).toBe('PROMO-OFFER-1');
  });

  it('omits the attributes block entirely (Apple PATCH only mutates prices)', () => {
    // Even an empty attributes:{} can confuse the API; the OpenAPI update
    // schema has no attributes block at all.
    expect(body.data.attributes).toBeUndefined();
  });

  it('replaces the prices to-many relationship wholesale (post-state, not delta)', () => {
    const pricesRel = (
      body.data.relationships as {
        prices: { data: Array<{ type: string; id: string }> };
      }
    ).prices;
    expect(pricesRel.data).toEqual([
      { type: 'subscriptionPromotionalOfferPrices', id: tempId(1) },
      { type: 'subscriptionPromotionalOfferPrices', id: tempId(2) },
    ]);
  });

  it('included[] mirrors the new prices set with temp IDs', () => {
    expect(body.included).toHaveLength(2);
    expect(body.included[0]?.relationships.territory?.data.id).toBe('USA');
    expect(body.included[1]?.relationships.territory?.data.id).toBe('JPN');
  });
});
