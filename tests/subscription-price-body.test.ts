import { describe, expect, it } from 'vitest';
import { buildSubscriptionPriceCreateBody } from '../src/domains/pricing.js';

// Pin the wire shape for POST /v1/subscriptionPrices.
//
// The bug this file exists to prevent a regression of: the tool used to mark
// startDate REQUIRED and serialize it unconditionally, which made a
// subscription's FIRST price impossible to create. Apple 409s a dated first
// price — reproduced at 1, 8 and 29 days out, with preserveCurrentPrice both
// true and false, and again after territory availability existed, so the date
// is the variable rather than the distance.
//
// Apple's contract (OpenAPI spec 4.4.1) backs the undated shape:
//   SubscriptionPriceCreateRequest.data.required = ['relationships', 'type']
//   attributes has NO required list, and startDate + preserveCurrentPrice are
//   both nullable: true.
// So the opening row of a schedule is the undated baseline, and a dated row is
// a price *change* — which presupposes a price to change from.

type Body = {
  data: {
    type: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

const REL = {
  subscriptionId: 'SUB-1',
  territoryId: 'USA',
  pricePointId: 'PP-1',
};

type Rel = { data: { type: string; id: string } };

function expectRelationships(body: Body): void {
  expect(body.data.type).toBe('subscriptionPrices');
  const rels = body.data.relationships as {
    subscription: Rel;
    subscriptionPricePoint: Rel;
    territory: Rel;
  };
  expect(rels.subscription.data).toEqual({ type: 'subscriptions', id: 'SUB-1' });
  expect(rels.subscriptionPricePoint.data).toEqual({
    type: 'subscriptionPricePoints',
    id: 'PP-1',
  });
  expect(rels.territory.data).toEqual({ type: 'territories', id: 'USA' });
}

describe('buildSubscriptionPriceCreateBody — baseline (first price)', () => {
  it('omits the attributes block entirely when no startDate is given', () => {
    // Apple accepts a body with no attributes at all, and an empty object is
    // the shape most likely to trip a validator.
    const body = buildSubscriptionPriceCreateBody(REL) as Body;
    expect(body.data.attributes).toBeUndefined();
    expectRelationships(body);
  });

  it('never emits startDate when it was not supplied', () => {
    const body = buildSubscriptionPriceCreateBody({
      ...REL,
      startDate: undefined,
    }) as Body;
    expect(JSON.stringify(body)).not.toContain('startDate');
  });

  it('does not default preserveCurrentPrice on a baseline', () => {
    // There is no existing cohort to grandfather on an opening price, so the
    // dated-change default must not leak into the baseline request.
    const body = buildSubscriptionPriceCreateBody(REL) as Body;
    expect(JSON.stringify(body)).not.toContain('preserveCurrentPrice');
  });

  it('still honours preserveCurrentPrice when set explicitly on a baseline', () => {
    const body = buildSubscriptionPriceCreateBody({
      ...REL,
      preserveCurrentPrice: false,
    }) as Body;
    expect(body.data.attributes).toEqual({ preserveCurrentPrice: false });
    expect(JSON.stringify(body)).not.toContain('startDate');
  });
});

describe('buildSubscriptionPriceCreateBody — dated change', () => {
  it('sends startDate and defaults preserveCurrentPrice to true', () => {
    const body = buildSubscriptionPriceCreateBody({
      ...REL,
      startDate: '2026-10-01',
    }) as Body;
    expect(body.data.attributes).toEqual({
      startDate: '2026-10-01',
      preserveCurrentPrice: true,
    });
    expectRelationships(body);
  });

  it('honours an explicit preserveCurrentPrice=false', () => {
    const body = buildSubscriptionPriceCreateBody({
      ...REL,
      startDate: '2026-10-01',
      preserveCurrentPrice: false,
    }) as Body;
    expect(body.data.attributes).toEqual({
      startDate: '2026-10-01',
      preserveCurrentPrice: false,
    });
  });

  it('produces the exact shape the PPP apply path relied on before it shared this builder', () => {
    // ppp.ts used to inline this body. The PPP rebalance flow has driven real
    // production price changes, so its wire output must be byte-identical.
    const body = buildSubscriptionPriceCreateBody({
      ...REL,
      startDate: '2026-10-01',
      preserveCurrentPrice: true,
    });
    expect(body).toEqual({
      data: {
        type: 'subscriptionPrices',
        attributes: {
          startDate: '2026-10-01',
          preserveCurrentPrice: true,
        },
        relationships: {
          subscription: { data: { type: 'subscriptions', id: 'SUB-1' } },
          subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'PP-1' } },
          territory: { data: { type: 'territories', id: 'USA' } },
        },
      },
    });
  });
});
