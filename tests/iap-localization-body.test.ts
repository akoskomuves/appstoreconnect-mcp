import { describe, expect, it } from 'vitest';
import {
  buildIapLocalizationCreateBody,
  buildIapLocalizationPatchBody,
} from '../src/domains/iap-localizations.js';

// Pin the wire shape for the two writable IAP-localization endpoints:
//   POST  /v2/inAppPurchaseLocalizations
//   PATCH /v2/inAppPurchaseLocalizations/{id}
//
// Apple's quirks driving these assertions:
//   1. Same structural shape as SubscriptionLocalization (name + locale
//      required, description optional, locale immutable post-create).
//   2. The v2 create's parent is the inAppPurchaseVersion, relationship key
//      `version`. The v1 parent (`inAppPurchaseV2` → 'inAppPurchases') is what
//      Apple removes in early 2027, so it must not come back.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildIapLocalizationCreateBody', () => {
  it('uses inAppPurchaseLocalizations type with required name + locale', () => {
    const body = buildIapLocalizationCreateBody({
      versionId: 'IAPV-1',
      name: 'Coins',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('inAppPurchaseLocalizations');
    expect(body.data.attributes).toEqual({ name: 'Coins', locale: 'en-US' });
  });

  it('parents on the IAP version via `version`, never the removed v1 inAppPurchaseV2 rel', () => {
    const body = buildIapLocalizationCreateBody({
      versionId: 'IAPV-1',
      name: 'Coins',
      locale: 'en-US',
    }) as Body;
    const rels = body.data.relationships as Record<string, { data: unknown }>;
    expect(Object.keys(rels)).toEqual(['version']);
    expect(rels.version?.data).toEqual({ type: 'inAppPurchaseVersions', id: 'IAPV-1' });
  });

  it('OMITS description when not provided (encodeIfPresent)', () => {
    const body = buildIapLocalizationCreateBody({
      versionId: 'IAPV-1',
      name: 'Coins',
      locale: 'en-US',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('description' in attrs).toBe(false);
  });

  it('emits description when provided', () => {
    const body = buildIapLocalizationCreateBody({
      versionId: 'IAPV-1',
      name: 'Coins',
      locale: 'en-US',
      description: '100 in-game coins.',
    }) as Body;
    expect((body.data.attributes as Record<string, unknown>).description).toBe(
      '100 in-game coins.',
    );
  });
});

describe('buildIapLocalizationPatchBody', () => {
  it('uses inAppPurchaseLocalizations type with the resource ID + no locale', () => {
    const body = buildIapLocalizationPatchBody({
      iapLocalizationId: 'IAPL-1',
      name: 'Renamed',
    }) as Body;
    expect(body.data.type).toBe('inAppPurchaseLocalizations');
    expect(body.data.id).toBe('IAPL-1');
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('locale' in attrs).toBe(false);
  });

  it('emits both name and description when both provided', () => {
    const body = buildIapLocalizationPatchBody({
      iapLocalizationId: 'IAPL-1',
      name: 'New Name',
      description: 'New desc.',
    }) as Body;
    expect(body.data.attributes).toEqual({ name: 'New Name', description: 'New desc.' });
  });

  it('OMITS undefined attrs (encodeIfPresent)', () => {
    const body = buildIapLocalizationPatchBody({
      iapLocalizationId: 'IAPL-1',
      description: 'D',
    }) as Body;
    expect(body.data.attributes).toEqual({ description: 'D' });
  });

  it('produces an empty attributes object when nothing is passed (tool-level guard against this)', () => {
    const body = buildIapLocalizationPatchBody({ iapLocalizationId: 'IAPL-1' }) as Body;
    expect(body.data.attributes).toEqual({});
  });

  it('does not include a relationships block', () => {
    const body = buildIapLocalizationPatchBody({
      iapLocalizationId: 'IAPL-1',
      name: 'X',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});
