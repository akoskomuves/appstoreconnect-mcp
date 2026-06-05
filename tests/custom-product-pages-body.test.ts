import { describe, expect, it } from 'vitest';
import {
  buildCustomProductPageCreateBody,
  buildCustomProductPageLocalizationCreateBody,
  buildCustomProductPageLocalizationPatchBody,
  buildCustomProductPagePatchBody,
  buildCustomProductPageVersionCreateBody,
  evaluateCustomProductPageVersionGate,
} from '../src/domains/custom-product-pages.js';

// Pin the wire shape for the Custom Product Pages surface:
//   POST  /v1/appCustomProductPages
//   PATCH /v1/appCustomProductPages/{id}
//   POST  /v1/appCustomProductPageVersions
//   POST  /v1/appCustomProductPageLocalizations
//   PATCH /v1/appCustomProductPageLocalizations/{id}
//
// Quirks driving these assertions:
//   1. WIRE-KEY GOTCHA on AppCustomProductPageUpdateRequest: Swift `isVisible` →
//      wire `visible`. Same strip as AppScreenshot.isUploaded → `uploaded`.
//   2. NO-ATTRS-BLOCK OMISSION on AppCustomProductPageVersionCreateRequest:
//      attributes is OPTIONAL in the Swift contract; when no deepLink is
//      provided, the entire attributes key must be OMITTED. Same pattern as
//      v0.9 AppInfo PATCH which has no attrs block at all.
//   3. Locale immutable on AppCustomProductPageLocalizationUpdateRequest —
//      only promotionalText is mutable.
//   4. State gate refuses WAITING_FOR_REVIEW / IN_REVIEW on the version
//      (Apple holds writes during review).

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildCustomProductPageCreateBody', () => {
  it('uses appCustomProductPages type with name attribute + app relationship', () => {
    const body = buildCustomProductPageCreateBody({
      appId: 'APP-1',
      name: 'Summer Campaign',
    }) as Body;
    expect(body.data.type).toBe('appCustomProductPages');
    expect(body.data.attributes).toEqual({ name: 'Summer Campaign' });
    const rels = body.data.relationships as { app: { data: { type: string; id: string } } };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
  });
});

describe('buildCustomProductPagePatchBody', () => {
  it('uses appCustomProductPages type with resource id', () => {
    const body = buildCustomProductPagePatchBody({
      appCustomProductPageId: 'CPP-1',
      name: 'Renamed',
    }) as Body;
    expect(body.data.type).toBe('appCustomProductPages');
    expect(body.data.id).toBe('CPP-1');
  });

  it('emits wire key `visible` (NOT Swift `isVisible`)', () => {
    const body = buildCustomProductPagePatchBody({
      appCustomProductPageId: 'CPP-1',
      visible: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.visible).toBe(true);
    // Regression guard: Swift's `isVisible` must NOT appear on the wire.
    expect('isVisible' in attrs).toBe(false);
  });

  it('OMITS undefined attrs (encodeIfPresent)', () => {
    const body = buildCustomProductPagePatchBody({
      appCustomProductPageId: 'CPP-1',
      name: 'X',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs).toEqual({ name: 'X' });
  });

  it('does not emit a relationships block', () => {
    const body = buildCustomProductPagePatchBody({
      appCustomProductPageId: 'CPP-1',
      name: 'X',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});

describe('buildCustomProductPageVersionCreateBody', () => {
  it('uses appCustomProductPageVersions type with required relationship', () => {
    const body = buildCustomProductPageVersionCreateBody({
      appCustomProductPageId: 'CPP-1',
    }) as Body;
    expect(body.data.type).toBe('appCustomProductPageVersions');
    const rels = body.data.relationships as {
      appCustomProductPage: { data: { type: string; id: string } };
    };
    expect(rels.appCustomProductPage.data).toEqual({
      type: 'appCustomProductPages',
      id: 'CPP-1',
    });
  });

  it('OMITS the entire attributes key when deepLink is not provided (no-attrs-block rule)', () => {
    const body = buildCustomProductPageVersionCreateBody({
      appCustomProductPageId: 'CPP-1',
    }) as Body;
    expect('attributes' in body.data).toBe(false);
  });

  it('emits attributes.deepLink only when provided', () => {
    const body = buildCustomProductPageVersionCreateBody({
      appCustomProductPageId: 'CPP-1',
      deepLink: 'https://example.com/landing',
    }) as Body;
    expect(body.data.attributes).toEqual({ deepLink: 'https://example.com/landing' });
  });
});

describe('buildCustomProductPageLocalizationCreateBody', () => {
  it('requires locale + parent version relationship', () => {
    const body = buildCustomProductPageLocalizationCreateBody({
      appCustomProductPageVersionId: 'CPPV-1',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('appCustomProductPageLocalizations');
    expect(body.data.attributes).toEqual({ locale: 'en-US' });
    const rels = body.data.relationships as {
      appCustomProductPageVersion: { data: { type: string; id: string } };
    };
    expect(rels.appCustomProductPageVersion.data).toEqual({
      type: 'appCustomProductPageVersions',
      id: 'CPPV-1',
    });
  });

  it('emits promotionalText when provided', () => {
    const body = buildCustomProductPageLocalizationCreateBody({
      appCustomProductPageVersionId: 'CPPV-1',
      locale: 'en-US',
      promotionalText: 'Limited time offer!',
    }) as Body;
    expect(body.data.attributes).toEqual({
      locale: 'en-US',
      promotionalText: 'Limited time offer!',
    });
  });
});

describe('buildCustomProductPageLocalizationPatchBody', () => {
  it('uses appCustomProductPageLocalizations type + resource id + no locale (immutable)', () => {
    const body = buildCustomProductPageLocalizationPatchBody({
      appCustomProductPageLocalizationId: 'CPPL-1',
      promotionalText: 'Updated',
    }) as Body;
    expect(body.data.type).toBe('appCustomProductPageLocalizations');
    expect(body.data.id).toBe('CPPL-1');
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('locale' in attrs).toBe(false);
    expect(attrs.promotionalText).toBe('Updated');
  });
});

describe('evaluateCustomProductPageVersionGate', () => {
  it('refuses WAITING_FOR_REVIEW', () => {
    const result = evaluateCustomProductPageVersionGate('WAITING_FOR_REVIEW');
    expect(result.allow).toBe(false);
    expect(result.state).toBe('WAITING_FOR_REVIEW');
    expect(result.reason).toContain('WAITING_FOR_REVIEW');
    expect(result.nextEditablePath).toContain('cancel');
  });

  it('refuses IN_REVIEW', () => {
    expect(evaluateCustomProductPageVersionGate('IN_REVIEW').allow).toBe(false);
  });

  it('allows PREPARE_FOR_SUBMISSION', () => {
    expect(evaluateCustomProductPageVersionGate('PREPARE_FOR_SUBMISSION').allow).toBe(true);
  });

  it('allows REJECTED + READY_FOR_REVIEW', () => {
    expect(evaluateCustomProductPageVersionGate('REJECTED').allow).toBe(true);
    expect(evaluateCustomProductPageVersionGate('READY_FOR_REVIEW').allow).toBe(true);
  });

  it('passes through unknown states (Apple stays the authoritative gate)', () => {
    expect(evaluateCustomProductPageVersionGate(undefined).allow).toBe(true);
    expect(evaluateCustomProductPageVersionGate('FUTURE_APPLE_STATE').allow).toBe(true);
  });
});
