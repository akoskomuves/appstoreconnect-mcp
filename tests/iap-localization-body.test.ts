import { describe, expect, it } from 'vitest';
import {
  buildIapLocalizationCreateBody,
  buildIapLocalizationPatchBody,
} from '../src/domains/iap-localizations.js';

// Pin the wire shape for the two writable IAP-localization endpoints:
//   POST  /v1/inAppPurchaseLocalizations
//   PATCH /v1/inAppPurchaseLocalizations/{id}
//
// Apple's quirks driving these assertions:
//   1. Same structural shape as SubscriptionLocalization (name + locale
//      required, description optional, state server-managed, locale
//      immutable post-create).
//   2. WIRE-KEY GOTCHA: the parent relationship is named `inAppPurchaseV2`
//      (with V2 suffix) but the resource type it references is
//      `inAppPurchases` (no V2). Easy to conflate.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildIapLocalizationCreateBody', () => {
  it('uses inAppPurchaseLocalizations type with required name + locale + inAppPurchaseV2 rel', () => {
    const body = buildIapLocalizationCreateBody({
      iapId: 'IAP-1',
      name: 'Coins',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('inAppPurchaseLocalizations');
    expect(body.data.attributes).toEqual({ name: 'Coins', locale: 'en-US' });
  });

  it('uses parent relationship name `inAppPurchaseV2` (with V2 suffix) but resource type `inAppPurchases` (no V2)', () => {
    const body = buildIapLocalizationCreateBody({
      iapId: 'IAP-1',
      name: 'Coins',
      locale: 'en-US',
    }) as Body;
    const rels = body.data.relationships as Record<string, unknown>;
    // Relationship key carries V2.
    expect('inAppPurchaseV2' in rels).toBe(true);
    // Resource type does NOT carry V2.
    const iapRel = rels.inAppPurchaseV2 as { data: { type: string; id: string } };
    expect(iapRel.data).toEqual({ type: 'inAppPurchases', id: 'IAP-1' });
    // Common wrong shapes that this guards against:
    expect('inAppPurchase' in rels).toBe(false);
    expect('iap' in rels).toBe(false);
  });

  it('OMITS description when not provided (encodeIfPresent)', () => {
    const body = buildIapLocalizationCreateBody({
      iapId: 'IAP-1',
      name: 'Coins',
      locale: 'en-US',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('description' in attrs).toBe(false);
  });

  it('emits description when provided', () => {
    const body = buildIapLocalizationCreateBody({
      iapId: 'IAP-1',
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
