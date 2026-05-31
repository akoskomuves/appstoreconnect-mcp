import { describe, expect, it } from 'vitest';
import { buildBuildBetaDetailPatchBody, buildBuildPatchBody } from '../src/domains/builds.js';

// Pin the JSON:API wire shape for the two writable TestFlight endpoints we
// PATCH against in v0.9.0:
//   PATCH /v1/builds/{id}
//   PATCH /v1/buildBetaDetails/{id}
//
// Apple's quirks driving these assertions:
//   1. BuildUpdateRequest ONLY permits `expired` + `usesNonExemptEncryption`.
//      No relationships block (touching app or buildBetaDetail rels would
//      422). Both attrs are encodeIfPresent — body builder OMITs the key
//      when undefined so we don't accidentally toggle the other flag.
//   2. BuildBetaDetailUpdateRequest ONLY permits `autoNotifyEnabled`. The
//      internal/external build state attrs are Apple-managed and rejected
//      from PATCH bodies.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
};

describe('buildBuildPatchBody', () => {
  it('uses builds as the type with the build ID', () => {
    const body = buildBuildPatchBody({ buildId: 'BUILD-1', expired: true }) as Body;
    expect(body.data.type).toBe('builds');
    expect(body.data.id).toBe('BUILD-1');
  });

  it('emits expired when caller passes it', () => {
    const b = buildBuildPatchBody({ buildId: 'BUILD-1', expired: true }) as Body;
    expect(b.data.attributes).toEqual({ expired: true });
  });

  it('emits usesNonExemptEncryption when caller passes it', () => {
    const b = buildBuildPatchBody({
      buildId: 'BUILD-1',
      usesNonExemptEncryption: false,
    }) as Body;
    expect(b.data.attributes).toEqual({ usesNonExemptEncryption: false });
  });

  it('emits both when caller passes both', () => {
    const b = buildBuildPatchBody({
      buildId: 'BUILD-1',
      expired: true,
      usesNonExemptEncryption: true,
    }) as Body;
    expect(b.data.attributes).toEqual({ expired: true, usesNonExemptEncryption: true });
  });

  it('OMITS expired when caller did not pass it (encodeIfPresent semantics)', () => {
    const b = buildBuildPatchBody({
      buildId: 'BUILD-1',
      usesNonExemptEncryption: true,
    }) as Body;
    const attrs = b.data.attributes as Record<string, unknown>;
    expect('expired' in attrs).toBe(false);
  });

  it('OMITS usesNonExemptEncryption when caller did not pass it', () => {
    const b = buildBuildPatchBody({ buildId: 'BUILD-1', expired: false }) as Body;
    const attrs = b.data.attributes as Record<string, unknown>;
    expect('usesNonExemptEncryption' in attrs).toBe(false);
  });

  it('produces an empty attributes object when nothing is passed (tool-level guard against this)', () => {
    const b = buildBuildPatchBody({ buildId: 'BUILD-1' }) as Body;
    expect(b.data.attributes).toEqual({});
  });

  it('has an empty relationships block (PATCH must not touch app or buildBetaDetail rels)', () => {
    const b = buildBuildPatchBody({ buildId: 'BUILD-1', expired: true }) as Body;
    expect(b.data.relationships).toEqual({});
  });
});

describe('buildBuildBetaDetailPatchBody', () => {
  const body = buildBuildBetaDetailPatchBody({
    buildBetaDetailId: 'BBD-1',
    autoNotifyEnabled: true,
  }) as Body;

  it('uses buildBetaDetails as the type with the resource ID', () => {
    expect(body.data.type).toBe('buildBetaDetails');
    expect(body.data.id).toBe('BBD-1');
  });

  it('carries only autoNotifyEnabled (internal/external state are Apple-managed, PATCH rejects)', () => {
    expect(body.data.attributes).toEqual({ autoNotifyEnabled: true });
  });

  it('serializes false correctly (boolean, not falsy-omitted)', () => {
    const b = buildBuildBetaDetailPatchBody({
      buildBetaDetailId: 'BBD-1',
      autoNotifyEnabled: false,
    }) as Body;
    expect((b.data.attributes as Record<string, unknown>).autoNotifyEnabled).toBe(false);
  });

  it('has an empty relationships block', () => {
    expect(body.data.relationships).toEqual({});
  });
});
