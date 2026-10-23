#!/usr/bin/env tsx
// Live smoke for the App Asset Library surfaces (App Store Connect API 4.5.1).
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     SMOKE_APP_ID=<app id> npx tsx scripts/smoke-asset-library.ts
//
// Without SMOKE_APP_ID it uses the first app on the account.
//
// READS AND DRY RUNS ONLY. Placements decide what a shipping app's product
// page shows, so nothing here POSTs, PATCHes or DELETEs. The write paths are
// exercised as dry runs: the body builders run against real, discovered IDs
// and the bodies are printed, never sent.
//
// Every ID is discovered, never hardcoded.

import { execFileSync } from 'node:child_process';
import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestAssetLibraryImages,
  digestAssetLibraryPlacements,
  digestAssetLibraryRefData,
  digestAssetLibraryVideos,
} from '../src/digest.js';
import {
  buildAssetLibraryAssetCreateBody,
  buildAssetLibraryAssetPatchBody,
  buildAssetLibraryPlacementCreateBody,
  buildAssetLibraryPlacementOrderingBody,
  buildAssetListQuery,
  buildPlacementListQuery,
  buildRefDataQuery,
} from '../src/domains/asset-library.js';
import { ascErrorText } from '../src/errors.js';
import { type JSONAPIResource, paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());

function section(label: string): void {
  console.log(`\n=== ${label} ===`);
}

function clip(text: string, lines = 25): string {
  const all = text.split('\n');
  return all.length <= lines
    ? text
    : `${all.slice(0, lines).join('\n')}\n… (${all.length - lines} more lines)`;
}

interface ListDoc {
  data?: JSONAPIResource[];
}
interface SingleDoc {
  data?: JSONAPIResource | JSONAPIResource[] | null;
}

let failures = 0;
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  section(label);
  try {
    return await fn();
  } catch (err) {
    failures += 1;
    console.log(`FAILED: ${ascErrorText(err)}`);
    return undefined;
  }
}

async function resolveAppId(): Promise<string> {
  if (process.env.SMOKE_APP_ID) return process.env.SMOKE_APP_ID;
  const any = await client.request<ListDoc>('/v1/apps?limit=1');
  const id = any.data?.[0]?.id;
  if (!id) throw new Error('no apps on this account — cannot smoke');
  return id;
}

