#!/usr/bin/env tsx
// Opt-in write cycle for Game Center matchmaking: create a throwaway rule set,
// team, rule and queue, run a rule-set test, patch each, read the metrics,
// then delete everything in reverse order.
//
// Usage:
//   SMOKE_GC_MATCHMAKING_WRITES=1 npx tsx scripts/smoke-game-center-matchmaking-cycle.ts
//
// Matchmaking objects are team-level developer config: a queue does nothing
// until a shipped game requests its name, and the names here are random
// smoke-only ones. Everything is deleted at the end, also on failure.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  buildMatchmakingQueueCreateBody,
  buildMatchmakingQueuePatchBody,
  buildMatchmakingRuleCreateBody,
  buildMatchmakingRulePatchBody,
  buildMatchmakingRuleSetCreateBody,
  buildMatchmakingRuleSetPatchBody,
  buildMatchmakingRuleSetTestBody,
  buildMatchmakingTeamCreateBody,
  buildMatchmakingTeamPatchBody,
  buildMetricsQuery,
  digestGameCenterMetrics,
  QUEUE_METRICS,
  RULE_METRICS,
} from '../src/domains/game-center-play.js';
import { ascErrorText } from '../src/errors.js';

if (process.env.SMOKE_GC_MATCHMAKING_WRITES !== '1') {
  console.log('Set SMOKE_GC_MATCHMAKING_WRITES=1 to run this write cycle.');
  process.exit(0);
}

const client = createASCClient(loadConfig());
const tag = `smoke_${Date.now().toString(36)}`;
const cleanup: Array<{ label: string; path: string }> = [];
let failures = 0;

