import { describe, expect, it } from 'vitest';
import {
  buildBetaGroupCreateBody,
  buildBetaGroupPatchBody,
  buildRelationshipLinkageBody,
} from '../src/domains/beta-groups.js';

// Pin the JSON:API wire shape for the four writable beta-group endpoints:
//   POST   /v1/betaGroups
//   PATCH  /v1/betaGroups/{id}
//   POST   /v1/betaGroups/{id}/relationships/betaTesters (+ DELETE same body)
//   POST   /v1/betaGroups/{id}/relationships/builds      (+ DELETE same body)
//
// Apple's quirks driving these assertions:
//   1. Wire keys differ from Swift property names. The body builder must
//      use Apple's JSON keys, not the Swift `isFoo` form:
//        Swift `isPublicLinkEnabled` -> wire `publicLinkEnabled`
//        Swift `isPublicLinkLimitEnabled` -> wire `publicLinkLimitEnabled`
//        Swift `isFeedbackEnabled` -> wire `feedbackEnabled`
//        Swift `isInternalGroup` -> wire `isInternalGroup` (KEPT)
//        Swift `hasAccessToAllBuilds` -> wire `hasAccessToAllBuilds` (KEPT)
//      Getting the prefix-stripping wrong silently lands the wrong shape
//      and Apple either no-ops or 422s.
//   2. BetaGroupCreateRequest requires name + app rel; everything else is
//      encodeIfPresent. Body builder must OMIT undefined keys, not send null.
//   3. BetaGroupUpdateRequest does NOT include isInternalGroup or
//      hasAccessToAllBuilds — these are immutable post-create. Patch body
//      must never carry them.
//   4. Relationship linkage requests have a flat to-many shape — no parent
//      data wrapper, no attributes. Same body works for both POST (add) and
//      DELETE (remove).

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildBetaGroupCreateBody', () => {
  it('uses betaGroups type with name attribute and app relationship (minimum required shape)', () => {
    const body = buildBetaGroupCreateBody({
      appId: 'APP-1',
      name: 'Internal QA',
    }) as Body;
    expect(body.data.type).toBe('betaGroups');
    expect(body.data.attributes).toEqual({ name: 'Internal QA' });
    expect(
      (body.data.relationships as { app: { data: { type: string; id: string } } }).app.data,
    ).toEqual({ type: 'apps', id: 'APP-1' });
  });

  it('keeps isInternalGroup + hasAccessToAllBuilds as wire keys (Apple does NOT strip the prefix on these)', () => {
    const body = buildBetaGroupCreateBody({
      appId: 'APP-1',
      name: 'Internal QA',
      isInternalGroup: true,
      hasAccessToAllBuilds: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.isInternalGroup).toBe(true);
    expect(attrs.hasAccessToAllBuilds).toBe(true);
    // Wrong-form keys should NOT appear (regression guard against accidental
    // is-stripping on these two specific attrs).
    expect('internalGroup' in attrs).toBe(false);
    expect('accessToAllBuilds' in attrs).toBe(false);
  });

  it('STRIPS the is-prefix on publicLinkEnabled / publicLinkLimitEnabled / feedbackEnabled', () => {
    const body = buildBetaGroupCreateBody({
      appId: 'APP-1',
      name: 'External Beta',
      publicLinkEnabled: true,
      publicLinkLimitEnabled: true,
      publicLinkLimit: 500,
      feedbackEnabled: false,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    // Wire keys (correct).
    expect(attrs.publicLinkEnabled).toBe(true);
    expect(attrs.publicLinkLimitEnabled).toBe(true);
    expect(attrs.publicLinkLimit).toBe(500);
    expect(attrs.feedbackEnabled).toBe(false);
    // is-prefixed Swift names (wrong) must NOT appear.
    expect('isPublicLinkEnabled' in attrs).toBe(false);
    expect('isPublicLinkLimitEnabled' in attrs).toBe(false);
    expect('isFeedbackEnabled' in attrs).toBe(false);
  });

  it('OMITS optional attrs entirely when caller does not pass them (encodeIfPresent)', () => {
    const body = buildBetaGroupCreateBody({
      appId: 'APP-1',
      name: 'Bare',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(Object.keys(attrs)).toEqual(['name']);
  });

  it('attaches initial tester IDs as a to-many betaTesters relationship', () => {
    const body = buildBetaGroupCreateBody({
      appId: 'APP-1',
      name: 'Seeded',
      initialTesterIds: ['T1', 'T2', 'T3'],
    }) as Body;
    const rels = body.data.relationships as {
      betaTesters: { data: Array<{ type: string; id: string }> };
    };
    expect(rels.betaTesters.data).toEqual([
      { type: 'betaTesters', id: 'T1' },
      { type: 'betaTesters', id: 'T2' },
      { type: 'betaTesters', id: 'T3' },
    ]);
  });

  it('attaches initial build IDs as a to-many builds relationship', () => {
    const body = buildBetaGroupCreateBody({
      appId: 'APP-1',
      name: 'Seeded',
      initialBuildIds: ['B1', 'B2'],
    }) as Body;
    const rels = body.data.relationships as {
      builds: { data: Array<{ type: string; id: string }> };
    };
    expect(rels.builds.data).toEqual([
      { type: 'builds', id: 'B1' },
      { type: 'builds', id: 'B2' },
    ]);
  });

  it('OMITS empty initialTesterIds/initialBuildIds arrays from relationships', () => {
    const body = buildBetaGroupCreateBody({
      appId: 'APP-1',
      name: 'Bare',
      initialTesterIds: [],
      initialBuildIds: [],
    }) as Body;
    const rels = body.data.relationships as Record<string, unknown>;
    expect('betaTesters' in rels).toBe(false);
    expect('builds' in rels).toBe(false);
    // app rel must still be present.
    expect('app' in rels).toBe(true);
  });
});

describe('buildBetaGroupPatchBody', () => {
  it('uses betaGroups type with the group ID', () => {
    const body = buildBetaGroupPatchBody({
      betaGroupId: 'BG-1',
      name: 'Renamed',
    }) as Body;
    expect(body.data.type).toBe('betaGroups');
    expect(body.data.id).toBe('BG-1');
  });

  it('emits each provided attr on the wire-correct key', () => {
    const body = buildBetaGroupPatchBody({
      betaGroupId: 'BG-1',
      name: 'New Name',
      publicLinkEnabled: true,
      publicLinkLimitEnabled: true,
      publicLinkLimit: 100,
      feedbackEnabled: false,
      iosBuildsAvailableForAppleSiliconMac: true,
      iosBuildsAvailableForAppleVision: false,
    }) as Body;
    expect(body.data.attributes).toEqual({
      name: 'New Name',
      publicLinkEnabled: true,
      publicLinkLimitEnabled: true,
      publicLinkLimit: 100,
      feedbackEnabled: false,
      iosBuildsAvailableForAppleSiliconMac: true,
      iosBuildsAvailableForAppleVision: false,
    });
  });

  it('OMITS undefined attrs entirely (encodeIfPresent)', () => {
    const body = buildBetaGroupPatchBody({
      betaGroupId: 'BG-1',
      feedbackEnabled: true,
    }) as Body;
    expect(body.data.attributes).toEqual({ feedbackEnabled: true });
  });

  it('produces an empty attributes object when nothing is passed (tool-level guard against this)', () => {
    const body = buildBetaGroupPatchBody({ betaGroupId: 'BG-1' }) as Body;
    expect(body.data.attributes).toEqual({});
  });

  it('has an empty relationships block (tester/build linkage uses separate endpoints)', () => {
    const body = buildBetaGroupPatchBody({
      betaGroupId: 'BG-1',
      name: 'X',
    }) as Body;
    expect(body.data.relationships).toEqual({});
  });
});

describe('buildRelationshipLinkageBody', () => {
  it('emits a flat to-many { data: [{ type, id }, ...] } shape for testers', () => {
    const body = buildRelationshipLinkageBody({
      betaGroupId: 'BG-1',
      ids: ['T1', 'T2'],
      resourceType: 'betaTesters',
    });
    expect(body).toEqual({
      data: [
        { type: 'betaTesters', id: 'T1' },
        { type: 'betaTesters', id: 'T2' },
      ],
    });
  });

  it('emits the same shape for builds (only the type label differs)', () => {
    const body = buildRelationshipLinkageBody({
      betaGroupId: 'BG-1',
      ids: ['B1'],
      resourceType: 'builds',
    });
    expect(body).toEqual({
      data: [{ type: 'builds', id: 'B1' }],
    });
  });

  it("has no parent data wrapper or attributes — Apple's linkage endpoints reject those", () => {
    const body = buildRelationshipLinkageBody({
      betaGroupId: 'BG-1',
      ids: ['T1'],
      resourceType: 'betaTesters',
    }) as Record<string, unknown>;
    // Top-level shape is just { data: [...] } — no `type`, no `id`, no
    // `attributes`, no `relationships`.
    expect(Object.keys(body)).toEqual(['data']);
  });
});
