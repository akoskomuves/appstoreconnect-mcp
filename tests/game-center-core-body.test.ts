import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ASCClient } from '../src/client.js';
import {
  buildAchievementCreateBody,
  buildAchievementPatchBody,
  buildDetailPlayerPatchBody,
  buildGameCenterDetailCreateBody,
  buildGameCenterDetailPatchBody,
  buildGameCenterGroupBody,
  buildGameCenterImageCommitBody,
  buildGameCenterImageCreateBody,
  buildGameCenterLocalizationCreateBody,
  buildGameCenterLocalizationPatchBody,
  buildGameCenterVersionCreateBody,
  buildItemListQuery,
  buildLeaderboardCreateBody,
  buildLeaderboardEntrySubmissionBody,
  buildLeaderboardPatchBody,
  buildLeaderboardSetCreateBody,
  buildLeaderboardSetPatchBody,
  buildLinkagesBody,
  buildMemberLocalizationCreateBody,
  buildMemberLocalizationPatchBody,
  buildPlayerAchievementSubmissionBody,
  buildScoreModerationPatchBody,
  diffOrdering,
  digestGameCenterItems,
  digestGameCenterVersions,
  evaluateGameCenterItemDeleteGate,
  evaluateGameCenterVersionEditGate,
  registerGameCenterCore,
} from '../src/domains/game-center-core.js';

// Pin the wire shape of the Game Center core writes (API 4.5.1, v2 paths):
//   1. Create of an achievement / leaderboard / set carries its FIRST VERSION
//      inline: a `${1}` temp-id resource in included[], linked from
//      relationships.versions (the spec marks `versions` required).
//   2. Exactly one owner: gameCenterDetail or gameCenterGroup.
//   3. Version create is relationships-only, keyed by the singular parent
//      (achievement / leaderboard / leaderboardSet).
//   4. Image commit is `uploaded: true` alone (no checksum).
//   5. Score values are strings on the wire (format "number").
//   6. The detail PATCH uses the V2 default-leaderboard relationships; the
//      unsuffixed ones and challengeEnabled are deprecated.

const T1 = `\${1}`;

describe('Game Center detail + group bodies', () => {
  it('creates a detail with only the app relationship (challengeEnabled is deprecated)', () => {
    expect(buildGameCenterDetailCreateBody('123')).toEqual({
      data: {
        type: 'gameCenterDetails',
        relationships: { app: { data: { type: 'apps', id: '123' } } },
      },
    });
  });

  it('patches the detail with V2 default-leaderboard relationships', () => {
    const body = buildGameCenterDetailPatchBody({
      gameCenterDetailId: 'd1',
      gameCenterGroupId: 'g1',
      defaultLeaderboardId: 'lb1',
      defaultGroupLeaderboardId: 'lb2',
    });
    expect(body.data.relationships).toEqual({
      gameCenterGroup: { data: { type: 'gameCenterGroups', id: 'g1' } },
      defaultLeaderboardV2: { data: { type: 'gameCenterLeaderboards', id: 'lb1' } },
      defaultGroupLeaderboardV2: { data: { type: 'gameCenterLeaderboards', id: 'lb2' } },
    });
    expect(body.data.attributes).toBeUndefined();
  });

  it('refuses an empty detail patch', () => {
    expect(() => buildGameCenterDetailPatchBody({ gameCenterDetailId: 'd1' })).toThrow(/Nothing/);
  });

  it('builds group create and rename bodies', () => {
    expect(buildGameCenterGroupBody('Shared')).toEqual({
      data: { type: 'gameCenterGroups', attributes: { referenceName: 'Shared' } },
    });
    expect(buildGameCenterGroupBody('Renamed', 'g1').data.id).toBe('g1');
  });
});

