import { describe, expect, it } from 'vitest';
import {
  buildAppAvailabilityV2CreateBody,
  buildEndAppAvailabilityPreOrderBody,
  buildTerritoryAvailabilityPatchBody,
} from '../src/domains/app-availability.js';

// Pin the wire shape for AppAvailabilityV2 + EndAppAvailabilityPreOrder.
//
// Quirks driving these assertions:
//   1. WIRE-KEY GOTCHA: Swift `isAvailableInNewTerritories` → wire
//      `availableInNewTerritories` (same is-prefix-strip family as
//      v0.13 isVisible → visible, v0.14 isVisibleForAllUsers).
//   2. AppAvailabilityV2 is POST-only — no PATCH / DELETE.
//   3. EndAppAvailabilityPreOrder is RELATIONSHIPS-ONLY — no attributes
//      block (same pattern as v0.9 AppInfo PATCH).
//   4. TerritoryAvailability IDs ARE the 3-letter ISO codes themselves
//      (same as v0.12 AppKeyword.id = the keyword string).

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppAvailabilityV2CreateBody', () => {
  it('uses appAvailabilities type with required attrs + app + territories', () => {
    const body = buildAppAvailabilityV2CreateBody({
      appId: 'APP-1',
      availableInNewTerritories: true,
      territoryIds: ['USA', 'BRA', 'JPN'],
    }) as Body;
    expect(body.data.type).toBe('appAvailabilities');
    const rels = body.data.relationships as {
      app: { data: { type: string; id: string } };
      territoryAvailabilities: { data: Array<{ type: string; id: string }> };
    };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
    expect(rels.territoryAvailabilities.data).toEqual([
      { type: 'territoryAvailabilities', id: 'USA' },
      { type: 'territoryAvailabilities', id: 'BRA' },
      { type: 'territoryAvailabilities', id: 'JPN' },
    ]);
  });

  it('emits wire key `availableInNewTerritories` (NOT Swift `isAvailableInNewTerritories`)', () => {
    const body = buildAppAvailabilityV2CreateBody({
      appId: 'APP-1',
      availableInNewTerritories: true,
      territoryIds: ['USA'],
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.availableInNewTerritories).toBe(true);
    expect('isAvailableInNewTerritories' in attrs).toBe(false);
  });

  it('preserves input territory order (Apple uses the array as the full list)', () => {
    const body = buildAppAvailabilityV2CreateBody({
      appId: 'APP-1',
      availableInNewTerritories: false,
      territoryIds: ['ZAF', 'AUS', 'CAN'],
    }) as Body;
    const rels = body.data.relationships as {
      territoryAvailabilities: { data: Array<{ id: string }> };
    };
    expect(rels.territoryAvailabilities.data.map((d) => d.id)).toEqual(['ZAF', 'AUS', 'CAN']);
  });
});

describe('buildEndAppAvailabilityPreOrderBody', () => {
  it('uses endAppAvailabilityPreOrders type with relationships-only body (NO attributes)', () => {
    const body = buildEndAppAvailabilityPreOrderBody({
      territoryIds: ['USA', 'BRA'],
    }) as Body;
    expect(body.data.type).toBe('endAppAvailabilityPreOrders');
    expect('attributes' in body.data).toBe(false);
    const rels = body.data.relationships as {
      territoryAvailabilities: { data: Array<{ type: string; id: string }> };
    };
    expect(rels.territoryAvailabilities.data).toEqual([
      { type: 'territoryAvailabilities', id: 'USA' },
      { type: 'territoryAvailabilities', id: 'BRA' },
    ]);
  });
});

describe('buildTerritoryAvailabilityPatchBody (v0.22 pre-orders)', () => {
  it('targets the opaque composite id with only provided attrs (verbatim camelCase keys)', () => {
    const body = buildTerritoryAvailabilityPatchBody({
      territoryAvailabilityId: 'eyJzIjoiMTIzNDUiLCJ0IjoiVVNBIn0',
      preOrderEnabled: true,
      releaseDate: '2026-09-01',
    }) as Body;
    expect(body.data.type).toBe('territoryAvailabilities');
    expect(body.data.id).toBe('eyJzIjoiMTIzNDUiLCJ0IjoiVVNBIn0');
    expect(body.data.attributes).toEqual({ preOrderEnabled: true, releaseDate: '2026-09-01' });
    expect('relationships' in body.data).toBe(false);
  });

  it('supports the available-only form (territory pull/restore)', () => {
    const body = buildTerritoryAvailabilityPatchBody({
      territoryAvailabilityId: 'TA-1',
      available: false,
    }) as Body;
    expect(body.data.attributes).toEqual({ available: false });
  });
});
