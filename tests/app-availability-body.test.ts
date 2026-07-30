import { describe, expect, it } from 'vitest';
import {
  APP_AVAILABILITIES_V2_ENDPOINT,
  buildAppAvailabilityV2CreateBody,
  buildEndAppAvailabilityPreOrderBody,
  buildTerritoryAvailabilityPatchBody,
  explainAvailability404,
} from '../src/domains/app-availability.js';
import { ASCError } from '../src/errors.js';
import { TerritoryAvailabilityIdSchema } from '../src/schemas.js';

// Pin the wire shape for AppAvailabilityV2 + EndAppAvailabilityPreOrder.
//
// Quirks driving these assertions:
//   1. WIRE-KEY GOTCHA: Swift `isAvailableInNewTerritories` → wire
//      `availableInNewTerritories` (same is-prefix-strip family as
//      v0.13 isVisible → visible, v0.14 isVisibleForAllUsers).
//   2. AppAvailabilityV2 is POST-only — no PATCH / DELETE.
//   3. EndAppAvailabilityPreOrder is RELATIONSHIPS-ONLY — no attributes
//      block (same pattern as v0.9 AppInfo PATCH).
//   4. TerritoryAvailability IDs are APPLE-OPAQUE, *not* the 3-letter ISO
//      codes — they are per-(app, territory) base64 of
//      `{"s":"<appId>","t":"<CODE>"}` with padding stripped. (An earlier
//      version of this comment claimed the ISO-code shape; that was wrong,
//      corrected by the v0.15 live smoke and re-confirmed 2026-07-30.)
//   5. The resource is served ONLY on /v2 — there is no /v1/appAvailabilities
//      resource at all (404 PATH_ERROR).

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

describe('APP_AVAILABILITIES_V2_ENDPOINT', () => {
  // The regression: the create tool POSTed to /v1/appAvailabilities, which
  // Apple 404s ("The resource 'v1/appAvailabilities' does not exist"), while
  // the sibling read path already used /v2. Both now derive from this
  // constant so they cannot drift apart again.
  it('is on /v2, never /v1', () => {
    expect(APP_AVAILABILITIES_V2_ENDPOINT).toBe('/v2/appAvailabilities');
    expect(APP_AVAILABILITIES_V2_ENDPOINT).not.toContain('/v1/');
  });
});

describe('TerritoryAvailabilityIdSchema — bare-code guard', () => {
  // The trap that sent a real territory rollout to manual: passing "USA"
  // where an opaque composite belongs. Apple's own rejection doesn't explain
  // the fix, so guard it at the schema with a message that names the tool to
  // call. A real ID is base64 of a JSON object (~38 chars), so a 3-letter
  // all-caps string can never be a false positive.
  it('rejects bare 3-letter territory codes', () => {
    for (const code of ['USA', 'BRA', 'JPN']) {
      const r = TerritoryAvailabilityIdSchema.safeParse(code);
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]?.message).toContain('asc_list_territory_availabilities');
      }
    }
  });

  it('accepts a composite in the live-verified shape', () => {
    // Synthetic app id, but the SHAPE is what live IDs use (checked against
    // real ones 2026-07-30): base64 of {"s":appId,"t":code}, padding stripped,
    // 38 chars for a 10-digit app id.
    const composite = 'eyJzIjoiMTIzNDU2Nzg5MCIsInQiOiJVU0EifQ';
    expect(composite).toHaveLength(38);
    expect(composite).not.toContain('=');
    expect(TerritoryAvailabilityIdSchema.safeParse(composite).success).toBe(true);
    expect(JSON.parse(Buffer.from(composite, 'base64').toString('utf8'))).toEqual({
      s: '1234567890',
      t: 'USA',
    });
  });

  it('does not reject lowercase or longer strings that merely look short', () => {
    // Only the exact bare-code shape is refused — no over-eager matching.
    expect(TerritoryAvailabilityIdSchema.safeParse('usa').success).toBe(true);
    expect(TerritoryAvailabilityIdSchema.safeParse('USAX').success).toBe(true);
  });
});

describe('explainAvailability404', () => {
  // Measured across 11 real apps 2026-07-30: the availability record appears
  // at FIRST SUBMISSION, not at publish. An app in PREPARE_FOR_SUBMISSION
  // 404s here with nothing wrong; read bare, that looks like "territories
  // are unset" and sends you to configure them by hand.
  it('turns a 404 into an explanation naming first submission', () => {
    const msg = explainAvailability404(new ASCError(404, 'Not Found', '{}'), 'APP-1');
    expect(msg).toBeDefined();
    expect(msg).toContain('FIRST SUBMISSION');
    expect(msg).toContain('APP-1');
    // Must explicitly kill the wrong conclusion, not just describe the state.
    expect(msg).toContain('does NOT mean territory availability is misconfigured');
  });

  it('still says a 404 on a submitted app is worth investigating', () => {
    const msg = explainAvailability404(new ASCError(404, 'Not Found', '{}'), 'APP-1');
    expect(msg).toContain('HAS been submitted');
  });

  it('leaves non-404 errors alone', () => {
    expect(explainAvailability404(new ASCError(409, 'Conflict', '{}'), 'APP-1')).toBeUndefined();
    expect(explainAvailability404(new ASCError(400, 'Bad', '{}'), 'APP-1')).toBeUndefined();
  });

  it('leaves non-ASC errors alone', () => {
    expect(explainAvailability404(new Error('boom'), 'APP-1')).toBeUndefined();
  });
});
