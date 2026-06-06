import { describe, expect, it } from 'vitest';
import {
  buildAppEventScreenshotCreateBody,
  buildAppEventScreenshotPatchBody,
} from '../src/domains/app-event-screenshots.js';
import {
  buildAppEventVideoClipCreateBody,
  buildAppEventVideoClipPatchBody,
} from '../src/domains/app-event-video-clips.js';

// Pin the wire shape for the AppEventScreenshot + AppEventVideoClip writes.
//
// Quirks driving these assertions:
//   1. appEventAssetType (EVENT_CARD / EVENT_DETAILS_PAGE) is REQUIRED at
//      create on BOTH resources.
//   2. WIRE-KEY GOTCHA on AppEventScreenshotUpdateRequest /
//      AppEventVideoClipUpdateRequest: Swift `isUploaded` → wire `uploaded`
//      (same strip as v0.13 AppScreenshot / AppPreview).
//   3. AppEventVideoClip has previewFrameTimeCode (poster frame) on BOTH
//      create AND patch — same shape as v0.13 AppPreview.
//   4. AppEventScreenshot has NO sourceFileChecksum slot anywhere — Apple
//      does not require an MD5 on commit (unlike v0.13 AppScreenshot).

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppEventScreenshotCreateBody', () => {
  it('uses appEventScreenshots type with required attrs + localization rel', () => {
    const body = buildAppEventScreenshotCreateBody({
      appEventLocalizationId: 'EVL-1',
      fileName: 'event-tile.png',
      fileSize: 250000,
      appEventAssetType: 'EVENT_CARD',
    }) as Body;
    expect(body.data.type).toBe('appEventScreenshots');
    expect(body.data.attributes).toEqual({
      fileName: 'event-tile.png',
      fileSize: 250000,
      appEventAssetType: 'EVENT_CARD',
    });
    const rels = body.data.relationships as {
      appEventLocalization: { data: { type: string; id: string } };
    };
    expect(rels.appEventLocalization.data).toEqual({
      type: 'appEventLocalizations',
      id: 'EVL-1',
    });
  });

  it('fileSize is a number (Apple expects Int, not string)', () => {
    const body = buildAppEventScreenshotCreateBody({
      appEventLocalizationId: 'EVL-1',
      fileName: 'x.png',
      fileSize: 999,
      appEventAssetType: 'EVENT_DETAILS_PAGE',
    }) as Body;
    expect(typeof (body.data.attributes as Record<string, unknown>).fileSize).toBe('number');
  });
});

describe('buildAppEventScreenshotPatchBody', () => {
  it('emits wire key `uploaded` (NOT Swift `isUploaded`)', () => {
    const body = buildAppEventScreenshotPatchBody({
      appEventScreenshotId: 'EVS-1',
      uploaded: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.uploaded).toBe(true);
    expect('isUploaded' in attrs).toBe(false);
  });

  it('does not emit a relationships block', () => {
    const body = buildAppEventScreenshotPatchBody({
      appEventScreenshotId: 'EVS-1',
      uploaded: true,
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});

describe('buildAppEventVideoClipCreateBody', () => {
  it('uses appEventVideoClips type with required attrs + localization rel', () => {
    const body = buildAppEventVideoClipCreateBody({
      appEventLocalizationId: 'EVL-1',
      fileName: 'event-clip.mov',
      fileSize: 5_000_000,
      appEventAssetType: 'EVENT_DETAILS_PAGE',
    }) as Body;
    expect(body.data.type).toBe('appEventVideoClips');
    expect(body.data.attributes).toEqual({
      fileName: 'event-clip.mov',
      fileSize: 5_000_000,
      appEventAssetType: 'EVENT_DETAILS_PAGE',
    });
  });

  it('emits previewFrameTimeCode when provided at create', () => {
    const body = buildAppEventVideoClipCreateBody({
      appEventLocalizationId: 'EVL-1',
      fileName: 'x.mov',
      fileSize: 1,
      appEventAssetType: 'EVENT_CARD',
      previewFrameTimeCode: '00:00:03:00',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.previewFrameTimeCode).toBe('00:00:03:00');
  });
});

describe('buildAppEventVideoClipPatchBody', () => {
  it('emits wire key `uploaded` (NOT Swift `isUploaded`)', () => {
    const body = buildAppEventVideoClipPatchBody({
      appEventVideoClipId: 'EVC-1',
      uploaded: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.uploaded).toBe(true);
    expect('isUploaded' in attrs).toBe(false);
  });

  it('lets previewFrameTimeCode be updated alone (poster frame change without re-upload)', () => {
    const body = buildAppEventVideoClipPatchBody({
      appEventVideoClipId: 'EVC-1',
      previewFrameTimeCode: '00:00:08:00',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.previewFrameTimeCode).toBe('00:00:08:00');
    expect('uploaded' in attrs).toBe(false);
  });

  it('OMITS undefined attrs', () => {
    const body = buildAppEventVideoClipPatchBody({
      appEventVideoClipId: 'EVC-1',
      uploaded: false,
    }) as Body;
    expect(body.data.attributes).toEqual({ uploaded: false });
  });
});
