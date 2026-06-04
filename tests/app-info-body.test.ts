import { describe, expect, it } from 'vitest';
import {
  buildAppInfoLocalizationCreateBody,
  buildAppInfoLocalizationPatchBody,
  buildAppInfoPatchBody,
  evaluateAppInfoPatchGate,
} from '../src/domains/app-info.js';

// Pin the wire shape for the writable AppInfo endpoints:
//   PATCH /v1/appInfos/{id}                  (categories relationships only)
//   POST  /v1/appInfoLocalizations
//   PATCH /v1/appInfoLocalizations/{id}
//
// Apple's quirks driving these assertions:
//   1. AppInfoUpdateRequest has NO attributes block — only relationships
//      (six category slots). Body builder must OMIT attributes.
//   2. Each slot accepts data: { type, id } to set, data: null to clear,
//      or be absent entirely to leave it alone.
//   3. AppInfoLocalization wire-key gotchas: Swift `privacyPolicyURL` →
//      wire `privacyPolicyUrl`, Swift `privacyChoicesURL` → wire
//      `privacyChoicesUrl`. Same camelCase-not-all-caps strip as
//      marketingUrl/supportUrl in v0.10.
//   4. Locale required+immutable on AppInfoLocalization (in CREATE
//      attrs, absent from UPDATE attrs).

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppInfoPatchBody', () => {
  it('uses appInfos type with the resource ID and NO attributes block', () => {
    const body = buildAppInfoPatchBody({
      appInfoId: 'AI-1',
      primaryCategoryId: 'CAT-FOOD',
    }) as Body;
    expect(body.data.type).toBe('appInfos');
    expect(body.data.id).toBe('AI-1');
    // Apple's AppInfoUpdateRequest is relationships-only — no attributes.
    expect('attributes' in body.data).toBe(false);
  });

  it('sets a category slot via { data: { type, id } }', () => {
    const body = buildAppInfoPatchBody({
      appInfoId: 'AI-1',
      primaryCategoryId: 'CAT-FOOD',
    }) as Body;
    const rels = body.data.relationships as {
      primaryCategory: { data: { type: string; id: string } };
    };
    expect(rels.primaryCategory.data).toEqual({ type: 'appCategories', id: 'CAT-FOOD' });
  });

  it('clears a category slot via { data: null } when null is passed', () => {
    const body = buildAppInfoPatchBody({
      appInfoId: 'AI-1',
      secondaryCategoryId: null,
    }) as Body;
    const rels = body.data.relationships as {
      secondaryCategory: { data: null };
    };
    expect(rels.secondaryCategory).toEqual({ data: null });
  });

  it('OMITS a slot entirely when undefined is passed (leaves it alone)', () => {
    const body = buildAppInfoPatchBody({
      appInfoId: 'AI-1',
      primaryCategoryId: 'CAT-FOOD',
    }) as Body;
    const rels = body.data.relationships as Record<string, unknown>;
    expect(Object.keys(rels)).toEqual(['primaryCategory']);
    expect('secondaryCategory' in rels).toBe(false);
    expect('primarySubcategoryOne' in rels).toBe(false);
  });

  it('emits all six slots when all are provided', () => {
    const body = buildAppInfoPatchBody({
      appInfoId: 'AI-1',
      primaryCategoryId: 'C1',
      primarySubcategoryOneId: 'C2',
      primarySubcategoryTwoId: 'C3',
      secondaryCategoryId: 'C4',
      secondarySubcategoryOneId: 'C5',
      secondarySubcategoryTwoId: 'C6',
    }) as Body;
    const rels = body.data.relationships as Record<string, { data: { id: string } | null }>;
    expect(rels.primaryCategory?.data).toEqual({ type: 'appCategories', id: 'C1' });
    expect(rels.primarySubcategoryOne?.data).toEqual({ type: 'appCategories', id: 'C2' });
    expect(rels.primarySubcategoryTwo?.data).toEqual({ type: 'appCategories', id: 'C3' });
    expect(rels.secondaryCategory?.data).toEqual({ type: 'appCategories', id: 'C4' });
    expect(rels.secondarySubcategoryOne?.data).toEqual({ type: 'appCategories', id: 'C5' });
    expect(rels.secondarySubcategoryTwo?.data).toEqual({ type: 'appCategories', id: 'C6' });
  });
});

