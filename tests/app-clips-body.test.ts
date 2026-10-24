import { describe, expect, it } from 'vitest';
import {
  buildAdvancedExperienceCreateBody,
  buildAdvancedExperiencePatchBody,
  buildAppClipImageCommitBody,
  buildAppClipImageReserveBody,
  buildAppStoreVersionDefaultExperienceLinkage,
  buildBetaInvocationCreateBody,
  buildBetaInvocationLocalizationCreateBody,
  buildBetaInvocationLocalizationPatchBody,
  buildBetaInvocationPatchBody,
  buildDefaultExperienceCreateBody,
  buildDefaultExperienceLocalizationCreateBody,
  buildDefaultExperienceLocalizationPatchBody,
  buildDefaultExperiencePatchBody,
  buildDefaultExperienceReleaseVersionLinkage,
  buildReviewDetailCreateBody,
  buildReviewDetailPatchBody,
  digestAdvancedExperiences,
  digestAppClips,
  digestDefaultExperienceLocalizations,
  digestDefaultExperiences,
} from '../src/domains/app-clips.js';
import type { CollectedPages } from '../src/jsonapi.js';

// Pin the wire shapes of the App Clip write endpoints against the 4.5.1 spec:
//   * default experience create: relationships-only unless `action` is set;
//     appClipDefaultExperienceTemplate copies an existing experience.
//   * header images + advanced experience images: legacy three-step upload
//     (reserve fileName + fileSize, commit sourceFileChecksum + uploaded).
//   * advanced experience + beta invocation: localizations created inline in
//     included[] with `${N}` temp ids.
//   * version ↔ default experience: bare { data: { type, id } } linkages.

const T1 = `\${1}`;
const T2 = `\${2}`;

describe('default experiences', () => {
  it('create omits the attributes block without an action', () => {
    expect(buildDefaultExperienceCreateBody({ appClipId: 'clip-1' })).toEqual({
      data: {
        type: 'appClipDefaultExperiences',
        relationships: { appClip: { data: { type: 'appClips', id: 'clip-1' } } },
      },
    });
  });

  it('create carries action, release version and template', () => {
    expect(
      buildDefaultExperienceCreateBody({
        appClipId: 'clip-1',
        action: 'OPEN',
        releaseWithAppStoreVersionId: 'ver-1',
        templateDefaultExperienceId: 'exp-0',
      }),
    ).toEqual({
      data: {
        type: 'appClipDefaultExperiences',
        attributes: { action: 'OPEN' },
        relationships: {
          appClip: { data: { type: 'appClips', id: 'clip-1' } },
          releaseWithAppStoreVersion: { data: { type: 'appStoreVersions', id: 'ver-1' } },
          appClipDefaultExperienceTemplate: {
            data: { type: 'appClipDefaultExperiences', id: 'exp-0' },
          },
        },
      },
    });
  });

  it('patch sends only what changed', () => {
    expect(buildDefaultExperiencePatchBody({ id: 'exp-1', action: 'PLAY' })).toEqual({
      data: { type: 'appClipDefaultExperiences', id: 'exp-1', attributes: { action: 'PLAY' } },
    });
    expect(
      buildDefaultExperiencePatchBody({ id: 'exp-1', releaseWithAppStoreVersionId: 'ver-2' }),
    ).toEqual({
      data: {
        type: 'appClipDefaultExperiences',
        id: 'exp-1',
        relationships: {
          releaseWithAppStoreVersion: { data: { type: 'appStoreVersions', id: 'ver-2' } },
        },
      },
    });
    expect(() => buildDefaultExperiencePatchBody({ id: 'exp-1' })).toThrow(/Nothing to update/);
  });

  it('relationship linkages are bare data objects', () => {
    expect(buildDefaultExperienceReleaseVersionLinkage('ver-1')).toEqual({
      data: { type: 'appStoreVersions', id: 'ver-1' },
    });
    expect(buildAppStoreVersionDefaultExperienceLinkage('exp-1')).toEqual({
      data: { type: 'appClipDefaultExperiences', id: 'exp-1' },
    });
  });
});