describe('item create bodies', () => {
  it('creates an achievement with an inline first version under a detail', () => {
    const body = buildAchievementCreateBody({
      gameCenterDetailId: 'd1',
      referenceName: 'First win',
      vendorIdentifier: 'first_win',
      points: 10,
      showBeforeEarned: true,
      repeatable: false,
    });
    expect(body).toEqual({
      data: {
        type: 'gameCenterAchievements',
        attributes: {
          referenceName: 'First win',
          vendorIdentifier: 'first_win',
          points: 10,
          showBeforeEarned: true,
          repeatable: false,
        },
        relationships: {
          gameCenterDetail: { data: { type: 'gameCenterDetails', id: 'd1' } },
          versions: { data: [{ type: 'gameCenterAchievementVersions', id: T1 }] },
        },
      },
      included: [{ type: 'gameCenterAchievementVersions', id: T1 }],
    });
  });

  it('uses the group as owner for a shared achievement', () => {
    const body = buildAchievementCreateBody({
      gameCenterGroupId: 'g1',
      referenceName: 'x',
      vendorIdentifier: 'x',
      points: 5,
      showBeforeEarned: false,
      repeatable: true,
      activityProperties: { mode: 'ranked' },
    });
    expect(body.data.relationships?.gameCenterGroup).toEqual({
      data: { type: 'gameCenterGroups', id: 'g1' },
    });
    expect(body.data.relationships?.gameCenterDetail).toBeUndefined();
    expect(body.data.attributes?.activityProperties).toEqual({ mode: 'ranked' });
  });

  it('requires exactly one owner', () => {
    const base = {
      referenceName: 'x',
      vendorIdentifier: 'x',
      points: 5,
      showBeforeEarned: false,
      repeatable: false,
    };
    expect(() => buildAchievementCreateBody(base)).toThrow(/exactly one/);
    expect(() =>
      buildAchievementCreateBody({ ...base, gameCenterDetailId: 'd', gameCenterGroupId: 'g' }),
    ).toThrow(/exactly one/);
  });

  it('creates a recurring leaderboard with string score range and set links', () => {
    const body = buildLeaderboardCreateBody({
      gameCenterDetailId: 'd1',
      referenceName: 'Weekly',
      vendorIdentifier: 'weekly',
      defaultFormatter: 'INTEGER',
      submissionType: 'BEST_SCORE',
      scoreSortType: 'DESC',
      scoreRangeStart: 0,
      scoreRangeEnd: '1000000',
      recurrenceStartDate: '2026-11-02T00:00:00Z',
      recurrenceDuration: 'P7D',
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1',
      leaderboardSetIds: ['s1'],
    });
    expect(body.data.attributes).toMatchObject({
      scoreRangeStart: '0',
      scoreRangeEnd: '1000000',
      recurrenceDuration: 'P7D',
    });
    expect(body.data.relationships?.gameCenterLeaderboardSets).toEqual({
      data: [{ type: 'gameCenterLeaderboardSets', id: 's1' }],
    });
    expect(body.included).toEqual([{ type: 'gameCenterLeaderboardVersions', id: T1 }]);
  });

  it('refuses a partial recurrence and an inverted score range', () => {
    const base = {
      gameCenterDetailId: 'd1',
      referenceName: 'x',
      vendorIdentifier: 'x',
      defaultFormatter: 'INTEGER' as const,
      submissionType: 'BEST_SCORE' as const,
      scoreSortType: 'DESC' as const,
    };
    expect(() => buildLeaderboardCreateBody({ ...base, recurrenceRule: 'FREQ=DAILY' })).toThrow(
      /all three/,
    );
    expect(() =>
      buildLeaderboardCreateBody({ ...base, scoreRangeStart: 10, scoreRangeEnd: 1 }),
    ).toThrow(/greater/);
  });

  it('creates a leaderboard set seeded with leaderboards', () => {
    const body = buildLeaderboardSetCreateBody({
      gameCenterGroupId: 'g1',
      referenceName: 'Season',
      vendorIdentifier: 'season',
      leaderboardIds: ['a', 'b'],
    });
    expect(body.data.relationships?.gameCenterLeaderboards).toEqual({
      data: [
        { type: 'gameCenterLeaderboards', id: 'a' },
        { type: 'gameCenterLeaderboards', id: 'b' },
      ],
    });
    expect(body.included).toEqual([{ type: 'gameCenterLeaderboardSetVersions', id: T1 }]);
  });
});

