import { describe, expect, it } from 'vitest';
import {
  buildBetaAppReviewDetailPatchBody,
  buildBetaAppReviewSubmissionCreateBody,
} from '../src/domains/beta-review.js';

// Pin the wire shape for the two writable beta-review endpoints:
//   POST /v1/betaAppReviewSubmissions
//   PATCH /v1/betaAppReviewDetails/{id}
//
// Apple's quirks:
//   1. BetaAppReviewSubmissionCreateRequest has NO attributes block at all —
//      only the `build` relationship. Body builder must omit `attributes`.
//   2. BetaAppReviewDetailUpdateRequest accepts contactFirstName /
//      contactLastName / contactPhone / contactEmail / demoAccountName /
//      demoAccountPassword / demoAccountRequired / notes. All encodeIfPresent.
//      Wire-key strip on `demoAccountRequired` (Swift `isDemoAccountRequired`);
//      all other attrs are 1:1.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildBetaAppReviewSubmissionCreateBody', () => {
  const body = buildBetaAppReviewSubmissionCreateBody({ buildId: 'B-1' }) as Body;

  it('uses betaAppReviewSubmissions type', () => {
    expect(body.data.type).toBe('betaAppReviewSubmissions');
  });

  it('points at the target build via the build relationship', () => {
    const rels = body.data.relationships as { build: { data: { type: string; id: string } } };
    expect(rels.build.data).toEqual({ type: 'builds', id: 'B-1' });
  });

  it("OMITS the attributes block entirely (Apple's contract has no attrs at all)", () => {
    // Regression guard: prevents accidental emission of `attributes: {}`,
    // which Apple has historically rejected on some submission endpoints.
    expect('attributes' in body.data).toBe(false);
  });
});

describe('buildBetaAppReviewDetailPatchBody', () => {
  it('uses betaAppReviewDetails type with the resource ID', () => {
    const body = buildBetaAppReviewDetailPatchBody({
      betaAppReviewDetailId: 'BARD-1',
      contactFirstName: 'Alex',
    }) as Body;
    expect(body.data.type).toBe('betaAppReviewDetails');
    expect(body.data.id).toBe('BARD-1');
  });

  it('emits each attr verbatim with wire-correct keys', () => {
    const body = buildBetaAppReviewDetailPatchBody({
      betaAppReviewDetailId: 'BARD-1',
      contactFirstName: 'Alex',
      contactLastName: 'Doe',
      contactPhone: '+1 415 555 0100',
      contactEmail: 'alex@example.com',
      demoAccountName: 'demo@example.com',
      demoAccountPassword: 'demo-throwaway',
      demoAccountRequired: true,
      notes: 'Reviewer guidance.',
    }) as Body;
    expect(body.data.attributes).toEqual({
      contactFirstName: 'Alex',
      contactLastName: 'Doe',
      contactPhone: '+1 415 555 0100',
      contactEmail: 'alex@example.com',
      demoAccountName: 'demo@example.com',
      demoAccountPassword: 'demo-throwaway',
      demoAccountRequired: true,
      notes: 'Reviewer guidance.',
    });
  });

  it('uses STRIPPED wire key `demoAccountRequired` (not Swift `isDemoAccountRequired`)', () => {
    const body = buildBetaAppReviewDetailPatchBody({
      betaAppReviewDetailId: 'BARD-1',
      demoAccountRequired: false,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.demoAccountRequired).toBe(false);
    // Regression guard.
    expect('isDemoAccountRequired' in attrs).toBe(false);
  });

  it('OMITS all undefined attrs (encodeIfPresent)', () => {
    const body = buildBetaAppReviewDetailPatchBody({
      betaAppReviewDetailId: 'BARD-1',
      contactEmail: 'alex@example.com',
    }) as Body;
    expect(body.data.attributes).toEqual({ contactEmail: 'alex@example.com' });
  });

  it('produces an empty attributes object when nothing is passed (tool-level guard against this)', () => {
    const body = buildBetaAppReviewDetailPatchBody({ betaAppReviewDetailId: 'BARD-1' }) as Body;
    expect(body.data.attributes).toEqual({});
  });

  it('does not include a relationships block', () => {
    const body = buildBetaAppReviewDetailPatchBody({
      betaAppReviewDetailId: 'BARD-1',
      notes: 'X',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});
