import { describe, expect, it } from 'vitest';
import {
  buildIapAvailabilityCreateBody,
  buildSubscriptionAvailabilityCreateBody,
  buildSubscriptionPlanAvailabilityCreateBody,
  buildSubscriptionPlanAvailabilityPatchBody,
} from '../src/domains/availabilities.js';

// These tests pin the JSON:API wire shapes for the availability creates.
// Load-bearing rules:
//   1. availableTerritories targets plain `territories` — the ids on the wire
//      are BARE 3-letter ISO codes, NOT the opaque per-(app, territory)
//      composites that appAvailabilities uses.
//   2. The attribute is `availableInNewTerritories` (wire form — the Swift
//      contract's isAvailableInNewTerritories with the is-prefix stripped).
//   3. Plan-availability PATCH carries the resource id in the body (Apple
//      409s without it) and only the blocks the caller asked to change.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

const rel = (body: Body, key: string) =>
  (body.data.relationships as Record<string, { data: unknown }>)[key]?.data;

describe('buildSubscriptionAvailabilityCreateBody', () => {
  const body = buildSubscriptionAvailabilityCreateBody({
    subscriptionId: 'SUB-1',
    availableInNewTerritories: true,
    territoryIds: ['USA', 'BRA'],
  }) as Body;

  it('uses subscriptionAvailabilities as the type', () => {
    expect(body.data.type).toBe('subscriptionAvailabilities');
  });

  it('carries availableInNewTerritories (wire key, no is-prefix)', () => {
    expect(body.data.attributes).toEqual({ availableInNewTerritories: true });
  });

  it('points at the owning subscription', () => {
    expect(rel(body, 'subscription')).toEqual({ type: 'subscriptions', id: 'SUB-1' });
  });

  it('availableTerritories are plain territories with bare ISO ids', () => {
    expect(rel(body, 'availableTerritories')).toEqual([
      { type: 'territories', id: 'USA' },
      { type: 'territories', id: 'BRA' },
    ]);
  });
});

describe('buildIapAvailabilityCreateBody', () => {
  const body = buildIapAvailabilityCreateBody({
    iapId: 'IAP-1',
    availableInNewTerritories: false,
    territoryIds: ['JPN'],
  }) as Body;

  it('uses inAppPurchaseAvailabilities as the type', () => {
    expect(body.data.type).toBe('inAppPurchaseAvailabilities');
  });

  it('relationship key is inAppPurchase (no V2 suffix on this resource)', () => {
    expect(rel(body, 'inAppPurchase')).toEqual({ type: 'inAppPurchases', id: 'IAP-1' });
  });

  it('carries availableInNewTerritories=false explicitly', () => {
    expect(body.data.attributes).toEqual({ availableInNewTerritories: false });
  });
});

describe('buildSubscriptionPlanAvailabilityCreateBody', () => {
  const body = buildSubscriptionPlanAvailabilityCreateBody({
    subscriptionId: 'SUB-1',
    planType: 'UPFRONT',
    territoryIds: ['USA'],
  }) as Body;

  it('uses subscriptionPlanAvailabilities as the type and carries planType', () => {
    expect(body.data.type).toBe('subscriptionPlanAvailabilities');
    expect(body.data.attributes).toEqual({ planType: 'UPFRONT' });
  });

  it('omits availableInNewTerritories when not provided (optional here)', () => {
    expect('availableInNewTerritories' in (body.data.attributes ?? {})).toBe(false);
  });

  it('includes availableInNewTerritories when provided', () => {
    const withFlag = buildSubscriptionPlanAvailabilityCreateBody({
      subscriptionId: 'SUB-1',
      planType: 'MONTHLY',
      availableInNewTerritories: true,
      territoryIds: ['USA'],
    }) as Body;
    expect(withFlag.data.attributes).toEqual({
      planType: 'MONTHLY',
      availableInNewTerritories: true,
    });
  });
});

describe('buildSubscriptionPlanAvailabilityPatchBody', () => {
  it('carries the resource id in the body', () => {
    const body = buildSubscriptionPlanAvailabilityPatchBody({
      planAvailabilityId: 'PLAN-1',
      availableInNewTerritories: true,
    }) as Body;
    expect(body.data.id).toBe('PLAN-1');
    expect(body.data.type).toBe('subscriptionPlanAvailabilities');
  });

  it('attributes-only patch omits the relationships block entirely', () => {
    const body = buildSubscriptionPlanAvailabilityPatchBody({
      planAvailabilityId: 'PLAN-1',
      availableInNewTerritories: false,
    }) as Body;
    expect(body.data.attributes).toEqual({ availableInNewTerritories: false });
    expect('relationships' in body.data).toBe(false);
  });

  it('territories-only patch omits the attributes block entirely', () => {
    const body = buildSubscriptionPlanAvailabilityPatchBody({
      planAvailabilityId: 'PLAN-1',
      territoryIds: ['USA', 'CAN'],
    }) as Body;
    expect('attributes' in body.data).toBe(false);
    expect(rel(body, 'availableTerritories')).toEqual([
      { type: 'territories', id: 'USA' },
      { type: 'territories', id: 'CAN' },
    ]);
  });
});