describe('default experience localizations + review details', () => {
  it('localization create requires locale, subtitle optional', () => {
    expect(
      buildDefaultExperienceLocalizationCreateBody({
        defaultExperienceId: 'exp-1',
        locale: 'en-US',
      }),
    ).toEqual({
      data: {
        type: 'appClipDefaultExperienceLocalizations',
        attributes: { locale: 'en-US' },
        relationships: {
          appClipDefaultExperience: { data: { type: 'appClipDefaultExperiences', id: 'exp-1' } },
        },
      },
    });
    expect(
      buildDefaultExperienceLocalizationCreateBody({
        defaultExperienceId: 'exp-1',
        locale: 'de-DE',
        subtitle: 'Bestellen',
      }).data.attributes,
    ).toEqual({ locale: 'de-DE', subtitle: 'Bestellen' });
  });

  it('localization patch is subtitle only', () => {
    expect(buildDefaultExperienceLocalizationPatchBody('loc-1', 'Order ahead')).toEqual({
      data: {
        type: 'appClipDefaultExperienceLocalizations',
        id: 'loc-1',
        attributes: { subtitle: 'Order ahead' },
      },
    });
  });

  it('review detail create omits attributes without URLs', () => {
    expect(buildReviewDetailCreateBody({ defaultExperienceId: 'exp-1' })).toEqual({
      data: {
        type: 'appClipAppStoreReviewDetails',
        relationships: {
          appClipDefaultExperience: { data: { type: 'appClipDefaultExperiences', id: 'exp-1' } },
        },
      },
    });
    expect(
      buildReviewDetailCreateBody({
        defaultExperienceId: 'exp-1',
        invocationUrls: ['https://example.com/clip'],
      }).data.attributes,
    ).toEqual({ invocationUrls: ['https://example.com/clip'] });
    expect(buildReviewDetailPatchBody('rd-1', [])).toEqual({
      data: {
        type: 'appClipAppStoreReviewDetails',
        id: 'rd-1',
        attributes: { invocationUrls: [] },
      },
    });
  });
});

describe('images', () => {
  it('header image reserve links the localization', () => {
    expect(
      buildAppClipImageReserveBody({
        kind: 'header',
        fileName: 'card.png',
        fileSize: 1234,
        defaultExperienceLocalizationId: 'loc-1',
      }),
    ).toEqual({
      data: {
        type: 'appClipHeaderImages',
        attributes: { fileName: 'card.png', fileSize: 1234 },
        relationships: {
          appClipDefaultExperienceLocalization: {
            data: { type: 'appClipDefaultExperienceLocalizations', id: 'loc-1' },
          },
        },
      },
    });
    expect(() =>
      buildAppClipImageReserveBody({ kind: 'header', fileName: 'a.png', fileSize: 1 }),
    ).toThrow(/defaultExperienceLocalizationId/);
  });

  it('advanced image reserve has no relationships', () => {
    expect(
      buildAppClipImageReserveBody({ kind: 'advanced', fileName: 'card.png', fileSize: 9 }),
    ).toEqual({
      data: {
        type: 'appClipAdvancedExperienceImages',
        attributes: { fileName: 'card.png', fileSize: 9 },
      },
    });
    expect(() =>
      buildAppClipImageReserveBody({
        kind: 'advanced',
        fileName: 'a.png',
        fileSize: 1,
        defaultExperienceLocalizationId: 'loc-1',
      }),
    ).toThrow(/no parent/);
  });

  it('commit uses sourceFileChecksum + uploaded (wire key `uploaded`, not isUploaded)', () => {
    expect(
      buildAppClipImageCommitBody({
        kind: 'header',
        id: 'img-1',
        sourceFileChecksum: 'abc123',
        uploaded: true,
      }),
    ).toEqual({
      data: {
        type: 'appClipHeaderImages',
        id: 'img-1',
        attributes: { sourceFileChecksum: 'abc123', uploaded: true },
      },
    });
    expect(buildAppClipImageCommitBody({ kind: 'advanced', id: 'img-2', uploaded: true })).toEqual({
      data: {
        type: 'appClipAdvancedExperienceImages',
        id: 'img-2',
        attributes: { uploaded: true },
      },
    });
    expect(() => buildAppClipImageCommitBody({ kind: 'header', id: 'x' })).toThrow();
  });
});

