import { describe, expect, it } from 'vitest';
import {
  buildVersionedCreateBody,
  buildVersionedPatchBody,
  IMAGE_CONFIGS,
  LOCALIZATION_CONFIGS,
} from '../src/domains/versioned-content.js';

// The /v2 content endpoints carry the same resource types and attributes as
// /v1, but hang off a product VERSION (relationship key `version`). Spec 4.5.1.

describe('buildVersionedCreateBody', () => {
  it('localization: attributes + a `version` relationship, undefined fields dropped', () => {
    const body = buildVersionedCreateBody({
      resourceType: 'inAppPurchaseLocalizations',
      versionType: 'inAppPurchaseVersions',
      versionId: 'V-1',
      attributes: { name: 'Coins', locale: 'en-US', description: undefined },
    });
    expect(body).toEqual({
      data: {
        type: 'inAppPurchaseLocalizations',
        attributes: { name: 'Coins', locale: 'en-US' },
        relationships: { version: { data: { type: 'inAppPurchaseVersions', id: 'V-1' } } },
      },
    });
  });

  it('image reserve: fileName + fileSize on the version', () => {
    const body = buildVersionedCreateBody({
      resourceType: 'subscriptionImages',
      versionType: 'subscriptionVersions',
      versionId: 'SV-1',
      attributes: { fileName: 'a.png', fileSize: 10 },
    });
    expect(body.data.attributes).toEqual({ fileName: 'a.png', fileSize: 10 });
    expect(body.data.relationships).toEqual({
      version: { data: { type: 'subscriptionVersions', id: 'SV-1' } },
    });
  });
});

describe('buildVersionedPatchBody', () => {
  it('carries the id and only the changed attributes', () => {
    expect(
      buildVersionedPatchBody('subscriptionGroupLocalizations', 'L-1', {
        name: 'Premium',
        customAppName: undefined,
      }),
    ).toEqual({
      data: { type: 'subscriptionGroupLocalizations', id: 'L-1', attributes: { name: 'Premium' } },
    });
  });

  it('v2 image commit is uploaded-only (no sourceFileChecksum in the v2 contract)', () => {
    const body = buildVersionedPatchBody('inAppPurchaseImages', 'I-1', { uploaded: true });
    expect(body.data.attributes).toEqual({ uploaded: true });
  });
});

describe('configs match spec 4.5.1 relationship targets', () => {
  it('localizations', () => {
    expect(LOCALIZATION_CONFIGS.map((c) => [c.resourceType, c.versionType, c.extraKey])).toEqual([
      ['inAppPurchaseLocalizations', 'inAppPurchaseVersions', 'description'],
      ['subscriptionLocalizations', 'subscriptionVersions', 'description'],
      ['subscriptionGroupLocalizations', 'subscriptionGroupVersions', 'customAppName'],
    ]);
  });

  it('images', () => {
    expect(IMAGE_CONFIGS.map((c) => [c.resourceType, c.versionType])).toEqual([
      ['inAppPurchaseImages', 'inAppPurchaseVersions'],
      ['subscriptionImages', 'subscriptionVersions'],
    ]);
  });

  it('tool names do not collide with the /v1 tools', () => {
    const bases = [...LOCALIZATION_CONFIGS, ...IMAGE_CONFIGS].map((c) => c.toolBase);
    for (const b of bases) expect(b).toContain('_version_');
  });
});
