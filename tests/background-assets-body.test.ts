import { describe, expect, it } from 'vitest';
import {
  buildBackgroundAssetCreateBody,
  buildBackgroundAssetListQuery,
  buildBackgroundAssetPatchBody,
  buildBackgroundAssetVersionCreateBody,
  buildUploadFileCommitBody,
  buildUploadFileReserveBody,
  buildVersionListQuery,
  digestBackgroundAssets,
  digestBackgroundAssetUploadFiles,
  digestBackgroundAssetVersions,
} from '../src/domains/background-assets.js';
import type { CollectedPages } from '../src/jsonapi.js';

// Pin the Background Assets wire shapes against the 4.5.1 spec:
//   * version create is relationships-only (no attributes block at all);
//   * upload files reserve assetType + fileName + fileSize;
//   * the commit sends `sourceFileChecksums.file` (plural object), never the
//     deprecated singular `sourceFileChecksum` string;
//   * PATCH backgroundAssets is `archived` only.

describe('asset packs + versions', () => {
  it('create links the app', () => {
    expect(
      buildBackgroundAssetCreateBody({ appId: 'app-1', assetPackIdentifier: 'levels.pack1' }),
    ).toEqual({
      data: {
        type: 'backgroundAssets',
        attributes: { assetPackIdentifier: 'levels.pack1' },
        relationships: { app: { data: { type: 'apps', id: 'app-1' } } },
      },
    });
  });

  it('patch is archived only', () => {
    expect(buildBackgroundAssetPatchBody('ba-1', true)).toEqual({
      data: { type: 'backgroundAssets', id: 'ba-1', attributes: { archived: true } },
    });
  });

  it('version create has no attributes block', () => {
    const body = buildBackgroundAssetVersionCreateBody('ba-1');
    expect(body).toEqual({
      data: {
        type: 'backgroundAssetVersions',
        relationships: { backgroundAsset: { data: { type: 'backgroundAssets', id: 'ba-1' } } },
      },
    });
    expect('attributes' in body.data).toBe(false);
  });
});

describe('upload files', () => {
  it('reserve carries assetType, fileName, fileSize and the version', () => {
    expect(
      buildUploadFileReserveBody({
        versionId: 'v-1',
        assetType: 'ASSET',
        fileName: 'pack.aar',
        fileSize: 4096,
      }),
    ).toEqual({
      data: {
        type: 'backgroundAssetUploadFiles',
        attributes: { assetType: 'ASSET', fileName: 'pack.aar', fileSize: 4096 },
        relationships: {
          backgroundAssetVersion: { data: { type: 'backgroundAssetVersions', id: 'v-1' } },
        },
      },
    });
  });

  it('commit uses sourceFileChecksums.file, MD5 by default', () => {
    const body = buildUploadFileCommitBody({ id: 'f-1', checksum: 'deadbeef', uploaded: true });
    expect(body).toEqual({
      data: {
        type: 'backgroundAssetUploadFiles',
        id: 'f-1',
        attributes: {
          sourceFileChecksums: { file: { hash: 'deadbeef', algorithm: 'MD5' } },
          uploaded: true,
        },
      },
    });
    expect(body.data.attributes).not.toHaveProperty('sourceFileChecksum');
  });

  it('commit accepts SHA_256 and uploaded alone', () => {
    expect(
      buildUploadFileCommitBody({ id: 'f-1', checksum: 'ab', checksumAlgorithm: 'SHA_256' }).data
        .attributes,
    ).toEqual({ sourceFileChecksums: { file: { hash: 'ab', algorithm: 'SHA_256' } } });
    expect(buildUploadFileCommitBody({ id: 'f-1', uploaded: true }).data.attributes).toEqual({
      uploaded: true,
    });
  });

  it('commit refuses empty or algorithm-only input', () => {
    expect(() => buildUploadFileCommitBody({ id: 'f-1' })).toThrow(/Nothing to update/);
    expect(() => buildUploadFileCommitBody({ id: 'f-1', checksumAlgorithm: 'MD5' })).toThrow();
  });
});

