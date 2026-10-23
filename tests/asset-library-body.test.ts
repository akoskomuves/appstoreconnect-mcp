import { describe, expect, it } from 'vitest';
import { digestAssetLibraryPlacements, digestAssetLibraryRefData } from '../src/digest.js';
import {
  buildAssetLibraryAssetCreateBody,
  buildAssetLibraryAssetPatchBody,
  buildAssetLibraryPlacementCreateBody,
  buildAssetLibraryPlacementOrderingBody,
  buildAssetListQuery,
  buildPlacementListQuery,
  buildRefDataQuery,
} from '../src/domains/asset-library.js';

// Pin the wire shape for the App Asset Library writes (API 4.5.1):
//   POST  /v1/appAssetLibraryImages | Videos           (reserve)
//   PATCH /v1/appAssetLibraryImages | Videos/{id}      (commit / archive / rename)
//   POST  /v1/appAssetLibraryPlacements
//   POST  /v1/appAssetLibraryPlacementOrderingRequests
//
// Contract points driving these assertions:
//   1. Create requires category alongside fileName + fileSize, and the
//      relationship is `assetLibrary` → type appAssetLibraries.
//   2. The commit is `uploaded: true` alone — the update request has no
//      sourceFileChecksum, unlike the legacy AppScreenshot commit.
//   3. Placement create is an anyOf: exactly one of image | video and exactly
//      one parent localization, keyed by the SINGULAR relationship name.
//   4. appAssetLibraryRefData rejects `limit` (400 PARAMETER_ERROR.ILLEGAL).

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, { data: unknown }>;
  };
};

describe('buildAssetLibraryAssetCreateBody', () => {
  it('reserves an image with category and the assetLibrary relationship', () => {
    const body = buildAssetLibraryAssetCreateBody({
      kind: 'image',
      assetLibraryId: 'APP-1',
      fileName: 'shot-1.png',
      fileSize: 1234,
      category: 'APP_SCREENSHOTS_AND_PREVIEWS',
    }) as Body;
    expect(body).toEqual({
      data: {
        type: 'appAssetLibraryImages',
        attributes: {
          fileName: 'shot-1.png',
          fileSize: 1234,
          category: 'APP_SCREENSHOTS_AND_PREVIEWS',
        },
        relationships: {
          assetLibrary: { data: { type: 'appAssetLibraries', id: 'APP-1' } },
        },
      },
    });
  });

  it('reserves a video and carries referenceName + previewFrameTimeCode when given', () => {
    const body = buildAssetLibraryAssetCreateBody({
      kind: 'video',
      assetLibraryId: 'APP-1',
      fileName: 'preview.mov',
      fileSize: 99,
      category: 'CREATIVE_ASSETS',
      referenceName: 'Summer event',
      previewFrameTimeCode: '00:00:05:01',
    }) as Body;
    expect(body.data.type).toBe('appAssetLibraryVideos');
    expect(body.data.attributes).toEqual({
      fileName: 'preview.mov',
      fileSize: 99,
      category: 'CREATIVE_ASSETS',
      referenceName: 'Summer event',
      previewFrameTimeCode: '00:00:05:01',
    });
  });

  it('omits optional attributes that are undefined', () => {
    const body = buildAssetLibraryAssetCreateBody({
      kind: 'video',
      assetLibraryId: 'APP-1',
      fileName: 'p.mov',
      fileSize: 1,
      category: 'APP_SCREENSHOTS_AND_PREVIEWS',
      referenceName: undefined,
      previewFrameTimeCode: undefined,
    }) as Body;
    expect(Object.keys(body.data.attributes ?? {})).toEqual(['fileName', 'fileSize', 'category']);
  });

  it('refuses a poster frame on an image', () => {
    expect(() =>
      buildAssetLibraryAssetCreateBody({
        kind: 'image',
        assetLibraryId: 'APP-1',
        fileName: 'a.png',
        fileSize: 1,
        category: 'APP_SCREENSHOTS_AND_PREVIEWS',
        previewFrameTimeCode: '00:00:01:00',
      }),
    ).toThrow(/videos only/);
  });
});

describe('buildAssetLibraryAssetPatchBody', () => {
  it('commits with uploaded=true and no checksum', () => {
    const body = buildAssetLibraryAssetPatchBody({ kind: 'image', id: 'IMG-1', uploaded: true });
    expect(body).toEqual({
      data: { type: 'appAssetLibraryImages', id: 'IMG-1', attributes: { uploaded: true } },
    });
    expect('sourceFileChecksum' in (body.data.attributes ?? {})).toBe(false);
  });

  it('archives and renames a video, moving its poster frame', () => {
    const body = buildAssetLibraryAssetPatchBody({
      kind: 'video',
      id: 'VID-1',
      archived: true,
      referenceName: 'old preview',
      previewFrameTimeCode: '00:00:02:00',
    });
    expect(body.data).toEqual({
      type: 'appAssetLibraryVideos',
      id: 'VID-1',
      attributes: {
        archived: true,
        referenceName: 'old preview',
        previewFrameTimeCode: '00:00:02:00',
      },
    });
  });

  it('sends archived=false (restore) rather than dropping it', () => {
    const body = buildAssetLibraryAssetPatchBody({ kind: 'image', id: 'IMG-1', archived: false });
    expect(body.data.attributes).toEqual({ archived: false });
  });

  it('refuses an empty PATCH', () => {
    expect(() => buildAssetLibraryAssetPatchBody({ kind: 'image', id: 'IMG-1' })).toThrow(
      /Nothing to update/,
    );
  });
});

