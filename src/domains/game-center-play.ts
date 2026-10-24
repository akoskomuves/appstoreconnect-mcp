import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import { type CollectedPages, formatTable, paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AppStoreVersionIdSchema,
  FileNameSchema,
  FileSizeSchema,
  LocaleSchema,
  LocalFilePathSchema,
} from '../schemas.js';
import {
  type AssetReserveResponse,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// Game Center PLAY surfaces (App Store Connect API 4.5.1): activities,
// challenges, matchmaking and the Game Center app-version switch. The core
// surfaces (details, groups, achievements, leaderboards, leaderboard sets,
// score moderation) live in a separate domain file.
//
// Shape of the API:
//
//   * Activities and challenges share one hierarchy:
//       item → versions → localizations → image
//     plus a version-level defaultImage. An item belongs to a gameCenterDetail
//     (one app) OR a gameCenterGroup (shared across apps) — exactly one.
//     Versions go through App Review with the app; a LIVE version is what
//     players see, so edits land on a new PREPARE_FOR_SUBMISSION version.
//
//   * Only non-deprecated paths are used. The *VersionReleases resources and
//     the v1 achievements / leaderboards / leaderboard relationships are
//     deprecated in 4.5.1 in favour of the version resources and the *V2
//     relationships (which point at the v2 achievement / leaderboard ids).
//
//   * Images upload like the App Asset Library: reserve (fileName + fileSize +
//     localization OR version) → PUT each uploadOperation → PATCH
//     uploaded=true. The update request has no sourceFileChecksum.
//
//   * Matchmaking: a rule set holds rules and teams; a queue points at a rule
//     set (plus an optional experiment rule set). Rules and teams have no GET
//     by id — list them through their rule set. A rule-set test runs a set of
//     made-up requests through a rule set and returns the matches, without
//     touching real players; its requests and player properties are created
//     inline in `included[]` with `${n}` temp ids.
//
//   * Rule expressions are JMESPath-based: literals need backticks
//     (requests[0].secondsInQueue >= `0`). A bare number is a 409
//     "Unable to compile expression" (live 2026-10-24).
//
//   * Matchmaking metrics are time series: data[] holds one series per
//     groupBy combination, each with dataPoints[{start, end, values}].

// ----- Kinds shared by activities and challenges -----

type PlayKind = 'activity' | 'challenge';

const PLAY = {
  activity: {
    label: 'activity',
    plural: 'activities',
    itemType: 'gameCenterActivities',
    itemPath: '/v1/gameCenterActivities',
    versionType: 'gameCenterActivityVersions',
    versionPath: '/v1/gameCenterActivityVersions',
    versionParentRel: 'activity',
    localizationType: 'gameCenterActivityLocalizations',
    localizationPath: '/v1/gameCenterActivityLocalizations',
    imageType: 'gameCenterActivityImages',
    imagePath: '/v1/gameCenterActivityImages',
    childPath: 'gameCenterActivities',
  },
  challenge: {
    label: 'challenge',
    plural: 'challenges',
    itemType: 'gameCenterChallenges',
    itemPath: '/v1/gameCenterChallenges',
    versionType: 'gameCenterChallengeVersions',
    versionPath: '/v1/gameCenterChallengeVersions',
    versionParentRel: 'challenge',
    localizationType: 'gameCenterChallengeLocalizations',
    localizationPath: '/v1/gameCenterChallengeLocalizations',
    imageType: 'gameCenterChallengeImages',
    imagePath: '/v1/gameCenterChallengeImages',
    childPath: 'gameCenterChallenges',
  },
} as const;

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
  included?: Array<Record<string, unknown>>;
}

function rel(type: string, id: string) {
  return { data: { type, id } };
}

function tempId(n: number): string {
  // Apple's JSON:API temp-ID convention for unsaved resources: literal `${N}`
  // strings on the wire. Built via concatenation so biome's
  // noTemplateCurlyInString rule doesn't false-flag it.
  return `\${${n}}`;
}

// Copy only the keys the caller set. `null` is kept: several Game Center
// attributes are nullable, and null is how a value is cleared.
function pick(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function requireChanges(attributes: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(attributes).length === 0) {
    throw new Error(`Nothing to update: pass at least one of ${keys.join(', ')}`);
  }
}

// An activity or challenge belongs to a detail (one app) or a group (shared
// across apps). Exactly one.
interface OwnerInput {
  gameCenterDetailId?: string | undefined;
  gameCenterGroupId?: string | undefined;
}

function ownerRelationship(input: OwnerInput): Record<string, unknown> {
  const hasDetail = input.gameCenterDetailId !== undefined;
  const hasGroup = input.gameCenterGroupId !== undefined;
  if (hasDetail === hasGroup) {
    throw new Error('Pass exactly one of gameCenterDetailId or gameCenterGroupId');
  }
  return hasDetail
    ? { gameCenterDetail: rel('gameCenterDetails', input.gameCenterDetailId as string) }
    : { gameCenterGroup: rel('gameCenterGroups', input.gameCenterGroupId as string) };
}

// ----- Body builders: activities -----

export type ActivityPlayStyle = 'ASYNCHRONOUS' | 'SYNCHRONOUS';

export interface GameCenterActivityCreateInput extends OwnerInput {
  referenceName: string;
  vendorIdentifier: string;
  playStyle?: ActivityPlayStyle | undefined;
  minimumPlayersCount?: number | undefined;
  maximumPlayersCount?: number | undefined;
  supportsPartyCode?: boolean | undefined;
  properties?: Record<string, string> | undefined;
}

const ACTIVITY_CREATE_KEYS = [
  'referenceName',
  'vendorIdentifier',
  'playStyle',
  'minimumPlayersCount',
  'maximumPlayersCount',
  'supportsPartyCode',
  'properties',
] as const;

export function buildGameCenterActivityCreateBody(
  input: GameCenterActivityCreateInput,
): JSONAPIBody {
  checkPlayerRange(input.minimumPlayersCount, input.maximumPlayersCount);
  return {
    data: {
      type: 'gameCenterActivities',
      attributes: pick({ ...input }, ACTIVITY_CREATE_KEYS),
      relationships: ownerRelationship(input),
    },
  };
}

export interface GameCenterActivityPatchInput {
  referenceName?: string | undefined;
  playStyle?: ActivityPlayStyle | undefined;
  minimumPlayersCount?: number | undefined;
  maximumPlayersCount?: number | undefined;
  supportsPartyCode?: boolean | undefined;
  archived?: boolean | undefined;
  properties?: Record<string, string> | undefined;
}

const ACTIVITY_PATCH_KEYS = [
  'referenceName',
  'playStyle',
  'minimumPlayersCount',
  'maximumPlayersCount',
  'supportsPartyCode',
  'archived',
  'properties',
] as const;

export function buildGameCenterActivityPatchBody(
  id: string,
  input: GameCenterActivityPatchInput,
): JSONAPIBody {
  checkPlayerRange(input.minimumPlayersCount, input.maximumPlayersCount);
  const attributes = pick({ ...input }, ACTIVITY_PATCH_KEYS);
  requireChanges(attributes, ACTIVITY_PATCH_KEYS);
  return { data: { type: 'gameCenterActivities', id, attributes } };
}

function checkPlayerRange(min: number | undefined, max: number | undefined): void {
  if (min !== undefined && max !== undefined && max < min) {
    throw new Error(`maximum players (${max}) is less than minimum (${min})`);
  }
}

// ----- Body builders: challenges -----

export interface GameCenterChallengeCreateInput extends OwnerInput {
  referenceName: string;
  vendorIdentifier: string;
  challengeType: 'LEADERBOARD';
  repeatable?: boolean | undefined;
  leaderboardId?: string | undefined;
}

export function buildGameCenterChallengeCreateBody(
  input: GameCenterChallengeCreateInput,
): JSONAPIBody {
  const relationships = ownerRelationship(input);
  // leaderboardV2, never the deprecated `leaderboard` relationship.
  if (input.leaderboardId !== undefined) {
    relationships.leaderboardV2 = rel('gameCenterLeaderboards', input.leaderboardId);
  }
  return {
    data: {
      type: 'gameCenterChallenges',
      attributes: pick({ ...input }, [
        'referenceName',
        'vendorIdentifier',
        'challengeType',
        'repeatable',
      ]),
      relationships,
    },
  };
}

export interface GameCenterChallengePatchInput {
  referenceName?: string | undefined;
  archived?: boolean | undefined;
  repeatable?: boolean | undefined;
  leaderboardId?: string | undefined;
}

const CHALLENGE_PATCH_KEYS = ['referenceName', 'archived', 'repeatable'] as const;

export function buildGameCenterChallengePatchBody(
  id: string,
  input: GameCenterChallengePatchInput,
): JSONAPIBody {
  const attributes = pick({ ...input }, CHALLENGE_PATCH_KEYS);
  if (input.leaderboardId === undefined) {
    requireChanges(attributes, [...CHALLENGE_PATCH_KEYS, 'leaderboardId']);
  }
  const body: JSONAPIBody = { data: { type: 'gameCenterChallenges', id } };
  if (Object.keys(attributes).length > 0) body.data.attributes = attributes;
  if (input.leaderboardId !== undefined) {
    body.data.relationships = {
      leaderboardV2: rel('gameCenterLeaderboards', input.leaderboardId),
    };
  }
  return body;
}