describe('queries', () => {
  it('asset list uses the dotted version filters', () => {
    const q = buildBackgroundAssetListQuery({
      archived: false,
      assetPackIdentifier: ['a', 'b'],
      locale: ['en-US'],
      platforms: ['IOS', 'VISION_OS'],
      sort: '-createdDate',
    });
    expect(q.get('filter[archived]')).toBe('false');
    expect(q.get('filter[assetPackIdentifier]')).toBe('a,b');
    expect(q.get('filter[versions.locale]')).toBe('en-US');
    expect(q.get('filter[versions.platforms]')).toBe('IOS,VISION_OS');
    expect(q.get('sort')).toBe('-createdDate');
    expect(q.get('include')).toBe('appStoreVersion,internalBetaVersion,externalBetaVersion');
  });

  it('version list maps release-state filters to dotted keys', () => {
    const q = buildVersionListQuery({
      state: ['COMPLETE'],
      internalBetaReleaseState: ['READY_FOR_TESTING'],
      externalBetaReleaseState: ['IN_REVIEW'],
      appStoreReleaseState: ['READY_FOR_DISTRIBUTION'],
      sort: '-version',
    });
    expect(q.get('filter[state]')).toBe('COMPLETE');
    expect(q.get('filter[internalBetaRelease.state]')).toBe('READY_FOR_TESTING');
    expect(q.get('filter[externalBetaRelease.state]')).toBe('IN_REVIEW');
    expect(q.get('filter[appStoreRelease.state]')).toBe('READY_FOR_DISTRIBUTION');
    expect(q.get('include')).toBe('internalBetaRelease,externalBetaRelease,appStoreRelease');
  });
});

function pages(data: CollectedPages['data'], included: CollectedPages['included'] = []) {
  return { data, included, pagesFetched: 1, truncated: false } satisfies CollectedPages;
}

describe('digests', () => {
  it('asset packs resolve the live version per track', () => {
    const out = digestBackgroundAssets(
      pages(
        [
          {
            type: 'backgroundAssets',
            id: 'ba-1',
            attributes: { assetPackIdentifier: 'levels', archived: false, usedBytes: 10 },
            relationships: {
              appStoreVersion: { data: { type: 'backgroundAssetVersions', id: 'v-3' } },
            },
          },
        ],
        [{ type: 'backgroundAssetVersions', id: 'v-3', attributes: { version: '3' } }],
      ),
    );
    expect(out).toContain('levels');
    expect(out).toMatch(/\s3\s/);
  });

  it('versions show release states', () => {
    const out = digestBackgroundAssetVersions(
      pages(
        [
          {
            type: 'backgroundAssetVersions',
            id: 'v-1',
            attributes: { version: '1', state: 'COMPLETE', platforms: ['IOS', 'MAC_OS'] },
            relationships: {
              appStoreRelease: {
                data: { type: 'backgroundAssetVersionAppStoreReleases', id: 'r-1' },
              },
            },
          },
        ],
        [
          {
            type: 'backgroundAssetVersionAppStoreReleases',
            id: 'r-1',
            attributes: { state: 'READY_FOR_DISTRIBUTION' },
          },
        ],
      ),
    );
    expect(out).toContain('IOS,MAC_OS');
    expect(out).toContain('READY_FOR_DISTRIBUTION');
  });

  it('upload files show type and delivery state', () => {
    const out = digestBackgroundAssetUploadFiles(
      pages([
        {
          type: 'backgroundAssetUploadFiles',
          id: 'f-1',
          attributes: {
            assetType: 'MANIFEST',
            fileName: 'manifest.json',
            fileSize: 5,
            assetDeliveryState: { state: 'AWAITING_UPLOAD' },
          },
        },
      ]),
    );
    expect(out).toContain('MANIFEST');
    expect(out).toContain('AWAITING_UPLOAD');
  });
});
