import { describe, expect, it } from 'vitest';
import {
  buildAppStoreVersionLocalizationCreateBody,
  buildAppStoreVersionLocalizationPatchBody,
} from '../src/domains/appstore-version-localizations.js';

// Pin the wire shape for the two writable AppStoreVersionLocalization endpoints:
//   POST  /v1/appStoreVersionLocalizations
//   PATCH /v1/appStoreVersionLocalizations/{id}
//
// Apple's quirks driving these assertions:
//   1. locale is REQUIRED at create + IMMUTABLE post-create. PATCH must not
//      carry it; the body builder has no codepath for it on PATCH.
//   2. Wire-key strip on URL attrs: Swift `marketingURL` -> wire
//      `marketingUrl`; Swift `supportURL` -> wire `supportUrl`. Same shape
//      as v0.9.0's BetaAppLocalization URLs. Easy to get wrong.
//   3. Five optional attrs at create AND patch (encodeIfPresent):
//      whatsNew, description, keywords, promotionalText, marketingUrl,
//      supportUrl. Body must OMIT undefined keys, not send null.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppStoreVersionLocalizationCreateBody', () => {
  it('uses appStoreVersionLocalizations type with locale + appStoreVersion rel required', () => {
    const body = buildAppStoreVersionLocalizationCreateBody({
      appStoreVersionId: 'V-1',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('appStoreVersionLocalizations');
    expect((body.data.attributes as Record<string, unknown>).locale).toBe('en-US');
    const rels = body.data.relationships as {
      appStoreVersion: { data: { type: string; id: string } };
    };
    expect(rels.appStoreVersion.data).toEqual({ type: 'appStoreVersions', id: 'V-1' });
  });

  it('emits camelCase WIRE keys for URL attrs (marketingUrl/supportUrl) — NOT Swift all-caps URL suffix', () => {
    const body = buildAppStoreVersionLocalizationCreateBody({
      appStoreVersionId: 'V-1',
      locale: 'en-US',
      marketingUrl: 'https://example.com/m',
      supportUrl: 'https://example.com/s',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.marketingUrl).toBe('https://example.com/m');
    expect(attrs.supportUrl).toBe('https://example.com/s');
    // Regression guard: the all-caps Swift names must NOT appear.
    expect('marketingURL' in attrs).toBe(false);
    expect('supportURL' in attrs).toBe(false);
  });

  it('OMITS all optional attrs when not provided (encodeIfPresent)', () => {
    const body = buildAppStoreVersionLocalizationCreateBody({
      appStoreVersionId: 'V-1',
      locale: 'de-DE',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(Object.keys(attrs)).toEqual(['locale']);
  });

  it('emits all six optional attrs verbatim when all are provided', () => {
    const body = buildAppStoreVersionLocalizationCreateBody({
      appStoreVersionId: 'V-1',
      locale: 'en-US',
      whatsNew: 'New features.',
      description: 'Long description.',
      keywords: 'app,fitness',
      promotionalText: 'Try this!',
      marketingUrl: 'https://example.com/m',
      supportUrl: 'https://example.com/s',
    }) as Body;
    expect(body.data.attributes).toEqual({
      locale: 'en-US',
      whatsNew: 'New features.',
      description: 'Long description.',
      keywords: 'app,fitness',
      promotionalText: 'Try this!',
      marketingUrl: 'https://example.com/m',
      supportUrl: 'https://example.com/s',
    });
  });
});

describe('buildAppStoreVersionLocalizationPatchBody', () => {
  it('uses appStoreVersionLocalizations type with the resource ID + no locale', () => {
    const body = buildAppStoreVersionLocalizationPatchBody({
      appStoreVersionLocalizationId: 'AVL-1',
      whatsNew: 'Updated.',
    }) as Body;
    expect(body.data.type).toBe('appStoreVersionLocalizations');
    expect(body.data.id).toBe('AVL-1');
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('locale' in attrs).toBe(false);
  });

  it('still uses camelCase WIRE keys for URL attrs on patch', () => {
    const body = buildAppStoreVersionLocalizationPatchBody({
      appStoreVersionLocalizationId: 'AVL-1',
      marketingUrl: 'https://example.com/new',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.marketingUrl).toBe('https://example.com/new');
    expect('marketingURL' in attrs).toBe(false);
  });

  it('OMITS all undefined attrs (encodeIfPresent)', () => {
    const body = buildAppStoreVersionLocalizationPatchBody({
      appStoreVersionLocalizationId: 'AVL-1',
      whatsNew: 'X',
    }) as Body;
    expect(body.data.attributes).toEqual({ whatsNew: 'X' });
  });

  it('produces an empty attributes object when nothing is passed (tool-level guard against this)', () => {
    const body = buildAppStoreVersionLocalizationPatchBody({
      appStoreVersionLocalizationId: 'AVL-1',
    }) as Body;
    expect(body.data.attributes).toEqual({});
  });

  it('does not include a relationships block', () => {
    const body = buildAppStoreVersionLocalizationPatchBody({
      appStoreVersionLocalizationId: 'AVL-1',
      keywords: 'a,b',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});