describe('item patch bodies', () => {
  it('archives an achievement', () => {
    expect(buildAchievementPatchBody({ achievementId: 'a1', archived: true })).toEqual({
      data: { type: 'gameCenterAchievements', id: 'a1', attributes: { archived: true } },
    });
  });

  it('clears leaderboard recurrence with nulls and stringifies numbers', () => {
    const body = buildLeaderboardPatchBody({
      leaderboardId: 'l1',
      recurrenceRule: null,
      recurrenceDuration: null,
      recurrenceStartDate: null,
      scoreRangeEnd: 50,
    });
    expect(body.data.attributes).toEqual({
      recurrenceRule: null,
      recurrenceDuration: null,
      recurrenceStartDate: null,
      scoreRangeEnd: '50',
    });
  });

  it('refuses empty patches', () => {
    expect(() => buildAchievementPatchBody({ achievementId: 'a1' })).toThrow(/Nothing/);
    expect(() => buildLeaderboardPatchBody({ leaderboardId: 'l1' })).toThrow(/Nothing/);
  });

  it('renames a leaderboard set', () => {
    expect(buildLeaderboardSetPatchBody('s1', 'New')).toEqual({
      data: { type: 'gameCenterLeaderboardSets', id: 's1', attributes: { referenceName: 'New' } },
    });
  });
});

describe('versions, localizations, images', () => {
  it('creates versions keyed by the singular parent', () => {
    expect(buildGameCenterVersionCreateBody('achievement', 'a1')).toEqual({
      data: {
        type: 'gameCenterAchievementVersions',
        relationships: { achievement: { data: { type: 'gameCenterAchievements', id: 'a1' } } },
      },
    });
    expect(buildGameCenterVersionCreateBody('leaderboardSet', 's1').data.relationships).toEqual({
      leaderboardSet: { data: { type: 'gameCenterLeaderboardSets', id: 's1' } },
    });
  });

  it('creates an achievement localization with all three copy fields', () => {
    const body = buildGameCenterLocalizationCreateBody({
      family: 'achievement',
      versionId: 'v1',
      locale: 'en-US',
      name: 'First win',
      beforeEarnedDescription: 'Win a match',
      afterEarnedDescription: 'You won a match',
    });
    expect(body).toEqual({
      data: {
        type: 'gameCenterAchievementLocalizations',
        attributes: {
          locale: 'en-US',
          name: 'First win',
          beforeEarnedDescription: 'Win a match',
          afterEarnedDescription: 'You won a match',
        },
        relationships: {
          version: { data: { type: 'gameCenterAchievementVersions', id: 'v1' } },
        },
      },
    });
  });

  it('requires the achievement descriptions and rejects fields of another family', () => {
    expect(() =>
      buildGameCenterLocalizationCreateBody({
        family: 'achievement',
        versionId: 'v1',
        locale: 'en-US',
        name: 'x',
      }),
    ).toThrow(/beforeEarnedDescription/);
    expect(() =>
      buildGameCenterLocalizationCreateBody({
        family: 'leaderboardSet',
        versionId: 'v1',
        locale: 'en-US',
        name: 'x',
        formatterSuffix: ' pts',
      }),
    ).toThrow(/does not apply/);
  });

  it('patches leaderboard copy, clearing a suffix with null, and refuses locale changes', () => {
    expect(
      buildGameCenterLocalizationPatchBody({
        family: 'leaderboard',
        localizationId: 'loc1',
        formatterSuffix: null,
        description: 'Top scores',
      }),
    ).toEqual({
      data: {
        type: 'gameCenterLeaderboardLocalizations',
        id: 'loc1',
        attributes: { formatterSuffix: null, description: 'Top scores' },
      },
    });
    expect(() =>
      buildGameCenterLocalizationPatchBody({
        family: 'leaderboard',
        localizationId: 'loc1',
        locale: 'de-DE',
        name: 'x',
      }),
    ).toThrow(/immutable/);
  });

  it('reserves and commits an image', () => {
    expect(buildGameCenterImageCreateBody('leaderboard', 'loc1', 'lb.png', 2048)).toEqual({
      data: {
        type: 'gameCenterLeaderboardImages',
        attributes: { fileName: 'lb.png', fileSize: 2048 },
        relationships: {
          localization: { data: { type: 'gameCenterLeaderboardLocalizations', id: 'loc1' } },
        },
      },
    });
    expect(buildGameCenterImageCommitBody('leaderboardSet', 'img1')).toEqual({
      data: { type: 'gameCenterLeaderboardSetImages', id: 'img1', attributes: { uploaded: true } },
    });
  });
});