export function buildChallengeLeaderboardBody(leaderboardId: string) {
  return rel('gameCenterLeaderboards', leaderboardId);
}

// To-many relationship linkage (POST adds, DELETE removes).
export function buildLinkageBody(type: string, ids: string[]) {
  if (ids.length === 0) throw new Error('Pass at least one id');
  return { data: ids.map((id) => ({ type, id })) };
}

// ----- Body builders: versions, localizations, images (both kinds) -----

export function buildGameCenterPlayVersionCreateBody(
  kind: PlayKind,
  parentId: string,
  fallbackUrl?: string | undefined,
): JSONAPIBody {
  const k = PLAY[kind];
  if (kind === 'challenge' && fallbackUrl !== undefined) {
    throw new Error('fallbackUrl applies to activity versions only');
  }
  const body: JSONAPIBody = {
    data: {
      type: k.versionType,
      relationships: { [k.versionParentRel]: rel(k.itemType, parentId) },
    },
  };
  if (fallbackUrl !== undefined) body.data.attributes = { fallbackUrl };
  return body;
}

export function buildGameCenterActivityVersionPatchBody(
  id: string,
  fallbackUrl: string | null,
): JSONAPIBody {
  return { data: { type: 'gameCenterActivityVersions', id, attributes: { fallbackUrl } } };
}

export interface GameCenterPlayLocalizationCreateInput {
  kind: PlayKind;
  versionId: string;
  locale: string;
  name: string;
  description?: string | undefined;
}

export function buildGameCenterPlayLocalizationCreateBody(
  input: GameCenterPlayLocalizationCreateInput,
): JSONAPIBody {
  const k = PLAY[input.kind];
  return {
    data: {
      type: k.localizationType,
      attributes: pick({ ...input }, ['locale', 'name', 'description']),
      relationships: { version: rel(k.versionType, input.versionId) },
    },
  };
}

export function buildGameCenterPlayLocalizationPatchBody(
  kind: PlayKind,
  id: string,
  changes: { name?: string | undefined; description?: string | undefined },
): JSONAPIBody {
  const attributes = pick({ ...changes }, ['name', 'description']);
  requireChanges(attributes, ['name', 'description']);
  return { data: { type: PLAY[kind].localizationType, id, attributes } };
}

export interface GameCenterPlayImageCreateInput {
  kind: PlayKind;
  fileName: string;
  fileSize: number;
  localizationId?: string | undefined;
  versionId?: string | undefined;
}

// An image hangs off a localization (its per-language image) or a version
// (the defaultImage). Exactly one.
export function buildGameCenterPlayImageCreateBody(
  input: GameCenterPlayImageCreateInput,
): JSONAPIBody {
  const k = PLAY[input.kind];
  const hasLoc = input.localizationId !== undefined;
  const hasVersion = input.versionId !== undefined;
  if (hasLoc === hasVersion) {
    throw new Error('Pass exactly one of localizationId or versionId');
  }
  return {
    data: {
      type: k.imageType,
      attributes: { fileName: input.fileName, fileSize: input.fileSize },
      relationships: hasLoc
        ? { localization: rel(k.localizationType, input.localizationId as string) }
        : { version: rel(k.versionType, input.versionId as string) },
    },
  };
}

export function buildGameCenterPlayImagePatchBody(
  kind: PlayKind,
  id: string,
  uploaded: boolean,
): JSONAPIBody {
  // No sourceFileChecksum: the image update request takes `uploaded` alone.
  return { data: { type: PLAY[kind].imageType, id, attributes: { uploaded } } };
}

// ----- Body builders: app versions -----

export function buildGameCenterAppVersionCreateBody(appStoreVersionId: string): JSONAPIBody {
  return {
    data: {
      type: 'gameCenterAppVersions',
      relationships: { appStoreVersion: rel('appStoreVersions', appStoreVersionId) },
    },
  };
}

export function buildGameCenterAppVersionPatchBody(id: string, enabled: boolean): JSONAPIBody {
  return { data: { type: 'gameCenterAppVersions', id, attributes: { enabled } } };
}

// ----- Body builders: matchmaking -----

export interface MatchmakingRuleSetCreateInput {
  referenceName: string;
  ruleLanguageVersion: number;
  minPlayers: number;
  maxPlayers: number;
}

export function buildMatchmakingRuleSetCreateBody(
  input: MatchmakingRuleSetCreateInput,
): JSONAPIBody {
  checkPlayerRange(input.minPlayers, input.maxPlayers);
  return {
    data: {
      type: 'gameCenterMatchmakingRuleSets',
      attributes: pick({ ...input }, [
        'referenceName',
        'ruleLanguageVersion',
        'minPlayers',
        'maxPlayers',
      ]),
    },
  };
}

export interface MatchmakingPlayerRangePatch {
  minPlayers?: number | undefined;
  maxPlayers?: number | undefined;
}

function playerRangePatch(type: string, id: string, input: MatchmakingPlayerRangePatch) {
  checkPlayerRange(input.minPlayers, input.maxPlayers);
  const attributes = pick({ ...input }, ['minPlayers', 'maxPlayers']);
  requireChanges(attributes, ['minPlayers', 'maxPlayers']);
  return { data: { type, id, attributes } };
}

export function buildMatchmakingRuleSetPatchBody(
  id: string,
  input: MatchmakingPlayerRangePatch,
): JSONAPIBody {
  return playerRangePatch('gameCenterMatchmakingRuleSets', id, input);
}

export interface MatchmakingTeamCreateInput {
  ruleSetId: string;
  referenceName: string;
  minPlayers: number;
  maxPlayers: number;
}

export function buildMatchmakingTeamCreateBody(input: MatchmakingTeamCreateInput): JSONAPIBody {
  checkPlayerRange(input.minPlayers, input.maxPlayers);
  return {
    data: {
      type: 'gameCenterMatchmakingTeams',
      attributes: pick({ ...input }, ['referenceName', 'minPlayers', 'maxPlayers']),
      relationships: { ruleSet: rel('gameCenterMatchmakingRuleSets', input.ruleSetId) },
    },
  };
}

export function buildMatchmakingTeamPatchBody(
  id: string,
  input: MatchmakingPlayerRangePatch,
): JSONAPIBody {
  return playerRangePatch('gameCenterMatchmakingTeams', id, input);
}

export type MatchmakingRuleType = 'COMPATIBLE' | 'DISTANCE' | 'MATCH' | 'TEAM';

export interface MatchmakingRuleCreateInput {
  ruleSetId: string;
  referenceName: string;
  description: string;
  type: MatchmakingRuleType;
  expression: string;
  weight?: number | undefined;
}

export function buildMatchmakingRuleCreateBody(input: MatchmakingRuleCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'gameCenterMatchmakingRules',
      attributes: pick({ ...input }, [
        'referenceName',
        'description',
        'type',
        'expression',
        'weight',
      ]),
      relationships: { ruleSet: rel('gameCenterMatchmakingRuleSets', input.ruleSetId) },
    },
  };
}

export interface MatchmakingRulePatchInput {
  description?: string | undefined;
  expression?: string | undefined;
  weight?: number | undefined;
}

export function buildMatchmakingRulePatchBody(
  id: string,
  input: MatchmakingRulePatchInput,
): JSONAPIBody {
  const keys = ['description', 'expression', 'weight'] as const;
  const attributes = pick({ ...input }, keys);
  requireChanges(attributes, keys);
  return { data: { type: 'gameCenterMatchmakingRules', id, attributes } };
}

export interface MatchmakingQueueCreateInput {
  referenceName: string;
  ruleSetId: string;
  experimentRuleSetId?: string | undefined;
  classicMatchmakingBundleIds?: string[] | undefined;
}

export function buildMatchmakingQueueCreateBody(input: MatchmakingQueueCreateInput): JSONAPIBody {
  const relationships: Record<string, unknown> = {
    ruleSet: rel('gameCenterMatchmakingRuleSets', input.ruleSetId),
  };
  if (input.experimentRuleSetId !== undefined) {
    relationships.experimentRuleSet = rel(
      'gameCenterMatchmakingRuleSets',
      input.experimentRuleSetId,
    );
  }
  return {
    data: {
      type: 'gameCenterMatchmakingQueues',
      attributes: pick({ ...input }, ['referenceName', 'classicMatchmakingBundleIds']),
      relationships,
    },
  };
}

export interface MatchmakingQueuePatchInput {
  classicMatchmakingBundleIds?: string[] | undefined;
  ruleSetId?: string | undefined;
  experimentRuleSetId?: string | undefined;
}

export function buildMatchmakingQueuePatchBody(
  id: string,
  input: MatchmakingQueuePatchInput,
): JSONAPIBody {
  const body: JSONAPIBody = { data: { type: 'gameCenterMatchmakingQueues', id } };
  const attributes = pick({ ...input }, ['classicMatchmakingBundleIds']);
  if (Object.keys(attributes).length > 0) body.data.attributes = attributes;
  const relationships: Record<string, unknown> = {};
  if (input.ruleSetId !== undefined) {
    relationships.ruleSet = rel('gameCenterMatchmakingRuleSets', input.ruleSetId);
  }
  if (input.experimentRuleSetId !== undefined) {
    relationships.experimentRuleSet = rel(
      'gameCenterMatchmakingRuleSets',
      input.experimentRuleSetId,
    );
  }
  if (Object.keys(relationships).length > 0) body.data.relationships = relationships;
  if (!body.data.attributes && !body.data.relationships) {
    throw new Error(
      'Nothing to update: pass at least one of classicMatchmakingBundleIds, ruleSetId, experimentRuleSetId',
    );
  }
  return body;
}

