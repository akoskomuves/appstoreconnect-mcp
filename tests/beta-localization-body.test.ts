import { describe, expect, it } from 'vitest';
import {
  buildBetaAppLocalizationCreateBody,
  buildBetaAppLocalizationPatchBody,
  buildBetaBuildLocalizationCreateBody,
  buildBetaBuildLocalizationPatchBody,
} from '../src/domains/beta-localizations.js';

// Pin the wire shape for the four writable beta-localization endpoints:
//   POST /v1/betaBuildLocalizations
//   PATCH /v1/betaBuildLocalizations/{id}
//   POST /v1/betaAppLocalizations
//   PATCH /v1/betaAppLocalizations/{id}
//
// Apple's quirks driving these assertions:
//   1. BetaBuildLocalization: locale is required at create + immutable.
//      whatsNew is the only mutable attr (PATCH-only). The build
//      relationship is required at create only.
//   2. BetaAppLocalization: locale is required at create + immutable.
//      All other attrs are optional at create AND patch (encodeIfPresent).
//      The app relationship is required at create only.
//   3. Wire-key strip on URL attrs: Swift `marketingURL` -> wire
//      `marketingUrl`; Swift `privacyPolicyURL` -> wire `privacyPolicyUrl`
//      (camelCase, NOT all-caps). Other attrs are 1:1.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildBetaBuildLocalizationCreateBody', () => {
  it('uses betaBuildLocalizations type with locale required + build rel', () => {
    const body = buildBetaBuildLocalizationCreateBody({
      buildId: 'B-1',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('betaBuildLocalizations');
    expect((body.data.attributes as Record<string, unknown>).locale).toBe('en-US');
    const rels = body.data.relationships as { build: { data: { type: string; id: string } } };
    expect(rels.build.data).toEqual({ type: 'builds', id: 'B-1' });
  });

  it('OMITS whatsNew when not provided (it is optional at create)', () => {
    const body = buildBetaBuildLocalizationCreateBody({
      buildId: 'B-1',
      locale: 'en-US',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('whatsNew' in attrs).toBe(false);
  });

  it('emits whatsNew when provided', () => {
    const body = buildBetaBuildLocalizationCreateBody({
      buildId: 'B-1',
      locale: 'en-US',
      whatsNew: 'Try the new feature.',
    }) as Body;
    expect((body.data.attributes as Record<string, unknown>).whatsNew).toBe('Try the new feature.');
  });
});

describe('buildBetaBuildLocalizationPatchBody', () => {
  it('uses betaBuildLocalizations type with the resource ID and only whatsNew (locale immutable)', () => {
    const body = buildBetaBuildLocalizationPatchBody({
      betaBuildLocalizationId: 'BBL-1',
      whatsNew: 'Updated copy.',
    }) as Body;
    expect(body.data.type).toBe('betaBuildLocalizations');
    expect(body.data.id).toBe('BBL-1');
    expect(body.data.attributes).toEqual({ whatsNew: 'Updated copy.' });
  });

  it('does not include a relationships block (PATCH must not touch the build rel)', () => {
    const body = buildBetaBuildLocalizationPatchBody({
      betaBuildLocalizationId: 'BBL-1',
      whatsNew: 'X',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});

describe('buildBetaAppLocalizationCreateBody', () => {
  it('uses betaAppLocalizations type with locale required + app rel', () => {
    const body = buildBetaAppLocalizationCreateBody({
      appId: 'APP-1',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('betaAppLocalizations');
    expect((body.data.attributes as Record<string, unknown>).locale).toBe('en-US');
    const rels = body.data.relationships as { app: { data: { type: string; id: string } } };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
  });

  it('emits camelCase WIRE keys for URL attrs (marketingUrl/privacyPolicyUrl) — NOT all-caps URL suffix', () => {
    const body = buildBetaAppLocalizationCreateBody({
      appId: 'APP-1',
      locale: 'en-US',
      marketingUrl: 'https://example.com/app',
      privacyPolicyUrl: 'https://example.com/privacy',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.marketingUrl).toBe('https://example.com/app');
    expect(attrs.privacyPolicyUrl).toBe('https://example.com/privacy');
    // Regression guard: the all-caps Swift names must NOT appear.
    expect('marketingURL' in attrs).toBe(false);
    expect('privacyPolicyURL' in attrs).toBe(false);
  });

  it('OMITS all optional attrs when not provided (encodeIfPresent)', () => {
    const body = buildBetaAppLocalizationCreateBody({
      appId: 'APP-1',
      locale: 'de-DE',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(Object.keys(attrs)).toEqual(['locale']);
  });

  it('emits all five optional attrs verbatim when all are provided', () => {
    const body = buildBetaAppLocalizationCreateBody({
      appId: 'APP-1',
      locale: 'en-US',
      description: 'Beta description',
      feedbackEmail: 'feedback@example.com',
      marketingUrl: 'https://example.com/m',
      privacyPolicyUrl: 'https://example.com/p',
      tvOsPrivacyPolicy: 'tvOS-specific privacy policy text',
    }) as Body;
    expect(body.data.attributes).toEqual({
      locale: 'en-US',
      description: 'Beta description',
      feedbackEmail: 'feedback@example.com',
      marketingUrl: 'https://example.com/m',
      privacyPolicyUrl: 'https://example.com/p',
      tvOsPrivacyPolicy: 'tvOS-specific privacy policy text',
    });
  });
});

describe('buildBetaAppLocalizationPatchBody', () => {
  it('uses betaAppLocalizations type with the resource ID + no locale', () => {
    const body = buildBetaAppLocalizationPatchBody({
      betaAppLocalizationId: 'BAL-1',
      description: 'Updated.',
    }) as Body;
    expect(body.data.type).toBe('betaAppLocalizations');
    expect(body.data.id).toBe('BAL-1');
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('locale' in attrs).toBe(false);
  });

  it('still uses camelCase WIRE keys for URL attrs on patch', () => {
    const body = buildBetaAppLocalizationPatchBody({
      betaAppLocalizationId: 'BAL-1',
      marketingUrl: 'https://example.com/new',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.marketingUrl).toBe('https://example.com/new');
    expect('marketingURL' in attrs).toBe(false);
  });

  it('OMITS all undefined attrs (encodeIfPresent)', () => {
    const body = buildBetaAppLocalizationPatchBody({
      betaAppLocalizationId: 'BAL-1',
      description: 'X',
    }) as Body;
    expect(body.data.attributes).toEqual({ description: 'X' });
  });

  it('produces an empty attributes object when nothing is passed (tool-level guard against this)', () => {
    const body = buildBetaAppLocalizationPatchBody({ betaAppLocalizationId: 'BAL-1' }) as Body;
    expect(body.data.attributes).toEqual({});
  });
});