describe('linkages, member localizations, moderation, submissions', () => {
  it('builds a linkage list and rejects duplicates', () => {
    expect(buildLinkagesBody('gameCenterLeaderboards', ['a', 'b'])).toEqual({
      data: [
        { type: 'gameCenterLeaderboards', id: 'a' },
        { type: 'gameCenterLeaderboards', id: 'b' },
      ],
    });
    expect(() => buildLinkagesBody('gameCenterLeaderboards', ['a', 'a'])).toThrow(/duplicates/);
  });

  it('links a member localization to both the set and the leaderboard', () => {
    const body = buildMemberLocalizationCreateBody({
      leaderboardSetId: 's1',
      leaderboardId: 'l1',
      locale: 'en-US',
      name: 'Daily',
    });
    expect(body.data.relationships).toEqual({
      gameCenterLeaderboardSet: { data: { type: 'gameCenterLeaderboardSets', id: 's1' } },
      gameCenterLeaderboard: { data: { type: 'gameCenterLeaderboards', id: 'l1' } },
    });
    expect(buildMemberLocalizationPatchBody('m1', 'Weekly').data).toEqual({
      type: 'gameCenterLeaderboardSetMemberLocalizations',
      id: 'm1',
      attributes: { name: 'Weekly' },
    });
  });

  it('builds moderation and player patches', () => {
    expect(buildScoreModerationPatchBody('sm1', true)).toEqual({
      data: { type: 'gameCenterScoreModerations', id: 'sm1', attributes: { blocked: true } },
    });
    expect(buildDetailPlayerPatchBody('p1', false)).toEqual({
      data: { type: 'gameCenterDetailPlayers', id: 'p1', attributes: { blocked: false } },
    });
  });

  it('sends scores as strings and omits unset optional fields', () => {
    const body = buildLeaderboardEntrySubmissionBody({
      bundleId: 'com.example.game',
      scopedPlayerId: 'T:1',
      vendorIdentifier: 'weekly',
      score: 4200,
      preReleased: true,
    });
    expect(body).toEqual({
      data: {
        type: 'gameCenterLeaderboardEntrySubmissions',
        attributes: {
          bundleId: 'com.example.game',
          scopedPlayerId: 'T:1',
          vendorIdentifier: 'weekly',
          score: '4200',
          preReleased: true,
        },
      },
    });
    expect(
      buildPlayerAchievementSubmissionBody({
        bundleId: 'com.example.game',
        scopedPlayerId: 'T:1',
        vendorIdentifier: 'first_win',
        percentageAchieved: 100,
      }).data.attributes,
    ).toEqual({
      bundleId: 'com.example.game',
      scopedPlayerId: 'T:1',
      vendorIdentifier: 'first_win',
      percentageAchieved: 100,
    });
  });
});

