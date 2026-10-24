import { describe, expect, it } from 'vitest';
import {
  buildChallengeLeaderboardBody,
  buildGameCenterActivityCreateBody,
  buildGameCenterActivityPatchBody,
  buildGameCenterActivityVersionPatchBody,
  buildGameCenterAppVersionCreateBody,
  buildGameCenterAppVersionPatchBody,
  buildGameCenterChallengeCreateBody,
  buildGameCenterChallengePatchBody,
  buildGameCenterPlayImageCreateBody,
  buildGameCenterPlayImagePatchBody,
  buildGameCenterPlayLocalizationCreateBody,
  buildGameCenterPlayLocalizationPatchBody,
  buildGameCenterPlayVersionCreateBody,
  buildLinkageBody,
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
  digestGameCenterRows,
  QUEUE_METRICS,
  RULE_METRICS,
} from '../src/domains/game-center-play.js';

const tempId = (n: number) => `$${'{'}${n}${'}'}`;

// Pin the wire shape for the Game Center play surfaces (API 4.5.1):
//   activities / challenges → versions → localizations → images
//   Game Center app versions, matchmaking rule sets / rules / teams / queues,
//   rule-set tests and matchmaking metrics.
//
// Contract points driving these assertions:
//   1. An activity or challenge has exactly one owner: gameCenterDetail OR
//      gameCenterGroup.
//   2. Challenges link leaderboards through `leaderboardV2` — the plain
//      `leaderboard` relationship is deprecated.
//   3. Images hang off a localization OR a version (default image); the commit
//      is `uploaded` alone, with no checksum.
//   4. Rule-set tests create requests and player properties inline with `${n}`
//      temp ids.

describe('activities', () => {
  it('creates an activity under a detail with only the set attributes', () => {
    expect(
      buildGameCenterActivityCreateBody({
        gameCenterDetailId: 'GCD-1',
        referenceName: 'Ranked duel',
        vendorIdentifier: 'com.example.duel',
        playStyle: 'SYNCHRONOUS',
        minimumPlayersCount: 2,
        maximumPlayersCount: 4,
        properties: { mode: 'ranked' },
      }),
    ).toEqual({
      data: {
        type: 'gameCenterActivities',
        attributes: {
          referenceName: 'Ranked duel',
          vendorIdentifier: 'com.example.duel',
          playStyle: 'SYNCHRONOUS',
          minimumPlayersCount: 2,
          maximumPlayersCount: 4,
          properties: { mode: 'ranked' },
        },
        relationships: {
          gameCenterDetail: { data: { type: 'gameCenterDetails', id: 'GCD-1' } },
        },
      },
    });
  });

  it('creates an activity under a group', () => {
    const body = buildGameCenterActivityCreateBody({
      gameCenterGroupId: 'GRP-1',
      referenceName: 'r',
      vendorIdentifier: 'v',
    });
    expect(body.data.relationships).toEqual({
      gameCenterGroup: { data: { type: 'gameCenterGroups', id: 'GRP-1' } },
    });
  });

  it('requires exactly one owner', () => {
    expect(() =>
      buildGameCenterActivityCreateBody({ referenceName: 'r', vendorIdentifier: 'v' }),
    ).toThrow(/exactly one/);
    expect(() =>
      buildGameCenterActivityCreateBody({
        gameCenterDetailId: 'a',
        gameCenterGroupId: 'b',
        referenceName: 'r',
        vendorIdentifier: 'v',
      }),
    ).toThrow(/exactly one/);
  });

  it('rejects max players below min', () => {
    expect(() =>
      buildGameCenterActivityPatchBody('A-1', { minimumPlayersCount: 4, maximumPlayersCount: 2 }),
    ).toThrow(/less than minimum/);
  });

  it('patches attributes only and refuses an empty patch', () => {
    expect(buildGameCenterActivityPatchBody('A-1', { archived: true })).toEqual({
      data: { type: 'gameCenterActivities', id: 'A-1', attributes: { archived: true } },
    });
    expect(() => buildGameCenterActivityPatchBody('A-1', {})).toThrow(/Nothing to update/);
  });

  it('links v2 achievements as to-many linkage', () => {
    expect(buildLinkageBody('gameCenterAchievements', ['ACH-1', 'ACH-2'])).toEqual({
      data: [
        { type: 'gameCenterAchievements', id: 'ACH-1' },
        { type: 'gameCenterAchievements', id: 'ACH-2' },
      ],
    });
    expect(() => buildLinkageBody('gameCenterLeaderboards', [])).toThrow();
  });
});

