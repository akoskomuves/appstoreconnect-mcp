import { describe, expect, it } from 'vitest';
import {
  buildAppStoreVersionCreateBody,
  buildAppStoreVersionPatchBody,
  evaluateVersionDeleteGate,
} from '../src/domains/appstore-versions.js';

// Pin the wire shape for the writable AppStoreVersion endpoints:
//   POST   /v1/appStoreVersions
//   PATCH  /v1/appStoreVersions/{id}
//   DELETE /v1/appStoreVersions/{id}
//
// Apple quirks driving these assertions:
//   1. CREATE: platform + versionString + app rel REQUIRED. Other attrs
//      encodeIfPresent. Optional build rel at create time.
//   2. PATCH: all attrs encodeIfPresent. Wire-key strip on isDownloadable
//      → downloadable. Build rel can be set, swapped, or cleared
//      (data: null).
//   3. DELETE is gated by state — only editable states allow it.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppStoreVersionCreateBody', () => {
  it('uses appStoreVersions type with platform + versionString attrs and app rel (minimum)', () => {
    const body = buildAppStoreVersionCreateBody({
      appId: 'APP-1',
      platform: 'IOS',
      versionString: '2.5.0',
    }) as Body;
    expect(body.data.type).toBe('appStoreVersions');
    expect(body.data.attributes).toEqual({ platform: 'IOS', versionString: '2.5.0' });
    const rels = body.data.relationships as { app: { data: { type: string; id: string } } };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
  });

  it('OMITS optional attrs when not provided (encodeIfPresent)', () => {
    const body = buildAppStoreVersionCreateBody({
      appId: 'APP-1',
      platform: 'IOS',
      versionString: '2.5.0',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(Object.keys(attrs).sort()).toEqual(['platform', 'versionString']);
  });

  it('emits all optional attrs verbatim when all are provided', () => {
    const body = buildAppStoreVersionCreateBody({
      appId: 'APP-1',
      platform: 'IOS',
      versionString: '2.5.0',
      copyright: '© 2026 Example',
      reviewType: 'APP_STORE',
      releaseType: 'SCHEDULED',
      earliestReleaseDate: '2026-08-01T00:00:00Z',
    }) as Body;
    expect(body.data.attributes).toEqual({
      platform: 'IOS',
      versionString: '2.5.0',
      copyright: '© 2026 Example',
      reviewType: 'APP_STORE',
      releaseType: 'SCHEDULED',
      earliestReleaseDate: '2026-08-01T00:00:00Z',
    });
  });

  it('attaches the build relationship when buildId is passed', () => {
    const body = buildAppStoreVersionCreateBody({
      appId: 'APP-1',
      platform: 'IOS',
      versionString: '2.5.0',
      buildId: 'B-1',
    }) as Body;
    const rels = body.data.relationships as {
      app: unknown;
      build: { data: { type: string; id: string } };
    };
    expect(rels.build.data).toEqual({ type: 'builds', id: 'B-1' });
  });

  it('OMITS the build relationship when buildId is not provided', () => {
    const body = buildAppStoreVersionCreateBody({
      appId: 'APP-1',
      platform: 'IOS',
      versionString: '2.5.0',
    }) as Body;
    const rels = body.data.relationships as Record<string, unknown>;
    expect('build' in rels).toBe(false);
    expect('app' in rels).toBe(true);
  });
});

