import { describe, expect, it } from 'vitest';
import {
  buildReviewSubmissionCreateBody,
  buildReviewSubmissionItemCreateBody,
  buildReviewSubmissionPatchBody,
} from '../src/domains/review-submissions.js';

// Pin the wire shape for Apple's V2 review submission endpoints:
//   POST  /v1/reviewSubmissions
//   PATCH /v1/reviewSubmissions/{id}        (submit / cancel)
//   POST  /v1/reviewSubmissionItems
//   DELETE /v1/reviewSubmissionItems/{id}   (linkage tested implicitly)
//
// Apple quirks driving these assertions:
//   1. ReviewSubmissionCreateRequest: app rel REQUIRED, platform attr
//      optional. attributes block must be omitted if no platform is
//      passed (Apple's create endpoints reject `attributes: {}` on this
//      resource — same pattern as BetaTesterInvitation).
//   2. ReviewSubmissionUpdateRequest: only `submitted` OR `canceled`
//      (mutually exclusive). Wire keys are STRIPPED from Swift's
//      `isSubmitted` / `isCanceled`.
//   3. ReviewSubmissionItemCreateRequest: reviewSubmission rel REQUIRED
//      + exactly ONE item-type rel. v0.11 wraps only the appStoreVersion
//      slot.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildReviewSubmissionCreateBody', () => {
  it('uses reviewSubmissions type with required app rel and no attributes block when platform omitted', () => {
    const body = buildReviewSubmissionCreateBody({ appId: 'APP-1' }) as Body;
    expect(body.data.type).toBe('reviewSubmissions');
    const rels = body.data.relationships as { app: { data: { type: string; id: string } } };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
    expect('attributes' in body.data).toBe(false);
  });

  it('emits the platform attribute when provided', () => {
    const body = buildReviewSubmissionCreateBody({ appId: 'APP-1', platform: 'IOS' }) as Body;
    expect(body.data.attributes).toEqual({ platform: 'IOS' });
  });
});

describe('buildReviewSubmissionPatchBody', () => {
  it('submit action emits wire-stripped `submitted: true` only', () => {
    const body = buildReviewSubmissionPatchBody({
      reviewSubmissionId: 'RS-1',
      action: 'submit',
    }) as Body;
    expect(body.data.type).toBe('reviewSubmissions');
    expect(body.data.id).toBe('RS-1');
    expect(body.data.attributes).toEqual({ submitted: true });
    // Regression guard: must NOT use the Swift `isSubmitted` name.
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('isSubmitted' in attrs).toBe(false);
  });

  it('cancel action emits wire-stripped `canceled: true` only', () => {
    const body = buildReviewSubmissionPatchBody({
      reviewSubmissionId: 'RS-1',
      action: 'cancel',
    }) as Body;
    expect(body.data.attributes).toEqual({ canceled: true });
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('isCanceled' in attrs).toBe(false);
  });

  it('NEVER emits both submitted and canceled in the same body (Apple rejects)', () => {
    const submit = buildReviewSubmissionPatchBody({
      reviewSubmissionId: 'RS-1',
      action: 'submit',
    }) as Body;
    const cancel = buildReviewSubmissionPatchBody({
      reviewSubmissionId: 'RS-1',
      action: 'cancel',
    }) as Body;
    const submitAttrs = submit.data.attributes as Record<string, unknown>;
    const cancelAttrs = cancel.data.attributes as Record<string, unknown>;
    expect(Object.keys(submitAttrs)).toEqual(['submitted']);
    expect(Object.keys(cancelAttrs)).toEqual(['canceled']);
  });
});

describe('buildReviewSubmissionItemCreateBody', () => {
  const body = buildReviewSubmissionItemCreateBody({
    reviewSubmissionId: 'RS-1',
    appStoreVersionId: 'V-1',
  }) as Body;

  it('uses reviewSubmissionItems type', () => {
    expect(body.data.type).toBe('reviewSubmissionItems');
  });

  it('points at the parent submission via reviewSubmission relationship', () => {
    const rels = body.data.relationships as {
      reviewSubmission: { data: { type: string; id: string } };
    };
    expect(rels.reviewSubmission.data).toEqual({
      type: 'reviewSubmissions',
      id: 'RS-1',
    });
  });

  it('attaches the AppStoreVersion as the item via appStoreVersion relationship', () => {
    const rels = body.data.relationships as {
      appStoreVersion: { data: { type: string; id: string } };
    };
    expect(rels.appStoreVersion.data).toEqual({
      type: 'appStoreVersions',
      id: 'V-1',
    });
  });

  it("does NOT emit attributes (Apple's contract has no attrs on item create)", () => {
    expect('attributes' in body.data).toBe(false);
  });

  it('does NOT emit other polymorphic item-type rels (only one item per create)', () => {
    const rels = body.data.relationships as Record<string, unknown>;
    // Should ONLY include reviewSubmission + appStoreVersion. Other v0.13+
    // slots (appCustomProductPageVersion, appEvent, etc.) must not appear.
    expect(Object.keys(rels).sort()).toEqual(['appStoreVersion', 'reviewSubmission']);
  });
});
