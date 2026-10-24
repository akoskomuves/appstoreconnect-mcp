#!/usr/bin/env tsx
// Live smoke for the Game Center core surfaces (details, groups, achievements,
// leaderboards, leaderboard sets — v2 paths, App Store Connect API 4.5.1).
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-game-center-core.ts
//
// SMOKE_APP_ID=<app id> narrows the detail scan to one app; otherwise every
// app on the account is checked for a Game Center detail.
//
// READS AND DRY RUNS ONLY. Game Center items reach players once their version
// is live, and vendorIdentifiers are never reusable, so nothing here POSTs,
// PATCHes or DELETEs. Write paths run as dry runs: the body builders run
// against real, discovered IDs (or placeholders when the account has no
// Game Center data) and the bodies are printed, never sent.
//
// An account with no Game Center games is a valid smoke: the empty reads are
// the check (paths, fieldsets and includes accepted by Apple).

import { execFileSync } from 'node:child_process';
import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  buildAchievementCreateBody,
  buildGameCenterDetailCreateBody,
  buildGameCenterImageCreateBody,
  buildGameCenterLocalizationCreateBody,
  buildGameCenterVersionCreateBody,
  buildItemListQuery,
  buildLeaderboardCreateBody,
  buildLeaderboardSetCreateBody,
  digestGameCenterGroups,
  digestGameCenterItems,
  digestGameCenterLocalizations,
  digestGameCenterVersions,
  GAME_CENTER_FAMILIES,
  type GameCenterFamily,
} from '../src/domains/game-center-core.js';
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

function dry(label: string, body: unknown): void {
  console.log(`\n--- dry run: ${label} ---\n${JSON.stringify(body, null, 2)}`);
}

interface SingleDoc {
  data?: JSONAPIResource | null;
}

let failures = 0;
// In the 4.5.1 spec but 404 PATH_ERROR live on 2026-10-24: reported, not failed.
async function knownNotLive(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!ascErrorText(err).includes('PATH_ERROR')) throw err;
    console.log('KNOWN: 404 PATH_ERROR — endpoint not switched on by Apple yet');
  }
}
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

