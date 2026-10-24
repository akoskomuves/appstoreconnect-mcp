#!/usr/bin/env tsx
// Live smoke for the Game Center play surfaces: activities, challenges,
// Game Center app versions and matchmaking (App Store Connect API 4.5.1).
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     SMOKE_APP_ID=<app id> npx tsx scripts/smoke-game-center-play.ts
//
// Without SMOKE_APP_ID it walks the account's apps and uses the first one
// with Game Center turned on.
//
// READS AND DRY RUNS ONLY. Activities, challenges and app-version switches are
// player-facing, and matchmaking queues serve live games, so nothing here
// POSTs, PATCHes or DELETEs. The write bodies are built against discovered
// IDs and printed, never sent. An account with no Game Center games gets
// empty lists — that still proves the paths and the query strings.

import { execFileSync } from 'node:child_process';
import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  buildGameCenterPlayLocalizationCreateBody,
  buildMatchmakingRuleSetTestBody,
  buildMetricsQuery,
  digestGameCenterMetrics,
  digestGameCenterRows,
  QUEUE_METRICS,
  RULE_METRICS,
} from '../src/domains/game-center-play.js';
import { ascErrorText } from '../src/errors.js';
import { type JSONAPIResource, paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());

function section(label: string): void {
  console.log(`\n=== ${label} ===`);
}

function clip(text: string, lines = 20): string {
  const all = text.split('\n');
  return all.length <= lines
    ? text
    : `${all.slice(0, lines).join('\n')}\n… (${all.length - lines} more lines)`;
}