export type MatchmakingPlatform = 'IOS' | 'MAC_OS' | 'TV_OS' | 'VISION_OS';

export interface MatchmakingTestPlayer {
  playerId: string;
  properties?: Array<{ key: string; value: string }> | undefined;
}

export interface MatchmakingTestRequest {
  requestName: string;
  secondsInQueue: number;
  bundleId: string;
  platform: MatchmakingPlatform;
  appVersion: string;
  locale?: string | undefined;
  location?: { latitude: number; longitude: number } | undefined;
  minPlayers?: number | undefined;
  maxPlayers?: number | undefined;
  playerCount?: number | undefined;
  players?: MatchmakingTestPlayer[] | undefined;
}

const TEST_REQUEST_KEYS = [
  'requestName',
  'secondsInQueue',
  'bundleId',
  'platform',
  'appVersion',
  'locale',
  'location',
  'minPlayers',
  'maxPlayers',
  'playerCount',
] as const;

// Requests and their player properties are created inline: each gets a `${n}`
// temp id, numbered across both types in the order they appear.
export function buildMatchmakingRuleSetTestBody(
  ruleSetId: string,
  requests: MatchmakingTestRequest[],
): JSONAPIBody {
  if (requests.length === 0) throw new Error('Pass at least one matchmaking request');
  let n = 0;
  const included: Array<Record<string, unknown>> = [];
  const requestRefs: Array<{ type: string; id: string }> = [];
  for (const r of requests) {
    const playerRefs: Array<{ type: string; id: string }> = [];
    for (const p of r.players ?? []) {
      n += 1;
      const ref = { type: 'gameCenterMatchmakingTestPlayerProperties', id: tempId(n) };
      playerRefs.push(ref);
      included.push({ ...ref, attributes: pick({ ...p }, ['playerId', 'properties']) });
    }
    n += 1;
    const ref = { type: 'gameCenterMatchmakingTestRequests', id: tempId(n) };
    requestRefs.push(ref);
    const entry: Record<string, unknown> = {
      ...ref,
      attributes: pick({ ...r }, TEST_REQUEST_KEYS),
    };
    if (playerRefs.length > 0) {
      entry.relationships = { matchmakingPlayerProperties: { data: playerRefs } };
    }
    included.push(entry);
  }
  return {
    data: {
      type: 'gameCenterMatchmakingRuleSetTests',
      relationships: {
        matchmakingRuleSet: rel('gameCenterMatchmakingRuleSets', ruleSetId),
        matchmakingRequests: { data: requestRefs },
      },
    },
    included,
  };
}

// ----- Matchmaking metrics -----

export const QUEUE_METRICS = {
  matchmakingRequests: {
    groupBy: ['result', 'gameCenterDetail'],
    sort: ['count', 'averageSecondsInQueue', 'p50SecondsInQueue', 'p95SecondsInQueue'],
    filters: ['result', 'gameCenterDetail'],
  },
  experimentMatchmakingRequests: {
    groupBy: ['result', 'gameCenterDetail'],
    sort: ['count', 'averageSecondsInQueue', 'p50SecondsInQueue', 'p95SecondsInQueue'],
    filters: ['result', 'gameCenterDetail'],
  },
  matchmakingQueueSizes: {
    groupBy: [],
    sort: ['count', 'averageNumberOfRequests', 'p50NumberOfRequests', 'p95NumberOfRequests'],
    filters: [],
  },
  experimentMatchmakingQueueSizes: {
    groupBy: [],
    sort: ['count', 'averageNumberOfRequests', 'p50NumberOfRequests', 'p95NumberOfRequests'],
    filters: [],
  },
  matchmakingSessions: {
    groupBy: [],
    sort: ['count', 'averagePlayerCount', 'p50PlayerCount', 'p95PlayerCount'],
    filters: [],
  },
} as const;

export const RULE_METRICS = {
  matchmakingBooleanRuleResults: {
    groupBy: ['result', 'gameCenterMatchmakingQueue'],
    sort: ['count'],
    filters: ['result', 'gameCenterMatchmakingQueue'],
  },
  matchmakingNumberRuleResults: {
    groupBy: ['gameCenterMatchmakingQueue'],
    sort: ['count', 'averageResult', 'p50Result', 'p95Result'],
    filters: ['gameCenterMatchmakingQueue'],
  },
  matchmakingRuleErrors: {
    groupBy: ['gameCenterMatchmakingQueue'],
    sort: ['count'],
    filters: ['gameCenterMatchmakingQueue'],
  },
} as const;

interface MetricSpec {
  groupBy: readonly string[];
  sort: readonly string[];
  filters: readonly string[];
}

export interface MetricsQueryInput {
  granularity: 'P1D' | 'PT1H' | 'PT15M';
  groupBy?: string[] | undefined;
  sort?: string | undefined;
  filters?: Record<string, string | undefined> | undefined;
  limit?: number | undefined;
}

// Validates groupBy / sort / filter keys against the chosen metric, because
// one tool serves several metric endpoints with different allowed values.
export function buildMetricsQuery(
  metric: string,
  spec: MetricSpec,
  input: MetricsQueryInput,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('granularity', input.granularity);
  if (input.groupBy?.length) {
    const bad = input.groupBy.filter((g) => !spec.groupBy.includes(g));
    if (bad.length) {
      throw new Error(
        `${metric} cannot group by ${bad.join(', ')} (allowed: ${spec.groupBy.join(', ') || 'none'})`,
      );
    }
    params.set('groupBy', input.groupBy.join(','));
  }
  for (const [key, value] of Object.entries(input.filters ?? {})) {
    if (value === undefined) continue;
    if (!spec.filters.includes(key)) {
      throw new Error(
        `${metric} has no filter[${key}] (allowed: ${spec.filters.join(', ') || 'none'})`,
      );
    }
    params.set(`filter[${key}]`, value);
  }
  if (input.sort !== undefined) {
    if (!spec.sort.includes(input.sort.replace(/^-/, ''))) {
      throw new Error(`${metric} cannot sort by ${input.sort} (allowed: ${spec.sort.join(', ')})`);
    }
    params.set('sort', input.sort);
  }
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  return params;
}

// ----- Digests -----