async function call<T>(
  label: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<T | undefined> {
  try {
    const res = await client.request<T>(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    console.log(`[ok] ${label}`);
    return res;
  } catch (err) {
    failures += 1;
    console.log(`FAILED ${label}: ${ascErrorText(err)}`);
    return undefined;
  }
}

type Created = { data?: { id?: string; attributes?: Record<string, unknown> } };

async function create(label: string, path: string, body: unknown): Promise<string | undefined> {
  const res = await call<Created>(label, path, 'POST', body);
  const id = res?.data?.id;
  if (id) cleanup.unshift({ label, path: `${path}/${id}` });
  return id;
}

async function main(): Promise<void> {
  const ruleSetId = await create(
    'POST rule set',
    '/v1/gameCenterMatchmakingRuleSets',
    buildMatchmakingRuleSetCreateBody({
      referenceName: `${tag}_rs`,
      ruleLanguageVersion: 1,
      minPlayers: 2,
      maxPlayers: 4,
    }),
  );
  if (!ruleSetId) return;
  const experimentId = await create(
    'POST experiment rule set',
    '/v1/gameCenterMatchmakingRuleSets',
    buildMatchmakingRuleSetCreateBody({
      referenceName: `${tag}_rsx`,
      ruleLanguageVersion: 1,
      minPlayers: 2,
      maxPlayers: 4,
    }),
  );
  await call(
    'PATCH rule set',
    `/v1/gameCenterMatchmakingRuleSets/${ruleSetId}`,
    'PATCH',
    buildMatchmakingRuleSetPatchBody(ruleSetId, { maxPlayers: 3 }),
  );

  const teamId = await create(
    'POST team',
    '/v1/gameCenterMatchmakingTeams',
    buildMatchmakingTeamCreateBody({
      ruleSetId,
      referenceName: `${tag}_red`,
      minPlayers: 1,
      maxPlayers: 2,
    }),
  );
  if (teamId) {
    await call(
      'PATCH team',
      `/v1/gameCenterMatchmakingTeams/${teamId}`,
      'PATCH',
      buildMatchmakingTeamPatchBody(teamId, { maxPlayers: 3 }),
    );
  }

  const ruleId = await create(
    'POST rule',
    '/v1/gameCenterMatchmakingRules',
    buildMatchmakingRuleCreateBody({
      ruleSetId,
      referenceName: `${tag}_rule`,
      description: 'smoke rule',
      type: 'COMPATIBLE',
      expression: 'requests[0].secondsInQueue >= `0`',
    }),
  );
  if (ruleId) {
    await call(
      'PATCH rule',
      `/v1/gameCenterMatchmakingRules/${ruleId}`,
      'PATCH',
      buildMatchmakingRulePatchBody(ruleId, { description: 'smoke rule (patched)' }),
    );
  }

  const listed = await call<{ data?: unknown[] }>(
    'GET rule set rules / teams',
    `/v1/gameCenterMatchmakingRuleSets/${ruleSetId}/rules?limit=200`,
    'GET',
  );
  console.log(`  rules on rule set: ${listed?.data?.length ?? '?'}`);
  await call('GET teams', `/v1/gameCenterMatchmakingRuleSets/${ruleSetId}/teams`, 'GET');

  const test = await call<{ data?: { attributes?: unknown } }>(
    'POST rule set test',
    '/v1/gameCenterMatchmakingRuleSetTests',
    'POST',
    buildMatchmakingRuleSetTestBody(ruleSetId, [
      {
        requestName: 'alice',
        secondsInQueue: 5,
        bundleId: 'com.example.smoke',
        platform: 'IOS',
        appVersion: '1.0',
        locale: 'EN-US',
        players: [{ playerId: 'p1', properties: [{ key: 'skill', value: '10' }] }],
      },
      {
        requestName: 'bob',
        secondsInQueue: 3,
        bundleId: 'com.example.smoke',
        platform: 'IOS',
        appVersion: '1.0',
        players: [{ playerId: 'p2', properties: [{ key: 'skill', value: '12' }] }],
      },
    ]),
  );
  if (test) console.log(`  test result: ${JSON.stringify(test.data?.attributes).slice(0, 400)}`);

  const queueId = await create(
    'POST queue',
    '/v1/gameCenterMatchmakingQueues',
    buildMatchmakingQueueCreateBody({ referenceName: `${tag}_q`, ruleSetId }),
  );
  if (queueId) {
    if (experimentId) {
      await call(
        'PATCH queue (experiment rule set)',
        `/v1/gameCenterMatchmakingQueues/${queueId}`,
        'PATCH',
        buildMatchmakingQueuePatchBody(queueId, { experimentRuleSetId: experimentId }),
      );
    }
    await call(
      'GET queue',
      `/v1/gameCenterMatchmakingQueues/${queueId}?include=ruleSet,experimentRuleSet`,
      'GET',
    );
    await call(
      'GET rule set queues',
      `/v1/gameCenterMatchmakingRuleSets/${ruleSetId}/matchmakingQueues`,
      'GET',
    );
    for (const metric of Object.keys(QUEUE_METRICS) as Array<keyof typeof QUEUE_METRICS>) {
      const q = buildMetricsQuery(metric, QUEUE_METRICS[metric], { granularity: 'P1D' });
      const doc = await call<{ data?: [] }>(
        `queue metric ${metric}`,
        `/v1/gameCenterMatchmakingQueues/${queueId}/metrics/${metric}?${q}`,
        'GET',
      );
      if (doc) console.log(`  ${digestGameCenterMetrics(doc, metric).split('\n')[0]}`);
    }
  }
  if (ruleId) {
    for (const metric of Object.keys(RULE_METRICS) as Array<keyof typeof RULE_METRICS>) {
      const q = buildMetricsQuery(metric, RULE_METRICS[metric], { granularity: 'P1D' });
      const doc = await call<{ data?: [] }>(
        `rule metric ${metric}`,
        `/v1/gameCenterMatchmakingRules/${ruleId}/metrics/${metric}?${q}`,
        'GET',
      );
      if (doc) console.log(`  ${digestGameCenterMetrics(doc, metric).split('\n')[0]}`);
    }
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error(ascErrorText(err));
  })
  .finally(async () => {
    console.log('\n=== cleanup ===');
    for (const c of cleanup) {
      try {
        await client.request(c.path, { method: 'DELETE' });
        console.log(`[ok] deleted ${c.label} ${c.path}`);
      } catch (err) {
        failures += 1;
        console.log(`!! could not delete ${c.path}: ${ascErrorText(err)}`);
      }
    }
    console.log(failures === 0 ? '\nall steps OK' : `\n${failures} step(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