interface ListDoc {
  data?: JSONAPIResource[];
}
interface SingleDoc {
  data?: JSONAPIResource | null;
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

async function list(path: string, max = 50): Promise<JSONAPIResource[]> {
  const sep = path.includes('?') ? '&' : '?';
  const pages = await paginate(client, `${path}${sep}limit=200`, max);
  return pages.data;
}

function rows(data: JSONAPIResource[], fields: string[], noun: string): string {
  return clip(digestGameCenterRows({ data, truncated: false }, fields, noun));
}

async function findDetail(): Promise<{ appId: string; detailId: string } | undefined> {
  const candidates = process.env.SMOKE_APP_ID
    ? [process.env.SMOKE_APP_ID]
    : ((await client.request<ListDoc>('/v1/apps?limit=200&fields[apps]=name')).data ?? []).map(
        (a) => a.id,
      );
  for (const appId of candidates) {
    try {
      const doc = await client.request<SingleDoc>(`/v1/apps/${appId}/gameCenterDetail`);
      if (doc.data?.id) return { appId, detailId: doc.data.id };
    } catch (err) {
      // Apps without Game Center answer 404 here; keep looking.
      const text = ascErrorText(err);
      if (!text.includes('404')) console.log(`  app ${appId}: ${text.slice(0, 160)}`);
    }
  }
  return undefined;
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

  const target = await step('resolve an app with Game Center', async () => {
    const found = await findDetail();
    console.log(
      found
        ? `app ${found.appId} → gameCenterDetail ${found.detailId}`
        : 'no app on this account has Game Center on — per-app reads are skipped',
    );
    return found;
  });

  if (target) {
    const d = target.detailId;
    for (const kind of ['activity', 'challenge'] as const) {
      const plural = kind === 'activity' ? 'Activities' : 'Challenges';
      const fields =
        kind === 'activity'
          ? ['referenceName', 'vendorIdentifier', 'playStyle', 'archived']
          : ['referenceName', 'vendorIdentifier', 'challengeType', 'archived'];
      const items = await step(
        `asc_list_game_center_${kind === 'activity' ? 'activities' : 'challenges'}`,
        async () => {
          const data = await list(`/v1/gameCenterDetails/${d}/gameCenter${plural}`);
          console.log(rows(data, fields, `${kind} rows`));
          return data;
        },
      );
      if (kind === 'challenge') {
        await step('challenges filter[archived]=false', async () => {
          const data = await list(
            `/v1/gameCenterDetails/${d}/gameCenterChallenges?filter[archived]=false`,
          );
          console.log(`[ok] ${data.length} unarchived challenge(s)`);
        });
      }
      const item = items?.[0];
      if (!item) continue;
      const base = kind === 'activity' ? 'gameCenterActivit' : 'gameCenterChallenge';
      const itemPath = kind === 'activity' ? 'gameCenterActivities' : 'gameCenterChallenges';
      await step(`asc_get_game_center_${kind}`, async () => {
        const doc = await client.request<SingleDoc>(`/v1/${itemPath}/${item.id}`);
        console.log(`[ok] ${doc.data?.type} ${doc.data?.id}`);
      });
      const versions = await step(`asc_list_game_center_${kind}_versions`, async () => {
        const data = await list(`/v1/${itemPath}/${item.id}/versions`);
        console.log(rows(data, ['version', 'state'], 'versions'));
        return data;
      });
      const version = versions?.[0];
      if (!version) continue;
      const versionPath = `${base}${kind === 'activity' ? 'yVersions' : 'Versions'}`;
      const locPath = `${base}${kind === 'activity' ? 'yLocalizations' : 'Localizations'}`;
      await step(`asc_get_game_center_${kind}_image (version default image)`, async () => {
        const doc = await client.request<SingleDoc>(
          `/v1/${versionPath}/${version.id}/defaultImage`,
        );
        console.log(`[ok] default image: ${doc.data?.id ?? 'none'}`);
      });
      const locs = await step(`asc_list_game_center_${kind}_localizations`, async () => {
        const data = await list(`/v1/${versionPath}/${version.id}/localizations`);
        console.log(rows(data, ['locale', 'name'], 'localizations'));
        return data;
      });
      const loc = locs?.[0];
      if (loc) {
        await step(`asc_get_game_center_${kind}_localization + image`, async () => {
          await client.request<SingleDoc>(`/v1/${locPath}/${loc.id}`);
          const img = await client.request<SingleDoc>(`/v1/${locPath}/${loc.id}/image`);
          console.log(`[ok] localization ${loc.id}, image ${img.data?.id ?? 'none'}`);
        });
      }
      section(`dry run: asc_post_game_center_${kind}_localization body`);
      console.log(
        JSON.stringify(
          buildGameCenterPlayLocalizationCreateBody({
            kind,
            versionId: version.id,
            locale: 'en-GB',
            name: 'Smoke (not sent)',
          }),
        ),
      );
    }

    const appVersions = await step('asc_list_game_center_app_versions', async () => {
      const data = await list(
        `/v1/gameCenterDetails/${d}/gameCenterAppVersions?include=appStoreVersion`,
      );
      console.log(rows(data, ['enabled'], 'Game Center app versions'));
      return data;
    });
    const av = appVersions?.[0];
    if (av) {
      await step('asc_get_game_center_app_version (+ appStoreVersion)', async () => {
        await client.request<SingleDoc>(
          `/v1/gameCenterAppVersions/${av.id}?include=appStoreVersion`,
        );
        const asv = await client.request<SingleDoc>(
          `/v1/gameCenterAppVersions/${av.id}/appStoreVersion`,
        );
        console.log(`[ok] → appStoreVersion ${asv.data?.id ?? 'none'}`);
      });
      await step('compatibilityVersions', async () => {
        const data = await list(`/v1/gameCenterAppVersions/${av.id}/compatibilityVersions`);
        console.log(`[ok] ${data.length} compatibility version(s)`);
      });
    }
  }

  // ---- Matchmaking is team-wide, not per app ----
  const ruleSets = await step('asc_list_game_center_matchmaking_rule_sets', async () => {
    const data = await list('/v1/gameCenterMatchmakingRuleSets');
    console.log(
      rows(data, ['referenceName', 'ruleLanguageVersion', 'minPlayers', 'maxPlayers'], 'rule sets'),
    );
    return data;
  });
  const queues = await step('asc_list_game_center_matchmaking_queues', async () => {
    const data = await list('/v1/gameCenterMatchmakingQueues');
    console.log(rows(data, ['referenceName'], 'queues'));
    return data;
  });

  const rs = ruleSets?.[0];
  let ruleId: string | undefined;
  if (rs) {
    await step('rule set: get + queues + teams', async () => {
      await client.request<SingleDoc>(`/v1/gameCenterMatchmakingRuleSets/${rs.id}`);
      const q = await list(`/v1/gameCenterMatchmakingRuleSets/${rs.id}/matchmakingQueues`);
      const t = await list(`/v1/gameCenterMatchmakingRuleSets/${rs.id}/teams`);
      console.log(`[ok] ${q.length} queue(s), ${t.length} team(s)`);
    });
    const rules = await step('asc_list_game_center_matchmaking_rules', async () => {
      const data = await list(`/v1/gameCenterMatchmakingRuleSets/${rs.id}/rules`);
      console.log(rows(data, ['referenceName', 'type', 'weight'], 'rules'));
      return data;
    });
    ruleId = rules?.[0]?.id;
    section('dry run: asc_test_game_center_matchmaking_rule_set body');
    console.log(
      JSON.stringify(
        buildMatchmakingRuleSetTestBody(rs.id, [
          {
            requestName: 'a',
            secondsInQueue: 1,
            bundleId: 'com.example.game',
            platform: 'IOS',
            appVersion: '1.0',
          },
        ]),
      ),
    );
  }

  const queue = queues?.[0];
  if (queue) {
    await step('asc_get_game_center_matchmaking_queue', async () => {
      await client.request(
        `/v1/gameCenterMatchmakingQueues/${queue.id}?include=ruleSet,experimentRuleSet`,
      );
      console.log('[ok]');
    });
    for (const metric of Object.keys(QUEUE_METRICS) as Array<keyof typeof QUEUE_METRICS>) {
      await step(`queue metric ${metric}`, async () => {
        const params = buildMetricsQuery(metric, QUEUE_METRICS[metric], { granularity: 'P1D' });
        const doc = await client.request<{ data?: [] }>(
          `/v1/gameCenterMatchmakingQueues/${queue.id}/metrics/${metric}?${params}`,
        );
        console.log(clip(digestGameCenterMetrics(doc, metric), 8));
      });
    }
  }
  if (ruleId) {
    for (const metric of Object.keys(RULE_METRICS) as Array<keyof typeof RULE_METRICS>) {
      await step(`rule metric ${metric}`, async () => {
        const params = buildMetricsQuery(metric, RULE_METRICS[metric], { granularity: 'P1D' });
        const doc = await client.request<{ data?: [] }>(
          `/v1/gameCenterMatchmakingRules/${ruleId}/metrics/${metric}?${params}`,
        );
        console.log(clip(digestGameCenterMetrics(doc, metric), 8));
      });
    }
  }

  section('summary');
  console.log(failures === 0 ? 'all reads OK' : `${failures} step(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(ascErrorText(err));
  process.exit(1);
});