describe('advanced experiences', () => {
  const base = {
    appClipId: 'clip-1',
    link: 'https://example.com/table/7',
    isPoweredBy: true,
    defaultLanguage: 'EN' as const,
    headerImageId: 'img-1',
    localizations: [
      { language: 'EN' as const, title: 'Order', subtitle: 'Table 7' },
      { language: 'DE' as const, title: 'Bestellen' },
    ],
  };

  it('create inlines localizations with temp ids and links the image', () => {
    const body = buildAdvancedExperienceCreateBody(base);
    expect(body.data).toEqual({
      type: 'appClipAdvancedExperiences',
      attributes: {
        link: 'https://example.com/table/7',
        isPoweredBy: true,
        defaultLanguage: 'EN',
      },
      relationships: {
        appClip: { data: { type: 'appClips', id: 'clip-1' } },
        headerImage: { data: { type: 'appClipAdvancedExperienceImages', id: 'img-1' } },
        localizations: {
          data: [
            { type: 'appClipAdvancedExperienceLocalizations', id: T1 },
            { type: 'appClipAdvancedExperienceLocalizations', id: T2 },
          ],
        },
      },
    });
    expect(body.included).toEqual([
      {
        type: 'appClipAdvancedExperienceLocalizations',
        id: T1,
        attributes: { language: 'EN', title: 'Order', subtitle: 'Table 7' },
      },
      {
        type: 'appClipAdvancedExperienceLocalizations',
        id: T2,
        attributes: { language: 'DE', title: 'Bestellen' },
      },
    ]);
  });

  it('create carries optional action, category and place', () => {
    const body = buildAdvancedExperienceCreateBody({
      ...base,
      action: 'VIEW',
      businessCategory: 'FOOD_AND_DRINK',
      place: { names: ['Cafe'], mapAction: 'RESTAURANT_ORDER_FOOD', relationship: 'OWNER' },
    });
    expect(body.data.attributes).toMatchObject({
      action: 'VIEW',
      businessCategory: 'FOOD_AND_DRINK',
      place: { names: ['Cafe'], mapAction: 'RESTAURANT_ORDER_FOOD', relationship: 'OWNER' },
    });
  });

  it('create refuses an empty localization list', () => {
    expect(() => buildAdvancedExperienceCreateBody({ ...base, localizations: [] })).toThrow();
  });

  it('patch with attributes only has no relationships or included', () => {
    expect(buildAdvancedExperiencePatchBody({ id: 'adv-1', removed: true })).toEqual({
      data: { type: 'appClipAdvancedExperiences', id: 'adv-1', attributes: { removed: true } },
    });
  });

  it('patch replacing localizations inlines them again', () => {
    const body = buildAdvancedExperiencePatchBody({
      id: 'adv-1',
      headerImageId: 'img-9',
      localizations: [{ language: 'FR', title: 'Commander' }],
    });
    expect(body).toEqual({
      data: {
        type: 'appClipAdvancedExperiences',
        id: 'adv-1',
        relationships: {
          headerImage: { data: { type: 'appClipAdvancedExperienceImages', id: 'img-9' } },
          localizations: { data: [{ type: 'appClipAdvancedExperienceLocalizations', id: T1 }] },
        },
      },
      included: [
        {
          type: 'appClipAdvancedExperienceLocalizations',
          id: T1,
          attributes: { language: 'FR', title: 'Commander' },
        },
      ],
    });
    expect(() => buildAdvancedExperiencePatchBody({ id: 'adv-1' })).toThrow(/Nothing to update/);
  });
});

