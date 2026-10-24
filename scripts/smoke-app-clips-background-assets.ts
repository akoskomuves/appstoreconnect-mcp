#!/usr/bin/env tsx
// Live smoke for the App Clips + Background Assets surfaces (API 4.5.1).
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-app-clips-background-assets.ts
//
// SMOKE_APP_ID=<app id> limits the walk to one app; by default every app on
// the account is checked (App Clips and asset packs are rare, so the walk
// looks for any).
//
// READS AND DRY RUNS ONLY. Default experiences ship with app versions and
// advanced experiences go live per URL, and an asset pack can't be deleted
// once created (only archived), so nothing here POSTs, PATCHes or DELETEs.
// Write bodies are built against discovered IDs and printed, never sent.

import { execFileSync } from 'node:child_process';
import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  buildAppStoreVersionDefaultExperienceLinkage,
  buildDefaultExperienceCreateBody,
  digestAdvancedExperiences,
  digestAppClips,
  digestDefaultExperienceLocalizations,
  digestDefaultExperiences,
} from '../src/domains/app-clips.js';
import {
  buildBackgroundAssetListQuery,
  buildBackgroundAssetVersionCreateBody,
  buildVersionListQuery,
  digestBackgroundAssets,
  digestBackgroundAssetUploadFiles,
  digestBackgroundAssetVersions,
} from '../src/domains/background-assets.js';
import { ascErrorText } from '../src/errors.js';
import { type JSONAPIResource, paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());

interface SingleDoc {
  data?: JSONAPIResource | null;
}

let failures = 0;
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  console.log(`\n=== ${label} ===`);
  try {
    return await fn();
  } catch (err) {
    failures += 1;
    console.log(`FAILED: ${ascErrorText(err)}`);
    return undefined;
  }
}

function relId(r: JSONAPIResource, key: string): string | undefined {
  const d = r.relationships?.[key]?.data;
  return d && !Array.isArray(d) ? d.id : undefined;
}

async function smokeAppClip(clipId: string, firstVersionId: string | undefined): Promise<void> {
  await step(`asc_get_app_clip ${clipId}`, async () => {
    const doc = await client.request<SingleDoc>(
      `/v1/appClips/${clipId}?include=app,appClipDefaultExperiences&fields[apps]=name,bundleId`,
    );
    console.log(`[ok] bundleId ${doc.data?.attributes?.bundleId}`);
  });

  const experiences = await step('asc_list_app_clip_default_experiences', async () => {
    const p = await paginate(
      client,
      `/v1/appClips/${clipId}/appClipDefaultExperiences?include=releaseWithAppStoreVersion&fields[appStoreVersions]=versionString,platform,appVersionState&limit=200`,
      50,
    );
    console.log(digestDefaultExperiences(p));
    return p.data;
  });

  const exp = experiences?.[0];
  if (exp) {
    await step('asc_list_app_clip_default_experience_localizations', async () => {
      const p = await paginate(
        client,
        `/v1/appClipDefaultExperiences/${exp.id}/appClipDefaultExperienceLocalizations?include=appClipHeaderImage&fields[appClipHeaderImages]=fileName,assetDeliveryState&limit=200`,
        50,
      );
      console.log(digestDefaultExperienceLocalizations(p));
      const loc = p.data[0];
      if (loc) {
        const header = await client.request<SingleDoc>(
          `/v1/appClipDefaultExperienceLocalizations/${loc.id}/appClipHeaderImage`,
        );
        console.log(`[ok] header image of ${loc.id}: ${header.data?.id ?? 'none'}`);
      }
    });
    await step('asc_get_app_clip_app_store_review_detail (by experience)', async () => {
      const doc = await client.request<SingleDoc>(
        `/v1/appClipDefaultExperiences/${exp.id}/appClipAppStoreReviewDetail`,
      );
      console.log(
        `[ok] review detail ${doc.data?.id ?? 'none'} urls=${JSON.stringify(doc.data?.attributes?.invocationUrls ?? [])}`,
      );
    });
    await step('asc_get_app_clip_default_experience_release_version', async () => {
      const doc = await client.request<SingleDoc>(
        `/v1/appClipDefaultExperiences/${exp.id}/releaseWithAppStoreVersion?fields[appStoreVersions]=versionString`,
      );
      console.log(`[ok] release version ${doc.data?.id ?? 'none'}`);
    });
  }

  await step('asc_list_app_clip_advanced_experiences', async () => {
    const p = await paginate(
      client,
      `/v1/appClips/${clipId}/appClipAdvancedExperiences?limit=200`,
      50,
    );
    console.log(digestAdvancedExperiences(p));
  });

  console.log('\n--- dry run (not sent) ---');
  console.log(
    JSON.stringify(
      buildDefaultExperienceCreateBody({
        appClipId: clipId,
        action: 'OPEN',
        ...(exp ? { templateDefaultExperienceId: exp.id } : {}),
      }),
    ),
  );
  if (firstVersionId && exp) {
    console.log(JSON.stringify(buildAppStoreVersionDefaultExperienceLinkage(exp.id)));
  }
}