function cell(v: unknown): string {
  if (v === undefined || v === null) return '-';
  if (Array.isArray(v)) return v.length ? v.join(',') : '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// One table row per resource: id plus the named attributes. Used for every
// list in this file; the resources are small enough that a column pick reads
// better than a bespoke digest each.
export function digestGameCenterRows(
  pages: Pick<CollectedPages, 'data' | 'truncated' | 'total'>,
  attributes: readonly string[],
  noun: string,
): string {
  if (pages.data.length === 0) return `No ${noun} found.`;
  const rows = pages.data.map((r) => [r.id, ...attributes.map((a) => cell(r.attributes?.[a]))]);
  const table = formatTable([{ header: 'id' }, ...attributes.map((a) => ({ header: a }))], rows);
  const total = pages.total !== undefined ? ` of ${pages.total}` : '';
  const more = pages.truncated ? ' (truncated — raise maxItems)' : '';
  return `${pages.data.length}${total} ${noun}${more}\n\n${table}`;
}

interface MetricSeries {
  dataPoints?: Array<{ start?: string; end?: string; values?: Record<string, unknown> }>;
  dimensions?: Record<string, { data?: unknown }>;
  granularity?: string;
}

export function digestGameCenterMetrics(doc: { data?: MetricSeries[] }, metric: string): string {
  const series = doc.data ?? [];
  if (series.length === 0) return `No ${metric} data points.`;
  const valueKeys = new Set<string>();
  const dimKeys = new Set<string>();
  for (const s of series) {
    for (const k of Object.keys(s.dimensions ?? {})) dimKeys.add(k);
    for (const p of s.dataPoints ?? [])
      for (const k of Object.keys(p.values ?? {})) valueKeys.add(k);
  }
  const dims = [...dimKeys];
  const values = [...valueKeys];
  const rows: string[][] = [];
  for (const s of series) {
    for (const p of s.dataPoints ?? []) {
      rows.push([
        cell(p.start),
        ...dims.map((d) => cell(s.dimensions?.[d]?.data)),
        ...values.map((v) => cell(p.values?.[v])),
      ]);
    }
  }
  const table = formatTable(
    [
      { header: 'start' },
      ...dims.map((d) => ({ header: d })),
      ...values.map((v) => ({ header: v, align: 'right' as const })),
    ],
    rows,
  );
  return `${metric}: ${series.length} series, ${rows.length} data points\n\n${table}`;
}

// ----- Tool plumbing -----

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function errorResult(err: unknown) {
  return { content: [{ type: 'text' as const, text: formatASCError(err) }], isError: true };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function json(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const idOf = (what: string) => z.string().min(1).describe(`${what} ID.`);
const DetailIdSchema = idOf(
  'Game Center detail (gameCenterDetails) — one per app. Pass appId instead to resolve it',
);
const GroupIdSchema = idOf('Game Center group (gameCenterGroups) — shared across apps');
const RuleSetIdSchema = idOf('Matchmaking rule set (gameCenterMatchmakingRuleSets)');
const QueueIdSchema = idOf('Matchmaking queue (gameCenterMatchmakingQueues)');
const RuleIdSchema = idOf('Matchmaking rule (gameCenterMatchmakingRules)');
const TeamIdSchema = idOf('Matchmaking team (gameCenterMatchmakingTeams)');
const AppVersionIdSchema = idOf('Game Center app version (gameCenterAppVersions)');
const LeaderboardIdSchema = idOf('Leaderboard (v2 gameCenterLeaderboards)');
const MaxItemsSchema = z.number().int().positive().max(2000).default(200);
const RawSchema = z.boolean().default(false);
const PlayersCountSchema = z.number().int().positive();
const PlayStyleSchema = z
  .enum(['ASYNCHRONOUS', 'SYNCHRONOUS'])
  .describe('SYNCHRONOUS = everyone plays at once (party); ASYNCHRONOUS = players take turns.');
const ActivityPropertiesSchema = z
  .record(z.string(), z.string())
  .describe(
    'Free-form string→string map your game reads back through GKGameActivity (e.g. { "mode": "ranked" }).',
  );
const GranularitySchema = z
  .enum(['P1D', 'PT1H', 'PT15M'])
  .describe('Bucket size: P1D = day, PT1H = hour, PT15M = 15 minutes.');

const ACTIVITY_FIELDS = [
  'referenceName',
  'vendorIdentifier',
  'playStyle',
  'minimumPlayersCount',
  'maximumPlayersCount',
  'supportsPartyCode',
  'archived',
] as const;
const CHALLENGE_FIELDS = [
  'referenceName',
  'vendorIdentifier',
  'challengeType',
  'repeatable',
  'archived',
] as const;
const VERSION_FIELDS = {
  activity: ['version', 'state', 'fallbackUrl'],
  challenge: ['version', 'state'],
} as const;
const LOCALIZATION_FIELDS = ['locale', 'name', 'description'] as const;

export function registerGameCenterPlay(server: McpServer, client: ASCClient): void {
  async function list(path: string, maxItems: number) {
    const sep = path.includes('?') ? '&' : '?';
    return paginate(client, `${path}${sep}limit=200`, maxItems);
  }

  async function resolveDetailId(input: {
    appId?: string | undefined;
    gameCenterDetailId?: string | undefined;
  }): Promise<string> {
    if (input.gameCenterDetailId) return input.gameCenterDetailId;
    if (!input.appId) throw new Error('Pass gameCenterDetailId or appId');
    const doc = await client.request<{ data?: { id?: string } | null }>(
      `/v1/apps/${encodeURIComponent(input.appId)}/gameCenterDetail`,
      { method: 'GET' },
    );
    const id = doc.data?.id;
    if (!id) throw new Error(`App ${input.appId} has no Game Center detail (Game Center is off)`);
    return id;
  }

  function simpleDelete(
    name: string,
    title: string,
    description: string,
    path: string,
    idKey: string,
  ) {
    server.registerTool(
      name,
      { title, description, inputSchema: z.object({ [idKey]: z.string().min(1) }) },
      async (input: Record<string, string>) => {
        const id = input[idKey] as string;
        try {
          await client.request<void>(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' });
          return textResult(`Deleted ${path.split('/').pop()} ${id}.`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  function simpleGet(
    name: string,
    title: string,
    description: string,
    path: string,
    idKey: string,
  ) {
    server.registerTool(
      name,
      { title, description, inputSchema: z.object({ [idKey]: z.string().min(1) }) },
      async (input: Record<string, string>) => {
        const id = input[idKey] as string;
        try {
          return json(await client.request<unknown>(`${path}/${encodeURIComponent(id)}`));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  async function send(path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
    const data = await client.request<unknown>(path, { method, body: JSON.stringify(body) });
    return data === undefined || data === null || data === ''
      ? textResult('OK (204).')
      : json(data);
  }

  // ===== Activities + challenges (shared hierarchy) =====

  for (const kind of ['activity', 'challenge'] as const) {
    const k = PLAY[kind];

    // ----- List (by detail / app, or by group) -----
    const challengeFilters =
      kind === 'challenge'
        ? {
            referenceName: z.string().min(1).optional().describe('filter[referenceName]'),
            archived: z.boolean().optional().describe('filter[archived]'),
          }
        : {};
    server.registerTool(
      `asc_list_game_center_${k.plural}`,
      {
        title: `List Game Center ${k.plural}`,
        description:
          kind === 'activity'
            ? "List an app's Game Center activities (deep links into a game mode or level that players can join from the Games app and invites). Pass appId, gameCenterDetailId, or gameCenterGroupId for activities shared across a Game Center group. Next: asc_list_game_center_activity_versions."
            : "List an app's Game Center challenges (leaderboard-based challenges players send each other, iOS 26+). Pass appId, gameCenterDetailId, or gameCenterGroupId for challenges shared across a Game Center group. Next: asc_list_game_center_challenge_versions.",
        inputSchema: z.object({
          appId: AppIdSchema.optional(),
          gameCenterDetailId: DetailIdSchema.optional(),
          gameCenterGroupId: GroupIdSchema.optional(),
          ...challengeFilters,
          maxItems: MaxItemsSchema,
          raw: RawSchema,
        }),
      },
      async (input) => {
        try {
          let parent: string;
          if (input.gameCenterGroupId) {
            parent = `/v1/gameCenterGroups/${encodeURIComponent(input.gameCenterGroupId)}`;
          } else {
            parent = `/v1/gameCenterDetails/${encodeURIComponent(await resolveDetailId(input))}`;
          }
          const params = new URLSearchParams();
          const f = input as { referenceName?: string; archived?: boolean };
          if (f.referenceName !== undefined) params.set('filter[referenceName]', f.referenceName);
          if (f.archived !== undefined) params.set('filter[archived]', String(f.archived));
          const pages = await list(withQuery(`${parent}/${k.childPath}`, params), input.maxItems);
          if (input.raw) return json(pages);
          const fields = kind === 'activity' ? ACTIVITY_FIELDS : CHALLENGE_FIELDS;
          return textResult(digestGameCenterRows(pages, fields, `Game Center ${k.plural}`));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    simpleGet(
      `asc_get_game_center_${kind}`,
      `Get a Game Center ${kind}`,
      `GET ${k.itemPath}/{id}. Returns the ${kind}'s attributes and relationship links.`,
      k.itemPath,
      `${kind}Id`,
    );

    simpleDelete(
      `asc_delete_game_center_${kind}`,
      `Delete a Game Center ${kind}`,
      `DELETE ${k.itemPath}/{id}. Removes the ${kind} with all its versions and localizations. Apple refuses once a version is live — PATCH archived=true retires a live ${kind} instead.`,
      k.itemPath,
      `${kind}Id`,
    );

    // ----- Versions -----
    server.registerTool(
      `asc_list_game_center_${kind}_versions`,
      {
        title: `List Game Center ${kind} versions`,
        description: `List the versions of a Game Center ${kind} (version number, review state). Players see the LIVE one; edits go on a PREPARE_FOR_SUBMISSION version, which ships with the next app review.`,
        inputSchema: z.object({
          [`${kind}Id`]: idOf(`Game Center ${kind}`),
          maxItems: MaxItemsSchema,
          raw: RawSchema,
        }),
      },
      async (input) => {
        const parentId = (input as Record<string, string>)[`${kind}Id`] as string;
        try {
          const pages = await list(
            `${k.itemPath}/${encodeURIComponent(parentId)}/versions`,
            input.maxItems as number,
          );
          if (input.raw) return json(pages);
          return textResult(
            digestGameCenterRows(pages, VERSION_FIELDS[kind], `Game Center ${kind} versions`),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    simpleGet(
      `asc_get_game_center_${kind}_version`,
      `Get a Game Center ${kind} version`,
      `GET ${k.versionPath}/{id} — version number, state${kind === 'activity' ? ', fallbackUrl' : ''}.`,
      k.versionPath,
      'versionId',
    );

    server.registerTool(
      `asc_post_game_center_${kind}_version`,
      {
        title: `Create a Game Center ${kind} version`,
        description:
          `POST ${k.versionPath}. Opens a new version of a ${kind} to edit (localizations, image${kind === 'activity' ? ', fallbackUrl' : ''}). Apple allows one editable version at a time.` +
          (kind === 'activity'
            ? ' fallbackUrl is where players without the game go (e.g. your App Store page).'
            : ''),
        inputSchema: z.object({
          [`${kind}Id`]: idOf(`Game Center ${kind}`),
          ...(kind === 'activity'
            ? { fallbackUrl: z.string().url().optional().describe('Universal link fallback.') }
            : {}),
        }),
      },
      async (input) => {
        const parentId = (input as Record<string, string>)[`${kind}Id`] as string;
        const fallbackUrl = (input as { fallbackUrl?: string }).fallbackUrl;
        try {
          return await send(
            k.versionPath,
            'POST',
            buildGameCenterPlayVersionCreateBody(kind, parentId, fallbackUrl),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    // ----- Localizations -----
    server.registerTool(
      `asc_list_game_center_${kind}_localizations`,
      {
        title: `List Game Center ${kind} localizations`,
        description: `List the localizations (locale, name, description) of a Game Center ${kind} version.`,
        inputSchema: z.object({
          versionId: idOf(`Game Center ${kind} version`),
          maxItems: MaxItemsSchema,
          raw: RawSchema,
        }),
      },
      async ({ versionId, maxItems, raw }) => {
        try {
          const pages = await list(
            `${k.versionPath}/${encodeURIComponent(versionId)}/localizations`,
            maxItems,
          );
          if (raw) return json(pages);
          return textResult(
            digestGameCenterRows(pages, LOCALIZATION_FIELDS, `Game Center ${kind} localizations`),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    simpleGet(
      `asc_get_game_center_${kind}_localization`,
      `Get a Game Center ${kind} localization`,
      `GET ${k.localizationPath}/{id}.`,
      k.localizationPath,
      'localizationId',
    );

    server.registerTool(
      `asc_post_game_center_${kind}_localization`,
      {
        title: `Create a Game Center ${kind} localization`,
        description: `POST ${k.localizationPath}. Adds a locale (name + optional description) to an editable ${kind} version. Players see it once the version goes live.`,
        inputSchema: z.object({
          versionId: idOf(`Game Center ${kind} version`),
          locale: LocaleSchema,
          name: z.string().min(1),
          description: z.string().min(1).optional(),
        }),
      },
      async (input) => {
        try {
          return await send(
            k.localizationPath,
            'POST',
            buildGameCenterPlayLocalizationCreateBody({ kind, ...input }),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_patch_game_center_${kind}_localization`,
      {
        title: `Update a Game Center ${kind} localization`,
        description: `PATCH ${k.localizationPath}/{id} — name and/or description. The locale is fixed.`,
        inputSchema: z.object({
          localizationId: idOf(`Game Center ${kind} localization`),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
        }),
      },
      async ({ localizationId, ...changes }) => {
        try {
          return await send(
            `${k.localizationPath}/${encodeURIComponent(localizationId)}`,
            'PATCH',
            buildGameCenterPlayLocalizationPatchBody(kind, localizationId, changes),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    simpleDelete(
      `asc_delete_game_center_${kind}_localization`,
      `Delete a Game Center ${kind} localization`,
      `DELETE ${k.localizationPath}/{id}. Removes one locale from an editable ${kind} version.`,
      k.localizationPath,
      'localizationId',
    );

    // ----- Images -----
    server.registerTool(
      `asc_get_game_center_${kind}_image`,
      {
        title: `Get a Game Center ${kind} image`,
        description: `Fetch a ${kind} image by imageId, the image of a localization (localizationId), or a version's default image (versionId). Pass exactly one. Returns null data when none is set.`,
        inputSchema: z.object({
          imageId: z.string().min(1).optional(),
          localizationId: z.string().min(1).optional(),
          versionId: z.string().min(1).optional(),
        }),
      },
      async ({ imageId, localizationId, versionId }) => {
        const given = [imageId, localizationId, versionId].filter((v) => v !== undefined);
        if (given.length !== 1) {
          return errorResult(new Error('Pass exactly one of imageId, localizationId, versionId'));
        }
        const path = imageId
          ? `${k.imagePath}/${encodeURIComponent(imageId)}`
          : localizationId
            ? `${k.localizationPath}/${encodeURIComponent(localizationId)}/image`
            : `${k.versionPath}/${encodeURIComponent(versionId as string)}/defaultImage`;
        try {
          return json(await client.request<unknown>(path));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    const imageTarget = {
      localizationId: z
        .string()
        .min(1)
        .optional()
        .describe(`Attach to this ${kind} localization (per-language image).`),
      versionId: z
        .string()
        .min(1)
        .optional()
        .describe(`Attach as this ${kind} version's default image.`),
    };

    server.registerTool(
      `asc_post_game_center_${kind}_image`,
      {
        title: `Reserve a Game Center ${kind} image`,
        description: `POST ${k.imagePath} — raw reserve step. Returns uploadOperations[]; PUT each with asc_upload_asset_chunk, then asc_patch_game_center_${kind}_image uploaded=true. asc_upload_game_center_${kind}_image does all three. Pass exactly one of localizationId or versionId.`,
        inputSchema: z.object({
          ...imageTarget,
          fileName: FileNameSchema,
          fileSize: FileSizeSchema,
        }),
      },
      async (input) => {
        try {
          return await send(
            k.imagePath,
            'POST',
            buildGameCenterPlayImageCreateBody({ kind, ...input }),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_patch_game_center_${kind}_image`,
      {
        title: `Commit a Game Center ${kind} image`,
        description: `PATCH ${k.imagePath}/{id} with uploaded=true once every chunk is PUT. This API takes no checksum.`,
        inputSchema: z.object({
          imageId: z.string().min(1),
          uploaded: z.boolean().default(true),
        }),
      },
      async ({ imageId, uploaded }) => {
        try {
          return await send(
            `${k.imagePath}/${encodeURIComponent(imageId)}`,
            'PATCH',
            buildGameCenterPlayImagePatchBody(kind, imageId, uploaded),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    simpleDelete(
      `asc_delete_game_center_${kind}_image`,
      `Delete a Game Center ${kind} image`,
      `DELETE ${k.imagePath}/{id}. Removes the image from its localization or version.`,
      k.imagePath,
      'imageId',
    );

    server.registerTool(
      `asc_upload_game_center_${kind}_image`,
      {
        title: `Upload a Game Center ${kind} image (composite)`,
        description: `Composite tool. Reads localFilePath, reserves a ${kind} image on a localization or as a version's default image, PUTs every chunk to Apple storage, then commits with uploaded=true. Pass exactly one of localizationId or versionId.`,
        inputSchema: z.object({
          ...imageTarget,
          localFilePath: LocalFilePathSchema,
          fileName: FileNameSchema.optional().describe('Defaults to basename(localFilePath).'),
        }),
      },
      async ({ localFilePath, fileName, localizationId, versionId }) => {
        const resolvedPath = expandHomePath(localFilePath);
        try {
          const fileSize = await readFileSizeBytes(resolvedPath);
          const name = fileName ?? resolvedPath.split('/').pop() ?? 'image.png';
          const reserveBody = buildGameCenterPlayImageCreateBody({
            kind,
            fileName: name,
            fileSize,
            localizationId,
            versionId,
          });
          const reserved = await client.request<AssetReserveResponse>(k.imagePath, {
            method: 'POST',
            body: JSON.stringify(reserveBody),
          });
          const imageId = reserved.data?.id;
          const operations = reserved.data?.attributes?.uploadOperations ?? [];
          if (!imageId) throw new Error('Reserve response missing image id');
          if (operations.length === 0) {
            throw new Error('Reserve response missing uploadOperations[] — cannot upload');
          }
          const executed = await executeAllUploadOperations(operations, resolvedPath);
          const committed = await client.request<unknown>(
            `${k.imagePath}/${encodeURIComponent(imageId)}`,
            {
              method: 'PATCH',
              body: JSON.stringify(buildGameCenterPlayImagePatchBody(kind, imageId, true)),
            },
          );
          return textResult(
            `Uploaded ${name} → ${k.imageType} ${imageId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(committed, null, 2)}`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  // ===== Activity-only tools =====

  const ownerFields = {
    gameCenterDetailId: DetailIdSchema.optional(),
    gameCenterGroupId: GroupIdSchema.optional(),
    appId: AppIdSchema.optional().describe('Resolves the Game Center detail of this app.'),
  };

  server.registerTool(
    'asc_post_game_center_activity',
    {
      title: 'Create a Game Center activity',
      description:
        'POST /v1/gameCenterActivities. Creates an activity in an app (appId or gameCenterDetailId) or a Game Center group (gameCenterGroupId) — exactly one owner. vendorIdentifier is the id your game uses in GKGameActivity and is fixed after create. Next: asc_post_game_center_activity_version, then localizations and an image.',
      inputSchema: z.object({
        ...ownerFields,
        referenceName: z.string().min(1).describe('Internal name, not shown to players.'),
        vendorIdentifier: z.string().min(1),
        playStyle: PlayStyleSchema.optional(),
        minimumPlayersCount: PlayersCountSchema.optional(),
        maximumPlayersCount: PlayersCountSchema.optional(),
        supportsPartyCode: z.boolean().optional().describe('Players can join with a party code.'),
        properties: ActivityPropertiesSchema.optional(),
      }),
    },
    async ({ appId, ...input }) => {
      try {
        const gameCenterDetailId =
          appId && !input.gameCenterGroupId
            ? await resolveDetailId({ appId })
            : input.gameCenterDetailId;
        return await send(
          '/v1/gameCenterActivities',
          'POST',
          buildGameCenterActivityCreateBody({ ...input, gameCenterDetailId }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_activity',
    {
      title: 'Update a Game Center activity',
      description:
        'PATCH /v1/gameCenterActivities/{id} — referenceName, playStyle, player counts, supportsPartyCode, properties, archived. archived=true retires the activity without deleting it. vendorIdentifier cannot change.',
      inputSchema: z.object({
        activityId: idOf('Game Center activity'),
        referenceName: z.string().min(1).optional(),
        playStyle: PlayStyleSchema.optional(),
        minimumPlayersCount: PlayersCountSchema.optional(),
        maximumPlayersCount: PlayersCountSchema.optional(),
        supportsPartyCode: z.boolean().optional(),
        archived: z.boolean().optional(),
        properties: ActivityPropertiesSchema.optional(),
      }),
    },
    async ({ activityId, ...changes }) => {
      try {
        return await send(
          `/v1/gameCenterActivities/${encodeURIComponent(activityId)}`,
          'PATCH',
          buildGameCenterActivityPatchBody(activityId, changes),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  for (const target of ['achievements', 'leaderboards'] as const) {
    const type = target === 'achievements' ? 'gameCenterAchievements' : 'gameCenterLeaderboards';
    for (const op of ['add', 'remove'] as const) {
      server.registerTool(
        `asc_${op}_game_center_activity_${target}`,
        {
          title: `${op === 'add' ? 'Link' : 'Unlink'} ${target} ${op === 'add' ? 'to' : 'from'} a Game Center activity`,
          description: `${op === 'add' ? 'POST' : 'DELETE'} /v1/gameCenterActivities/{id}/relationships/${target}V2. ${op === 'add' ? 'Links' : 'Unlinks'} v2 ${target} ${op === 'add' ? 'to' : 'from'} the activity — the ${target} players work on during it. Takes v2 ${type} ids.`,
          inputSchema: z.object({
            activityId: idOf('Game Center activity'),
            ids: z.array(z.string().min(1)).min(1).describe(`v2 ${type} ids.`),
          }),
        },
        async ({ activityId, ids }) => {
          try {
            return await send(
              `/v1/gameCenterActivities/${encodeURIComponent(activityId)}/relationships/${target}V2`,
              op === 'add' ? 'POST' : 'DELETE',
              buildLinkageBody(type, ids),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      );
    }
  }

  server.registerTool(
    'asc_patch_game_center_activity_version',
    {
      title: 'Update a Game Center activity version',
      description:
        'PATCH /v1/gameCenterActivityVersions/{id} — fallbackUrl (where players without the game go). Pass null to clear it.',
      inputSchema: z.object({
        versionId: idOf('Game Center activity version'),
        fallbackUrl: z.string().url().nullable(),
      }),
    },
    async ({ versionId, fallbackUrl }) => {
      try {
        return await send(
          `/v1/gameCenterActivityVersions/${encodeURIComponent(versionId)}`,
          'PATCH',
          buildGameCenterActivityVersionPatchBody(versionId, fallbackUrl),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ===== Challenge-only tools =====

  server.registerTool(
    'asc_post_game_center_challenge',
    {
      title: 'Create a Game Center challenge',
      description:
        'POST /v1/gameCenterChallenges. Creates a leaderboard challenge in an app (appId or gameCenterDetailId) or a Game Center group (gameCenterGroupId) — exactly one owner. leaderboardId is the v2 leaderboard the challenge scores on. vendorIdentifier is fixed after create. Next: asc_post_game_center_challenge_version, then localizations and an image.',
      inputSchema: z.object({
        ...ownerFields,
        referenceName: z.string().min(1).describe('Internal name, not shown to players.'),
        vendorIdentifier: z.string().min(1),
        challengeType: z.enum(['LEADERBOARD']).default('LEADERBOARD'),
        repeatable: z.boolean().optional().describe('Players can take the challenge again.'),
        leaderboardId: LeaderboardIdSchema.optional(),
      }),
    },
    async ({ appId, ...input }) => {
      try {
        const gameCenterDetailId =
          appId && !input.gameCenterGroupId
            ? await resolveDetailId({ appId })
            : input.gameCenterDetailId;
        return await send(
          '/v1/gameCenterChallenges',
          'POST',
          buildGameCenterChallengeCreateBody({ ...input, gameCenterDetailId }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_challenge',
    {
      title: 'Update a Game Center challenge',
      description:
        'PATCH /v1/gameCenterChallenges/{id} — referenceName, repeatable, archived, and optionally the v2 leaderboard (leaderboardId). archived=true retires the challenge without deleting it.',
      inputSchema: z.object({
        challengeId: idOf('Game Center challenge'),
        referenceName: z.string().min(1).optional(),
        repeatable: z.boolean().optional(),
        archived: z.boolean().optional(),
        leaderboardId: LeaderboardIdSchema.optional(),
      }),
    },
    async ({ challengeId, ...changes }) => {
      try {
        return await send(
          `/v1/gameCenterChallenges/${encodeURIComponent(challengeId)}`,
          'PATCH',
          buildGameCenterChallengePatchBody(challengeId, changes),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_set_game_center_challenge_leaderboard',
    {
      title: 'Set the leaderboard of a Game Center challenge',
      description:
        'PATCH /v1/gameCenterChallenges/{id}/relationships/leaderboardV2. Points the challenge at a v2 leaderboard.',
      inputSchema: z.object({
        challengeId: idOf('Game Center challenge'),
        leaderboardId: LeaderboardIdSchema,
      }),
    },
    async ({ challengeId, leaderboardId }) => {
      try {
        return await send(
          `/v1/gameCenterChallenges/${encodeURIComponent(challengeId)}/relationships/leaderboardV2`,
          'PATCH',
          buildChallengeLeaderboardBody(leaderboardId),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ===== Game Center app versions =====

  server.registerTool(
    'asc_list_game_center_app_versions',
    {
      title: 'List Game Center app versions',
      description:
        "List an app's Game Center app versions: one per App Store version, saying whether Game Center is enabled for it. Pass appId or gameCenterDetailId; enabled filters. compatibilityVersionsOf lists the versions a given Game Center app version is compatible with instead.",
      inputSchema: z.object({
        appId: AppIdSchema.optional(),
        gameCenterDetailId: DetailIdSchema.optional(),
        compatibilityVersionsOf: AppVersionIdSchema.optional(),
        enabled: z.boolean().optional().describe('filter[enabled]'),
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ appId, gameCenterDetailId, compatibilityVersionsOf, enabled, maxItems, raw }) => {
      try {
        const params = new URLSearchParams();
        params.set('include', 'appStoreVersion');
        if (enabled !== undefined) params.set('filter[enabled]', String(enabled));
        const base = compatibilityVersionsOf
          ? `/v1/gameCenterAppVersions/${encodeURIComponent(compatibilityVersionsOf)}/compatibilityVersions`
          : `/v1/gameCenterDetails/${encodeURIComponent(
              await resolveDetailId({ appId, gameCenterDetailId }),
            )}/gameCenterAppVersions`;
        const pages = await list(withQuery(base, params), maxItems);
        if (raw) return json(pages);
        const versionString = new Map(
          pages.included
            .filter((r) => r.type === 'appStoreVersions')
            .map((r) => [r.id, cell(r.attributes?.versionString)]),
        );
        const rows = pages.data.map((r) => {
          const asv = r.relationships?.appStoreVersion?.data;
          const asvId = asv && !Array.isArray(asv) ? asv.id : undefined;
          return {
            ...r,
            attributes: {
              ...r.attributes,
              appStoreVersion: asvId ? `${versionString.get(asvId) ?? '?'} (${asvId})` : '-',
            },
          };
        });
        return textResult(
          digestGameCenterRows(
            { ...pages, data: rows },
            ['enabled', 'appStoreVersion'],
            'Game Center app versions',
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_game_center_app_version',
    {
      title: 'Get a Game Center app version',
      description:
        'GET /v1/gameCenterAppVersions/{id} with its App Store version included. withAppStoreVersion=true returns only the App Store version (GET …/appStoreVersion).',
      inputSchema: z.object({
        appVersionId: AppVersionIdSchema,
        withAppStoreVersion: z.boolean().default(false),
      }),
    },
    async ({ appVersionId, withAppStoreVersion }) => {
      const base = `/v1/gameCenterAppVersions/${encodeURIComponent(appVersionId)}`;
      try {
        return json(
          await client.request<unknown>(
            withAppStoreVersion ? `${base}/appStoreVersion` : `${base}?include=appStoreVersion`,
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_app_version',
    {
      title: 'Create a Game Center app version',
      description:
        'POST /v1/gameCenterAppVersions. Turns on Game Center tracking for one App Store version. Usually App Store Connect creates these itself when Game Center is on; use this when one is missing.',
      inputSchema: z.object({ appStoreVersionId: AppStoreVersionIdSchema }),
    },
    async ({ appStoreVersionId }) => {
      try {
        return await send(
          '/v1/gameCenterAppVersions',
          'POST',
          buildGameCenterAppVersionCreateBody(appStoreVersionId),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_app_version',
    {
      title: 'Enable or disable Game Center for an app version',
      description:
        'PATCH /v1/gameCenterAppVersions/{id} — enabled. ⚠️ enabled=false turns Game Center off for players on that App Store version; confirm intent first.',
      inputSchema: z.object({ appVersionId: AppVersionIdSchema, enabled: z.boolean() }),
    },
    async ({ appVersionId, enabled }) => {
      try {
        return await send(
          `/v1/gameCenterAppVersions/${encodeURIComponent(appVersionId)}`,
          'PATCH',
          buildGameCenterAppVersionPatchBody(appVersionId, enabled),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  for (const op of ['add', 'remove'] as const) {
    server.registerTool(
      `asc_${op}_game_center_app_version_compatibility`,
      {
        title: `${op === 'add' ? 'Add' : 'Remove'} Game Center compatibility versions`,
        description: `${op === 'add' ? 'POST' : 'DELETE'} /v1/gameCenterAppVersions/{id}/relationships/compatibilityVersions. ${op === 'add' ? 'Marks' : 'Unmarks'} other Game Center app versions (e.g. the macOS or tvOS build) as compatible with this one, so their players see the same leaderboards and match each other.`,
        inputSchema: z.object({
          appVersionId: AppVersionIdSchema,
          compatibilityVersionIds: z.array(z.string().min(1)).min(1),
        }),
      },
      async ({ appVersionId, compatibilityVersionIds }) => {
        try {
          return await send(
            `/v1/gameCenterAppVersions/${encodeURIComponent(appVersionId)}/relationships/compatibilityVersions`,
            op === 'add' ? 'POST' : 'DELETE',
            buildLinkageBody('gameCenterAppVersions', compatibilityVersionIds),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  // ===== Matchmaking: rule sets =====

  server.registerTool(
    'asc_list_game_center_matchmaking_rule_sets',
    {
      title: 'List Game Center matchmaking rule sets',
      description:
        'List the rule sets on this team (account-wide, not per app). A rule set holds the rules and teams a matchmaking queue uses. Next: asc_list_game_center_matchmaking_rules / _teams / _queues with ruleSetId.',
      inputSchema: z.object({ maxItems: MaxItemsSchema, raw: RawSchema }),
    },
    async ({ maxItems, raw }) => {
      try {
        const pages = await list('/v1/gameCenterMatchmakingRuleSets', maxItems);
        if (raw) return json(pages);
        return textResult(
          digestGameCenterRows(
            pages,
            ['referenceName', 'ruleLanguageVersion', 'minPlayers', 'maxPlayers'],
            'matchmaking rule sets',
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  simpleGet(
    'asc_get_game_center_matchmaking_rule_set',
    'Get a Game Center matchmaking rule set',
    'GET /v1/gameCenterMatchmakingRuleSets/{id}.',
    '/v1/gameCenterMatchmakingRuleSets',
    'ruleSetId',
  );

  server.registerTool(
    'asc_post_game_center_matchmaking_rule_set',
    {
      title: 'Create a Game Center matchmaking rule set',
      description:
        'POST /v1/gameCenterMatchmakingRuleSets. referenceName and ruleLanguageVersion are fixed after create. Then add rules and teams, and point a queue at it.',
      inputSchema: z.object({
        referenceName: z.string().min(1),
        ruleLanguageVersion: z.number().int().positive().default(1),
        minPlayers: PlayersCountSchema,
        maxPlayers: PlayersCountSchema,
      }),
    },
    async (input) => {
      try {
        return await send(
          '/v1/gameCenterMatchmakingRuleSets',
          'POST',
          buildMatchmakingRuleSetCreateBody(input),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_matchmaking_rule_set',
    {
      title: 'Update a Game Center matchmaking rule set',
      description: 'PATCH /v1/gameCenterMatchmakingRuleSets/{id} — minPlayers and/or maxPlayers.',
      inputSchema: z.object({
        ruleSetId: RuleSetIdSchema,
        minPlayers: PlayersCountSchema.optional(),
        maxPlayers: PlayersCountSchema.optional(),
      }),
    },
    async ({ ruleSetId, ...changes }) => {
      try {
        return await send(
          `/v1/gameCenterMatchmakingRuleSets/${encodeURIComponent(ruleSetId)}`,
          'PATCH',
          buildMatchmakingRuleSetPatchBody(ruleSetId, changes),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  simpleDelete(
    'asc_delete_game_center_matchmaking_rule_set',
    'Delete a Game Center matchmaking rule set',
    'DELETE /v1/gameCenterMatchmakingRuleSets/{id}. Check asc_list_game_center_matchmaking_queues with ruleSetId first: a queue using it would lose its rules.',
    '/v1/gameCenterMatchmakingRuleSets',
    'ruleSetId',
  );

  server.registerTool(
    'asc_test_game_center_matchmaking_rule_set',
    {
      title: 'Test a Game Center matchmaking rule set',
      description:
        'POST /v1/gameCenterMatchmakingRuleSetTests. Runs made-up matchmaking requests through a rule set and returns which requests Apple would match and onto which teams. No real players are involved and nothing is saved on the rule set — use it to check rules before pointing a live queue at them.',
      inputSchema: z.object({
        ruleSetId: RuleSetIdSchema,
        requests: z
          .array(
            z.object({
              requestName: z.string().min(1),
              secondsInQueue: z.number().int().nonnegative(),
              bundleId: z.string().min(1),
              platform: z.enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS']),
              appVersion: z.string().min(1),
              locale: z
                .string()
                .regex(/^[A-Z]{2}-[A-Z]{2}$/, 'Upper-case locale like EN-US')
                .optional()
                .describe('Upper-case, e.g. EN-US, HU-HU.'),
              location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
              minPlayers: PlayersCountSchema.optional(),
              maxPlayers: PlayersCountSchema.optional(),
              playerCount: PlayersCountSchema.optional(),
              players: z
                .array(
                  z.object({
                    playerId: z.string().min(1),
                    properties: z
                      .array(z.object({ key: z.string(), value: z.string() }))
                      .optional(),
                  }),
                )
                .optional()
                .describe('Per-player properties your rules read (e.g. skill).'),
            }),
          )
          .min(1),
      }),
    },
    async ({ ruleSetId, requests }) => {
      try {
        return await send(
          '/v1/gameCenterMatchmakingRuleSetTests',
          'POST',
          buildMatchmakingRuleSetTestBody(ruleSetId, requests),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ===== Matchmaking: rules + teams (listed through their rule set) =====

  server.registerTool(
    'asc_list_game_center_matchmaking_rules',
    {
      title: 'List Game Center matchmaking rules',
      description: 'List the rules of a matchmaking rule set (type, expression, weight).',
      inputSchema: z.object({
        ruleSetId: RuleSetIdSchema,
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ ruleSetId, maxItems, raw }) => {
      try {
        const pages = await list(
          `/v1/gameCenterMatchmakingRuleSets/${encodeURIComponent(ruleSetId)}/rules`,
          maxItems,
        );
        if (raw) return json(pages);
        return textResult(
          digestGameCenterRows(
            pages,
            ['referenceName', 'type', 'weight', 'expression'],
            'matchmaking rules',
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_matchmaking_rule',
    {
      title: 'Create a Game Center matchmaking rule',
      description:
        "POST /v1/gameCenterMatchmakingRules. Adds a rule to a rule set. type: COMPATIBLE (can two requests match), DISTANCE (prefer close values), MATCH (must hold for the whole match), TEAM (must hold per team). expression is in Apple's matchmaking rule language (JMESPath-based): literals go in backticks, e.g. requests[0].secondsInQueue >= `5` — a bare 5 is a 409 compile error. Test with asc_test_game_center_matchmaking_rule_set before a live queue uses it.",
      inputSchema: z.object({
        ruleSetId: RuleSetIdSchema,
        referenceName: z.string().min(1),
        description: z.string().min(1),
        type: z.enum(['COMPATIBLE', 'DISTANCE', 'MATCH', 'TEAM']),
        expression: z.string().min(1),
        weight: z.number().optional().describe('DISTANCE rules: how much this rule counts.'),
      }),
    },
    async (input) => {
      try {
        return await send(
          '/v1/gameCenterMatchmakingRules',
          'POST',
          buildMatchmakingRuleCreateBody(input),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_matchmaking_rule',
    {
      title: 'Update a Game Center matchmaking rule',
      description:
        'PATCH /v1/gameCenterMatchmakingRules/{id} — description, expression, weight. referenceName and type are fixed. A queue using this rule set picks the change up at once.',
      inputSchema: z.object({
        ruleId: RuleIdSchema,
        description: z.string().min(1).optional(),
        expression: z.string().min(1).optional(),
        weight: z.number().optional(),
      }),
    },
    async ({ ruleId, ...changes }) => {
      try {
        return await send(
          `/v1/gameCenterMatchmakingRules/${encodeURIComponent(ruleId)}`,
          'PATCH',
          buildMatchmakingRulePatchBody(ruleId, changes),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  simpleDelete(
    'asc_delete_game_center_matchmaking_rule',
    'Delete a Game Center matchmaking rule',
    'DELETE /v1/gameCenterMatchmakingRules/{id}. Live queues on the rule set stop applying it at once.',
    '/v1/gameCenterMatchmakingRules',
    'ruleId',
  );

  server.registerTool(
    'asc_list_game_center_matchmaking_teams',
    {
      title: 'List Game Center matchmaking teams',
      description: 'List the teams of a matchmaking rule set (name, min/max players).',
      inputSchema: z.object({
        ruleSetId: RuleSetIdSchema,
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ ruleSetId, maxItems, raw }) => {
      try {
        const pages = await list(
          `/v1/gameCenterMatchmakingRuleSets/${encodeURIComponent(ruleSetId)}/teams`,
          maxItems,
        );
        if (raw) return json(pages);
        return textResult(
          digestGameCenterRows(
            pages,
            ['referenceName', 'minPlayers', 'maxPlayers'],
            'matchmaking teams',
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_matchmaking_team',
    {
      title: 'Create a Game Center matchmaking team',
      description:
        'POST /v1/gameCenterMatchmakingTeams. Adds a team (e.g. "red", "blue") with its player range to a rule set.',
      inputSchema: z.object({
        ruleSetId: RuleSetIdSchema,
        referenceName: z.string().min(1),
        minPlayers: PlayersCountSchema,
        maxPlayers: PlayersCountSchema,
      }),
    },
    async (input) => {
      try {
        return await send(
          '/v1/gameCenterMatchmakingTeams',
          'POST',
          buildMatchmakingTeamCreateBody(input),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_matchmaking_team',
    {
      title: 'Update a Game Center matchmaking team',
      description: 'PATCH /v1/gameCenterMatchmakingTeams/{id} — minPlayers and/or maxPlayers.',
      inputSchema: z.object({
        teamId: TeamIdSchema,
        minPlayers: PlayersCountSchema.optional(),
        maxPlayers: PlayersCountSchema.optional(),
      }),
    },
    async ({ teamId, ...changes }) => {
      try {
        return await send(
          `/v1/gameCenterMatchmakingTeams/${encodeURIComponent(teamId)}`,
          'PATCH',
          buildMatchmakingTeamPatchBody(teamId, changes),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  simpleDelete(
    'asc_delete_game_center_matchmaking_team',
    'Delete a Game Center matchmaking team',
    'DELETE /v1/gameCenterMatchmakingTeams/{id}. Rules that name the team stop matching it.',
    '/v1/gameCenterMatchmakingTeams',
    'teamId',
  );

  // ===== Matchmaking: queues =====

  server.registerTool(
    'asc_list_game_center_matchmaking_queues',
    {
      title: 'List Game Center matchmaking queues',
      description:
        'List matchmaking queues on this team, or only those using a rule set (ruleSetId). A queue is what your game names in GKMatchRequest.queueName.',
      inputSchema: z.object({
        ruleSetId: RuleSetIdSchema.optional(),
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ ruleSetId, maxItems, raw }) => {
      try {
        const path = ruleSetId
          ? `/v1/gameCenterMatchmakingRuleSets/${encodeURIComponent(ruleSetId)}/matchmakingQueues`
          : '/v1/gameCenterMatchmakingQueues';
        const pages = await list(path, maxItems);
        if (raw) return json(pages);
        return textResult(
          digestGameCenterRows(
            pages,
            ['referenceName', 'classicMatchmakingBundleIds'],
            'matchmaking queues',
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_game_center_matchmaking_queue',
    {
      title: 'Get a Game Center matchmaking queue',
      description:
        'GET /v1/gameCenterMatchmakingQueues/{id} with its rule set and experiment rule set included.',
      inputSchema: z.object({ queueId: QueueIdSchema }),
    },
    async ({ queueId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/gameCenterMatchmakingQueues/${encodeURIComponent(queueId)}?include=ruleSet,experimentRuleSet`,
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_matchmaking_queue',
    {
      title: 'Create a Game Center matchmaking queue',
      description:
        'POST /v1/gameCenterMatchmakingQueues. Creates a queue on a rule set. experimentRuleSetId runs a second rule set on part of the traffic (compare with the experiment* metrics). classicMatchmakingBundleIds lets older builds that use classic matchmaking join the queue.',
      inputSchema: z.object({
        referenceName: z.string().min(1).describe('Queue name your game passes in GKMatchRequest.'),
        ruleSetId: RuleSetIdSchema,
        experimentRuleSetId: RuleSetIdSchema.optional(),
        classicMatchmakingBundleIds: z.array(z.string().min(1)).optional(),
      }),
    },
    async (input) => {
      try {
        return await send(
          '/v1/gameCenterMatchmakingQueues',
          'POST',
          buildMatchmakingQueueCreateBody(input),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_matchmaking_queue',
    {
      title: 'Update a Game Center matchmaking queue',
      description:
        'PATCH /v1/gameCenterMatchmakingQueues/{id} — swap the rule set or experiment rule set, or replace classicMatchmakingBundleIds (the list is replaced, not merged). Live players move to the new rules at once.',
      inputSchema: z.object({
        queueId: QueueIdSchema,
        ruleSetId: RuleSetIdSchema.optional(),
        experimentRuleSetId: RuleSetIdSchema.optional(),
        classicMatchmakingBundleIds: z.array(z.string().min(1)).optional(),
      }),
    },
    async ({ queueId, ...changes }) => {
      try {
        return await send(
          `/v1/gameCenterMatchmakingQueues/${encodeURIComponent(queueId)}`,
          'PATCH',
          buildMatchmakingQueuePatchBody(queueId, changes),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  simpleDelete(
    'asc_delete_game_center_matchmaking_queue',
    'Delete a Game Center matchmaking queue',
    'DELETE /v1/gameCenterMatchmakingQueues/{id}. ⚠️ Shipped builds that request this queue name stop finding matches. Confirm no live build uses it first.',
    '/v1/gameCenterMatchmakingQueues',
    'queueId',
  );

  // ===== Matchmaking metrics =====

  const queueMetricNames = Object.keys(QUEUE_METRICS) as Array<keyof typeof QUEUE_METRICS>;
  const ruleMetricNames = Object.keys(RULE_METRICS) as Array<keyof typeof RULE_METRICS>;

  server.registerTool(
    'asc_get_game_center_matchmaking_queue_metrics',
    {
      title: 'Get Game Center matchmaking queue metrics',
      description:
        'Time-series metrics for a matchmaking queue: matchmakingRequests (count + seconds in queue, by result MATCHED/CANCELED/EXPIRED), matchmakingQueueSizes (requests waiting), matchmakingSessions (matches made + player count), and the experiment* variants for the experiment rule set. groupBy / filters / sort are checked against the chosen metric.',
      inputSchema: z.object({
        queueId: QueueIdSchema,
        metric: z.enum(queueMetricNames as [string, ...string[]]),
        granularity: GranularitySchema,
        groupBy: z.array(z.enum(['result', 'gameCenterDetail'])).optional(),
        result: z.enum(['MATCHED', 'CANCELED', 'EXPIRED']).optional().describe('filter[result]'),
        gameCenterDetailId: DetailIdSchema.optional().describe('filter[gameCenterDetail]'),
        sort: z.string().optional().describe('e.g. -count, p95SecondsInQueue.'),
        limit: z.number().int().positive().max(200).optional(),
        raw: RawSchema,
      }),
    },
    async ({
      queueId,
      metric,
      granularity,
      groupBy,
      result,
      gameCenterDetailId,
      sort,
      limit,
      raw,
    }) => {
      try {
        const spec = QUEUE_METRICS[metric as keyof typeof QUEUE_METRICS];
        const params = buildMetricsQuery(metric, spec, {
          granularity,
          groupBy,
          sort,
          limit,
          filters: { result, gameCenterDetail: gameCenterDetailId },
        });
        const doc = await client.request<{ data?: MetricSeries[] }>(
          withQuery(
            `/v1/gameCenterMatchmakingQueues/${encodeURIComponent(queueId)}/metrics/${metric}`,
            params,
          ),
        );
        return raw ? json(doc) : textResult(digestGameCenterMetrics(doc, metric));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_game_center_matchmaking_rule_metrics',
    {
      title: 'Get Game Center matchmaking rule metrics',
      description:
        'Time-series metrics for one matchmaking rule: matchmakingBooleanRuleResults (true/false counts), matchmakingNumberRuleResults (value distribution), matchmakingRuleErrors (expression errors). Group or filter by queue.',
      inputSchema: z.object({
        ruleId: RuleIdSchema,
        metric: z.enum(ruleMetricNames as [string, ...string[]]),
        granularity: GranularitySchema,
        groupBy: z.array(z.enum(['result', 'gameCenterMatchmakingQueue'])).optional(),
        result: z.string().optional().describe('filter[result] (boolean results only).'),
        queueId: QueueIdSchema.optional().describe('filter[gameCenterMatchmakingQueue]'),
        sort: z.string().optional().describe('e.g. -count.'),
        limit: z.number().int().positive().max(200).optional(),
        raw: RawSchema,
      }),
    },
    async ({ ruleId, metric, granularity, groupBy, result, queueId, sort, limit, raw }) => {
      try {
        const spec = RULE_METRICS[metric as keyof typeof RULE_METRICS];
        const params = buildMetricsQuery(metric, spec, {
          granularity,
          groupBy,
          sort,
          limit,
          filters: { result, gameCenterMatchmakingQueue: queueId },
        });
        const doc = await client.request<{ data?: MetricSeries[] }>(
          withQuery(
            `/v1/gameCenterMatchmakingRules/${encodeURIComponent(ruleId)}/metrics/${metric}`,
            params,
          ),
        );
        return raw ? json(doc) : textResult(digestGameCenterMetrics(doc, metric));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
