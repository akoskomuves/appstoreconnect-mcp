import { describe, expect, it } from 'vitest';
import { buildIntroOfferBody } from '../src/domains/intro-offers.js';

// These tests pin the JSON:API wire shape for the POST
// /v1/subscriptionIntroductoryOffers body. Apple has three load-bearing rules
// that are easy to typo:
//   1. FREE_TRIAL must NOT carry a subscriptionPricePoint relationship.
//   2. PAY_AS_YOU_GO requires numberOfPeriods; PAY_UP_FRONT must omit it.
//   3. A null territory = wildcard ("all territories"). The relationship key
//      should be absent — not present with a null `data`.

type Body = {
  data: {
    type: string;
    attributes: Record<string, unknown>;
    relationships: Record<string, { data: { type: string; id: string } } | undefined>;
  };
};

describe('buildIntroOfferBody', () => {
  describe('FREE_TRIAL', () => {
    const body = buildIntroOfferBody({
      subscriptionId: 'SUB-1',
      territoryId: 'USA',
      offerMode: 'FREE_TRIAL',
      duration: 'ONE_WEEK',
      startDate: '2026-06-01',
    }) as Body;

    it('uses subscriptionIntroductoryOffers as the type', () => {
      expect(body.data.type).toBe('subscriptionIntroductoryOffers');
    });

    it('attributes carry startDate, duration, offerMode', () => {
      expect(body.data.attributes).toEqual({
        startDate: '2026-06-01',
        duration: 'ONE_WEEK',
        offerMode: 'FREE_TRIAL',
      });
    });

    it('omits subscriptionPricePoint relationship (no price on a free trial)', () => {
      expect(body.data.relationships.subscriptionPricePoint).toBeUndefined();
    });

    it('omits numberOfPeriods (only meaningful for PAY_AS_YOU_GO)', () => {
      expect(body.data.attributes.numberOfPeriods).toBeUndefined();
    });

    it('points at the owning subscription and territory', () => {
      expect(body.data.relationships.subscription?.data).toEqual({
        type: 'subscriptions',
        id: 'SUB-1',
      });
      expect(body.data.relationships.territory?.data).toEqual({
        type: 'territories',
        id: 'USA',
      });
    });
  });

  describe('PAY_AS_YOU_GO', () => {
    const body = buildIntroOfferBody({
      subscriptionId: 'SUB-1',
      territoryId: 'USA',
      offerMode: 'PAY_AS_YOU_GO',
      duration: 'ONE_MONTH',
      startDate: '2026-06-01',
      pricePointId: 'POINT-1',
      numberOfPeriods: 3,
    }) as Body;

    it('carries numberOfPeriods in attributes', () => {
      expect(body.data.attributes.numberOfPeriods).toBe(3);
    });

    it('carries subscriptionPricePoint relationship', () => {
      expect(body.data.relationships.subscriptionPricePoint?.data).toEqual({
        type: 'subscriptionPricePoints',
        id: 'POINT-1',
      });
    });
  });

  describe('PAY_UP_FRONT', () => {
    const body = buildIntroOfferBody({
      subscriptionId: 'SUB-1',
      territoryId: 'USA',
      offerMode: 'PAY_UP_FRONT',
      duration: 'THREE_MONTHS',
      startDate: '2026-06-01',
      pricePointId: 'POINT-1',
      // PAY_UP_FRONT charges once for the whole duration — periods irrelevant.
      // Even if caller passes a value, the builder should drop it.
      numberOfPeriods: 5,
    }) as Body;

    it('omits numberOfPeriods even when passed in', () => {
      expect(body.data.attributes.numberOfPeriods).toBeUndefined();
    });

    it('carries subscriptionPricePoint relationship', () => {
      expect(body.data.relationships.subscriptionPricePoint?.data).toEqual({
        type: 'subscriptionPricePoints',
        id: 'POINT-1',
      });
    });
  });

  describe('all-territories wildcard', () => {
    const body = buildIntroOfferBody({
      subscriptionId: 'SUB-1',
      territoryId: undefined,
      offerMode: 'FREE_TRIAL',
      duration: 'ONE_WEEK',
      startDate: '2026-06-01',
    }) as Body;

    it('omits the territory relationship key entirely', () => {
      expect(body.data.relationships.territory).toBeUndefined();
      expect('territory' in body.data.relationships).toBe(false);
    });
  });

  describe('optional endDate', () => {
    it('included when provided', () => {
      const body = buildIntroOfferBody({
        subscriptionId: 'SUB-1',
        territoryId: 'USA',
        offerMode: 'FREE_TRIAL',
        duration: 'ONE_WEEK',
        startDate: '2026-06-01',
        endDate: '2026-08-01',
      }) as Body;
      expect(body.data.attributes.endDate).toBe('2026-08-01');
    });

    it('omitted when not provided (null = open-ended in Apple-speak, but we drop the key)', () => {
      const body = buildIntroOfferBody({
        subscriptionId: 'SUB-1',
        territoryId: 'USA',
        offerMode: 'FREE_TRIAL',
        duration: 'ONE_WEEK',
        startDate: '2026-06-01',
      }) as Body;
      expect('endDate' in body.data.attributes).toBe(false);
    });
  });
});