async function main(): Promise<void> {
  // This script runs src/ via tsx; a locally registered MCP server runs dist/.
  try {
    execFileSync('node', ['scripts/check-dist-fresh.mjs'], { stdio: 'pipe' });
  } catch (err) {
    const e = err as { stderr?: Buffer };
    console.log(`\n!! ${e.stderr?.toString().trim() ?? 'dist/ is stale'}`);
    console.log('!! This smoke tests src/ and will pass regardless. Build before trusting it.\n');
  }

  const appId = await resolveAppId();
  console.log(`smoke target app: ${appId}`);

  // ---- Library: id should equal the app id ----
  const library = await step('asc_get_app_asset_library', async () => {
    const doc = await client.request<SingleDoc>(`/v1/apps/${appId}/assetLibrary`);
    const lib = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    console.log(
      `library id ${lib?.id} (${lib?.id === appId ? 'equals app id' : 'DIFFERS from app id'})`,
    );
    return lib?.id;
  });
  const libraryId = library ?? appId;

  // ---- Ref data: no limit, filters, one row ----
  await step('asc_get_asset_library_ref_data (iPhone Duo)', async () => {
    const params = buildRefDataQuery({
      sections: ['placementProfileGroups', 'features', 'placementTypes', 'imageSpecs'],
      placementProfileGroups: ['IPHONE_DUO_PROFILE'],
    });
    const doc = await client.request<SingleDoc>(`/v1/appAssetLibraryRefData?${params}`);
    const rows = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
    console.log(`[ok] ${rows.length} row(s)`);
    for (const r of rows) console.log(clip(digestAssetLibraryRefData(r), 60));
  });

  await step('asc_get_asset_library_ref_data (by id, displayClasses only)', async () => {
    const doc = await client.request<SingleDoc>(
      `/v1/appAssetLibraryRefData/1?${buildRefDataQuery({ sections: ['displayClasses'] })}`,
    );
    const row = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (row) console.log(clip(digestAssetLibraryRefData(row)));
  });

  await step('ref data still rejects limit (expect 400)', async () => {
    try {
      await client.request('/v1/appAssetLibraryRefData?limit=1');
      console.log('!! accepted limit — the quirk is gone; the no-limit guard can stay harmlessly');
    } catch (err) {
      console.log(`[ok] rejected as expected: ${ascErrorText(err).slice(0, 200)}`);
    }
  });

  // ---- Images + videos ----
  const images = await step('asc_list_asset_library_images', async () => {
    const params = buildAssetListQuery({
      kind: 'image',
      sort: '-createdDate',
      includePlacements: true,
    });
    const pages = await paginate(client, `/v1/appAssetLibraries/${libraryId}/images?${params}`, 50);
    console.log(clip(digestAssetLibraryImages(pages)));
    return pages.data;
  });

  await step('asc_list_asset_library_images (filter state, hide ARCHIVED)', async () => {
    const params = buildAssetListQuery({
      kind: 'image',
      state: ['COMPLETE', 'PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'APPROVED'],
    });
    const pages = await paginate(client, `/v1/appAssetLibraries/${libraryId}/images?${params}`, 50);
    console.log(clip(digestAssetLibraryImages(pages), 10));
  });

  const videos = await step('asc_list_asset_library_videos', async () => {
    const params = buildAssetListQuery({
      kind: 'video',
      sort: '-createdDate',
      includePlacements: true,
    });
    const pages = await paginate(client, `/v1/appAssetLibraries/${libraryId}/videos?${params}`, 50);
    console.log(clip(digestAssetLibraryVideos(pages)));
    return pages.data;
  });

  const image = images?.[0];
  const video = videos?.[0];
  if (image) {
    await step('asc_get_asset_library_image', async () => {
      const doc = await client.request<SingleDoc>(
        `/v1/appAssetLibraryImages/${image.id}?include=placements&limit[placements]=50`,
      );
      const r = Array.isArray(doc.data) ? doc.data[0] : doc.data;
      console.log(`[ok] ${r?.id} state=${String(r?.attributes?.state)}`);
    });
    await step('asc_list_asset_library_image_placements', async () => {
      const pages = await paginate(
        client,
        `/v1/appAssetLibraryImages/${image.id}/placements?${buildPlacementListQuery({})}`,
        50,
      );
      console.log(clip(digestAssetLibraryPlacements(pages)));
    });
  } else {
    console.log('\n(no library images — image GET/placements paths not exercised)');
  }
  if (video) {
    await step('asc_get_asset_library_video', async () => {
      const doc = await client.request<SingleDoc>(
        `/v1/appAssetLibraryVideos/${video.id}?include=placements&limit[placements]=50`,
      );
      const r = Array.isArray(doc.data) ? doc.data[0] : doc.data;
      console.log(`[ok] ${r?.id} state=${String(r?.attributes?.state)}`);
    });
    await step('asc_list_asset_library_video_placements', async () => {
      const pages = await paginate(
        client,
        `/v1/appAssetLibraryVideos/${video.id}/placements?${buildPlacementListQuery({})}`,
        50,
      );
      console.log(clip(digestAssetLibraryPlacements(pages)));
    });
  } else {
    console.log('\n(no library videos — video GET/placements paths not exercised)');
  }

  // ---- Localization placements (newest version's first localization) ----
  const localizationId = await step('discover a version localization', async () => {
    const versions = await client.request<ListDoc>(
      `/v1/apps/${appId}/appStoreVersions?fields[appStoreVersions]=versionString,appStoreState&limit=1`,
    );
    const v = versions.data?.[0];
    if (!v) return undefined;
    const locs = await client.request<ListDoc>(
      `/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale&limit=1`,
    );
    const loc = locs.data?.[0];
    console.log(
      `version ${String(v.attributes?.versionString)} (${String(v.attributes?.appStoreState)}), localization ${String(loc?.attributes?.locale)} ${loc?.id}`,
    );
    return loc?.id;
  });

  let placements: JSONAPIResource[] = [];
  if (localizationId) {
    placements =
      (await step('asc_list_localization_placements (version localization)', async () => {
        const params = buildPlacementListQuery({ sort: 'placementGroupPosition' });
        const pages = await paginate(
          client,
          `/v1/appStoreVersionLocalizations/${localizationId}/placements?${params}`,
          500,
        );
        console.log(clip(digestAssetLibraryPlacements(pages), 40));
        const states = new Set(pages.data.map((p) => String(p.attributes?.state)));
        console.log(`placement states seen: ${[...states].join(', ') || '(none)'}`);
        return pages.data;
      })) ?? [];

    await step('asc_list_localization_placements (filtered: APP_SCREENSHOT)', async () => {
      const params = buildPlacementListQuery({ placementType: ['APP_SCREENSHOT'] });
      const pages = await paginate(
        client,
        `/v1/appStoreVersionLocalizations/${localizationId}/placements?${params}`,
        500,
      );
      console.log(`[ok] ${pages.data.length} APP_SCREENSHOT placements`);
    });
  }

  const first = placements[0];
  if (first) {
    await step('asc_get_asset_library_placement', async () => {
      const doc = await client.request<SingleDoc>(
        `/v1/appAssetLibraryPlacements/${first.id}?include=image,video`,
      );
      const r = Array.isArray(doc.data) ? doc.data[0] : doc.data;
      console.log(
        `[ok] ${r?.id} ${String(r?.attributes?.placementType)}/${String(r?.attributes?.placementGroup)} state=${String(r?.attributes?.state)}`,
      );
    });
  }

  // ---- Dry runs: bodies built from real IDs, printed, NOT sent ----
  section('DRY RUN — bodies only, nothing is sent');
  const dry = (label: string, body: unknown) =>
    console.log(`\n-- ${label} --\n${JSON.stringify(body, null, 2)}`);
  dry(
    'POST /v1/appAssetLibraryImages',
    buildAssetLibraryAssetCreateBody({
      kind: 'image',
      assetLibraryId: libraryId,
      fileName: 'duo-outer-1.png',
      fileSize: 123456,
      category: 'APP_SCREENSHOTS_AND_PREVIEWS',
    }),
  );
  dry(
    'POST /v1/appAssetLibraryVideos',
    buildAssetLibraryAssetCreateBody({
      kind: 'video',
      assetLibraryId: libraryId,
      fileName: 'preview.mov',
      fileSize: 1234567,
      category: 'APP_SCREENSHOTS_AND_PREVIEWS',
      previewFrameTimeCode: '00:00:05:00',
    }),
  );
  if (image) {
    dry(
      `PATCH /v1/appAssetLibraryImages/${image.id}`,
      buildAssetLibraryAssetPatchBody({ kind: 'image', id: image.id, uploaded: true }),
    );
  }
  if (image && localizationId) {
    dry(
      'POST /v1/appAssetLibraryPlacements',
      buildAssetLibraryPlacementCreateBody({
        placementType: 'APP_SCREENSHOT',
        placementGroup: 'IPHONE_DUO_PROFILE',
        imageId: image.id,
        parentType: 'appStoreVersionLocalizations',
        parentLocalizationId: localizationId,
      }),
    );
  }
  const group = first?.attributes?.placementGroup;
  if (localizationId && typeof group === 'string') {
    const inGroup = placements
      .filter((p) => p.attributes?.placementGroup === group)
      .map((p) => p.id);
    dry(
      'POST /v1/appAssetLibraryPlacementOrderingRequests (reversed)',
      buildAssetLibraryPlacementOrderingBody({
        placementGroup: group,
        orderedPlacementIds: [...inGroup].reverse(),
        parentType: 'appStoreVersionLocalizations',
        parentLocalizationId: localizationId,
      }),
    );
  }

  console.log(failures === 0 ? '\nSMOKE CLEAN' : `\nSMOKE: ${failures} step(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nSmoke test failed:', ascErrorText(err));
  process.exit(1);
});
