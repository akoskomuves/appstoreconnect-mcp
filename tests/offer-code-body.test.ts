import { describe, expect, it } from 'vitest';
import {
  buildOfferCodeBody,
  buildOfferCodePatchBody,
  buildOneTimeUseBody,
  buildOneTimeUsePatchBody,
} from '../src/domains/offer-codes.js';

// Pin the JSON:API wire shape for the four offer-code endpoints we POST/PATCH
// against:
//   POST   /v1/subscriptionOfferCodes
//   PATCH  /v1/subscriptionOfferCodes/{id}
//   POST   /v1/subscriptionOfferCodeOneTimeUseCodes
//   PATCH  /v1/subscriptionOfferCodeOneTimeUseCodes/{id}
//
// Apple's quirks that drive these assertions:
//   1. Prices live in `included[]` with temp IDs (`${1}`-style strings, same
//      convention as promo offers). The to-many `prices` relationship on
//      the campaign references each by ID.
//   2. SubscriptionOfferCodePrice has NO attributes — only territory +
//      subscriptionPricePoint relationships, same as promo-offer prices.
//   3. PATCH on `subscriptionOfferCodes` ONLY permits `active`. The body
//      must not carry name/eligibilities/mode/duration/prices — Apple 422s
//      if any of them appear in the patch.
//   4. PATCH on `subscriptionOfferCodeOneTimeUseCodes` ONLY permits
//      `active`. numberOfCodes and expirationDate are immutable post-create.
//   5. numberOfPeriods only carries for PAY_AS_YOU_GO mode.
//   6. FREE_TRIAL is permitted by Apple's enum but rejected at the PPP
//      layer (no price to compute). Body builder stays generic.

type Body = {
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
    // FREE_TRIAL offer-code price rows OMIT subscriptionPricePoint entirely
    // (Apple's persistence layer 500s on an explicit data:null). The Record
    // index signature naturally allows missing keys.
    relationships: Record<string, { data: { type: string; id: string } }>;
  }>;
};

const tempId = (n: number) => `$${'{'}${n}${'}'}`;

describe('buildOfferCodeBody (campaign create)', () => {
  const body = buildOfferCodeBody({
    subscriptionId: 'SUB-1',
    name: 'Spring Onboarding',
    customerEligibilities: ['NEW', 'EXPIRED'],
    offerEligibility: 'STACK_WITH_INTRO_OFFERS',
    offerMode: 'PAY_AS_YOU_GO',
    duration: 'ONE_MONTH',
    numberOfPeriods: 3,
    prices: [
      { territoryId: 'USA', pricePointId: 'POINT-USA' },
      { territoryId: 'BRA', pricePointId: 'POINT-BRA' },
    ],
  }) as Body;

  it('uses subscriptionOfferCodes as the type', () => {
    expect(body.data.type).toBe('subscriptionOfferCodes');
  });

  it('carries name, customerEligibilities, offerEligibility, mode, duration, numberOfPeriods in attributes', () => {
    expect(body.data.attributes).toEqual({
      name: 'Spring Onboarding',
      customerEligibilities: ['NEW', 'EXPIRED'],
      offerEligibility: 'STACK_WITH_INTRO_OFFERS',
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
      { type: 'subscriptionOfferCodePrices', id: tempId(1) },
      { type: 'subscriptionOfferCodePrices', id: tempId(2) },
    ]);
  });

  it('included[] has one row per price with no attributes', () => {
    expect(body.included).toHaveLength(2);
    for (const row of body.included ?? []) {
      expect(row.type).toBe('subscriptionOfferCodePrices');
      // Apple's schema for this resource has NO attributes block. Sending
      // attributes:{} or any keys here gets the request 422'd.
      expect(row.attributes).toBeUndefined();
    }
  });

  it('each included row carries territory + subscriptionPricePoint relationships', () => {
    expect(body.included?.[0]?.relationships.territory?.data).toEqual({
      type: 'territories',
      id: 'USA',
    });
    expect(body.included?.[0]?.relationships.subscriptionPricePoint?.data).toEqual({
      type: 'subscriptionPricePoints',
      id: 'POINT-USA',
    });
    expect(body.included?.[1]?.relationships.territory?.data).toEqual({
      type: 'territories',
      id: 'BRA',
    });
  });

  describe('PAY_UP_FRONT', () => {
    const body2 = buildOfferCodeBody({
      subscriptionId: 'SUB-1',
      name: 'Annual Lift',
      customerEligibilities: ['EXISTING'],
      offerEligibility: 'REPLACE_INTRO_OFFERS',
      offerMode: 'PAY_UP_FRONT',
      duration: 'THREE_MONTHS',
      // Apple requires numberOfPeriods on every mode — set 1 for one-shot
      // modes like PAY_UP_FRONT and FREE_TRIAL.
      numberOfPeriods: 1,
      prices: [{ territoryId: 'USA', pricePointId: 'POINT-USA' }],
    }) as Body;

    it('still carries numberOfPeriods (Apple requires it unconditionally)', () => {
      expect((body2.data.attributes as Record<string, unknown>).numberOfPeriods).toBe(1);
    });
  });

  describe('FREE_TRIAL', () => {
    const body2 = buildOfferCodeBody({
      subscriptionId: 'SUB-1',
      name: 'Try It',
      customerEligibilities: ['NEW'],
      offerEligibility: 'STACK_WITH_INTRO_OFFERS',
      offerMode: 'FREE_TRIAL',
      duration: 'ONE_WEEK',
      // Apple still requires numberOfPeriods even for FREE_TRIAL (the smoke
      // test surfaced this — POST 409s without it). FREE_TRIAL prices have
      // no price-point: each row's subscriptionPricePoint must serialize
      // { data: null } (also smoke-test surfaced). Caller therefore omits
      // pricePointId; only territoryId matters.
      numberOfPeriods: 1,
      prices: [{ territoryId: 'USA' }],
    }) as Body;

    it('still carries numberOfPeriods (Apple requires it for FREE_TRIAL too)', () => {
      expect((body2.data.attributes as Record<string, unknown>).numberOfPeriods).toBe(1);
    });

    it('still emits the prices relationship + included row', () => {
      const pricesRel = (body2.data.relationships as { prices: { data: unknown[] } }).prices;
      expect(pricesRel.data).toHaveLength(1);
      expect(body2.included).toHaveLength(1);
    });

    it('OMITS subscriptionPricePoint entirely on each price row (not data:null)', () => {
      // Apple's persistence layer 500s on explicit { data: null } here. The
      // Swift SDK encodes the field with encodeIfPresent, so the spec-
      // compliant wire form is to drop the key. v0.8.0 went through three
      // wrong shapes before this one — guard with a regression assertion
      // that the key is genuinely absent from the relationships object.
      const rels = body2.included?.[0]?.relationships as Record<string, unknown> | undefined;
      expect(rels).toBeDefined();
      expect('subscriptionPricePoint' in (rels ?? {})).toBe(false);
      // territory must still be present — offer scope is per-territory even
      // when there's no price-point.
      expect(rels?.['territory']).toEqual({
        data: { type: 'territories', id: 'USA' },
      });
    });
  });
});