describe('challenges', () => {
  it('creates a challenge with leaderboardV2, never leaderboard', () => {
    const body = buildGameCenterChallengeCreateBody({
      gameCenterDetailId: 'GCD-1',
      referenceName: 'Beat my score',
      vendorIdentifier: 'beat',
      challengeType: 'LEADERBOARD',
      repeatable: true,
      leaderboardId: 'LB-1',
    });
    expect(body).toEqual({
      data: {
        type: 'gameCenterChallenges',
        attributes: {
          referenceName: 'Beat my score',
          vendorIdentifier: 'beat',
          challengeType: 'LEADERBOARD',
          repeatable: true,
        },
        relationships: {
          gameCenterDetail: { data: { type: 'gameCenterDetails', id: 'GCD-1' } },
          leaderboardV2: { data: { type: 'gameCenterLeaderboards', id: 'LB-1' } },
        },
      },
    });
    expect(body.data.relationships).not.toHaveProperty('leaderboard');
  });

  it('patches only the leaderboard without an empty attributes block', () => {
    expect(buildGameCenterChallengePatchBody('C-1', { leaderboardId: 'LB-2' })).toEqual({
      data: {
        type: 'gameCenterChallenges',
        id: 'C-1',
        relationships: {
          leaderboardV2: { data: { type: 'gameCenterLeaderboards', id: 'LB-2' } },
        },
      },
    });
    expect(() => buildGameCenterChallengePatchBody('C-1', {})).toThrow(/Nothing to update/);
  });

  it('sets the leaderboard relationship as to-one linkage', () => {
    expect(buildChallengeLeaderboardBody('LB-3')).toEqual({
      data: { type: 'gameCenterLeaderboards', id: 'LB-3' },
    });
  });
});

describe('versions, localizations, images', () => {
  it('creates versions with the kind-specific parent relationship', () => {
    expect(buildGameCenterPlayVersionCreateBody('activity', 'A-1', 'https://example.com')).toEqual({
      data: {
        type: 'gameCenterActivityVersions',
        attributes: { fallbackUrl: 'https://example.com' },
        relationships: { activity: { data: { type: 'gameCenterActivities', id: 'A-1' } } },
      },
    });
    expect(buildGameCenterPlayVersionCreateBody('challenge', 'C-1')).toEqual({
      data: {
        type: 'gameCenterChallengeVersions',
        relationships: { challenge: { data: { type: 'gameCenterChallenges', id: 'C-1' } } },
      },
    });
    expect(() => buildGameCenterPlayVersionCreateBody('challenge', 'C-1', 'https://x')).toThrow();
  });

  it('clears an activity version fallbackUrl with null', () => {
    expect(buildGameCenterActivityVersionPatchBody('V-1', null)).toEqual({
      data: { type: 'gameCenterActivityVersions', id: 'V-1', attributes: { fallbackUrl: null } },
    });
  });

  it('creates and patches localizations', () => {
    expect(
      buildGameCenterPlayLocalizationCreateBody({
        kind: 'challenge',
        versionId: 'V-1',
        locale: 'en-US',
        name: 'Beat me',
      }),
    ).toEqual({
      data: {
        type: 'gameCenterChallengeLocalizations',
        attributes: { locale: 'en-US', name: 'Beat me' },
        relationships: { version: { data: { type: 'gameCenterChallengeVersions', id: 'V-1' } } },
      },
    });
    expect(
      buildGameCenterPlayLocalizationPatchBody('activity', 'L-1', { description: 'd' }),
    ).toEqual({
      data: {
        type: 'gameCenterActivityLocalizations',
        id: 'L-1',
        attributes: { description: 'd' },
      },
    });
    expect(() => buildGameCenterPlayLocalizationPatchBody('activity', 'L-1', {})).toThrow();
  });

  it('reserves an image on a localization or as a version default image', () => {
    expect(
      buildGameCenterPlayImageCreateBody({
        kind: 'activity',
        fileName: 'a.png',
        fileSize: 10,
        localizationId: 'L-1',
      }),
    ).toEqual({
      data: {
        type: 'gameCenterActivityImages',
        attributes: { fileName: 'a.png', fileSize: 10 },
        relationships: {
          localization: { data: { type: 'gameCenterActivityLocalizations', id: 'L-1' } },
        },
      },
    });
    const v = buildGameCenterPlayImageCreateBody({
      kind: 'challenge',
      fileName: 'c.png',
      fileSize: 10,
      versionId: 'V-1',
    });
    expect(v.data.relationships).toEqual({
      version: { data: { type: 'gameCenterChallengeVersions', id: 'V-1' } },
    });
    expect(() =>
      buildGameCenterPlayImageCreateBody({ kind: 'challenge', fileName: 'c', fileSize: 1 }),
    ).toThrow(/exactly one/);
  });

  it('commits an image with uploaded alone', () => {
    expect(buildGameCenterPlayImagePatchBody('challenge', 'I-1', true)).toEqual({
      data: { type: 'gameCenterChallengeImages', id: 'I-1', attributes: { uploaded: true } },
    });
  });
});