async function main(): Promise<void> {
  // This script runs src/ via tsx; a locally registered MCP server runs dist/.
  try {
    execFileSync('node', ['scripts/check-dist-fresh.mjs'], { stdio: 'pipe' });
  } catch (err) {
    const e = err as { stderr?: Buffer };
    console.log(`\n!! ${e.stderr?.toString().trim() ?? 'dist/ is stale'}`);
    console.log('!! This smoke tests src/ and will pass regardless. Build before trusting it.\n');
  }

  // ---- Find apps with a Game Center detail ----
  const appIds = await step('apps to scan', async () => {
    if (process.env.SMOKE_APP_ID) return [process.env.SMOKE_APP_ID];
    const apps = await paginate(client, '/v1/apps?fields[apps]=name&limit=200', 200);
    console.log(`${apps.data.length} app(s) on the account`);
    return apps.data.map((a) => a.id);
  });
  if (!appIds?.length) throw new Error('no apps on this account — cannot smoke');

  const details: Array<{ appId: string; detailId: string }> = [];
  await step('asc_get_app_game_center_detail (every app)', async () => {
    for (const appId of appIds) {
      try {
        const doc = await client.request<SingleDoc>(
          `/v1/apps/${appId}/gameCenterDetail?fields[gameCenterDetails]=arcadeEnabled,app,gameCenterGroup,defaultLeaderboardV2,defaultGroupLeaderboardV2&include=gameCenterGroup`,
        );
        if (doc.data?.id) {
          details.push({ appId, detailId: doc.data.id });
          console.log(`app ${appId}: detail ${doc.data.id}`);
        } else {
          console.log(`app ${appId}: 200 + data:null (no Game Center detail)`);
        }
      } catch (err) {
        const text = ascErrorText(err);
        if (text.includes(' 404 ')) console.log(`app ${appId}: 404 (no Game Center detail)`);
        else throw err;
      }
    }
    console.log(`[ok] ${details.length} app(s) with a Game Center detail`);
  });

  // ---- Groups (account-wide) ----
  const groups = await step('asc_list_game_center_groups', async () => {
    const pages = await paginate(
      client,
      '/v1/gameCenterGroups?fields[gameCenterGroups]=referenceName,gameCenterDetails&include=gameCenterDetails&fields[gameCenterDetails]=app&limit[gameCenterDetails]=50&limit=200',
      200,
    );
    console.log(clip(digestGameCenterGroups(pages)));
    return pages.data;
  });

  const owners: Array<{ label: string; base: string }> = details.map((d) => ({
    label: `detail ${d.detailId} (app ${d.appId})`,
    base: `/v1/gameCenterDetails/${d.detailId}`,
  }));
  for (const g of groups ?? []) {
    owners.push({ label: `group ${g.id}`, base: `/v1/gameCenterGroups/${g.id}` });
  }

  const firstIds: Partial<Record<GameCenterFamily, string>> = {};
  let firstLocalizationId: string | undefined;

  for (const owner of owners) {
    if (owner.base.startsWith('/v1/gameCenterDetails/')) {
      await step(`asc_get_game_center_detail_group — ${owner.label}`, async () => {
        const doc = await client.request<SingleDoc>(
          `${owner.base}/gameCenterGroup?fields[gameCenterGroups]=referenceName,gameCenterDetails`,
        );
        console.log(doc.data ? `in group ${doc.data.id}` : 'not in a group (data:null)');
      });
      await step(`asc_list_game_center_blocked_players — ${owner.label}`, async () => {
        await knownNotLive(async () => {
          const pages = await paginate(client, `${owner.base}/blockedPlayers?limit=200`, 200);
          console.log(`[ok] ${pages.data.length} blocked player(s)`);
        });
      });
    }
    for (const family of ['achievement', 'leaderboard', 'leaderboardSet'] as GameCenterFamily[]) {
      const f = GAME_CENTER_FAMILIES[family];
      await step(`asc_list_game_center_${f.label}s — ${owner.label}`, async () => {
        const params = buildItemListQuery(family, {});
        const pages = await paginate(client, `${owner.base}/${f.ownerRel}?${params}`, 200);
        console.log(clip(digestGameCenterItems(family, pages)));
        const first = pages.data[0];
        if (first && !firstIds[family]) firstIds[family] = first.id;
      });
    }
  }

  // ---- Drill into the first item of each family ----
  for (const family of ['achievement', 'leaderboard', 'leaderboardSet'] as GameCenterFamily[]) {
    const f = GAME_CENTER_FAMILIES[family];
    const id = firstIds[family];
    if (!id) {
      section(`${f.noun}: none on the account — drill skipped`);
      continue;
    }
    await step(`asc_get_game_center_${f.label} ${id}`, async () => {
      const doc = await client.request<SingleDoc>(
        `${f.path}/${id}?include=gameCenterDetail,gameCenterGroup,versions&fields[${f.versionType}]=version,state&limit[versions]=50`,
      );
      console.log(`[ok] ${doc.data?.attributes?.['referenceName'] ?? '(no name)'}`);
    });
    const versionId = await step(`asc_list_game_center_${f.label}_versions ${id}`, async () => {
      const pages = await paginate(
        client,
        `${f.path}/${id}/versions?fields[${f.versionType}]=version,state,localizations&include=localizations&fields[${f.locType}]=locale&limit[localizations]=50&limit=200`,
        200,
      );
      console.log(clip(digestGameCenterVersions(family, pages)));
      return pages.data[0]?.id;
    });
    if (!versionId) continue;
    await step(`asc_get_game_center_${f.label}_version ${versionId}`, async () => {
      await client.request(
        `${f.versionPath}/${versionId}?include=localizations&limit[localizations]=50`,
      );
      console.log('[ok]');
    });
    const locId = await step(
      `asc_list_game_center_${f.label}_localizations ${versionId}`,
      async () => {
        const pages = await paginate(
          client,
          `${f.versionPath}/${versionId}/localizations?include=image&fields[${f.imageType}]=fileName,assetDeliveryState&limit=200`,
          200,
        );
        console.log(clip(digestGameCenterLocalizations(family, pages)));
        return pages.data[0]?.id;
      },
    );
    if (!locId) continue;
    if (!firstLocalizationId) firstLocalizationId = locId;
    await step(`asc_get_game_center_${f.label}_localization ${locId}`, async () => {
      await client.request(`${f.locPath}/${locId}?include=version,image`);
      console.log('[ok]');
    });
    await step(`asc_get_game_center_${f.label}_image (by localization)`, async () => {
      const doc = await client.request<SingleDoc>(`${f.locPath}/${locId}/image`);
      console.log(doc.data ? `image ${doc.data.id}` : 'no image (data:null)');
    });
    if (family === 'leaderboard') {
      await step(`asc_list_game_center_leaderboard_score_moderations ${id}`, async () => {
        await knownNotLive(async () => {
          const pages = await paginate(
            client,
            `/v2/gameCenterLeaderboards/${id}/gameCenterScoreModerations?include=player&limit=50`,
            50,
          );
          console.log(`[ok] ${pages.data.length} entr(y/ies)`);
        });
      });
    }
    if (family === 'leaderboardSet') {
      await step(`asc_list_game_center_leaderboards (members of set ${id})`, async () => {
        const params = buildItemListQuery('leaderboard', {});
        const pages = await paginate(
          client,
          `/v2/gameCenterLeaderboardSets/${id}/gameCenterLeaderboards?${params}`,
          200,
        );
        console.log(clip(digestGameCenterItems('leaderboard', pages)));
      });
    }
  }

  // ---- Dry runs (never sent) ----
  const detailId = details[0]?.detailId ?? '<gameCenterDetailId>';
  dry('POST /v1/gameCenterDetails', buildGameCenterDetailCreateBody(appIds[0] ?? '<appId>'));
  dry(
    'POST /v2/gameCenterAchievements',
    buildAchievementCreateBody({
      gameCenterDetailId: detailId,
      referenceName: 'Smoke achievement',
      vendorIdentifier: 'smoke.achievement',
      points: 10,
      showBeforeEarned: true,
      repeatable: false,
    }),
  );
  dry(
    'POST /v2/gameCenterLeaderboards',
    buildLeaderboardCreateBody({
      gameCenterDetailId: detailId,
      referenceName: 'Smoke leaderboard',
      vendorIdentifier: 'smoke.leaderboard',
      defaultFormatter: 'INTEGER',
      submissionType: 'BEST_SCORE',
      scoreSortType: 'DESC',
    }),
  );
  dry(
    'POST /v2/gameCenterLeaderboardSets',
    buildLeaderboardSetCreateBody({
      gameCenterDetailId: detailId,
      referenceName: 'Smoke set',
      vendorIdentifier: 'smoke.set',
    }),
  );
  dry(
    'POST /v2/gameCenterAchievementVersions',
    buildGameCenterVersionCreateBody('achievement', firstIds.achievement ?? '<achievementId>'),
  );
  dry(
    'POST /v2/gameCenterLeaderboardLocalizations',
    buildGameCenterLocalizationCreateBody({
      family: 'leaderboard',
      versionId: '<leaderboardVersionId>',
      locale: 'en-US',
      name: 'High scores',
      formatterSuffix: ' points',
    }),
  );
  dry(
    'POST /v2/gameCenterAchievementImages',
    buildGameCenterImageCreateBody(
      'achievement',
      firstLocalizationId ?? '<localizationId>',
      'icon.png',
      4096,
    ),
  );

  console.log(failures === 0 ? '\nSMOKE CLEAN' : `\nSMOKE: ${failures} step(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nSmoke test failed:', ascErrorText(err));
  process.exit(1);
});