describe('buildOfferCodePatchBody', () => {
  const body = buildOfferCodePatchBody({ offerCodeId: 'OC-1', active: false }) as Body;

  it('uses subscriptionOfferCodes as the type and includes the campaign ID', () => {
    expect(body.data.type).toBe('subscriptionOfferCodes');
    expect(body.data.id).toBe('OC-1');
  });

  it('carries only the active attribute (no name/eligibilities/mode/duration/prices)', () => {
    expect(body.data.attributes).toEqual({ active: false });
  });

  it('has an empty relationships block (PATCH must not touch prices)', () => {
    expect(body.data.relationships).toEqual({});
  });

  it('does not emit an included[] block', () => {
    expect(body.included).toBeUndefined();
  });
});

describe('buildOneTimeUseBody (batch create)', () => {
  const body = buildOneTimeUseBody({
    offerCodeId: 'OC-1',
    numberOfCodes: 5000,
    expirationDate: '2026-12-31',
  }) as Body;

  it('uses subscriptionOfferCodeOneTimeUseCodes as the type', () => {
    expect(body.data.type).toBe('subscriptionOfferCodeOneTimeUseCodes');
  });

  it('carries only numberOfCodes + expirationDate (no `active` on create — PATCH-only field)', () => {
    expect(body.data.attributes).toEqual({
      numberOfCodes: 5000,
      expirationDate: '2026-12-31',
    });
  });

  it('does not send the active flag on create (Apple rejects)', () => {
    // Regression guard: v0.8.0 sent `active: true` on create. Apple's CREATE
    // schema only accepts numberOfCodes + expirationDate (+ optional
    // environment, deferred). Sending active surfaces as a validation error.
    expect((body.data.attributes as Record<string, unknown>).active).toBeUndefined();
  });

  it('points at the parent offer-code campaign via the offerCode relationship', () => {
    const rel = (body.data.relationships as { offerCode: { data: { type: string; id: string } } })
      .offerCode;
    expect(rel.data).toEqual({ type: 'subscriptionOfferCodes', id: 'OC-1' });
  });
});

describe('buildOneTimeUsePatchBody', () => {
  const body = buildOneTimeUsePatchBody({ oneTimeUseId: 'BATCH-1', active: false }) as Body;

  it('uses subscriptionOfferCodeOneTimeUseCodes as the type with the batch ID', () => {
    expect(body.data.type).toBe('subscriptionOfferCodeOneTimeUseCodes');
    expect(body.data.id).toBe('BATCH-1');
  });

  it('carries only the active attribute (numberOfCodes + expirationDate are immutable)', () => {
    expect(body.data.attributes).toEqual({ active: false });
  });

  it('has an empty relationships block', () => {
    expect(body.data.relationships).toEqual({});
  });
});