describe('app versions', () => {
  it('creates and toggles a Game Center app version', () => {
    expect(buildGameCenterAppVersionCreateBody('ASV-1')).toEqual({
      data: {
        type: 'gameCenterAppVersions',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'ASV-1' } } },
      },
    });
    expect(buildGameCenterAppVersionPatchBody('GAV-1', false)).toEqual({
      data: { type: 'gameCenterAppVersions', id: 'GAV-1', attributes: { enabled: false } },
    });
  });
});

describe('matchmaking', () => {
  it('builds rule set, team and rule bodies', () => {
    expect(
      buildMatchmakingRuleSetCreateBody({
        referenceName: 'rs',
        ruleLanguageVersion: 1,
        minPlayers: 2,
        maxPlayers: 8,
      }),
    ).toEqual({
      data: {
        type: 'gameCenterMatchmakingRuleSets',
        attributes: { referenceName: 'rs', ruleLanguageVersion: 1, minPlayers: 2, maxPlayers: 8 },
      },
    });
    expect(buildMatchmakingRuleSetPatchBody('RS-1', { maxPlayers: 6 })).toEqual({
      data: { type: 'gameCenterMatchmakingRuleSets', id: 'RS-1', attributes: { maxPlayers: 6 } },
    });
    expect(
      buildMatchmakingTeamCreateBody({
        ruleSetId: 'RS-1',
        referenceName: 'red',
        minPlayers: 1,
        maxPlayers: 4,
      }).data.relationships,
    ).toEqual({ ruleSet: { data: { type: 'gameCenterMatchmakingRuleSets', id: 'RS-1' } } });
    expect(() => buildMatchmakingTeamPatchBody('T-1', {})).toThrow(/Nothing to update/);
    expect(
      buildMatchmakingRuleCreateBody({
        ruleSetId: 'RS-1',
        referenceName: 'skill',
        description: 'close skill',
        type: 'DISTANCE',
        expression: 'requests[0].properties.skill',
        weight: 0.5,
      }).data.attributes,
    ).toEqual({
      referenceName: 'skill',
      description: 'close skill',
      type: 'DISTANCE',
      expression: 'requests[0].properties.skill',
      weight: 0.5,
    });
    expect(buildMatchmakingRulePatchBody('R-1', { weight: 1 }).data.attributes).toEqual({
      weight: 1,
    });
  });

  it('builds queue create and patch bodies', () => {
    expect(
      buildMatchmakingQueueCreateBody({
        referenceName: 'ranked',
        ruleSetId: 'RS-1',
        experimentRuleSetId: 'RS-2',
      }),
    ).toEqual({
      data: {
        type: 'gameCenterMatchmakingQueues',
        attributes: { referenceName: 'ranked' },
        relationships: {
          ruleSet: { data: { type: 'gameCenterMatchmakingRuleSets', id: 'RS-1' } },
          experimentRuleSet: { data: { type: 'gameCenterMatchmakingRuleSets', id: 'RS-2' } },
        },
      },
    });
    expect(buildMatchmakingQueuePatchBody('Q-1', { classicMatchmakingBundleIds: ['a.b'] })).toEqual(
      {
        data: {
          type: 'gameCenterMatchmakingQueues',
          id: 'Q-1',
          attributes: { classicMatchmakingBundleIds: ['a.b'] },
        },
      },
    );
    expect(() => buildMatchmakingQueuePatchBody('Q-1', {})).toThrow(/Nothing to update/);
  });

  it('creates rule-set test requests and players inline with temp ids', () => {
    const body = buildMatchmakingRuleSetTestBody('RS-1', [
      {
        requestName: 'alice',
        secondsInQueue: 5,
        bundleId: 'com.example.game',
        platform: 'IOS',
        appVersion: '1.0',
        locale: 'EN-US',
        players: [{ playerId: 'p1', properties: [{ key: 'skill', value: '10' }] }],
      },
      {
        requestName: 'bob',
        secondsInQueue: 3,
        bundleId: 'com.example.game',
        platform: 'MAC_OS',
        appVersion: '1.0',
      },
    ]);
    expect(body.data).toEqual({
      type: 'gameCenterMatchmakingRuleSetTests',
      relationships: {
        matchmakingRuleSet: { data: { type: 'gameCenterMatchmakingRuleSets', id: 'RS-1' } },
        matchmakingRequests: {
          data: [
            { type: 'gameCenterMatchmakingTestRequests', id: tempId(2) },
            { type: 'gameCenterMatchmakingTestRequests', id: tempId(3) },
          ],
        },
      },
    });
    expect(body.included).toEqual([
      {
        type: 'gameCenterMatchmakingTestPlayerProperties',
        id: tempId(1),
        attributes: { playerId: 'p1', properties: [{ key: 'skill', value: '10' }] },
      },
      {
        type: 'gameCenterMatchmakingTestRequests',
        id: tempId(2),
        attributes: {
          requestName: 'alice',
          secondsInQueue: 5,
          bundleId: 'com.example.game',
          platform: 'IOS',
          appVersion: '1.0',
          locale: 'EN-US',
        },
        relationships: {
          matchmakingPlayerProperties: {
            data: [{ type: 'gameCenterMatchmakingTestPlayerProperties', id: tempId(1) }],
          },
        },
      },
      {
        type: 'gameCenterMatchmakingTestRequests',
        id: tempId(3),
        attributes: {
          requestName: 'bob',
          secondsInQueue: 3,
          bundleId: 'com.example.game',
          platform: 'MAC_OS',
          appVersion: '1.0',
        },
      },
    ]);
    expect(() => buildMatchmakingRuleSetTestBody('RS-1', [])).toThrow();
  });
});

