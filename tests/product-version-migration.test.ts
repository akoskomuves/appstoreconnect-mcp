import { describe, expect, it } from 'vitest';
import {
  decideWriteVersion,
  EDITABLE_VERSION_STATES,
  pickLatestVersion,
} from '../src/domains/product-version-resolve.js';
import {
  buildReviewSubmissionItemCreateBody,
  decideSubmissionTarget,
  REVIEW_SUBMISSION_ITEM_TYPES,
} from '../src/domains/review-submissions.js';

// Apple removes the product-scoped v1 IAP / subscription localization, image
// and standalone-submission endpoints beginning in early 2027 (developer email,
// 2026-11). Replacements hang off a product VERSION, and submission is a
// reviewSubmission item pointing at that version. These pin the pieces that
// route the old product-id tools onto that model.

type Body = { data: { type: string; relationships: Record<string, { data: unknown }> } };

describe('review submission items', () => {
  it('in-app product items point at the VERSION type', () => {
    for (const [itemType, type] of [
      ['inAppPurchaseVersion', 'inAppPurchaseVersions'],
      ['subscriptionVersion', 'subscriptionVersions'],
      ['subscriptionGroupVersion', 'subscriptionGroupVersions'],
    ] as const) {
      const body = buildReviewSubmissionItemCreateBody({
        reviewSubmissionId: 'RS-1',
        itemType,
        itemId: 'V-1',
      }) as Body;
      expect(Object.keys(body.data.relationships).sort()).toEqual(
        ['reviewSubmission', itemType].sort(),
      );
      expect(body.data.relationships[itemType]?.data).toEqual({ type, id: 'V-1' });
    }
  });

  it('covers every item relationship in spec 4.6', () => {
    expect(Object.keys(REVIEW_SUBMISSION_ITEM_TYPES)).toHaveLength(17);
    // Two keys, one wire type.
    expect(REVIEW_SUBMISSION_ITEM_TYPES.appStoreVersionExperiment).toBe(
      'appStoreVersionExperiments',
    );
    expect(REVIEW_SUBMISSION_ITEM_TYPES.appStoreVersionExperimentV2).toBe(
      'appStoreVersionExperiments',
    );
  });
});

describe('decideSubmissionTarget', () => {
  it('creates a fresh submission when the app has no draft', () => {
    expect(decideSubmissionTarget([])).toEqual({ action: 'create' });
  });

  it('refuses to submit an existing draft it did not create', () => {
    const t = decideSubmissionTarget(['RS-OPEN']);
    expect(t.action).toBe('refuse');
    if (t.action === 'refuse') expect(t.reason).toContain('RS-OPEN');
  });

  it('adds to an explicitly named draft without submitting it', () => {
    expect(decideSubmissionTarget(['RS-OPEN'], 'RS-OPEN')).toEqual({
      action: 'add-to-given',
      reviewSubmissionId: 'RS-OPEN',
    });
  });
});

describe('pickLatestVersion', () => {
  it('takes the highest version number', () => {
    const v = pickLatestVersion([
      { id: 'a', version: 1, state: 'REPLACED_WITH_NEW_VERSION' },
      { id: 'c', version: 3, state: 'PREPARE_FOR_SUBMISSION' },
      { id: 'b', version: 2, state: 'APPROVED' },
    ]);
    expect(v?.id).toBe('c');
  });

  it('returns null for no versions', () => {
    expect(pickLatestVersion([])).toBeNull();
  });
});

describe('decideWriteVersion', () => {
  const v = (state: string) => ({ id: 'V', version: 1, state });

  it('writes to an editable version', () => {
    for (const s of EDITABLE_VERSION_STATES) {
      expect(decideWriteVersion('iap', 'P', v(s), false).action).toBe('use');
    }
  });

  it('refuses a live version unless createVersionIfNeeded', () => {
    for (const s of ['APPROVED', 'REPLACED_WITH_NEW_VERSION']) {
      const refused = decideWriteVersion('subscription', 'P', v(s), false);
      expect(refused.action).toBe('refuse');
      if (refused.action === 'refuse') expect(refused.reason).toContain('createVersionIfNeeded');
      expect(decideWriteVersion('subscription', 'P', v(s), true).action).toBe('create');
    }
  });

  it('never creates over a version that is in review', () => {
    for (const s of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACCEPTED']) {
      expect(decideWriteVersion('subscriptionGroup', 'P', v(s), true).action).toBe('refuse');
    }
  });

  it('creates the first version only when asked', () => {
    expect(decideWriteVersion('iap', 'P', null, false).action).toBe('refuse');
    expect(decideWriteVersion('iap', 'P', null, true).action).toBe('create');
  });
});