describe('beta App Clip invocations', () => {
  it('create links the build bundle and inlines localizations', () => {
    expect(
      buildBetaInvocationCreateBody({
        buildBundleId: 'bb-1',
        url: 'https://example.com/try',
        localizations: [{ locale: 'en-US', title: 'Try it' }],
      }),
    ).toEqual({
      data: {
        type: 'betaAppClipInvocations',
        attributes: { url: 'https://example.com/try' },
        relationships: {
          buildBundle: { data: { type: 'buildBundles', id: 'bb-1' } },
          betaAppClipInvocationLocalizations: {
            data: [{ type: 'betaAppClipInvocationLocalizations', id: T1 }],
          },
        },
      },
      included: [
        {
          type: 'betaAppClipInvocationLocalizations',
          id: T1,
          attributes: { locale: 'en-US', title: 'Try it' },
        },
      ],
    });
  });

  it('patch + localization bodies', () => {
    expect(buildBetaInvocationPatchBody('inv-1', 'https://example.com/b')).toEqual({
      data: {
        type: 'betaAppClipInvocations',
        id: 'inv-1',
        attributes: { url: 'https://example.com/b' },
      },
    });
    expect(
      buildBetaInvocationLocalizationCreateBody({
        invocationId: 'inv-1',
        locale: 'ja',
        title: 'T',
      }),
    ).toEqual({
      data: {
        type: 'betaAppClipInvocationLocalizations',
        attributes: { locale: 'ja', title: 'T' },
        relationships: {
          betaAppClipInvocation: { data: { type: 'betaAppClipInvocations', id: 'inv-1' } },
        },
      },
    });
    expect(buildBetaInvocationLocalizationPatchBody('l-1', 'New')).toEqual({
      data: { type: 'betaAppClipInvocationLocalizations', id: 'l-1', attributes: { title: 'New' } },
    });
  });
});

function pages(data: CollectedPages['data'], included: CollectedPages['included'] = []) {
  return { data, included, pagesFetched: 1, truncated: false } satisfies CollectedPages;
}

describe('digests', () => {
  it('empty lists say so', () => {
    expect(digestAppClips(pages([]))).toBe('0 App Clips');
  });

  it('App Clips show bundle id and experience count', () => {
    const out = digestAppClips(
      pages([
        {
          type: 'appClips',
          id: 'clip-1',
          attributes: { bundleId: 'com.example.app.Clip' },
          relationships: {
            appClipDefaultExperiences: {
              data: [
                { type: 'appClipDefaultExperiences', id: 'e1' },
                { type: 'appClipDefaultExperiences', id: 'e2' },
              ],
            },
          },
        },
      ]),
    );
    expect(out).toContain('com.example.app.Clip');
    expect(out).toMatch(/clip-1/);
    expect(out).toMatch(/\s2\s/);
  });

  it('default experiences resolve the release version string', () => {
    const out = digestDefaultExperiences(
      pages(
        [
          {
            type: 'appClipDefaultExperiences',
            id: 'exp-1',
            attributes: { action: 'OPEN' },
            relationships: {
              releaseWithAppStoreVersion: { data: { type: 'appStoreVersions', id: 'ver-1' } },
            },
          },
        ],
        [{ type: 'appStoreVersions', id: 'ver-1', attributes: { versionString: '2.1' } }],
      ),
    );
    expect(out).toContain('2.1 (ver-1)');
  });

  it('localizations show the header image state', () => {
    const out = digestDefaultExperienceLocalizations(
      pages(
        [
          {
            type: 'appClipDefaultExperienceLocalizations',
            id: 'loc-1',
            attributes: { locale: 'en-US', subtitle: 'Order ahead' },
            relationships: {
              appClipHeaderImage: { data: { type: 'appClipHeaderImages', id: 'h1' } },
            },
          },
        ],
        [
          {
            type: 'appClipHeaderImages',
            id: 'h1',
            attributes: { assetDeliveryState: { state: 'COMPLETE' } },
          },
        ],
      ),
    );
    expect(out).toContain('h1 COMPLETE');
  });

  it('advanced experiences list link and status', () => {
    const out = digestAdvancedExperiences(
      pages([
        {
          type: 'appClipAdvancedExperiences',
          id: 'adv-1',
          attributes: { link: 'https://example.com/x', status: 'RECEIVED', placeStatus: 'MATCHED' },
        },
      ]),
    );
    expect(out).toContain('https://example.com/x');
    expect(out).toContain('MATCHED');
  });
});
