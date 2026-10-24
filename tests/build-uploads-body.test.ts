import { describe, expect, it } from 'vitest';
import {
  buildBuildUploadBody,
  buildBuildUploadFileBody,
  buildBuildUploadFileCommitBody,
  buildBuildUploadListQuery,
  buildUploadStateCell,
  utiForFileName,
} from '../src/domains/build-uploads.js';

// Pin the wire shape of the build-upload flow (API 4.1):
//   POST  /v1/buildUploads           attrs cfBundleShortVersionString + cfBundleVersion + platform, rel app
//   POST  /v1/buildUploadFiles       attrs assetType + fileName + fileSize + uti, rel buildUpload
//   PATCH /v1/buildUploadFiles/{id}  attrs uploaded + sourceFileChecksums { file: { hash, algorithm } }
// The commit checksum is a nested PLURAL object — not the flat
// sourceFileChecksum string the screenshot / IAP-image commits use.

describe('buildBuildUploadBody', () => {
  it('creates the slot against the app', () => {
    expect(
      buildBuildUploadBody({
        appId: 'APP',
        cfBundleShortVersionString: '2.5',
        cfBundleVersion: '412',
        platform: 'IOS',
      }),
    ).toEqual({
      data: {
        type: 'buildUploads',
        attributes: { cfBundleShortVersionString: '2.5', cfBundleVersion: '412', platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: 'APP' } } },
      },
    });
  });
});

describe('buildBuildUploadFileBody', () => {
  it('reserves the binary against the upload', () => {
    expect(
      buildBuildUploadFileBody({
        buildUploadId: 'BU',
        fileName: 'App.ipa',
        fileSize: 1234,
        uti: 'com.apple.ipa',
        assetType: 'ASSET',
      }),
    ).toEqual({
      data: {
        type: 'buildUploadFiles',
        attributes: {
          assetType: 'ASSET',
          fileName: 'App.ipa',
          fileSize: 1234,
          uti: 'com.apple.ipa',
        },
        relationships: { buildUpload: { data: { type: 'buildUploads', id: 'BU' } } },
      },
    });
  });
});

describe('buildBuildUploadFileCommitBody', () => {
  it('nests the checksum under sourceFileChecksums.file, MD5 by default', () => {
    expect(
      buildBuildUploadFileCommitBody({ buildUploadFileId: 'F', uploaded: true, checksum: 'abc' }),
    ).toEqual({
      data: {
        type: 'buildUploadFiles',
        id: 'F',
        attributes: {
          uploaded: true,
          sourceFileChecksums: { file: { hash: 'abc', algorithm: 'MD5' } },
        },
      },
    });
  });

  it('never sends the flat screenshot-style sourceFileChecksum key', () => {
    const body = buildBuildUploadFileCommitBody({
      buildUploadFileId: 'F',
      uploaded: true,
      checksum: 'abc',
      checksumAlgorithm: 'SHA_256',
    });
    expect(body.data.attributes).not.toHaveProperty('sourceFileChecksum');
    expect(body.data.attributes?.['sourceFileChecksums']).toEqual({
      file: { hash: 'abc', algorithm: 'SHA_256' },
    });
  });

  it('refuses an empty commit', () => {
    expect(() => buildBuildUploadFileCommitBody({ buildUploadFileId: 'F' })).toThrow(
      /Nothing to update/,
    );
  });
});

describe('utiForFileName', () => {
  it('maps the binary extensions', () => {
    expect(utiForFileName('App.IPA')).toBe('com.apple.ipa');
    expect(utiForFileName('/x/App.pkg')).toBe('com.apple.pkg');
    expect(utiForFileName('App.zip')).toBe('com.pkware.zip-archive');
    expect(utiForFileName('App.dmg')).toBeUndefined();
  });
});

describe('buildBuildUploadListQuery', () => {
  it('defaults to newest first and joins filters', () => {
    const q = buildBuildUploadListQuery({ cfBundleVersion: ['1', '2'], state: ['FAILED'] });
    expect(q.get('sort')).toBe('-uploadedDate');
    expect(q.get('include')).toBe('build');
    expect(q.get('filter[cfBundleVersion]')).toBe('1,2');
    expect(q.get('filter[state]')).toBe('FAILED');
    expect(q.has('filter[platform]')).toBe(false);
    expect(q.get('limit')).toBe('200');
  });
});

describe('buildUploadStateCell', () => {
  it('flattens the state object with error and warning counts', () => {
    expect(
      buildUploadStateCell({
        state: 'FAILED',
        errors: [{ code: 'INVALID_BINARY', description: 'x' }],
        warnings: [{}, {}],
      }),
    ).toBe('FAILED · 1 err: INVALID_BINARY · 2 warn');
    expect(buildUploadStateCell({ state: 'COMPLETE' })).toBe('COMPLETE');
    expect(buildUploadStateCell(undefined)).toBe('');
  });
});