describe('buildAppInfoLocalizationCreateBody', () => {
  it('requires locale + name; OMITS optional attrs when not passed', () => {
    const body = buildAppInfoLocalizationCreateBody({
      appInfoId: 'AI-1',
      locale: 'en-US',
      name: 'My App',
    }) as Body;
    expect(body.data.type).toBe('appInfoLocalizations');
    expect(body.data.attributes).toEqual({ locale: 'en-US', name: 'My App' });
    const rels = body.data.relationships as { appInfo: { data: { type: string; id: string } } };
    expect(rels.appInfo.data).toEqual({ type: 'appInfos', id: 'AI-1' });
  });

  it('emits camelCase WIRE keys for URL attrs (privacyPolicyUrl/privacyChoicesUrl)', () => {
    const body = buildAppInfoLocalizationCreateBody({
      appInfoId: 'AI-1',
      locale: 'en-US',
      name: 'My App',
      privacyPolicyUrl: 'https://example.com/privacy',
      privacyChoicesUrl: 'https://example.com/choices',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.privacyPolicyUrl).toBe('https://example.com/privacy');
    expect(attrs.privacyChoicesUrl).toBe('https://example.com/choices');
    // Regression guard: Swift's all-caps URL forms must NOT appear.
    expect('privacyPolicyURL' in attrs).toBe(false);
    expect('privacyChoicesURL' in attrs).toBe(false);
  });

  it('emits all six attrs when all provided', () => {
    const body = buildAppInfoLocalizationCreateBody({
      appInfoId: 'AI-1',
      locale: 'en-US',
      name: 'My App',
      subtitle: 'Catch fish',
      privacyPolicyUrl: 'https://example.com/p',
      privacyChoicesUrl: 'https://example.com/c',
      privacyPolicyText: 'Full privacy policy text...',
    }) as Body;
    expect(body.data.attributes).toEqual({
      locale: 'en-US',
      name: 'My App',
      subtitle: 'Catch fish',
      privacyPolicyUrl: 'https://example.com/p',
      privacyChoicesUrl: 'https://example.com/c',
      privacyPolicyText: 'Full privacy policy text...',
    });
  });
});

describe('buildAppInfoLocalizationPatchBody', () => {
  it('uses appInfoLocalizations type + the resource ID + no locale (immutable)', () => {
    const body = buildAppInfoLocalizationPatchBody({
      appInfoLocalizationId: 'AIL-1',
      name: 'Renamed',
    }) as Body;
    expect(body.data.type).toBe('appInfoLocalizations');
    expect(body.data.id).toBe('AIL-1');
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('locale' in attrs).toBe(false);
  });

  it('uses camelCase WIRE keys for URL attrs on patch', () => {
    const body = buildAppInfoLocalizationPatchBody({
      appInfoLocalizationId: 'AIL-1',
      privacyPolicyUrl: 'https://example.com/new',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.privacyPolicyUrl).toBe('https://example.com/new');
    expect('privacyPolicyURL' in attrs).toBe(false);
  });

  it('OMITS undefined attrs (encodeIfPresent)', () => {
    const body = buildAppInfoLocalizationPatchBody({
      appInfoLocalizationId: 'AIL-1',
      subtitle: 'New subtitle',
    }) as Body;
    expect(body.data.attributes).toEqual({ subtitle: 'New subtitle' });
  });

  it('does not emit a relationships block', () => {
    const body = buildAppInfoLocalizationPatchBody({
      appInfoLocalizationId: 'AIL-1',
      name: 'X',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});

describe('evaluateAppInfoPatchGate', () => {
  it('refuses WAITING_FOR_REVIEW', () => {
    const result = evaluateAppInfoPatchGate('WAITING_FOR_REVIEW');
    expect(result.allow).toBe(false);
    expect(result.state).toBe('WAITING_FOR_REVIEW');
    expect(result.reason).toContain('WAITING_FOR_REVIEW');
    expect(result.nextEditablePath).toContain('cancel');
  });

  it('refuses IN_REVIEW', () => {
    const result = evaluateAppInfoPatchGate('IN_REVIEW');
    expect(result.allow).toBe(false);
  });

  it('allows PREPARE_FOR_SUBMISSION', () => {
    const result = evaluateAppInfoPatchGate('PREPARE_FOR_SUBMISSION');
    expect(result.allow).toBe(true);
  });

  it('allows DEVELOPER_REJECTED + REJECTED (categories editable on rejection)', () => {
    expect(evaluateAppInfoPatchGate('DEVELOPER_REJECTED').allow).toBe(true);
    expect(evaluateAppInfoPatchGate('REJECTED').allow).toBe(true);
  });

  it('passes through unknown states (Apple stays the authoritative gate)', () => {
    expect(evaluateAppInfoPatchGate(undefined).allow).toBe(true);
    expect(evaluateAppInfoPatchGate('FUTURE_APPLE_STATE').allow).toBe(true);
  });
});
