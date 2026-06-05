import { describe, expect, it } from 'vitest';
import {
  buildAppScreenshotCreateBody,
  buildAppScreenshotPatchBody,
  buildAppScreenshotSetCreateBody,
} from '../src/domains/screenshots.js';

// Pin the wire shape for the AppScreenshot + AppScreenshotSet writes:
//   POST  /v1/appScreenshotSets
//   POST  /v1/appScreenshots                  (reserve)
//   PATCH /v1/appScreenshots/{id}             (commit)
//
// Apple-contract quirks driving these assertions:
//   1. AppScreenshotSetCreateRequest carries the parent relationship as
//      one of three slots (appStoreVersionLocalization /
//      appCustomProductPageLocalization /
//      appStoreVersionExperimentTreatmentLocalization). Exactly one is
//      Apple-required at runtime; body builder picks based on parentType.
//   2. WIRE-KEY GOTCHA on AppScreenshotUpdateRequest: Swift `isUploaded` →
//      wire `uploaded`. Same strip pattern as AppCustomProductPage.isVisible →
//      `visible` and AppTag.isVisibleInAppStore → `visibleInAppStore`.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppScreenshotSetCreateBody', () => {
  it('uses appScreenshotSets type with screenshotDisplayType in attributes', () => {
    const body = buildAppScreenshotSetCreateBody({
      screenshotDisplayType: 'APP_IPHONE_67',
      parentType: 'appStoreVersionLocalizations',
      parentLocalizationId: 'LOC-1',
    }) as Body;
    expect(body.data.type).toBe('appScreenshotSets');
    expect(body.data.attributes).toEqual({ screenshotDisplayType: 'APP_IPHONE_67' });
  });

  it('attaches to appStoreVersionLocalization (singular) when parentType is appStoreVersionLocalizations', () => {
    const body = buildAppScreenshotSetCreateBody({
      screenshotDisplayType: 'APP_IPHONE_67',
      parentType: 'appStoreVersionLocalizations',
      parentLocalizationId: 'LOC-1',
    }) as Body;
    const rels = body.data.relationships as {
      appStoreVersionLocalization: { data: { type: string; id: string } };
    };
    expect(rels.appStoreVersionLocalization.data).toEqual({
      type: 'appStoreVersionLocalizations',
      id: 'LOC-1',
    });
    expect('appCustomProductPageLocalization' in rels).toBe(false);
  });

  it('attaches to appCustomProductPageLocalization when parentType is the CPP form', () => {
    const body = buildAppScreenshotSetCreateBody({
      screenshotDisplayType: 'APP_IPAD_PRO_129',
      parentType: 'appCustomProductPageLocalizations',
      parentLocalizationId: 'CPP-LOC-1',
    }) as Body;
    const rels = body.data.relationships as {
      appCustomProductPageLocalization: { data: { type: string; id: string } };
    };
    expect(rels.appCustomProductPageLocalization.data).toEqual({
      type: 'appCustomProductPageLocalizations',
      id: 'CPP-LOC-1',
    });
    expect('appStoreVersionLocalization' in rels).toBe(false);
  });
});

describe('buildAppScreenshotCreateBody', () => {
  it('reserve body carries appScreenshotSet relationship + fileName + fileSize', () => {
    const body = buildAppScreenshotCreateBody({
      appScreenshotSetId: 'SET-1',
      fileName: 'iphone-67-1.png',
      fileSize: 123456,
    }) as Body;
    expect(body.data.type).toBe('appScreenshots');
    expect(body.data.attributes).toEqual({
      fileName: 'iphone-67-1.png',
      fileSize: 123456,
    });
    const rels = body.data.relationships as {
      appScreenshotSet: { data: { type: string; id: string } };
    };
    expect(rels.appScreenshotSet.data).toEqual({ type: 'appScreenshotSets', id: 'SET-1' });
  });

  it('fileSize is a number (Apple expects Int, not string)', () => {
    const body = buildAppScreenshotCreateBody({
      appScreenshotSetId: 'SET-1',
      fileName: 'iphone-67-1.png',
      fileSize: 999,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(typeof attrs.fileSize).toBe('number');
  });
});

describe('buildAppScreenshotPatchBody', () => {
  it('uses appScreenshots type + resource id + attributes block', () => {
    const body = buildAppScreenshotPatchBody({
      appScreenshotId: 'SHOT-1',
      sourceFileChecksum: 'abc123',
      uploaded: true,
    }) as Body;
    expect(body.data.type).toBe('appScreenshots');
    expect(body.data.id).toBe('SHOT-1');
  });

  it('emits wire key `uploaded` (NOT Swift `isUploaded`)', () => {
    const body = buildAppScreenshotPatchBody({
      appScreenshotId: 'SHOT-1',
      uploaded: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.uploaded).toBe(true);
    // Regression guard: Swift's `isUploaded` must NOT appear on the wire.
    expect('isUploaded' in attrs).toBe(false);
  });

  it('OMITS uploaded when not provided (encodeIfPresent)', () => {
    const body = buildAppScreenshotPatchBody({
      appScreenshotId: 'SHOT-1',
      sourceFileChecksum: 'deadbeef',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.sourceFileChecksum).toBe('deadbeef');
    expect('uploaded' in attrs).toBe(false);
  });

  it('OMITS sourceFileChecksum when only uploaded is set', () => {
    const body = buildAppScreenshotPatchBody({
      appScreenshotId: 'SHOT-1',
      uploaded: false,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.uploaded).toBe(false);
    expect('sourceFileChecksum' in attrs).toBe(false);
  });

  it('does not emit a relationships block', () => {
    const body = buildAppScreenshotPatchBody({
      appScreenshotId: 'SHOT-1',
      uploaded: true,
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});