describe('gates', () => {
  it('allows deleting items whose versions are all editable', () => {
    expect(
      evaluateGameCenterItemDeleteGate('achievement', ['PREPARE_FOR_SUBMISSION', 'REJECTED']).allow,
    ).toBe(true);
    expect(evaluateGameCenterItemDeleteGate('leaderboard', []).allow).toBe(true);
  });

  it('refuses deleting a live item and points at archive (or not, for sets)', () => {
    const lb = evaluateGameCenterItemDeleteGate('leaderboard', ['LIVE', 'PREPARE_FOR_SUBMISSION']);
    expect(lb.allow).toBe(false);
    expect(lb.reason).toMatch(/LIVE/);
    expect(lb.next).toMatch(/archived:true/);
    const set = evaluateGameCenterItemDeleteGate('leaderboardSet', ['IN_REVIEW']);
    expect(set.allow).toBe(false);
    expect(set.next).toMatch(/cannot be archived/);
  });

  it('gates localization / image deletes on the version state', () => {
    expect(evaluateGameCenterVersionEditGate('achievement', 'READY_FOR_REVIEW').allow).toBe(true);
    expect(evaluateGameCenterVersionEditGate('achievement', undefined).allow).toBe(true);
    const g = evaluateGameCenterVersionEditGate('leaderboard', 'WAITING_FOR_REVIEW');
    expect(g.allow).toBe(false);
    expect(g.next).toMatch(/asc_post_game_center_leaderboard_version/);
  });

  it('diffs an ordering against the current list', () => {
    expect(diffOrdering(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual({ missing: [], extra: [] });
    expect(diffOrdering(['a', 'b'], ['b', 'x'])).toEqual({ missing: ['a'], extra: ['x'] });
  });
});

describe('queries + digests', () => {
  it('pins the list fieldset and drops filter[archived] for sets', () => {
    const lb = buildItemListQuery('leaderboard', { archived: false, referenceName: ['A'] });
    expect(lb.get('include')).toBe('versions');
    expect(lb.get('fields[gameCenterLeaderboardVersions]')).toBe('version,state');
    expect(lb.get('filter[archived]')).toBe('false');
    expect(lb.get('filter[referenceName]')).toBe('A');
    expect(
      buildItemListQuery('leaderboardSet', { archived: true }).get('filter[archived]'),
    ).toBeNull();
  });

  it('shows the latest version state per item', () => {
    const text = digestGameCenterItems('achievement', {
      data: [
        {
          type: 'gameCenterAchievements',
          id: 'a1',
          attributes: { vendorIdentifier: 'first_win', referenceName: 'First', points: 10 },
          relationships: {
            versions: {
              data: [
                { type: 'gameCenterAchievementVersions', id: 'v1' },
                { type: 'gameCenterAchievementVersions', id: 'v2' },
              ],
            },
          },
        },
      ],
      included: [
        {
          type: 'gameCenterAchievementVersions',
          id: 'v1',
          attributes: { version: 1, state: 'LIVE' },
        },
        {
          type: 'gameCenterAchievementVersions',
          id: 'v2',
          attributes: { version: 2, state: 'PREPARE_FOR_SUBMISSION' },
        },
      ],
      pagesFetched: 1,
      truncated: false,
    });
    expect(text).toMatch(/1 achievements/);
    expect(text).toMatch(/v2 PREPARE_FOR_SUBMISSION/);
  });

  it('lists version locales', () => {
    const text = digestGameCenterVersions('leaderboard', {
      data: [
        {
          type: 'gameCenterLeaderboardVersions',
          id: 'v1',
          attributes: { version: 1, state: 'LIVE' },
          relationships: {
            localizations: { data: [{ type: 'gameCenterLeaderboardLocalizations', id: 'l1' }] },
          },
        },
      ],
      included: [
        { type: 'gameCenterLeaderboardLocalizations', id: 'l1', attributes: { locale: 'en-US' } },
      ],
      pagesFetched: 1,
      truncated: false,
    });
    expect(text).toMatch(/en-US/);
  });
});

describe('registration', () => {
  type Handler = (input: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;

  function capture() {
    const tools = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _def: unknown, handler: Handler) => {
        if (tools.has(name)) throw new Error(`duplicate tool ${name}`);
        tools.set(name, handler);
      },
    } as unknown as McpServer;
    const calls: Array<{ path: string; method: string }> = [];
    const client = {
      request: async (path: string, init?: { method?: string }) => {
        calls.push({ path, method: init?.method ?? 'GET' });
        if (path.includes('/gameCenterAchievementsV2?')) {
          return {
            data: [
              { type: 'gameCenterAchievements', id: 'a' },
              { type: 'gameCenterAchievements', id: 'b' },
            ],
          };
        }
        if (path.includes('/versions?')) {
          return {
            data: [
              { type: 'gameCenterLeaderboardVersions', id: 'v', attributes: { state: 'LIVE' } },
            ],
          };
        }
        return { data: [] };
      },
    } as unknown as ASCClient;
    registerGameCenterCore(server, client);
    return { tools, calls };
  }

  it('registers every tool once with asc_ names', () => {
    const { tools } = capture();
    expect(tools.size).toBe(81);
    for (const name of tools.keys()) expect(name).toMatch(/^asc_[a-z_]+$/);
    expect(tools.has('asc_upload_game_center_leaderboard_set_image')).toBe(true);
  });

  it('refuses an ordering that would drop an achievement, without PATCHing', async () => {
    const { tools, calls } = capture();
    const res = await tools.get('asc_patch_game_center_achievement_order')?.({
      gameCenterDetailId: 'd1',
      achievementIds: ['b'],
      force: false,
    });
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toMatch(/would be dropped\): a/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('refuses deleting a live leaderboard, without DELETEing', async () => {
    const { tools, calls } = capture();
    const res = await tools.get('asc_delete_game_center_leaderboard')?.({
      leaderboardId: 'l1',
      force: false,
    });
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toMatch(/archived:true/);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('force skips the pre-check', async () => {
    const { tools, calls } = capture();
    await tools.get('asc_delete_game_center_leaderboard')?.({ leaderboardId: 'l1', force: true });
    expect(calls).toEqual([{ path: '/v2/gameCenterLeaderboards/l1', method: 'DELETE' }]);
  });
});
