import { describe, expect, it } from 'vitest';
import {
  buildMappingCreateBody,
  buildMappingPatchBody,
  SHA256_FINGERPRINT,
} from '../src/domains/android-app-mappings.js';
import {
  buildLinkagesBody,
  buildVersionPromotionBody,
  LINKAGES,
  linkagePath,
  linkageToolName,
} from '../src/domains/relationship-linkages.js';
import { buildAttributesPatchBody } from '../src/domains/resource-updates.js';

describe('relationship linkages', () => {
  it('builds the flat to-many body', () => {
    expect(buildLinkagesBody('appKeywords', ['k1', 'k2'])).toEqual({
      data: [
        { type: 'appKeywords', id: 'k1' },
        { type: 'appKeywords', id: 'k2' },
      ],
    });
  });

  it('keeps the order of ids (it is the display order on set)', () => {
    expect(buildLinkagesBody('appScreenshots', ['c', 'a', 'b']).data.map((d) => d.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('builds the relationships path', () => {
    const cfg = LINKAGES.find(
      (c) => c.parent === 'builds' && c.relationship === 'individualTesters',
    );
    if (!cfg) throw new Error('missing');
    expect(linkagePath(cfg, 'B 1')).toBe('/v1/builds/B%201/relationships/individualTesters');
    expect(cfg.targetType).toBe('betaTesters');
  });

  it('gives every verb of every config a unique tool name', () => {
    const names = LINKAGES.flatMap((c) => c.verbs.map((v) => linkageToolName(c, v)));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('asc_add_build_beta_groups');
    expect(names).toContain('asc_set_app_screenshot_set_order');
    expect(names).toContain('asc_remove_app_beta_testers');
  });

  it('builds the version promotion body with both relationships', () => {
    expect(buildVersionPromotionBody({ appStoreVersionId: 'V', treatmentId: 'T' })).toEqual({
      data: {
        type: 'appStoreVersionPromotions',
        relationships: {
          appStoreVersion: { data: { type: 'appStoreVersions', id: 'V' } },
          appStoreVersionExperimentTreatment: {
            data: { type: 'appStoreVersionExperimentTreatments', id: 'T' },
          },
        },
      },
    });
  });
});

describe('android → iOS app mappings', () => {
  const fp =
    'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

  it('accepts colon-separated and bare hex SHA-256 fingerprints', () => {
    expect(SHA256_FINGERPRINT.test(fp)).toBe(true);
    expect(SHA256_FINGERPRINT.test(fp.replaceAll(':', ''))).toBe(true);
    expect(SHA256_FINGERPRINT.test('AB:CD')).toBe(false);
    expect(SHA256_FINGERPRINT.test(`${fp}:00`)).toBe(false);
  });

  it('create sends both required attributes and the app relationship', () => {
    expect(
      buildMappingCreateBody({ appId: 'A', packageName: 'com.example.app', fingerprints: [fp] }),
    ).toEqual({
      data: {
        type: 'androidToIosAppMappingDetails',
        attributes: {
          packageName: 'com.example.app',
          appSigningKeyPublicCertificateSha256Fingerprints: [fp],
        },
        relationships: { app: { data: { type: 'apps', id: 'A' } } },
      },
    });
  });

  it('patch sends only what changed', () => {
    expect(buildMappingPatchBody({ mappingId: 'M', fingerprints: [fp] }).data).toEqual({
      type: 'androidToIosAppMappingDetails',
      id: 'M',
      attributes: { appSigningKeyPublicCertificateSha256Fingerprints: [fp] },
    });
  });
});

describe('buildAttributesPatchBody', () => {
  it('drops undefined and passes null through (null clears the field)', () => {
    expect(
      buildAttributesPatchBody('apps', 'A', {
        subscriptionStatusUrl: null,
        subscriptionStatusUrlVersion: 'V2',
        primaryLocale: undefined,
      }),
    ).toEqual({
      data: {
        type: 'apps',
        id: 'A',
        attributes: { subscriptionStatusUrl: null, subscriptionStatusUrlVersion: 'V2' },
      },
    });
  });

  it('keeps false booleans', () => {
    expect(
      buildAttributesPatchBody('reviewSubmissionItems', 'I', {
        resolved: false,
        removed: undefined,
      }).data.attributes,
    ).toEqual({ resolved: false });
  });
});
