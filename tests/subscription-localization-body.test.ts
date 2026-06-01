import { describe, expect, it } from 'vitest';
import {
  buildSubscriptionLocalizationCreateBody,
  buildSubscriptionLocalizationPatchBody,
} from '../src/domains/subscription-localizations.js';
import {
  IapLocalizationDescriptionSchema,
  SubscriptionLocalizationDescriptionSchema,
} from '../src/schemas.js';

// Pin the wire shape for the two writable SubscriptionLocalization endpoints:
//   POST  /v1/subscriptionLocalizations
//   PATCH /v1/subscriptionLocalizations/{id}
//
// Apple's quirks driving these assertions:
//   1. name + locale REQUIRED at create; description optional. Locale
//      IMMUTABLE post-create (lookup key).
//   2. PATCH accepts only name + description; locale not patchable. The
//      `state` attribute is server-managed (PREPARE_FOR_SUBMISSION /
//      WAITING_FOR_REVIEW / APPROVED / REJECTED) and rejected from PATCH
//      bodies — the patch builder has no codepath for it.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildSubscriptionLocalizationCreateBody', () => {
  it('uses subscriptionLocalizations type with required name + locale + subscription rel', () => {
    const body = buildSubscriptionLocalizationCreateBody({
      subscriptionId: 'SUB-1',
      name: 'Pro Plan',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('subscriptionLocalizations');
    expect(body.data.attributes).toEqual({ name: 'Pro Plan', locale: 'en-US' });
    const rels = body.data.relationships as {
      subscription: { data: { type: string; id: string } };
    };
    expect(rels.subscription.data).toEqual({ type: 'subscriptions', id: 'SUB-1' });
  });

  it('OMITS description when not provided (encodeIfPresent)', () => {
    const body = buildSubscriptionLocalizationCreateBody({
      subscriptionId: 'SUB-1',
      name: 'Pro',
      locale: 'en-US',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('description' in attrs).toBe(false);
  });

  it('emits description when provided', () => {
    const body = buildSubscriptionLocalizationCreateBody({
      subscriptionId: 'SUB-1',
      name: 'Pro',
      locale: 'en-US',
      description: 'Unlock all features.',
    }) as Body;
    expect((body.data.attributes as Record<string, unknown>).description).toBe(
      'Unlock all features.',
    );
  });
});

describe('buildSubscriptionLocalizationPatchBody', () => {
  it('uses subscriptionLocalizations type with the resource ID + no locale', () => {
    const body = buildSubscriptionLocalizationPatchBody({
      subscriptionLocalizationId: 'SL-1',
      name: 'Renamed',
    }) as Body;
    expect(body.data.type).toBe('subscriptionLocalizations');
    expect(body.data.id).toBe('SL-1');
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('locale' in attrs).toBe(false);
  });

  it('emits both name and description when both provided', () => {
    const body = buildSubscriptionLocalizationPatchBody({
      subscriptionLocalizationId: 'SL-1',
      name: 'New Name',
      description: 'New desc.',
    }) as Body;
    expect(body.data.attributes).toEqual({ name: 'New Name', description: 'New desc.' });
  });

  it('OMITS undefined attrs (encodeIfPresent)', () => {
    const body = buildSubscriptionLocalizationPatchBody({
      subscriptionLocalizationId: 'SL-1',
      description: 'D',
    }) as Body;
    expect(body.data.attributes).toEqual({ description: 'D' });
  });

  it('produces an empty attributes object when nothing is passed (tool-level guard against this)', () => {
    const body = buildSubscriptionLocalizationPatchBody({
      subscriptionLocalizationId: 'SL-1',
    }) as Body;
    expect(body.data.attributes).toEqual({});
  });

  it('does not include a relationships block', () => {
    const body = buildSubscriptionLocalizationPatchBody({
      subscriptionLocalizationId: 'SL-1',
      name: 'X',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});

describe('description schema relaxation (v0.10 smoke fix)', () => {
  // Live smoke (2026-06-01) found an APPROVED SubscriptionLocalization on a
  // shipped app with a 50-character description string. Apple's public docs
  // say 45, but the live API accepts more. Initial v0.10 capped at 45 and
  // would have client-side-rejected legitimate copy. Schemas now have no
  // max — Apple is the source of truth.
  it('SubscriptionLocalizationDescriptionSchema accepts a 50-character string', () => {
    const fifty = '0123456789012345678901234567890123456789012345678';
    expect(fifty).toHaveLength(49);
    const result = SubscriptionLocalizationDescriptionSchema.safeParse(`${fifty}.`);
    expect(result.success).toBe(true);
  });

  it('SubscriptionLocalizationDescriptionSchema accepts a 200-character string (no upper bound)', () => {
    const long = 'x'.repeat(200);
    const result = SubscriptionLocalizationDescriptionSchema.safeParse(long);
    expect(result.success).toBe(true);
  });

  it('SubscriptionLocalizationDescriptionSchema still rejects empty strings (min(1) kept)', () => {
    const result = SubscriptionLocalizationDescriptionSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('IapLocalizationDescriptionSchema accepts a 50-character string (same fix)', () => {
    const long = 'x'.repeat(50);
    const result = IapLocalizationDescriptionSchema.safeParse(long);
    expect(result.success).toBe(true);
  });
});