describe('buildAssetLibraryPlacementCreateBody', () => {
  it('places an image on a version localization under the singular relationship key', () => {
    const body = buildAssetLibraryPlacementCreateBody({
      placementType: 'APP_SCREENSHOT',
      placementGroup: 'IPHONE_DUO_PROFILE',
      imageId: 'IMG-1',
      parentType: 'appStoreVersionLocalizations',
      parentLocalizationId: 'LOC-1',
    }) as Body;
    expect(body).toEqual({
      data: {
        type: 'appAssetLibraryPlacements',
        attributes: { placementType: 'APP_SCREENSHOT', placementGroup: 'IPHONE_DUO_PROFILE' },
        relationships: {
          image: { data: { type: 'appAssetLibraryImages', id: 'IMG-1' } },
          appStoreVersionLocalization: {
            data: { type: 'appStoreVersionLocalizations', id: 'LOC-1' },
          },
        },
      },
    });
  });

  it.each([
    ['appCustomProductPageLocalizations', 'appCustomProductPageLocalization'],
    [
      'appStoreVersionExperimentTreatmentLocalizations',
      'appStoreVersionExperimentTreatmentLocalization',
    ],
    ['appEventLocalizations', 'appEventLocalization'],
  ] as const)('maps parentType %s to relationship %s', (parentType, relKey) => {
    const body = buildAssetLibraryPlacementCreateBody({
      placementType: 'EVENT_CARD_ASSET',
      videoId: 'VID-1',
      parentType,
      parentLocalizationId: 'P-1',
    }) as Body;
    const rels = body.data.relationships ?? {};
    expect(Object.keys(rels).sort()).toEqual([relKey, 'video'].sort());
    expect(rels[relKey]?.data).toEqual({ type: parentType, id: 'P-1' });
    expect(rels.video?.data).toEqual({ type: 'appAssetLibraryVideos', id: 'VID-1' });
  });

  it('omits placementGroup when not given', () => {
    const body = buildAssetLibraryPlacementCreateBody({
      placementType: 'EVENT_DETAILS_PAGE_ASSET',
      imageId: 'IMG-1',
      parentType: 'appEventLocalizations',
      parentLocalizationId: 'EV-1',
    }) as Body;
    expect(body.data.attributes).toEqual({ placementType: 'EVENT_DETAILS_PAGE_ASSET' });
  });

  it('refuses both or neither of imageId / videoId', () => {
    const base = {
      placementType: 'APP_SCREENSHOT',
      parentType: 'appStoreVersionLocalizations' as const,
      parentLocalizationId: 'LOC-1',
    };
    expect(() => buildAssetLibraryPlacementCreateBody(base)).toThrow(/exactly one/);
    expect(() =>
      buildAssetLibraryPlacementCreateBody({ ...base, imageId: 'I', videoId: 'V' }),
    ).toThrow(/exactly one/);
  });
});

describe('buildAssetLibraryPlacementOrderingBody', () => {
  it('sends the group, the ordered placements and the parent', () => {
    const body = buildAssetLibraryPlacementOrderingBody({
      placementGroup: 'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE',
      orderedPlacementIds: ['P-3', 'P-1', 'P-2'],
      parentType: 'appCustomProductPageLocalizations',
      parentLocalizationId: 'CPP-LOC-1',
    }) as Body;
    expect(body).toEqual({
      data: {
        type: 'appAssetLibraryPlacementOrderingRequests',
        attributes: { placementGroup: 'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE' },
        relationships: {
          orderedPlacements: {
            data: [
              { type: 'appAssetLibraryPlacements', id: 'P-3' },
              { type: 'appAssetLibraryPlacements', id: 'P-1' },
              { type: 'appAssetLibraryPlacements', id: 'P-2' },
            ],
          },
          appCustomProductPageLocalization: {
            data: { type: 'appCustomProductPageLocalizations', id: 'CPP-LOC-1' },
          },
        },
      },
    });
  });

  it('refuses an empty or duplicated order', () => {
    const base = {
      placementGroup: 'G',
      parentType: 'appStoreVersionLocalizations' as const,
      parentLocalizationId: 'LOC-1',
    };
    expect(() =>
      buildAssetLibraryPlacementOrderingBody({ ...base, orderedPlacementIds: [] }),
    ).toThrow(/at least one/);
    expect(() =>
      buildAssetLibraryPlacementOrderingBody({ ...base, orderedPlacementIds: ['A', 'A'] }),
    ).toThrow(/duplicates/);
  });
});

