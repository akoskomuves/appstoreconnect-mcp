import { describe, expect, it } from 'vitest';
import {
  buildPhasedReleaseCreateBody,
  buildPhasedReleasePatchBody,
} from '../src/domains/phased-release.js';

// Pin the wire shape for AppStoreVersionPhasedRelease.
//
// Quirks driving these assertions:
//   1. NO-ATTRS-BLOCK OMISSION on Create when no state is provided —
//      attributes block is OPTIONAL in the Swift contract (the only attr,
//      phasedReleaseState, is also optional). Body builder must OMIT the
//      entire `attributes` key when state is not passed (same pattern as
//      v0.9 AppInfo PATCH and v0.13 CPP Version Create).
//   2. Update body only carries phasedReleaseState — caller already
//      guarded empty input upstream.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildPhasedReleaseCreateBody', () => {
  it('uses appStoreVersionPhasedReleases type with required appStoreVersion rel', () => {
    const body = buildPhasedReleaseCreateBody({
      appStoreVersionId: 'V-1',
    }) as Body;
    expect(body.data.type).toBe('appStoreVersionPhasedReleases');
    const rels = body.data.relationships as {
      appStoreVersion: { data: { type: string; id: string } };
    };
    expect(rels.appStoreVersion.data).toEqual({ type: 'appStoreVersions', id: 'V-1' });
  });

  it('OMITS the entire attributes key when phasedReleaseState is not provided', () => {
    const body = buildPhasedReleaseCreateBody({
      appStoreVersionId: 'V-1',
    }) as Body;
    expect('attributes' in body.data).toBe(false);
  });

  it('emits attributes.phasedReleaseState only when provided', () => {
    const body = buildPhasedReleaseCreateBody({
      appStoreVersionId: 'V-1',
      phasedReleaseState: 'ACTIVE',
    }) as Body;
    expect(body.data.attributes).toEqual({ phasedReleaseState: 'ACTIVE' });
  });
});

describe('buildPhasedReleasePatchBody', () => {
  it('uses appStoreVersionPhasedReleases type + resource id + state attr', () => {
    const body = buildPhasedReleasePatchBody({
      phasedReleaseId: 'PR-1',
      phasedReleaseState: 'PAUSED',
    }) as Body;
    expect(body.data.type).toBe('appStoreVersionPhasedReleases');
    expect(body.data.id).toBe('PR-1');
    expect(body.data.attributes).toEqual({ phasedReleaseState: 'PAUSED' });
  });

  it('does not emit a relationships block', () => {
    const body = buildPhasedReleasePatchBody({
      phasedReleaseId: 'PR-1',
      phasedReleaseState: 'COMPLETE',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});