describe('buildAppStoreVersionPatchBody', () => {
  it('uses appStoreVersions type with the resource ID', () => {
    const body = buildAppStoreVersionPatchBody({
      appStoreVersionId: 'V-1',
      copyright: '© 2026 Updated',
    }) as Body;
    expect(body.data.type).toBe('appStoreVersions');
    expect(body.data.id).toBe('V-1');
    expect(body.data.attributes).toEqual({ copyright: '© 2026 Updated' });
  });

  it('uses stripped WIRE key `downloadable` (not Swift `isDownloadable`)', () => {
    const body = buildAppStoreVersionPatchBody({
      appStoreVersionId: 'V-1',
      downloadable: false,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.downloadable).toBe(false);
    expect('isDownloadable' in attrs).toBe(false);
  });

  it('emits all six attrs verbatim when all are provided', () => {
    const body = buildAppStoreVersionPatchBody({
      appStoreVersionId: 'V-1',
      versionString: '2.5.1',
      copyright: '© 2026',
      reviewType: 'APP_STORE',
      releaseType: 'MANUAL',
      earliestReleaseDate: '2026-08-01T00:00:00Z',
      downloadable: true,
    }) as Body;
    expect(body.data.attributes).toEqual({
      versionString: '2.5.1',
      copyright: '© 2026',
      reviewType: 'APP_STORE',
      releaseType: 'MANUAL',
      earliestReleaseDate: '2026-08-01T00:00:00Z',
      downloadable: true,
    });
  });

  it('OMITS the relationships block when neither buildId nor clearBuild is passed', () => {
    const body = buildAppStoreVersionPatchBody({
      appStoreVersionId: 'V-1',
      copyright: 'X',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });

  it('attaches the build relationship when buildId is provided', () => {
    const body = buildAppStoreVersionPatchBody({
      appStoreVersionId: 'V-1',
      buildId: 'B-2',
    }) as Body;
    const rels = body.data.relationships as {
      build: { data: { type: string; id: string } };
    };
    expect(rels.build.data).toEqual({ type: 'builds', id: 'B-2' });
  });

  it('clears the build relationship with data: null when clearBuild=true', () => {
    const body = buildAppStoreVersionPatchBody({
      appStoreVersionId: 'V-1',
      clearBuild: true,
    }) as Body;
    const rels = body.data.relationships as { build: { data: null } };
    expect(rels.build).toEqual({ data: null });
  });

  it('produces empty attributes when nothing is passed (tool-level guard against this)', () => {
    const body = buildAppStoreVersionPatchBody({ appStoreVersionId: 'V-1' }) as Body;
    expect(body.data.attributes).toEqual({});
  });
});

describe('evaluateVersionDeleteGate', () => {
  describe('editable states — allow', () => {
    const states = [
      'PREPARE_FOR_SUBMISSION',
      'DEVELOPER_REJECTED',
      'METADATA_REJECTED',
      'REJECTED',
      'INVALID_BINARY',
      'DEVELOPER_REMOVED_FROM_SALE',
    ];
    for (const state of states) {
      it(`allows DELETE in ${state}`, () => {
        const result = evaluateVersionDeleteGate(state);
        expect(result.allow).toBe(true);
        expect(result.state).toBe(state);
      });
    }
  });

  describe('frozen states — refuse with review-in-progress reason', () => {
    const states = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PROCESSING_FOR_APP_STORE'];
    for (const state of states) {
      it(`refuses DELETE in ${state}`, () => {
        const result = evaluateVersionDeleteGate(state);
        expect(result.allow).toBe(false);
        expect(result.state).toBe(state);
        expect(result.reason).toContain('review');
        expect(result.nextEditablePath).toContain('Cancel');
      });
    }
  });

  describe('live / promo states — refuse with orphan-customers reason', () => {
    const states = [
      'READY_FOR_SALE',
      'PENDING_DEVELOPER_RELEASE',
      'REPLACED_WITH_NEW_VERSION',
      'REMOVED_FROM_SALE',
    ];
    for (const state of states) {
      it(`refuses DELETE in ${state}`, () => {
        const result = evaluateVersionDeleteGate(state);
        expect(result.allow).toBe(false);
        expect(result.state).toBe(state);
        expect(result.reason).toContain(state);
        // The recovery path tells the caller to create a new version.
        expect(result.nextEditablePath?.toLowerCase()).toContain('new app store version');
      });
    }
  });

  describe('unknown / undefined — pass through', () => {
    it('passes through undefined (fetch failed)', () => {
      const result = evaluateVersionDeleteGate(undefined);
      expect(result.allow).toBe(true);
    });

    it('passes through novel Apple states', () => {
      const result = evaluateVersionDeleteGate('NEW_STATE_FOO');
      expect(result.allow).toBe(true);
    });
  });
});
