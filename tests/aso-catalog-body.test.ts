import { describe, expect, it } from 'vitest';
import { buildAppTagPatchBody } from '../src/domains/aso-catalog.js';

// Pin the wire shape for AppTag PATCH (the only writable surface in
// v0.12.0's ASO catalog domain — AppCategory + SearchKeywords are
// read-only).
//
// Apple's quirks:
//   1. AppTagUpdateRequest accepts ONLY visibleInAppStore (single attr).
//      Body builder hard-codes this single field.
//   2. Wire-key gotcha: Swift `isVisibleInAppStore` → wire
//      `visibleInAppStore` (is-prefix stripped). Same pattern as
//      autoRenewEnabled (offer codes), demoAccountRequired
//      (beta-app review), etc.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
  };
};

describe('buildAppTagPatchBody', () => {
  it('uses appTags type with the resource ID', () => {
    const body = buildAppTagPatchBody({
      appTagId: 'TAG-1',
      visibleInAppStore: true,
    }) as Body;
    expect(body.data.type).toBe('appTags');
    expect(body.data.id).toBe('TAG-1');
  });

  it('emits the WIRE key `visibleInAppStore` (stripped from Swift `isVisibleInAppStore`)', () => {
    const body = buildAppTagPatchBody({
      appTagId: 'TAG-1',
      visibleInAppStore: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.visibleInAppStore).toBe(true);
    // Regression guard: Swift `isVisibleInAppStore` must NOT appear.
    expect('isVisibleInAppStore' in attrs).toBe(false);
  });

  it('serializes false correctly (boolean, not falsy-omitted)', () => {
    const body = buildAppTagPatchBody({
      appTagId: 'TAG-1',
      visibleInAppStore: false,
    }) as Body;
    expect((body.data.attributes as Record<string, unknown>).visibleInAppStore).toBe(false);
  });

  it('attributes block has ONLY visibleInAppStore (no other mutable fields)', () => {
    const body = buildAppTagPatchBody({
      appTagId: 'TAG-1',
      visibleInAppStore: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(Object.keys(attrs)).toEqual(['visibleInAppStore']);
  });
});