async function smokeBackgroundAsset(asset: JSONAPIResource): Promise<void> {
  const versions = await step(`asc_list_background_asset_versions ${asset.id}`, async () => {
    const p = await paginate(
      client,
      `/v1/backgroundAssets/${asset.id}/versions?${buildVersionListQuery({ sort: '-version' })}`,
      20,
    );
    console.log(digestBackgroundAssetVersions(p));
    return p.data;
  });
  const v = versions?.[0];
  if (v) {
    await step('asc_list_background_asset_upload_files', async () => {
      const p = await paginate(
        client,
        `/v1/backgroundAssetVersions/${v.id}/backgroundAssetUploadFiles?limit=200`,
        20,
      );
      console.log(digestBackgroundAssetUploadFiles(p));
    });
    const tracks = [
      ['internalBetaRelease', 'backgroundAssetVersionInternalBetaReleases'],
      ['externalBetaRelease', 'backgroundAssetVersionExternalBetaReleases'],
      ['appStoreRelease', 'backgroundAssetVersionAppStoreReleases'],
    ] as const;
    for (const [rel, type] of tracks) {
      const id = relId(v, rel);
      if (!id) continue;
      await step(`asc_get_background_asset_version_release ${type}`, async () => {
        const doc = await client.request<SingleDoc>(`/v1/${type}/${id}`);
        console.log(`[ok] ${doc.data?.attributes?.state}`);
      });
    }
  }
  console.log('\n--- dry run (not sent) ---');
  console.log(JSON.stringify(buildBackgroundAssetVersionCreateBody(asset.id)));
}

async function main(): Promise<void> {
  try {
    execFileSync('node', ['scripts/check-dist-fresh.mjs'], { stdio: 'pipe' });
  } catch (err) {
    const e = err as { stderr?: Buffer };
    console.log(`\n!! ${e.stderr?.toString().trim() ?? 'dist/ is stale'}`);
    console.log('!! This smoke tests src/ and will pass regardless. Build before trusting it.\n');
  }

  const appIds = process.env.SMOKE_APP_ID
    ? [process.env.SMOKE_APP_ID]
    : (await paginate(client, '/v1/apps?fields[apps]=bundleId&limit=200', 200)).data.map(
        (a) => a.id,
      );
  console.log(`walking ${appIds.length} app(s)`);

  let clipCount = 0;
  let packCount = 0;
  for (const appId of appIds) {
    const clips = await step(`asc_list_app_clips app=${appId}`, async () => {
      const p = await paginate(
        client,
        `/v1/apps/${appId}/appClips?include=appClipDefaultExperiences&fields[appClipDefaultExperiences]=action&limit[appClipDefaultExperiences]=50&limit=200`,
        50,
      );
      console.log(digestAppClips(p));
      return p.data;
    });
    const packs = await step(`asc_list_background_assets app=${appId}`, async () => {
      const p = await paginate(
        client,
        `/v1/apps/${appId}/backgroundAssets?${buildBackgroundAssetListQuery({})}`,
        50,
      );
      console.log(digestBackgroundAssets(p));
      return p.data;
    });

    const version = await step(
      `asc_get_app_store_version_app_clip_default_experience app=${appId}`,
      async () => {
        const list = await client.request<{ data?: JSONAPIResource[] }>(
          `/v1/apps/${appId}/appStoreVersions?limit=1&fields[appStoreVersions]=versionString`,
        );
        const v = list.data?.[0];
        if (!v) {
          console.log('no versions');
          return undefined;
        }
        const doc = await client.request<SingleDoc>(
          `/v1/appStoreVersions/${v.id}/appClipDefaultExperience`,
        );
        console.log(
          `[ok] version ${v.attributes?.versionString} → default experience ${doc.data?.id ?? 'none (data: null)'}`,
        );
        return v.id;
      },
    );

    for (const clip of clips ?? []) {
      clipCount += 1;
      await smokeAppClip(clip.id, version);
    }
    for (const pack of packs ?? []) {
      packCount += 1;
      await smokeBackgroundAsset(pack);
    }
  }

  console.log(
    `\nDone. ${clipCount} App Clip(s), ${packCount} asset pack(s) found; ${failures} failed step(s).`,
  );
  if (clipCount === 0) console.log('No App Clips on this account: drill-down reads not exercised.');
  if (packCount === 0)
    console.log('No asset packs on this account: drill-down reads not exercised.');
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(ascErrorText(err));
  process.exit(1);
});
