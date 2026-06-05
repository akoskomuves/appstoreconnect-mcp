import { describe, expect, it } from 'vitest';
import {
  buildAppPreviewCreateBody,
  buildAppPreviewPatchBody,
  buildAppPreviewSetCreateBody,
} from '../src/domains/previews.js';

// Pin the wire shape for the AppPreview + AppPreviewSet writes:
//   POST  /v1/appPreviewSets
//   POST  /v1/appPreviews                  (reserve)
//   PATCH /v1/appPreviews/{id}             (commit or update poster frame)
//
// Quirks driving these assertions:
//   1. PreviewType uses NO `APP_` prefix (IPHONE_67, not APP_IPHONE_67).
//      Distinct enum from ScreenshotDisplayType.
//   2. WIRE-KEY GOTCHA on AppPreviewUpdateRequest: Swift `isUploaded` →
//      wire `uploaded` (same as AppScreenshot).
//   3. AppPreview supports a previewFrameTimeCode attr — both at reserve
//      and on patch (poster frame can change without re-uploading).

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppPreviewSetCreateBody', () => {
  it('uses appPreviewSets type with previewType (NO APP_ prefix) in attributes', () => {
    const body = buildAppPreviewSetCreateBody({
      previewType: 'IPHONE_67',
      parentType: 'appStoreVersionLocalizations',
      parentLocalizationId: 'LOC-1',
    }) as Body;
    expect(body.data.type).toBe('appPreviewSets');
    expect(body.data.attributes).toEqual({ previewType: 'IPHONE_67' });
  });

  it('routes parent relationship by parentType', () => {
    const body = buildAppPreviewSetCreateBody({
      previewType: 'APPLE_TV',
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
  });
});

describe('buildAppPreviewCreateBody', () => {
  it('reserve body carries appPreviewSet relationship + fileName + fileSize', () => {
    const body = buildAppPreviewCreateBody({
      appPreviewSetId: 'SET-1',
      fileName: 'preview-en.mov',
      fileSize: 5_000_000,
    }) as Body;
    expect(body.data.type).toBe('appPreviews');
    expect(body.data.attributes).toEqual({
      fileName: 'preview-en.mov',
      fileSize: 5_000_000,
    });
    const rels = body.data.relationships as {
      appPreviewSet: { data: { type: string; id: string } };
    };
    expect(rels.appPreviewSet.data).toEqual({ type: 'appPreviewSets', id: 'SET-1' });
  });

  it('emits optional previewFrameTimeCode + mimeType when passed', () => {
    const body = buildAppPreviewCreateBody({
      appPreviewSetId: 'SET-1',
      fileName: 'preview.mov',
      fileSize: 1,
      previewFrameTimeCode: '00:00:05:00',
      mimeType: 'video/quicktime',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.previewFrameTimeCode).toBe('00:00:05:00');
    expect(attrs.mimeType).toBe('video/quicktime');
  });

  it('OMITS optional attrs when not provided', () => {
    const body = buildAppPreviewCreateBody({
      appPreviewSetId: 'SET-1',
      fileName: 'preview.mov',
      fileSize: 1,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('previewFrameTimeCode' in attrs).toBe(false);
    expect('mimeType' in attrs).toBe(false);
  });
});

describe('buildAppPreviewPatchBody', () => {
  it('emits wire key `uploaded` (NOT Swift `isUploaded`)', () => {
    const body = buildAppPreviewPatchBody({
      appPreviewId: 'PRV-1',
      uploaded: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.uploaded).toBe(true);
    expect('isUploaded' in attrs).toBe(false);
  });

  it('lets previewFrameTimeCode be updated alone (poster frame change without re-upload)', () => {
    const body = buildAppPreviewPatchBody({
      appPreviewId: 'PRV-1',
      previewFrameTimeCode: '00:00:10:00',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.previewFrameTimeCode).toBe('00:00:10:00');
    expect('uploaded' in attrs).toBe(false);
    expect('sourceFileChecksum' in attrs).toBe(false);
  });

  it('OMITS undefined attrs', () => {
    const body = buildAppPreviewPatchBody({
      appPreviewId: 'PRV-1',
      sourceFileChecksum: 'abc',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs).toEqual({ sourceFileChecksum: 'abc' });
  });
});