describe('metrics', () => {
  it('builds a metrics query and checks keys against the metric', () => {
    const q = buildMetricsQuery('matchmakingRequests', QUEUE_METRICS.matchmakingRequests, {
      granularity: 'P1D',
      groupBy: ['result'],
      sort: '-p95SecondsInQueue',
      filters: { result: 'MATCHED', gameCenterDetail: undefined },
      limit: 50,
    });
    expect(q.toString()).toBe(
      'granularity=P1D&groupBy=result&filter%5Bresult%5D=MATCHED&sort=-p95SecondsInQueue&limit=50',
    );
    expect(() =>
      buildMetricsQuery('matchmakingSessions', QUEUE_METRICS.matchmakingSessions, {
        granularity: 'P1D',
        groupBy: ['result'],
      }),
    ).toThrow(/cannot group by/);
    expect(() =>
      buildMetricsQuery('matchmakingRuleErrors', RULE_METRICS.matchmakingRuleErrors, {
        granularity: 'PT1H',
        filters: { result: 'true' },
      }),
    ).toThrow(/no filter\[result\]/);
    expect(() =>
      buildMetricsQuery('matchmakingRuleErrors', RULE_METRICS.matchmakingRuleErrors, {
        granularity: 'PT1H',
        sort: 'averageResult',
      }),
    ).toThrow(/cannot sort/);
  });

  it('digests metric series into one row per data point', () => {
    const text = digestGameCenterMetrics(
      {
        data: [
          {
            dimensions: { result: { data: 'MATCHED' } },
            dataPoints: [
              { start: '2026-10-01T00:00:00Z', values: { count: 12, p95SecondsInQueue: 4.5 } },
            ],
          },
        ],
      },
      'matchmakingRequests',
    );
    expect(text).toContain('1 series, 1 data points');
    expect(text).toContain('MATCHED');
    expect(text).toContain('4.5');
    expect(digestGameCenterMetrics({ data: [] }, 'x')).toBe('No x data points.');
  });
});

describe('digestGameCenterRows', () => {
  it('renders id plus the picked attributes', () => {
    const text = digestGameCenterRows(
      {
        data: [{ type: 'gameCenterActivities', id: 'A-1', attributes: { referenceName: 'r' } }],
        truncated: false,
      },
      ['referenceName', 'archived'],
      'activities',
    );
    expect(text).toContain('1 activities');
    expect(text).toMatch(/A-1\s+r\s+-/);
    expect(digestGameCenterRows({ data: [], truncated: false }, [], 'queues')).toBe(
      'No queues found.',
    );
  });
});