describe('query builders', () => {
  it('ref data never sends limit', () => {
    const params = buildRefDataQuery({
      sections: ['placementProfileGroups', 'imageSpecs'],
      placementProfileGroups: ['IPHONE_DUO_PROFILE'],
      placementTypes: ['APP_SCREENSHOT'],
    });
    expect(params.has('limit')).toBe(false);
    expect(params.get('fields[appAssetLibraryRefData]')).toBe('placementProfileGroups,imageSpecs');
    expect(params.get('filter[placementProfileGroups]')).toBe('IPHONE_DUO_PROFILE');
    expect(params.get('filter[placementTypes]')).toBe('APP_SCREENSHOT');
    expect(buildRefDataQuery({}).toString()).toBe('');
  });

  it('image list uses the image fieldset, comma-joined filters and optional placements include', () => {
    const params = buildAssetListQuery({
      kind: 'image',
      state: ['COMPLETE', 'APPROVED'],
      category: ['APP_SCREENSHOTS_AND_PREVIEWS'],
      sort: '-createdDate',
      includePlacements: true,
    });
    expect(params.get('fields[appAssetLibraryImages]')).toContain('imageAsset');
    expect(params.has('fields[appAssetLibraryVideos]')).toBe(false);
    expect(params.get('filter[state]')).toBe('COMPLETE,APPROVED');
    expect(params.get('filter[category]')).toBe('APP_SCREENSHOTS_AND_PREVIEWS');
    expect(params.get('include')).toBe('placements');
    expect(params.get('limit')).toBe('200');
  });

  it('video list uses the video fieldset and skips the include when not asked', () => {
    const params = buildAssetListQuery({ kind: 'video' });
    expect(params.get('fields[appAssetLibraryVideos]')).toContain('previewFrameTimeCode');
    expect(params.has('include')).toBe(false);
  });

  it('placement list includes the placed asset names and passes filters through', () => {
    const params = buildPlacementListQuery({
      placementType: ['APP_SCREENSHOT'],
      placementGroup: ['IPHONE_DUO_PROFILE'],
      state: ['INACTIVE'],
      sort: 'placementGroupPosition',
    });
    expect(params.get('include')).toBe('image,video');
    expect(params.get('fields[appAssetLibraryPlacements]')).toContain('placementGroup');
    expect(params.get('filter[placementType]')).toBe('APP_SCREENSHOT');
    expect(params.get('filter[placementGroup]')).toBe('IPHONE_DUO_PROFILE');
    expect(params.get('filter[state]')).toBe('INACTIVE');
    expect(params.get('sort')).toBe('placementGroupPosition');
  });
});

describe('digests', () => {
  it('placements: groups by type+group, numbers positions, names the placed asset', () => {
    const placement = (id: string, group: string, imageId: string) => ({
      type: 'appAssetLibraryPlacements',
      id,
      attributes: {
        mediaType: 'IMAGE',
        placementType: 'APP_SCREENSHOT',
        placementGroup: group,
        state: 'INACTIVE',
      },
      relationships: { image: { data: { type: 'appAssetLibraryImages', id: imageId } } },
    });
    const text = digestAssetLibraryPlacements({
      data: [
        placement('P1', 'A_PROFILE', 'I1'),
        placement('P2', 'B_PROFILE', 'I2'),
        placement('P3', 'A_PROFILE', 'I3'),
      ],
      included: [
        { type: 'appAssetLibraryImages', id: 'I1', attributes: { referenceName: 'first.png' } },
      ],
      pagesFetched: 1,
      truncated: false,
    });
    const lines = text.split('\n').filter((l) => l.includes('APP_SCREENSHOT'));
    expect(lines.map((l) => l.match(/P\d/)?.[0])).toEqual(['P1', 'P3', 'P2']);
    expect(lines[0]).toContain('first.png');
    expect(lines[1]).toMatch(/A_PROFILE\s+2/);
    expect(lines[2]).toContain('I2');
  });

  it('ref data: renders only the sections that came back', () => {
    const text = digestAssetLibraryRefData({
      type: 'appAssetLibraryRefData',
      id: '1',
      attributes: {
        placementProfileGroups: [
          {
            placementProfileGroupId: 'IPHONE_DUO_PROFILE',
            platform: 'IPHONE_APP_STORE',
            displayClassId: 'IPHONE_DUO',
          },
        ],
        imageSpecs: [
          {
            specId: 'S1',
            dimensions: { minWidth: 1398, maxWidth: 1398, minHeight: 2034, maxHeight: 2034 },
            aspectRatio: '1398:2034',
            alphaAllowed: false,
            fileExtensions: ['.png'],
            compatiblePlacementTypes: ['APP_SCREENSHOT'],
          },
        ],
      },
    });
    expect(text).toContain('IPHONE_DUO_PROFILE');
    expect(text).toContain('1398x2034');
    expect(text).not.toContain('Video specs');
    expect(text).not.toContain('Display classes');
  });
});
