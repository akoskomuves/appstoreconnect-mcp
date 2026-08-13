import { describe, expect, it } from 'vitest';
import {
  buildGracePeriodPatchBody,
  buildReleaseRequestBody,
  buildReviewDetailCreateBody,
  buildReviewDetailPatchBody,
} from '../src/domains/review-details.js';
import { buildStandaloneItemSubmissionBody } from '../src/domains/review-submissions.js';

// Wire-shape pins for the v1.5 ship-loop resources.
// Load-bearing rules:
//   1. appStoreReviewDetail create needs the appStoreVersion relationship;
//      every attribute is optional (a bare card is valid).
//   2. PATCH bodies carry the resource id (Apple 409s without it) and only
//      caller-supplied attributes — Apple merges.
//   3. appStoreVersionReleaseRequests and the standalone item submissions are
//      relationships-only creates: no attributes block at all.
//   4. WIRE-KEY GOTCHA: inAppPurchaseSubmissions uses relationship key
//      `inAppPurchaseV2` while the target data.type stays 'inAppPurchases' —
//      same trap as the IAP review screenshot in review-assets.

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

describe('buildReviewDetailCreateBody', () => {
  const body = buildReviewDetailCreateBody({
    appStoreVersionId: 'VER-1',
    attributes: {
      contactFirstName: 'Alex',
      demoAccountRequired: true,
      notes: undefined,
    },
  }) as Body;

  it('uses appStoreReviewDetails as the type and links the version', () => {
    expect(body.data.type).toBe('appStoreReviewDetails');
    expect(rel(body, 'appStoreVersion')).toEqual({ type: 'appStoreVersions', id: 'VER-1' });
  });

  it('drops undefined attributes, keeps supplied ones', () => {
    expect(body.data.attributes).toEqual({ contactFirstName: 'Alex', demoAccountRequired: true });
  });
});

describe('buildReviewDetailPatchBody', () => {
  const body = buildReviewDetailPatchBody({
    reviewDetailId: 'DETAIL-1',
    attributes: { notes: 'Use the demo account on the login screen.' },
  }) as Body;

  it('carries the resource id in the body', () => {
    expect(body.data.id).toBe('DETAIL-1');
    expect(body.data.type).toBe('appStoreReviewDetails');
  });

  it('emits only the supplied attributes (Apple merges)', () => {
    expect(body.data.attributes).toEqual({ notes: 'Use the demo account on the login screen.' });
  });
});

describe('buildReleaseRequestBody', () => {
  const body = buildReleaseRequestBody('VER-1') as Body;

  it('is a relationships-only create pointing at the version', () => {
    expect(body.data.type).toBe('appStoreVersionReleaseRequests');
    expect(rel(body, 'appStoreVersion')).toEqual({ type: 'appStoreVersions', id: 'VER-1' });
    expect('attributes' in body.data).toBe(false);
  });
});

describe('buildGracePeriodPatchBody', () => {
  const body = buildGracePeriodPatchBody({
    gracePeriodId: 'GRACE-1',
    optIn: true,
    duration: 'SIXTEEN_DAYS',
  }) as Body;

  it('carries the resource id and only supplied attributes', () => {
    expect(body.data.id).toBe('GRACE-1');
    expect(body.data.type).toBe('subscriptionGracePeriods');
    expect(body.data.attributes).toEqual({ optIn: true, duration: 'SIXTEEN_DAYS' });
  });
});

describe('buildStandaloneItemSubmissionBody', () => {
  it('IAP submission uses relKey inAppPurchaseV2 with data.type inAppPurchases', () => {
    const body = buildStandaloneItemSubmissionBody({
      resourceType: 'inAppPurchaseSubmissions',
      relKey: 'inAppPurchaseV2',
      relType: 'inAppPurchases',
      itemId: 'IAP-1',
    }) as Body;
    expect(body.data.type).toBe('inAppPurchaseSubmissions');
    expect(rel(body, 'inAppPurchaseV2')).toEqual({ type: 'inAppPurchases', id: 'IAP-1' });
    expect('inAppPurchase' in (body.data.relationships ?? {})).toBe(false);
    expect('attributes' in body.data).toBe(false);
  });

  it('subscription-group submission links the group', () => {
    const body = buildStandaloneItemSubmissionBody({
      resourceType: 'subscriptionGroupSubmissions',
      relKey: 'subscriptionGroup',
      relType: 'subscriptionGroups',
      itemId: 'GROUP-1',
    }) as Body;
    expect(body.data.type).toBe('subscriptionGroupSubmissions');
    expect(rel(body, 'subscriptionGroup')).toEqual({ type: 'subscriptionGroups', id: 'GROUP-1' });
  });
});
