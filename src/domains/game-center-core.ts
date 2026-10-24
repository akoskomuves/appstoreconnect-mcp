import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError, ascErrorText } from '../errors.js';
import {
  buildIncludedIndex,
  type CollectedPages,
  type Column,
  formatTable,
  type JSONAPIResource,
  lookupIncluded,
  paginate,
} from '../jsonapi.js';
import { AppIdSchema, FileNameSchema, FileSizeSchema, LocalFilePathSchema } from '../schemas.js';
import {
  type AssetReserveResponse,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// Game Center core (App Store Connect API 4.5.1): the Game Center detail of an
// app, groups, and the achievement / leaderboard / leaderboard-set families.
// Activities, challenges, matchmaking and Game Center app versions live in a
// separate domain file.
//
// The model (v2, introduced in 4.4/4.5; every /v1 achievement / leaderboard /
// leaderboard-set CRUD path and every *Release resource is deprecated):
//
//   app ─1:1─ gameCenterDetail ─(optional)─ gameCenterGroup
//                │                              │
//                ├─ achievements / leaderboards / leaderboardSets (owned by
//                │  the detail for a single-app game, or by the group when
//                │  several apps share Game Center data)
//                │
//   achievement / leaderboard / leaderboardSet
//     └─ versions (version 1, 2, …; each has a GameCenterVersionState that
//        goes through review)
//          └─ localizations (one per locale: name + copy)
//               └─ image (to-one; three-step upload: reserve → PUT → commit)
//
//   * Create is POST /v2/<family> with an INLINE first version: the version is
//     a temp-id `${1}` resource in `included[]`, linked from
//     relationships.versions. `versions` is required by the spec.
//
//   * Owner: exactly one of gameCenterDetail or gameCenterGroup on create.
//
//   * Ordering lives on the owner: PATCH /v1/gameCenterDetails|Groups/{id}/
//     relationships/gameCenterAchievementsV2 (and …LeaderboardsV2, …SetsV2)
//     REPLACES the whole to-many list in the given order. Leaving an id out
//     drops it from the owner, so the ordering tools refuse a set mismatch.
//
//   * Leaderboard-set membership: POST adds, PATCH replaces (= reorders),
//     DELETE removes, on /v2/gameCenterLeaderboardSets/{id}/relationships/
//     gameCenterLeaderboards.
//
//   * Image update has only `uploaded` — no checksum, like the asset library.
//
//   * GameCenterDetail.challengeEnabled and the defaultLeaderboard /
//     defaultGroupLeaderboard relationships are deprecated; this file sends
//     the V2 relationships only.
//
// Delete gates (inferred from Apple's documented rule that live Game Center
// items cannot be deleted, not observed): an achievement / leaderboard / set
// whose versions reached review or went live is refused, and so is a
// localization or image whose version is no longer editable. `force` skips the
// pre-check.

// ----- Families -----

export type GameCenterFamily = 'achievement' | 'leaderboard' | 'leaderboardSet';

interface FamilyConfig {
  label: string; // tool-name fragment
  noun: string; // human text
  type: string;
  path: string;
  ownerRel: string; // relationship key on gameCenterDetails / gameCenterGroups
  versionType: string;
  versionPath: string;
  versionParentRel: string;
  locType: string;
  locPath: string;
  imageType: string;
  imagePath: string;
  archivable: boolean;
}

export const GAME_CENTER_FAMILIES: Record<GameCenterFamily, FamilyConfig> = {
  achievement: {
    label: 'achievement',
    noun: 'achievement',
    type: 'gameCenterAchievements',
    path: '/v2/gameCenterAchievements',
    ownerRel: 'gameCenterAchievementsV2',
    versionType: 'gameCenterAchievementVersions',
    versionPath: '/v2/gameCenterAchievementVersions',
    versionParentRel: 'achievement',
    locType: 'gameCenterAchievementLocalizations',
    locPath: '/v2/gameCenterAchievementLocalizations',
    imageType: 'gameCenterAchievementImages',
    imagePath: '/v2/gameCenterAchievementImages',
    archivable: true,
  },
  leaderboard: {
    label: 'leaderboard',
    noun: 'leaderboard',
    type: 'gameCenterLeaderboards',
    path: '/v2/gameCenterLeaderboards',
    ownerRel: 'gameCenterLeaderboardsV2',
    versionType: 'gameCenterLeaderboardVersions',
    versionPath: '/v2/gameCenterLeaderboardVersions',
    versionParentRel: 'leaderboard',
    locType: 'gameCenterLeaderboardLocalizations',
    locPath: '/v2/gameCenterLeaderboardLocalizations',
    imageType: 'gameCenterLeaderboardImages',
    imagePath: '/v2/gameCenterLeaderboardImages',
    archivable: true,
  },
  leaderboardSet: {
    label: 'leaderboard_set',
    noun: 'leaderboard set',
    type: 'gameCenterLeaderboardSets',
    path: '/v2/gameCenterLeaderboardSets',
    ownerRel: 'gameCenterLeaderboardSetsV2',
    versionType: 'gameCenterLeaderboardSetVersions',
    versionPath: '/v2/gameCenterLeaderboardSetVersions',
    versionParentRel: 'leaderboardSet',
    locType: 'gameCenterLeaderboardSetLocalizations',
    locPath: '/v2/gameCenterLeaderboardSetLocalizations',
    imageType: 'gameCenterLeaderboardSetImages',
    imagePath: '/v2/gameCenterLeaderboardSetImages',
    archivable: false,
  },
};

const FAMILY_FIELDS: Record<GameCenterFamily, string> = {
  achievement:
    'referenceName,vendorIdentifier,points,showBeforeEarned,repeatable,archived,activityProperties,gameCenterDetail,gameCenterGroup,versions',
  leaderboard:
    'defaultFormatter,referenceName,vendorIdentifier,submissionType,scoreSortType,scoreRangeStart,scoreRangeEnd,recurrenceStartDate,recurrenceDuration,recurrenceRule,archived,activityProperties,visibility,gameCenterDetail,gameCenterGroup,gameCenterLeaderboardSets,versions',
  leaderboardSet:
    'referenceName,vendorIdentifier,gameCenterDetail,gameCenterGroup,gameCenterLeaderboards,versions',
};

const LOC_FIELDS: Record<GameCenterFamily, string> = {
  achievement: 'locale,name,beforeEarnedDescription,afterEarnedDescription,version,image',
  leaderboard:
    'locale,name,formatterOverride,formatterSuffix,formatterSuffixSingular,description,version,image',
  leaderboardSet: 'locale,name,version,image',
};

const GC_DETAIL_FIELDS =
  'arcadeEnabled,app,gameCenterGroup,defaultLeaderboardV2,defaultGroupLeaderboardV2';
const GC_VERSION_FIELDS = 'version,state,localizations';
const GC_IMAGE_FIELDS =
  'fileSize,fileName,imageAsset,uploadOperations,assetDeliveryState,localization';

// ----- Enums -----

export const GAME_CENTER_VERSION_STATES = [
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'ACCEPTED',
  'PENDING_RELEASE',
  'LIVE',
  'REPLACED_WITH_NEW_VERSION',
] as const;

// Editable = the version has not been submitted, or came back from review.
const EDITABLE_VERSION_STATES = new Set<string>([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
]);

const LeaderboardFormatterSchema = z
  .enum([
    'INTEGER',
    'DECIMAL_POINT_1_PLACE',
    'DECIMAL_POINT_2_PLACE',
    'DECIMAL_POINT_3_PLACE',
    'ELAPSED_TIME_CENTISECOND',
    'ELAPSED_TIME_MINUTE',
    'ELAPSED_TIME_SECOND',
    'MONEY_POUND_DECIMAL',
    'MONEY_POUND',
    'MONEY_DOLLAR_DECIMAL',
    'MONEY_DOLLAR',
    'MONEY_EURO_DECIMAL',
    'MONEY_EURO',
    'MONEY_FRANC_DECIMAL',
    'MONEY_FRANC',
    'MONEY_KRONER_DECIMAL',
    'MONEY_KRONER',
    'MONEY_YEN',
  ])
  .describe('How scores are shown, e.g. INTEGER, ELAPSED_TIME_SECOND, MONEY_DOLLAR_DECIMAL.');
type LeaderboardFormatter = z.infer<typeof LeaderboardFormatterSchema>;

const SubmissionTypeSchema = z
  .enum(['BEST_SCORE', 'MOST_RECENT_SCORE'])
  .describe('BEST_SCORE keeps each player’s best; MOST_RECENT_SCORE keeps the latest.');
const ScoreSortTypeSchema = z
  .enum(['ASC', 'DESC'])
  .describe('DESC = higher is better; ASC = lower is better (e.g. race times).');
const LeaderboardVisibilitySchema = z.enum(['SHOW_FOR_ALL', 'HIDE_FOR_ALL']);

// Apple types score ranges as strings with format "number".
// Accept a JSON number too; builders normalize with numStr().
const NumericStringSchema = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?$/, 'Must be a number'),
]);

type NumLike = string | number;

function numStr<T extends NumLike | null | undefined>(v: T): string | Exclude<T, NumLike> {
  return (typeof v === 'number' ? String(v) : v) as string | Exclude<T, NumLike>;
}

const StringMapSchema = z
  .record(z.string(), z.string())
  .describe('activityProperties: string → string map Apple passes to Game Center activities.');

// ----- ID schemas -----

const GameCenterDetailIdSchema = z
  .string()
  .min(1)
  .describe('GameCenterDetail ID — get it from asc_get_app_game_center_detail (one per app).');
const GameCenterGroupIdSchema = z
  .string()
  .min(1)
  .describe('GameCenterGroup ID from asc_list_game_center_groups.');
const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/, 'Must be a BCP-47 locale like "en-US"');

// ----- Body builders -----

interface Ref {
  type: string;
  id: string;
}

export interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
  included?: Array<{ type: string; id: string }>;
}

function tempId(n: number): string {
  // Apple's temp-ID convention for inline-created resources: the literal
  // string `${N}`. Concatenated so biome's noTemplateCurlyInString stays quiet.
  return `\${${n}}`;
}

function one(type: string, id: string): { data: Ref } {
  return { data: { type, id } };
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function requireChanges(attributes: Record<string, unknown>, rels: Record<string, unknown>): void {
  if (Object.keys(attributes).length === 0 && Object.keys(rels).length === 0) {
    throw new Error('Nothing to update: pass at least one field to change');
  }
}

export interface GameCenterOwner {
  gameCenterDetailId?: string | undefined;
  gameCenterGroupId?: string | undefined;
}

function ownerRelationships(owner: GameCenterOwner): Record<string, { data: Ref }> {
  if ((owner.gameCenterDetailId === undefined) === (owner.gameCenterGroupId === undefined)) {
    throw new Error('Pass exactly one of gameCenterDetailId or gameCenterGroupId');
  }
  return owner.gameCenterDetailId !== undefined
    ? { gameCenterDetail: one('gameCenterDetails', owner.gameCenterDetailId) }
    : { gameCenterGroup: one('gameCenterGroups', owner.gameCenterGroupId as string) };
}

function inlineFirstVersion(family: GameCenterFamily): {
  versions: { data: Ref[] };
  included: Ref[];
} {
  const version = { type: GAME_CENTER_FAMILIES[family].versionType, id: tempId(1) };
  return { versions: { data: [version] }, included: [version] };
}

export function buildGameCenterDetailCreateBody(appId: string): JSONAPIBody {
  // challengeEnabled is the only attribute and it is deprecated: send none.
  return { data: { type: 'gameCenterDetails', relationships: { app: one('apps', appId) } } };
}

export interface GameCenterDetailPatchInput {
  gameCenterDetailId: string;
  gameCenterGroupId?: string | undefined;
  defaultLeaderboardId?: string | undefined;
  defaultGroupLeaderboardId?: string | undefined;
}

export function buildGameCenterDetailPatchBody(input: GameCenterDetailPatchInput): JSONAPIBody {
  const relationships: Record<string, unknown> = {};
  if (input.gameCenterGroupId !== undefined) {
    relationships.gameCenterGroup = one('gameCenterGroups', input.gameCenterGroupId);
  }
  if (input.defaultLeaderboardId !== undefined) {
    relationships.defaultLeaderboardV2 = one('gameCenterLeaderboards', input.defaultLeaderboardId);
  }
  if (input.defaultGroupLeaderboardId !== undefined) {
    relationships.defaultGroupLeaderboardV2 = one(
      'gameCenterLeaderboards',
      input.defaultGroupLeaderboardId,
    );
  }
  requireChanges({}, relationships);
  return { data: { type: 'gameCenterDetails', id: input.gameCenterDetailId, relationships } };
}

export function buildGameCenterGroupBody(referenceName: string, groupId?: string): JSONAPIBody {
  const data: JSONAPIBody['data'] = { type: 'gameCenterGroups', attributes: { referenceName } };
  if (groupId !== undefined) data.id = groupId;
  return { data };
}

export interface AchievementCreateInput extends GameCenterOwner {
  referenceName: string;
  vendorIdentifier: string;
  points: number;
  showBeforeEarned: boolean;
  repeatable: boolean;
  activityProperties?: Record<string, string> | undefined;
}

export function buildAchievementCreateBody(input: AchievementCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    referenceName: input.referenceName,
    vendorIdentifier: input.vendorIdentifier,
    points: input.points,
    showBeforeEarned: input.showBeforeEarned,
    repeatable: input.repeatable,
  };
  setIfDefined(attributes, 'activityProperties', input.activityProperties);
  const { versions, included } = inlineFirstVersion('achievement');
  return {
    data: {
      type: 'gameCenterAchievements',
      attributes,
      relationships: { ...ownerRelationships(input), versions },
    },
    included,
  };
}

export interface AchievementPatchInput {
  achievementId: string;
  referenceName?: string | undefined;
  points?: number | undefined;
  showBeforeEarned?: boolean | undefined;
  repeatable?: boolean | undefined;
  archived?: boolean | undefined;
  activityProperties?: Record<string, string> | null | undefined;
}

export function buildAchievementPatchBody(input: AchievementPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  setIfDefined(attributes, 'referenceName', input.referenceName);
  setIfDefined(attributes, 'points', input.points);
  setIfDefined(attributes, 'showBeforeEarned', input.showBeforeEarned);
  setIfDefined(attributes, 'repeatable', input.repeatable);
  setIfDefined(attributes, 'archived', input.archived);
  setIfDefined(attributes, 'activityProperties', input.activityProperties);
  requireChanges(attributes, {});
  return { data: { type: 'gameCenterAchievements', id: input.achievementId, attributes } };
}

interface LeaderboardRecurrence {
  recurrenceStartDate?: string | null | undefined;
  recurrenceDuration?: string | null | undefined;
  recurrenceRule?: string | null | undefined;
}

export interface LeaderboardCreateInput extends GameCenterOwner, LeaderboardRecurrence {
  referenceName: string;
  vendorIdentifier: string;
  defaultFormatter: LeaderboardFormatter;
  submissionType: 'BEST_SCORE' | 'MOST_RECENT_SCORE';
  scoreSortType: 'ASC' | 'DESC';
  scoreRangeStart?: NumLike | undefined;
  scoreRangeEnd?: NumLike | undefined;
  visibility?: 'SHOW_FOR_ALL' | 'HIDE_FOR_ALL' | undefined;
  activityProperties?: Record<string, string> | undefined;
  leaderboardSetIds?: string[] | undefined;
}

function checkRecurrence(input: LeaderboardRecurrence, partialAllowed: boolean): void {
  const set = [input.recurrenceStartDate, input.recurrenceDuration, input.recurrenceRule].filter(
    (v) => v !== undefined && v !== null,
  ).length;
  if (!partialAllowed && set !== 0 && set !== 3) {
    throw new Error(
      'A recurring leaderboard needs all three of recurrenceStartDate, recurrenceDuration and recurrenceRule',
    );
  }
}

function checkScoreRange(start: NumLike | null | undefined, end: NumLike | null | undefined): void {
  if (
    start !== undefined &&
    start !== null &&
    end !== undefined &&
    end !== null &&
    Number(start) > Number(end)
  ) {
    throw new Error(`scoreRangeStart (${start}) is greater than scoreRangeEnd (${end})`);
  }
}

export function buildLeaderboardCreateBody(input: LeaderboardCreateInput): JSONAPIBody {
  checkRecurrence(input, false);
  checkScoreRange(input.scoreRangeStart, input.scoreRangeEnd);
  const attributes: Record<string, unknown> = {
    referenceName: input.referenceName,
    vendorIdentifier: input.vendorIdentifier,
    defaultFormatter: input.defaultFormatter,
    submissionType: input.submissionType,
    scoreSortType: input.scoreSortType,
  };
  setIfDefined(attributes, 'scoreRangeStart', numStr(input.scoreRangeStart));
  setIfDefined(attributes, 'scoreRangeEnd', numStr(input.scoreRangeEnd));
  setIfDefined(attributes, 'recurrenceStartDate', input.recurrenceStartDate);
  setIfDefined(attributes, 'recurrenceDuration', input.recurrenceDuration);
  setIfDefined(attributes, 'recurrenceRule', input.recurrenceRule);
  setIfDefined(attributes, 'visibility', input.visibility);
  setIfDefined(attributes, 'activityProperties', input.activityProperties);
  const { versions, included } = inlineFirstVersion('leaderboard');
  const relationships: Record<string, unknown> = { ...ownerRelationships(input), versions };
  if (input.leaderboardSetIds?.length) {
    relationships.gameCenterLeaderboardSets = {
      data: input.leaderboardSetIds.map((id) => ({ type: 'gameCenterLeaderboardSets', id })),
    };
  }
  return { data: { type: 'gameCenterLeaderboards', attributes, relationships }, included };
}

export interface LeaderboardPatchInput extends LeaderboardRecurrence {
  leaderboardId: string;
  referenceName?: string | undefined;
  defaultFormatter?: LeaderboardFormatter | undefined;
  submissionType?: 'BEST_SCORE' | 'MOST_RECENT_SCORE' | undefined;
  scoreSortType?: 'ASC' | 'DESC' | undefined;
  scoreRangeStart?: NumLike | null | undefined;
  scoreRangeEnd?: NumLike | null | undefined;
  visibility?: 'SHOW_FOR_ALL' | 'HIDE_FOR_ALL' | undefined;
  archived?: boolean | undefined;
  activityProperties?: Record<string, string> | null | undefined;
}

export function buildLeaderboardPatchBody(input: LeaderboardPatchInput): JSONAPIBody {
  checkScoreRange(input.scoreRangeStart, input.scoreRangeEnd);
  const attributes: Record<string, unknown> = {};
  for (const key of [
    'referenceName',
    'defaultFormatter',
    'submissionType',
    'scoreSortType',
    'scoreRangeStart',
    'scoreRangeEnd',
    'recurrenceStartDate',
    'recurrenceDuration',
    'recurrenceRule',
    'visibility',
    'archived',
    'activityProperties',
  ] as const) {
    const value = input[key];
    setIfDefined(attributes, key, typeof value === 'number' ? String(value) : value);
  }
  requireChanges(attributes, {});
  return { data: { type: 'gameCenterLeaderboards', id: input.leaderboardId, attributes } };
}

export interface LeaderboardSetCreateInput extends GameCenterOwner {
  referenceName: string;
  vendorIdentifier: string;
  leaderboardIds?: string[] | undefined;
}

export function buildLeaderboardSetCreateBody(input: LeaderboardSetCreateInput): JSONAPIBody {
  const { versions, included } = inlineFirstVersion('leaderboardSet');
  const relationships: Record<string, unknown> = { ...ownerRelationships(input), versions };
  if (input.leaderboardIds?.length) {
    relationships.gameCenterLeaderboards = {
      data: input.leaderboardIds.map((id) => ({ type: 'gameCenterLeaderboards', id })),
    };
  }
  return {
    data: {
      type: 'gameCenterLeaderboardSets',
      attributes: { referenceName: input.referenceName, vendorIdentifier: input.vendorIdentifier },
      relationships,
    },
    included,
  };
}

export function buildLeaderboardSetPatchBody(
  leaderboardSetId: string,
  referenceName: string,
): JSONAPIBody {
  return {
    data: {
      type: 'gameCenterLeaderboardSets',
      id: leaderboardSetId,
      attributes: { referenceName },
    },
  };
}

export function buildGameCenterVersionCreateBody(
  family: GameCenterFamily,
  parentId: string,
): JSONAPIBody {
  const f = GAME_CENTER_FAMILIES[family];
  return {
    data: { type: f.versionType, relationships: { [f.versionParentRel]: one(f.type, parentId) } },
  };
}

export interface GameCenterLocalizationInput {
  family: GameCenterFamily;
  versionId?: string | undefined; // create only
  localizationId?: string | undefined; // patch only
  locale?: string | undefined; // create only
  name?: string | undefined;
  beforeEarnedDescription?: string | undefined;
  afterEarnedDescription?: string | undefined;
  formatterOverride?: LeaderboardFormatter | null | undefined;
  formatterSuffix?: string | null | undefined;
  formatterSuffixSingular?: string | null | undefined;
  description?: string | null | undefined;
}

const LOC_ATTRS: Record<GameCenterFamily, readonly string[]> = {
  achievement: ['name', 'beforeEarnedDescription', 'afterEarnedDescription'],
  leaderboard: [
    'name',
    'formatterOverride',
    'formatterSuffix',
    'formatterSuffixSingular',
    'description',
  ],
  leaderboardSet: ['name'],
};

const LOC_REQUIRED: Record<GameCenterFamily, readonly string[]> = {
  achievement: ['name', 'beforeEarnedDescription', 'afterEarnedDescription'],
  leaderboard: ['name'],
  leaderboardSet: ['name'],
};

function collectLocAttributes(input: GameCenterLocalizationInput): Record<string, unknown> {
  const allowed = LOC_ATTRS[input.family];
  const attributes: Record<string, unknown> = {};
  for (const key of [
    'name',
    'beforeEarnedDescription',
    'afterEarnedDescription',
    'formatterOverride',
    'formatterSuffix',
    'formatterSuffixSingular',
    'description',
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!allowed.includes(key)) {
      throw new Error(`${key} does not apply to ${GAME_CENTER_FAMILIES[input.family].noun} copy`);
    }
    attributes[key] = value;
  }
  return attributes;
}

export function buildGameCenterLocalizationCreateBody(
  input: GameCenterLocalizationInput,
): JSONAPIBody {
  const f = GAME_CENTER_FAMILIES[input.family];
  if (!input.versionId || !input.locale) throw new Error('versionId and locale are required');
  const attributes = { locale: input.locale, ...collectLocAttributes(input) };
  const missing = LOC_REQUIRED[input.family].filter(
    (k) => (attributes as Record<string, unknown>)[k] === undefined,
  );
  if (missing.length) throw new Error(`Missing required field(s): ${missing.join(', ')}`);
  return {
    data: {
      type: f.locType,
      attributes,
      relationships: { version: one(f.versionType, input.versionId) },
    },
  };
}

export function buildGameCenterLocalizationPatchBody(
  input: GameCenterLocalizationInput,
): JSONAPIBody {
  const f = GAME_CENTER_FAMILIES[input.family];
  if (!input.localizationId) throw new Error('localizationId is required');
  if (input.locale !== undefined) throw new Error('locale is immutable after create');
  const attributes = collectLocAttributes(input);
  requireChanges(attributes, {});
  return { data: { type: f.locType, id: input.localizationId, attributes } };
}

export function buildGameCenterImageCreateBody(
  family: GameCenterFamily,
  localizationId: string,
  fileName: string,
  fileSize: number,
): JSONAPIBody {
  const f = GAME_CENTER_FAMILIES[family];
  return {
    data: {
      type: f.imageType,
      attributes: { fileName, fileSize },
      relationships: { localization: one(f.locType, localizationId) },
    },
  };
}

export function buildGameCenterImageCommitBody(
  family: GameCenterFamily,
  imageId: string,
): JSONAPIBody {
  return {
    data: {
      type: GAME_CENTER_FAMILIES[family].imageType,
      id: imageId,
      attributes: { uploaded: true },
    },
  };
}

export function buildLinkagesBody(type: string, ids: string[]): { data: Ref[] } {
  if (new Set(ids).size !== ids.length) throw new Error('The id list contains duplicates');
  return { data: ids.map((id) => ({ type, id })) };
}

export function buildMemberLocalizationCreateBody(input: {
  leaderboardSetId: string;
  leaderboardId: string;
  locale: string;
  name: string;
}): JSONAPIBody {
  return {
    data: {
      type: 'gameCenterLeaderboardSetMemberLocalizations',
      attributes: { locale: input.locale, name: input.name },
      relationships: {
        gameCenterLeaderboardSet: one('gameCenterLeaderboardSets', input.leaderboardSetId),
        gameCenterLeaderboard: one('gameCenterLeaderboards', input.leaderboardId),
      },
    },
  };
}

export function buildMemberLocalizationPatchBody(id: string, name: string): JSONAPIBody {
  return {
    data: { type: 'gameCenterLeaderboardSetMemberLocalizations', id, attributes: { name } },
  };
}

export function buildScoreModerationPatchBody(id: string, blocked: boolean): JSONAPIBody {
  return { data: { type: 'gameCenterScoreModerations', id, attributes: { blocked } } };
}

export function buildDetailPlayerPatchBody(
  id: string,
  blocked: boolean,
  bundleId?: string,
): JSONAPIBody {
  const attributes: Record<string, unknown> = { blocked };
  setIfDefined(attributes, 'bundleId', bundleId);
  return { data: { type: 'gameCenterDetailPlayers', id, attributes } };
}

interface PlayerSubmissionBase {
  bundleId: string;
  scopedPlayerId: string;
  vendorIdentifier: string;
  submittedDate?: string | undefined;
  preReleased?: boolean | undefined;
  challengeIds?: string[] | undefined;
}

export function buildLeaderboardEntrySubmissionBody(
  input: PlayerSubmissionBase & { score: NumLike; context?: NumLike | undefined },
): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    bundleId: input.bundleId,
    scopedPlayerId: input.scopedPlayerId,
    vendorIdentifier: input.vendorIdentifier,
    score: numStr(input.score),
  };
  setIfDefined(attributes, 'context', numStr(input.context));
  setIfDefined(attributes, 'submittedDate', input.submittedDate);
  setIfDefined(attributes, 'preReleased', input.preReleased);
  setIfDefined(attributes, 'challengeIds', input.challengeIds);
  return { data: { type: 'gameCenterLeaderboardEntrySubmissions', attributes } };
}

export function buildPlayerAchievementSubmissionBody(
  input: PlayerSubmissionBase & { percentageAchieved: number },
): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    bundleId: input.bundleId,
    scopedPlayerId: input.scopedPlayerId,
    vendorIdentifier: input.vendorIdentifier,
    percentageAchieved: input.percentageAchieved,
  };
  setIfDefined(attributes, 'submittedDate', input.submittedDate);
  setIfDefined(attributes, 'preReleased', input.preReleased);
  setIfDefined(attributes, 'challengeIds', input.challengeIds);
  return { data: { type: 'gameCenterPlayerAchievementSubmissions', attributes } };
}

// ----- Gates -----

export interface GameCenterGate {
  allow: boolean;
  reason?: string;
  next?: string;
}

/** Delete of an achievement / leaderboard / set: refused once any version left the editable states. */
export function evaluateGameCenterItemDeleteGate(
  family: GameCenterFamily,
  versionStates: string[],
): GameCenterGate {
  const locked = versionStates.filter((s) => !EDITABLE_VERSION_STATES.has(s));
  if (locked.length === 0) return { allow: true };
  const f = GAME_CENTER_FAMILIES[family];
  return {
    allow: false,
    reason: `A version of this ${f.noun} is ${[...new Set(locked)].join(', ')}. Apple does not delete Game Center items that went to review or live.`,
    next: f.archivable
      ? `Hide it instead: asc_patch_game_center_${f.label} with archived:true.`
      : `Remove its leaderboards or stop using it; a ${f.noun} cannot be archived.`,
  };
}

/** Delete of a localization or image: refused when its version is not editable. */
export function evaluateGameCenterVersionEditGate(
  family: GameCenterFamily,
  versionState: string | undefined,
): GameCenterGate {
  if (versionState === undefined || EDITABLE_VERSION_STATES.has(versionState)) {
    return { allow: true };
  }
  const f = GAME_CENTER_FAMILIES[family];
  return {
    allow: false,
    reason: `Its ${f.noun} version is ${versionState}; only PREPARE_FOR_SUBMISSION / READY_FOR_REVIEW / DEVELOPER_REJECTED / REJECTED versions are editable.`,
    next: `Create a new version with asc_post_game_center_${f.label}_version and edit that one.`,
  };
}

/** Owner ordering PATCH replaces the list: refuse unless it is a permutation of the current one. */
export function diffOrdering(
  current: string[],
  proposed: string[],
): { missing: string[]; extra: string[] } {
  const cur = new Set(current);
  const prop = new Set(proposed);
  return {
    missing: current.filter((id) => !prop.has(id)),
    extra: proposed.filter((id) => !cur.has(id)),
  };
}

// ----- Digests -----

function attr(r: JSONAPIResource, key: string): string {
  const v = r.attributes?.[key];
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function relIds(r: JSONAPIResource, key: string): string[] {
  const d = r.relationships?.[key]?.data;
  if (!d) return [];
  return Array.isArray(d) ? d.map((x) => x.id) : [d.id];
}

function footer(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ' (truncated — raise maxItems or pass raw:true)' : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

function latestVersion(
  r: JSONAPIResource,
  index: Map<string, JSONAPIResource>,
  versionType: string,
): string {
  let best: JSONAPIResource | undefined;
  for (const id of relIds(r, 'versions')) {
    const v = lookupIncluded(index, versionType, id);
    if (!v) continue;
    if (
      !best ||
      Number(v.attributes?.['version'] ?? 0) > Number(best.attributes?.['version'] ?? 0)
    ) {
      best = v;
    }
  }
  return best ? `v${attr(best, 'version')} ${attr(best, 'state')}` : '';
}

export function digestGameCenterItems(family: GameCenterFamily, pages: CollectedPages): string {
  const f = GAME_CENTER_FAMILIES[family];
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [{ header: 'VENDOR_ID' }, { header: 'REFERENCE_NAME' }];
  if (family === 'achievement') {
    columns.push(
      { header: 'POINTS', align: 'right' },
      { header: 'REPEAT' },
      { header: 'ARCHIVED' },
    );
  } else if (family === 'leaderboard') {
    columns.push(
      { header: 'FORMAT' },
      { header: 'SORT' },
      { header: 'RECURS' },
      { header: 'ARCHIVED' },
    );
  } else {
    columns.push({ header: 'LEADERBOARDS', align: 'right' });
  }
  columns.push({ header: 'LATEST_VERSION' }, { header: 'ID' });
  const rows = pages.data.map((r) => {
    const row = [attr(r, 'vendorIdentifier'), attr(r, 'referenceName')];
    if (family === 'achievement') {
      row.push(attr(r, 'points'), attr(r, 'repeatable'), attr(r, 'archived'));
    } else if (family === 'leaderboard') {
      row.push(
        attr(r, 'defaultFormatter'),
        `${attr(r, 'submissionType')}/${attr(r, 'scoreSortType')}`,
        attr(r, 'recurrenceRule') ? 'yes' : '',
        attr(r, 'archived'),
      );
    } else {
      row.push(String(relIds(r, 'gameCenterLeaderboards').length || ''));
    }
    row.push(latestVersion(r, index, f.versionType), r.id);
    return row;
  });
  return `${footer(pages, `${f.noun}s`)}\n\n${formatTable(columns, rows)}`;
}

export function digestGameCenterVersions(family: GameCenterFamily, pages: CollectedPages): string {
  const f = GAME_CENTER_FAMILIES[family];
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'VERSION', align: 'right' },
    { header: 'STATE' },
    { header: 'LOCALES' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((v) => [
    attr(v, 'version'),
    attr(v, 'state'),
    relIds(v, 'localizations')
      .map((id) => attr(lookupIncluded(index, f.locType, id) ?? { type: '', id: '' }, 'locale'))
      .filter(Boolean)
      .join(','),
    v.id,
  ]);
  rows.sort((a, b) => Number(b[0]) - Number(a[0]));
  return `${footer(pages, `${f.noun} versions`)}\n\n${formatTable(columns, rows)}`;
}

export function digestGameCenterLocalizations(
  family: GameCenterFamily,
  pages: CollectedPages,
): string {
  const f = GAME_CENTER_FAMILIES[family];
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [{ header: 'LOCALE' }, { header: 'NAME' }];
  if (family === 'leaderboard') columns.push({ header: 'SUFFIX' });
  columns.push({ header: 'IMAGE' }, { header: 'ID' });
  const rows = pages.data.map((l) => {
    const row = [attr(l, 'locale'), attr(l, 'name')];
    if (family === 'leaderboard') row.push(attr(l, 'formatterSuffix'));
    const imageId = relIds(l, 'image')[0];
    const image = imageId ? lookupIncluded(index, f.imageType, imageId) : undefined;
    // assetDeliveryState is a struct ({ state, errors, warnings }), not a string.
    const delivery = image?.attributes?.['assetDeliveryState'] as { state?: string } | undefined;
    row.push(imageId ? (delivery?.state ?? 'yes') : '', l.id);
    return row;
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${footer(pages, `${f.noun} localizations`)}\n\n${formatTable(columns, rows)}`;
}

export function digestGameCenterGroups(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'REFERENCE_NAME' },
    { header: 'APPS', align: 'right' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((g) => [
    attr(g, 'referenceName'),
    String(relIds(g, 'gameCenterDetails').length),
    g.id,
  ]);
  return `${footer(pages, 'Game Center groups')}\n\n${formatTable(columns, rows)}`;
}

export function digestScoreModerations(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'RANK', align: 'right' },
    { header: 'SCORE', align: 'right' },
    { header: 'PLAYER' },
    { header: 'SUBMITTED' },
    { header: 'BLOCKED' },
    { header: 'PRE_RELEASE' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((m) => {
    const playerId = relIds(m, 'player')[0];
    const player = lookupIncluded(index, 'gameCenterDetailPlayers', playerId);
    return [
      attr(m, 'rank'),
      attr(m, 'score'),
      player ? attr(player, 'nickname') || player.id : (playerId ?? ''),
      attr(m, 'submittedDate'),
      attr(m, 'blocked'),
      attr(m, 'preReleased'),
      m.id,
    ];
  });
  return `${footer(pages, 'leaderboard entries')}\n\n${formatTable(columns, rows)}`;
}

export function digestDetailPlayers(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'NICKNAME' }, { header: 'BLOCKED' }, { header: 'ID' }];
  const rows = pages.data.map((p) => [attr(p, 'nickname'), attr(p, 'blocked'), p.id]);
  return `${footer(pages, 'blocked players')}\n\n${formatTable(columns, rows)}`;
}

export function digestMemberLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'LOCALE' }, { header: 'NAME' }, { header: 'ID' }];
  const rows = pages.data.map((l) => [attr(l, 'locale'), attr(l, 'name'), l.id]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${footer(pages, 'member localizations')}\n\n${formatTable(columns, rows)}`;
}

// ----- Tool helpers -----

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

// In the 4.5.1 spec but answered 404 PATH_ERROR live on 2026-10-24 (every
// path variant tried), so Apple has not switched them on yet.
const NOT_LIVE_NOTE =
  'Apple answers this endpoint with 404 PATH_ERROR ("The URL path is not valid") as of 2026-10-24, although it is in the 4.5.1 spec — it does not seem to be switched on yet. Retry later; the App Store Connect web UI (Game Center → Leaderboards / Players) has the same data.';

function notLiveResult(err: unknown) {
  if (ascErrorText(err).includes('PATH_ERROR')) {
    return {
      content: [{ type: 'text' as const, text: `${NOT_LIVE_NOTE}\n\n${formatASCError(err)}` }],
      isError: true,
    };
  }
  return errorResult(err);
}

function refusal(what: string, gate: GameCenterGate) {
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Refused: ${what}.`,
          '',
          `Reason: ${gate.reason ?? ''}`,
          `Next:   ${gate.next ?? ''}`,
          '',
          'If you believe Apple would accept it, retry with force:true — the pre-check is skipped and Apple decides.',
        ].join('\n'),
      },
    ],
    isError: true,
  };
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const MaxItemsSchema = z.number().int().positive().max(2000).default(500);
const RawSchema = z.boolean().default(false);
const ForceSchema = z
  .boolean()
  .default(false)
  .describe(
    'Skip the client-side state pre-check and send the request anyway, letting Apple be the judge. The gate is inferred from Apple’s documented rules, not observed, so it can be wrong.',
  );

const OWNER_PATHS = {
  detail: { type: 'gameCenterDetails', path: '/v1/gameCenterDetails' },
  group: { type: 'gameCenterGroups', path: '/v1/gameCenterGroups' },
} as const;

function ownerPath(owner: GameCenterOwner): string {
  if ((owner.gameCenterDetailId === undefined) === (owner.gameCenterGroupId === undefined)) {
    throw new Error('Pass exactly one of gameCenterDetailId or gameCenterGroupId');
  }
  return owner.gameCenterDetailId !== undefined
    ? `${OWNER_PATHS.detail.path}/${enc(owner.gameCenterDetailId)}`
    : `${OWNER_PATHS.group.path}/${enc(owner.gameCenterGroupId as string)}`;
}

export function buildItemListQuery(
  family: GameCenterFamily,
  filters: {
    referenceName?: string[] | undefined;
    archived?: boolean | undefined;
    id?: string[] | undefined;
  },
): URLSearchParams {
  const f = GAME_CENTER_FAMILIES[family];
  const params = new URLSearchParams();
  params.set(`fields[${f.type}]`, FAMILY_FIELDS[family]);
  // Without the include Apple returns no linkage data for to-many
  // relationships, so the set's LEADERBOARDS column would read empty.
  params.set(
    'include',
    family === 'leaderboardSet' ? 'versions,gameCenterLeaderboards' : 'versions',
  );
  params.set(`fields[${f.versionType}]`, 'version,state');
  params.set('limit[versions]', '50');
  if (family === 'leaderboardSet') {
    params.set('fields[gameCenterLeaderboards]', 'vendorIdentifier');
    params.set('limit[gameCenterLeaderboards]', '50');
  }
  if (filters.referenceName?.length)
    params.set('filter[referenceName]', filters.referenceName.join(','));
  if (filters.archived !== undefined && family !== 'leaderboardSet') {
    params.set('filter[archived]', String(filters.archived));
  }
  if (filters.id?.length) params.set('filter[id]', filters.id.join(','));
  params.set('limit', '200');
  return params;
}

export function registerGameCenterCore(server: McpServer, client: ASCClient): void {
  async function versionStateOfLocalization(
    family: GameCenterFamily,
    localizationId: string,
  ): Promise<string | undefined> {
    const f = GAME_CENTER_FAMILIES[family];
    const params = new URLSearchParams();
    params.set('include', 'version');
    params.set(`fields[${f.locType}]`, 'locale,version');
    params.set(`fields[${f.versionType}]`, 'version,state');
    const res = await client.request<{ data?: JSONAPIResource; included?: JSONAPIResource[] }>(
      withQuery(`${f.locPath}/${enc(localizationId)}`, params),
    );
    const versionId = res.data ? relIds(res.data, 'version')[0] : undefined;
    const version = (res.included ?? []).find(
      (r) => r.type === f.versionType && r.id === versionId,
    );
    return version ? attr(version, 'state') || undefined : undefined;
  }

  // ----- Detail -----

  server.registerTool(
    'asc_get_app_game_center_detail',
    {
      title: "Get an app's Game Center detail",
      description:
        "Fetch an app's GameCenterDetail — the root every Game Center tool hangs off (one per app). Its id is the gameCenterDetailId the achievement / leaderboard / leaderboard-set tools take. Includes the app's Game Center group (if the app shares Game Center data with other apps) and the default leaderboards. An app without Game Center answers data: null (the tool says so); create the detail with asc_post_game_center_detail.",
      inputSchema: z.object({ appId: AppIdSchema }),
    },
    async ({ appId }) => {
      const params = new URLSearchParams();
      params.set('fields[gameCenterDetails]', GC_DETAIL_FIELDS);
      params.set('include', 'gameCenterGroup');
      try {
        const data = await client.request<{ data?: unknown }>(
          withQuery(`/v1/apps/${enc(appId)}/gameCenterDetail`, params),
        );
        // Live 2026-10-24: an app without Game Center answers 200 + data:null.
        if (!data.data) {
          return textResult(
            `App ${appId} has no Game Center detail (data: null) — Game Center was never set up for it. asc_post_game_center_detail creates one.`,
          );
        }
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        if (err instanceof ASCError && err.status === 404) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `App ${appId} has no Game Center detail (404). Game Center was never set up for it; asc_post_game_center_detail creates one.\n\n${formatASCError(err)}`,
              },
            ],
            isError: true,
          };
        }
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_game_center_detail',
    {
      title: 'Get a Game Center detail',
      description:
        'Fetch a GameCenterDetail by id with its app, group and default leaderboards (V2 relationships).',
      inputSchema: z.object({ gameCenterDetailId: GameCenterDetailIdSchema }),
    },
    async ({ gameCenterDetailId }) => {
      const params = new URLSearchParams();
      params.set('fields[gameCenterDetails]', GC_DETAIL_FIELDS);
      params.set('include', 'app,gameCenterGroup,defaultLeaderboardV2,defaultGroupLeaderboardV2');
      params.set('fields[apps]', 'name,bundleId');
      try {
        const data = await client.request<unknown>(
          withQuery(`/v1/gameCenterDetails/${enc(gameCenterDetailId)}`, params),
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_detail',
    {
      title: 'Set up Game Center for an app',
      description:
        'Create the GameCenterDetail of an app — turns on Game Center configuration in App Store Connect so achievements and leaderboards can be added. One per app; Apple refuses a second. The app still needs the Game Center capability in its bundle id and must ship a version with Game Center enabled for players to see anything. (challengeEnabled is deprecated and not sent.)',
      inputSchema: z.object({ appId: AppIdSchema }),
    },
    async ({ appId }) => {
      try {
        const data = await client.request<unknown>('/v1/gameCenterDetails', {
          method: 'POST',
          body: JSON.stringify(buildGameCenterDetailCreateBody(appId)),
        });
        return textResult(
          `Created Game Center detail for app ${appId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_detail',
    {
      title: 'Update a Game Center detail',
      description:
        "PATCH a GameCenterDetail's relationships: move the app into a Game Center group (gameCenterGroupId — shared achievements/leaderboards across apps; Apple treats joining a group as one-way for live games), and set the default leaderboard (defaultLeaderboardId) or default group leaderboard (defaultGroupLeaderboardId) shown first in the Game Center dashboard. Pass at least one.",
      inputSchema: z.object({
        gameCenterDetailId: GameCenterDetailIdSchema,
        gameCenterGroupId: GameCenterGroupIdSchema.optional(),
        defaultLeaderboardId: z.string().min(1).optional(),
        defaultGroupLeaderboardId: z.string().min(1).optional(),
      }),
    },
    async (input) => {
      try {
        const body = buildGameCenterDetailPatchBody(input);
        const data = await client.request<unknown>(
          `/v1/gameCenterDetails/${enc(input.gameCenterDetailId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return textResult(
          `Patched Game Center detail ${input.gameCenterDetailId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_game_center_detail_group',
    {
      title: "Get a Game Center detail's group",
      description:
        'Fetch the GameCenterGroup an app belongs to (data: null when the app is not in a group).',
      inputSchema: z.object({ gameCenterDetailId: GameCenterDetailIdSchema }),
    },
    async ({ gameCenterDetailId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/gameCenterDetails/${enc(gameCenterDetailId)}/gameCenterGroup?fields[gameCenterGroups]=referenceName,gameCenterDetails`,
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_list_game_center_blocked_players',
    {
      title: 'List blocked Game Center players',
      description:
        "List the players blocked on an app's Game Center (their scores are hidden from leaderboards). Unblock with asc_patch_game_center_detail_player blocked:false. ⚠️ Live 2026-10-24 Apple answered 404 PATH_ERROR for this path (in the spec, not switched on yet); the tool says so when it happens.",
      inputSchema: z.object({
        gameCenterDetailId: GameCenterDetailIdSchema,
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ gameCenterDetailId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/gameCenterDetails/${enc(gameCenterDetailId)}/blockedPlayers?limit=200`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestDetailPlayers(pages));
      } catch (err) {
        return notLiveResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_detail_player',
    {
      title: 'Block or unblock a Game Center player',
      description:
        "PATCH a GameCenterDetailPlayer: blocked:true hides the player's scores on this app's leaderboards (cheaters), blocked:false restores them. Player ids come from asc_list_game_center_blocked_players or the `player` of asc_list_game_center_leaderboard_score_moderations. ⚠️ Changes what players see on live leaderboards.",
      inputSchema: z.object({
        playerId: z.string().min(1).describe('GameCenterDetailPlayer id.'),
        blocked: z.boolean(),
        bundleId: z
          .string()
          .min(1)
          .optional()
          .describe('Optional bundleId attribute (spec field).'),
      }),
    },
    async ({ playerId, blocked, bundleId }) => {
      try {
        const data = await client.request<unknown>(`/v1/gameCenterDetailPlayers/${enc(playerId)}`, {
          method: 'PATCH',
          body: JSON.stringify(buildDetailPlayerPatchBody(playerId, blocked, bundleId)),
        });
        return textResult(
          `${blocked ? 'Blocked' : 'Unblocked'} player ${playerId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ----- Groups -----

  server.registerTool(
    'asc_list_game_center_groups',
    {
      title: 'List Game Center groups',
      description:
        'List the Game Center groups on the account. A group lets several apps share achievements, leaderboards and leaderboard sets. Pass gameCenterDetailId to find the group one app is in.',
      inputSchema: z.object({
        gameCenterDetailId: GameCenterDetailIdSchema.optional(),
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ gameCenterDetailId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[gameCenterGroups]', 'referenceName,gameCenterDetails');
      params.set('include', 'gameCenterDetails');
      params.set('fields[gameCenterDetails]', 'app');
      params.set('limit[gameCenterDetails]', '50');
      if (gameCenterDetailId) params.set('filter[gameCenterDetails]', gameCenterDetailId);
      params.set('limit', '200');
      try {
        const pages = await paginate(client, withQuery('/v1/gameCenterGroups', params), maxItems);
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestGameCenterGroups(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_game_center_group',
    {
      title: 'Get a Game Center group',
      description: 'Fetch one GameCenterGroup with its member Game Center details.',
      inputSchema: z.object({ gameCenterGroupId: GameCenterGroupIdSchema }),
    },
    async ({ gameCenterGroupId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/gameCenterGroups/${enc(gameCenterGroupId)}?include=gameCenterDetails&limit[gameCenterDetails]=50`,
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_list_game_center_group_details',
    {
      title: 'List the apps in a Game Center group',
      description:
        'List the GameCenterDetails (one per app) that belong to a group, with the app name and bundle id.',
      inputSchema: z.object({
        gameCenterGroupId: GameCenterGroupIdSchema,
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ gameCenterGroupId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/gameCenterGroups/${enc(gameCenterGroupId)}/gameCenterDetails?include=app&fields[apps]=name,bundleId&limit=200`,
          maxItems,
        );
        if (raw) return textResult(JSON.stringify(pages, null, 2));
        const index = buildIncludedIndex(pages.included);
        const rows = pages.data.map((d) => {
          const app = lookupIncluded(index, 'apps', relIds(d, 'app')[0]);
          return [
            app ? attr(app, 'name') : '',
            app ? attr(app, 'bundleId') : '',
            app?.id ?? '',
            d.id,
          ];
        });
        return textResult(
          `${footer(pages, 'Game Center details')}\n\n${formatTable(
            [
              { header: 'APP' },
              { header: 'BUNDLE_ID' },
              { header: 'APP_ID' },
              { header: 'DETAIL_ID' },
            ],
            rows,
          )}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_group',
    {
      title: 'Create a Game Center group',
      description:
        'Create a GameCenterGroup (referenceName is internal only). Then move apps into it with asc_patch_game_center_detail gameCenterGroupId, and create shared achievements / leaderboards with gameCenterGroupId as the owner.',
      inputSchema: z.object({ referenceName: z.string().min(1) }),
    },
    async ({ referenceName }) => {
      try {
        const data = await client.request<unknown>('/v1/gameCenterGroups', {
          method: 'POST',
          body: JSON.stringify(buildGameCenterGroupBody(referenceName)),
        });
        return textResult(
          `Created Game Center group "${referenceName}".\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_group',
    {
      title: 'Rename a Game Center group',
      description: 'PATCH a GameCenterGroup referenceName (its only attribute).',
      inputSchema: z.object({
        gameCenterGroupId: GameCenterGroupIdSchema,
        referenceName: z.string().min(1),
      }),
    },
    async ({ gameCenterGroupId, referenceName }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/gameCenterGroups/${enc(gameCenterGroupId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(buildGameCenterGroupBody(referenceName, gameCenterGroupId)),
          },
        );
        return textResult(
          `Renamed group ${gameCenterGroupId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_game_center_group',
    {
      title: 'Delete a Game Center group',
      description:
        'DELETE a GameCenterGroup. The tool pre-checks the member apps and refuses while any app is still in the group (their shared achievements and leaderboards live on it). Pass force:true to skip the pre-check and let Apple judge.',
      inputSchema: z.object({ gameCenterGroupId: GameCenterGroupIdSchema, force: ForceSchema }),
    },
    async ({ gameCenterGroupId, force }) => {
      let note = '';
      if (!force) {
        try {
          const members = await paginate(
            client,
            `/v1/gameCenterGroups/${enc(gameCenterGroupId)}/gameCenterDetails?fields[gameCenterDetails]=app&limit=200`,
            200,
          );
          if (members.data.length > 0) {
            return refusal('Game Center group DELETE blocked by member apps', {
              allow: false,
              reason: `${members.data.length} app(s) are still in this group: ${members.data.map((d) => d.id).join(', ')} (gameCenterDetail ids).`,
              next: 'Leave it in place; Apple does not move live games out of a group.',
            });
          }
        } catch {
          note =
            'Note: the member pre-check could not run (the GET failed), so this DELETE went out unguarded.\n\n';
        }
      }
      try {
        await client.request<unknown>(`/v1/gameCenterGroups/${enc(gameCenterGroupId)}`, {
          method: 'DELETE',
        });
        return textResult(`${note}Deleted Game Center group ${gameCenterGroupId}.`);
      } catch (err) {
        return {
          ...errorResult(err),
          content: [{ type: 'text' as const, text: `${note}${formatASCError(err)}` }],
        };
      }
    },
  );

  // ----- Families -----

  for (const family of ['achievement', 'leaderboard', 'leaderboardSet'] as GameCenterFamily[]) {
    const f = GAME_CENTER_FAMILIES[family];
    const idKey = `${family}Id`;
    const ItemIdSchema = z.string().min(1).describe(`Game Center ${f.noun} id (v2).`);
    const VersionIdSchema = z.string().min(1).describe(`Game Center ${f.noun} version id.`);
    const LocIdSchema = z.string().min(1).describe(`Game Center ${f.noun} localization id.`);
    const ImageIdSchema = z.string().min(1).describe(`Game Center ${f.noun} image id.`);

    // List under an owner (detail or group), or — for leaderboards — under a set.
    const listShape: Record<string, z.ZodType> = {
      gameCenterDetailId: GameCenterDetailIdSchema.optional(),
      gameCenterGroupId: GameCenterGroupIdSchema.optional(),
    };
    if (family === 'leaderboard') {
      listShape.leaderboardSetId = z
        .string()
        .min(1)
        .optional()
        .describe('List the leaderboards of this leaderboard set instead (in set order).');
    }
    listShape.referenceName = z.array(z.string().min(1)).min(1).optional();
    if (family !== 'leaderboardSet') {
      listShape.archived = z.boolean().optional().describe('filter[archived].');
    }
    listShape.id = z.array(z.string().min(1)).min(1).optional();
    listShape.maxItems = MaxItemsSchema;
    listShape.raw = RawSchema;

    server.registerTool(
      `asc_list_game_center_${f.label}s`,
      {
        title: `List Game Center ${f.noun}s`,
        description: `List the ${f.noun}s of a Game Center detail (single app) or group (shared across apps), in their display order, with each one's latest version and its review state. Pass exactly one owner${family === 'leaderboard' ? ', or leaderboardSetId for the members of a set' : ''}. Filters: referenceName, ${family === 'leaderboardSet' ? '' : 'archived, '}id.`,
        inputSchema: z.object(listShape),
      },
      async (input: Record<string, unknown>) => {
        try {
          const params = buildItemListQuery(family, {
            referenceName: input.referenceName as string[] | undefined,
            archived: input.archived as boolean | undefined,
            id: input.id as string[] | undefined,
          });
          const setId = input.leaderboardSetId as string | undefined;
          const owners = [input.gameCenterDetailId, input.gameCenterGroupId, setId].filter(
            (v) => v !== undefined,
          );
          if (owners.length !== 1) {
            throw new Error(
              `Pass exactly one of gameCenterDetailId, gameCenterGroupId${family === 'leaderboard' ? ', leaderboardSetId' : ''}`,
            );
          }
          const base = setId
            ? `/v2/gameCenterLeaderboardSets/${enc(setId)}/gameCenterLeaderboards`
            : `${ownerPath({
                gameCenterDetailId: input.gameCenterDetailId as string | undefined,
                gameCenterGroupId: input.gameCenterGroupId as string | undefined,
              })}/${f.ownerRel}`;
          const pages = await paginate(client, withQuery(base, params), input.maxItems as number);
          return textResult(
            input.raw ? JSON.stringify(pages, null, 2) : digestGameCenterItems(family, pages),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_get_game_center_${f.label}`,
      {
        title: `Get a Game Center ${f.noun}`,
        description: `Fetch one Game Center ${f.noun} (v2) with its owner and versions.`,
        inputSchema: z.object({ [idKey]: ItemIdSchema }),
      },
      async (input: Record<string, unknown>) => {
        const id = input[idKey] as string;
        const params = new URLSearchParams();
        params.set('include', 'gameCenterDetail,gameCenterGroup,versions');
        params.set(`fields[${f.versionType}]`, 'version,state');
        params.set('limit[versions]', '50');
        try {
          const data = await client.request<unknown>(withQuery(`${f.path}/${enc(id)}`, params));
          return textResult(JSON.stringify(data, null, 2));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_delete_game_center_${f.label}`,
      {
        title: `Delete a Game Center ${f.noun}`,
        description: `DELETE a Game Center ${f.noun}. The tool reads its versions first and refuses once any version reached review or went live (Apple keeps live Game Center items${f.archivable ? `; archive it with asc_patch_game_center_${f.label} archived:true instead` : ''}). vendorIdentifier is not freed for reuse. Pass force:true to skip the pre-check and let Apple judge.`,
        inputSchema: z.object({ [idKey]: ItemIdSchema, force: ForceSchema }),
      },
      async (input: Record<string, unknown>) => {
        const id = input[idKey] as string;
        let note = '';
        if (!input.force) {
          try {
            const versions = await paginate(
              client,
              `${f.path}/${enc(id)}/versions?fields[${f.versionType}]=version,state&limit=200`,
              200,
            );
            const gate = evaluateGameCenterItemDeleteGate(
              family,
              versions.data.map((v) => attr(v, 'state')).filter(Boolean),
            );
            if (!gate.allow)
              return refusal(`Game Center ${f.noun} DELETE blocked by version state`, gate);
          } catch {
            note =
              'Note: the version pre-check could not run (the GET failed), so this DELETE went out unguarded.\n\n';
          }
        }
        try {
          await client.request<unknown>(`${f.path}/${enc(id)}`, { method: 'DELETE' });
          return textResult(`${note}Deleted Game Center ${f.noun} ${id}.`);
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `${note}${formatASCError(err)}` }],
            isError: true,
          };
        }
      },
    );

    // Ordering on the owner.
    server.registerTool(
      `asc_patch_game_center_${f.label}_order`,
      {
        title: `Reorder Game Center ${f.noun}s`,
        description: `Set the display order of the ${f.noun}s on a Game Center detail or group (PATCH …/relationships/${f.ownerRel}). Apple REPLACES the whole list, so an id left out would be dropped from the owner: the tool reads the current list and refuses unless ${idKey}s is exactly a reordering of it. Pass force:true to send the list as-is.`,
        inputSchema: z.object({
          gameCenterDetailId: GameCenterDetailIdSchema.optional(),
          gameCenterGroupId: GameCenterGroupIdSchema.optional(),
          [`${idKey}s`]: z.array(ItemIdSchema).min(1).describe('Every id, in the new order.'),
          force: ForceSchema,
        }),
      },
      async (input: Record<string, unknown>) => {
        const ids = input[`${idKey}s`] as string[];
        try {
          const base = ownerPath({
            gameCenterDetailId: input.gameCenterDetailId as string | undefined,
            gameCenterGroupId: input.gameCenterGroupId as string | undefined,
          });
          const body = buildLinkagesBody(f.type, ids);
          if (!input.force) {
            const current = await paginate(
              client,
              `${base}/${f.ownerRel}?fields[${f.type}]=referenceName&limit=200`,
              2000,
            );
            const { missing, extra } = diffOrdering(
              current.data.map((r) => r.id),
              ids,
            );
            if (missing.length || extra.length) {
              return refusal(`the new ${f.noun} order is not a reordering of the current list`, {
                allow: false,
                reason: `${missing.length ? `Missing (would be dropped): ${missing.join(', ')}. ` : ''}${extra.length ? `Not currently on this owner: ${extra.join(', ')}.` : ''}`,
                next: `Pass every id from asc_list_game_center_${f.label}s, in the order you want.`,
              });
            }
          }
          await client.request<unknown>(`${base}/relationships/${f.ownerRel}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          return textResult(`Set the order of ${ids.length} ${f.noun}s.`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    // ----- Versions -----

    server.registerTool(
      `asc_list_game_center_${f.label}_versions`,
      {
        title: `List Game Center ${f.noun} versions`,
        description: `List the versions of a Game Center ${f.noun} with their review state (${GAME_CENTER_VERSION_STATES.join(' / ')}) and locales. Copy and images live on a version; once a version is in review or live, create a new one to change them.`,
        inputSchema: z.object({ [idKey]: ItemIdSchema, maxItems: MaxItemsSchema, raw: RawSchema }),
      },
      async (input: Record<string, unknown>) => {
        const params = new URLSearchParams();
        params.set(`fields[${f.versionType}]`, GC_VERSION_FIELDS);
        params.set('include', 'localizations');
        params.set(`fields[${f.locType}]`, 'locale');
        params.set('limit[localizations]', '50');
        params.set('limit', '200');
        try {
          const pages = await paginate(
            client,
            withQuery(`${f.path}/${enc(input[idKey] as string)}/versions`, params),
            input.maxItems as number,
          );
          return textResult(
            input.raw ? JSON.stringify(pages, null, 2) : digestGameCenterVersions(family, pages),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_get_game_center_${f.label}_version`,
      {
        title: `Get a Game Center ${f.noun} version`,
        description: `Fetch one Game Center ${f.noun} version with its localizations.`,
        inputSchema: z.object({ versionId: VersionIdSchema }),
      },
      async ({ versionId }) => {
        try {
          const data = await client.request<unknown>(
            `${f.versionPath}/${enc(versionId)}?include=localizations&limit[localizations]=50`,
          );
          return textResult(JSON.stringify(data, null, 2));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_post_game_center_${f.label}_version`,
      {
        title: `Create a Game Center ${f.noun} version`,
        description: `Create the next version of a Game Center ${f.noun} — needed to change copy or images once the current version is in review or live. Version 1 is created with the ${f.noun} itself. Then add localizations with asc_post_game_center_${f.label}_localization and submit the version for review.`,
        inputSchema: z.object({ [idKey]: ItemIdSchema }),
      },
      async (input: Record<string, unknown>) => {
        const id = input[idKey] as string;
        try {
          const data = await client.request<unknown>(f.versionPath, {
            method: 'POST',
            body: JSON.stringify(buildGameCenterVersionCreateBody(family, id)),
          });
          return textResult(
            `Created a new version of ${f.noun} ${id}.\n\n${JSON.stringify(data, null, 2)}`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    // ----- Localizations -----

    server.registerTool(
      `asc_list_game_center_${f.label}_localizations`,
      {
        title: `List Game Center ${f.noun} localizations`,
        description: `List the per-locale copy of one Game Center ${f.noun} version, with whether each locale has an image.`,
        inputSchema: z.object({
          versionId: VersionIdSchema,
          maxItems: MaxItemsSchema,
          raw: RawSchema,
        }),
      },
      async ({ versionId, maxItems, raw }) => {
        const params = new URLSearchParams();
        params.set(`fields[${f.locType}]`, LOC_FIELDS[family]);
        params.set('include', 'image');
        params.set(`fields[${f.imageType}]`, 'fileName,assetDeliveryState');
        params.set('limit', '200');
        try {
          const pages = await paginate(
            client,
            withQuery(`${f.versionPath}/${enc(versionId)}/localizations`, params),
            maxItems,
          );
          return textResult(
            raw ? JSON.stringify(pages, null, 2) : digestGameCenterLocalizations(family, pages),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_get_game_center_${f.label}_localization`,
      {
        title: `Get a Game Center ${f.noun} localization`,
        description: `Fetch one Game Center ${f.noun} localization with its version and image.`,
        inputSchema: z.object({ localizationId: LocIdSchema }),
      },
      async ({ localizationId }) => {
        try {
          const data = await client.request<unknown>(
            `${f.locPath}/${enc(localizationId)}?include=version,image`,
          );
          return textResult(JSON.stringify(data, null, 2));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    const locCopyShape: Record<string, z.ZodType> =
      family === 'achievement'
        ? {
            name: z.string().min(1),
            beforeEarnedDescription: z
              .string()
              .min(1)
              .describe('Shown before the player earns it (if showBeforeEarned).'),
            afterEarnedDescription: z.string().min(1).describe('Shown once earned.'),
          }
        : family === 'leaderboard'
          ? {
              name: z.string().min(1),
              formatterOverride: LeaderboardFormatterSchema.nullable()
                .optional()
                .describe(
                  'Locale-specific score format, overriding the leaderboard defaultFormatter.',
                ),
              formatterSuffix: z
                .string()
                .nullable()
                .optional()
                .describe('Unit after a score, plural (e.g. " points").'),
              formatterSuffixSingular: z
                .string()
                .nullable()
                .optional()
                .describe('Unit after a score of 1 (e.g. " point").'),
              description: z.string().nullable().optional(),
            }
          : { name: z.string().min(1) };

    server.registerTool(
      `asc_post_game_center_${f.label}_localization`,
      {
        title: `Add a Game Center ${f.noun} localization`,
        description: `Add one locale's copy to a Game Center ${f.noun} version (${LOC_REQUIRED[family].join(' + ')} required). The version must be editable (PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW or rejected). Then add the image with asc_upload_game_center_${f.label}_image.`,
        inputSchema: z.object({
          versionId: VersionIdSchema,
          locale: LocaleSchema,
          ...locCopyShape,
        }),
      },
      async (input: Record<string, unknown>) => {
        try {
          const body = buildGameCenterLocalizationCreateBody({
            ...(input as Omit<GameCenterLocalizationInput, 'family'>),
            family,
          });
          const data = await client.request<unknown>(f.locPath, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          return textResult(
            `Added ${input.locale as string} copy.\n\n${JSON.stringify(data, null, 2)}`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    const patchShape: Record<string, z.ZodType> = {};
    for (const [k, v] of Object.entries(locCopyShape)) {
      patchShape[k] = v instanceof z.ZodOptional ? v : v.optional();
    }
    server.registerTool(
      `asc_patch_game_center_${f.label}_localization`,
      {
        title: `Update a Game Center ${f.noun} localization`,
        description: `PATCH one locale's copy of a Game Center ${f.noun}. locale is immutable. Apple refuses edits once the version is in review or live — create a new version first.${family === 'leaderboard' ? ' Pass null to clear formatterOverride / formatterSuffix / formatterSuffixSingular / description.' : ''}`,
        inputSchema: z.object({ localizationId: LocIdSchema, ...patchShape }),
      },
      async (input: Record<string, unknown>) => {
        try {
          const body = buildGameCenterLocalizationPatchBody({
            ...(input as Omit<GameCenterLocalizationInput, 'family'>),
            family,
          });
          const data = await client.request<unknown>(
            `${f.locPath}/${enc(input.localizationId as string)}`,
            { method: 'PATCH', body: JSON.stringify(body) },
          );
          return textResult(
            `Patched localization ${input.localizationId as string}.\n\n${JSON.stringify(data, null, 2)}`,
          );
        } catch (err) {
          const text = ascErrorText(err);
          if (/UNMODIFIABLE|STATE_ERROR/.test(text)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Apple refused the edit: the ${f.noun} version is locked. Create a new version with asc_post_game_center_${f.label}_version and edit its localization.\n\n${formatASCError(err)}`,
                },
              ],
              isError: true,
            };
          }
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_delete_game_center_${f.label}_localization`,
      {
        title: `Delete a Game Center ${f.noun} localization`,
        description: `DELETE one locale's copy of a Game Center ${f.noun} version. The tool reads the version state first and refuses unless the version is editable (PREPARE_FOR_SUBMISSION / READY_FOR_REVIEW / DEVELOPER_REJECTED / REJECTED). Pass force:true to skip the pre-check.`,
        inputSchema: z.object({ localizationId: LocIdSchema, force: ForceSchema }),
      },
      async ({ localizationId, force }) => {
        let note = '';
        if (!force) {
          try {
            const gate = evaluateGameCenterVersionEditGate(
              family,
              await versionStateOfLocalization(family, localizationId),
            );
            if (!gate.allow) return refusal(`localization DELETE blocked by version state`, gate);
          } catch {
            note =
              'Note: the version pre-check could not run (the GET failed), so this DELETE went out unguarded.\n\n';
          }
        }
        try {
          await client.request<unknown>(`${f.locPath}/${enc(localizationId)}`, {
            method: 'DELETE',
          });
          return textResult(`${note}Deleted ${f.noun} localization ${localizationId}.`);
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `${note}${formatASCError(err)}` }],
            isError: true,
          };
        }
      },
    );

    // ----- Images (to-one per localization) -----

    server.registerTool(
      `asc_get_game_center_${f.label}_image`,
      {
        title: `Get a Game Center ${f.noun} image`,
        description: `Fetch a Game Center ${f.noun} image by imageId, or the image of a localization by localizationId (data: null when it has none). Shows fileName, assetDeliveryState and the image template URL.`,
        inputSchema: z.object({
          imageId: ImageIdSchema.optional(),
          localizationId: LocIdSchema.optional(),
        }),
      },
      async ({ imageId, localizationId }) => {
        if ((imageId === undefined) === (localizationId === undefined)) {
          return errorResult(new Error('Pass exactly one of imageId or localizationId'));
        }
        const path = imageId
          ? `${f.imagePath}/${enc(imageId)}`
          : `${f.locPath}/${enc(localizationId as string)}/image`;
        try {
          const data = await client.request<unknown>(
            `${path}?fields[${f.imageType}]=${GC_IMAGE_FIELDS}`,
          );
          return textResult(JSON.stringify(data, null, 2));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_post_game_center_${f.label}_image`,
      {
        title: `Reserve a Game Center ${f.noun} image (raw step 1)`,
        description: `Raw step 1 of 3: reserve an image on a Game Center ${f.noun} localization; the response carries uploadOperations[]. PUT each chunk (asc_upload_asset_chunk), then commit with asc_patch_game_center_${f.label}_image uploaded:true. One image per localization. Prefer the composite asc_upload_game_center_${f.label}_image.`,
        inputSchema: z.object({
          localizationId: LocIdSchema,
          fileName: FileNameSchema,
          fileSize: FileSizeSchema,
        }),
      },
      async ({ localizationId, fileName, fileSize }) => {
        try {
          const data = await client.request<unknown>(f.imagePath, {
            method: 'POST',
            body: JSON.stringify(
              buildGameCenterImageCreateBody(family, localizationId, fileName, fileSize),
            ),
          });
          return textResult(JSON.stringify(data, null, 2));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_patch_game_center_${f.label}_image`,
      {
        title: `Commit a Game Center ${f.noun} image (raw step 3)`,
        description: `Raw step 3 of 3: PATCH uploaded:true on a reserved Game Center ${f.noun} image after every chunk is PUT. (uploaded is the only attribute; no checksum.)`,
        inputSchema: z.object({ imageId: ImageIdSchema }),
      },
      async ({ imageId }) => {
        try {
          const data = await client.request<unknown>(`${f.imagePath}/${enc(imageId)}`, {
            method: 'PATCH',
            body: JSON.stringify(buildGameCenterImageCommitBody(family, imageId)),
          });
          return textResult(`Committed image ${imageId}.\n\n${JSON.stringify(data, null, 2)}`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_upload_game_center_${f.label}_image`,
      {
        title: `Upload a Game Center ${f.noun} image (composite)`,
        description: `Composite tool: reads localFilePath, reserves the image on the localization, PUTs every chunk to Apple storage and commits with uploaded:true. One image per localization — the tool refuses if one exists (delete it first). Apple's spec: ${family === 'achievement' ? '512x512 or 1024x1024' : family === 'leaderboard' ? '512x512 or 1024x1024 (or 1000x1000 legacy)' : '512x512 or 1024x1024'} PNG/JPEG, 72 dpi, RGB.`,
        inputSchema: z.object({
          localizationId: LocIdSchema,
          localFilePath: LocalFilePathSchema,
          fileName: FileNameSchema.optional().describe('Defaults to basename(localFilePath).'),
        }),
      },
      async ({ localizationId, localFilePath, fileName }) => {
        const resolvedPath = expandHomePath(localFilePath);
        try {
          try {
            const existing = await client.request<{ data?: { id?: string } | null }>(
              `${f.locPath}/${enc(localizationId)}/image?fields[${f.imageType}]=fileName`,
            );
            if (existing.data?.id) {
              return errorResult(
                new Error(
                  `Localization ${localizationId} already has image ${existing.data.id}. Delete it with asc_delete_game_center_${f.label}_image first.`,
                ),
              );
            }
          } catch (err) {
            if (!(err instanceof ASCError && err.status === 404)) throw err;
          }
          const fileSize = await readFileSizeBytes(resolvedPath);
          const name = fileName ?? resolvedPath.split('/').pop() ?? 'image.png';
          const reserved = await client.request<AssetReserveResponse>(f.imagePath, {
            method: 'POST',
            body: JSON.stringify(
              buildGameCenterImageCreateBody(family, localizationId, name, fileSize),
            ),
          });
          const imageId = reserved.data?.id;
          const operations = reserved.data?.attributes?.uploadOperations ?? [];
          if (!imageId) throw new Error('Reserve response missing image id');
          if (operations.length === 0)
            throw new Error('Reserve response missing uploadOperations[]');
          const executed = await executeAllUploadOperations(operations, resolvedPath);
          const committed = await client.request<unknown>(`${f.imagePath}/${enc(imageId)}`, {
            method: 'PATCH',
            body: JSON.stringify(buildGameCenterImageCommitBody(family, imageId)),
          });
          return textResult(
            `Uploaded ${name} → ${f.noun} image ${imageId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(committed, null, 2)}`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_delete_game_center_${f.label}_image`,
      {
        title: `Delete a Game Center ${f.noun} image`,
        description: `DELETE a Game Center ${f.noun} image. The tool reads its localization's version state first and refuses unless the version is editable. Pass force:true to skip the pre-check.`,
        inputSchema: z.object({ imageId: ImageIdSchema, force: ForceSchema }),
      },
      async ({ imageId, force }) => {
        let note = '';
        if (!force) {
          try {
            const img = await client.request<{ data?: JSONAPIResource }>(
              `${f.imagePath}/${enc(imageId)}?include=localization&fields[${f.imageType}]=localization`,
            );
            const locId = img.data ? relIds(img.data, 'localization')[0] : undefined;
            const state = locId ? await versionStateOfLocalization(family, locId) : undefined;
            const gate = evaluateGameCenterVersionEditGate(family, state);
            if (!gate.allow) return refusal('image DELETE blocked by version state', gate);
          } catch {
            note =
              'Note: the version pre-check could not run (the GET failed), so this DELETE went out unguarded.\n\n';
          }
        }
        try {
          await client.request<unknown>(`${f.imagePath}/${enc(imageId)}`, { method: 'DELETE' });
          return textResult(`${note}Deleted ${f.noun} image ${imageId}.`);
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `${note}${formatASCError(err)}` }],
            isError: true,
          };
        }
      },
    );
  }

  // ----- Create / patch per family (attribute sets differ) -----

  const ownerShape = {
    gameCenterDetailId: GameCenterDetailIdSchema.optional().describe(
      'Owner for a single-app item. Pass exactly one of gameCenterDetailId / gameCenterGroupId.',
    ),
    gameCenterGroupId: GameCenterGroupIdSchema.optional().describe(
      'Owner for an item shared across the apps of a group.',
    ),
  };

  async function postItem(family: GameCenterFamily, body: JSONAPIBody) {
    const f = GAME_CENTER_FAMILIES[family];
    const data = await client.request<unknown>(f.path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return textResult(
      `Created Game Center ${f.noun} with version 1. Next: asc_list_game_center_${f.label}_versions, then asc_post_game_center_${f.label}_localization on that version.\n\n${JSON.stringify(data, null, 2)}`,
    );
  }

  async function patchItem(family: GameCenterFamily, id: string, body: JSONAPIBody) {
    const f = GAME_CENTER_FAMILIES[family];
    const data = await client.request<unknown>(`${f.path}/${enc(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return textResult(`Patched Game Center ${f.noun} ${id}.\n\n${JSON.stringify(data, null, 2)}`);
  }

  const VendorIdentifierSchema = z
    .string()
    .min(1)
    .max(100)
    .describe(
      'The id the game code uses (e.g. "com.example.game.first_win"). Immutable, never reusable.',
    );

  server.registerTool(
    'asc_post_game_center_achievement',
    {
      title: 'Create a Game Center achievement',
      description:
        'Create a Game Center achievement (v2) with its first version in one POST. points: 0–100 per achievement (live achievements with 0 exist), 1000 per game in total. showBeforeEarned:false makes it hidden until earned. repeatable lets players earn it again (no extra points). vendorIdentifier is immutable and can never be reused, even after delete. Then add per-locale copy to the version.',
      inputSchema: z.object({
        ...ownerShape,
        referenceName: z.string().min(1),
        vendorIdentifier: VendorIdentifierSchema,
        points: z.number().int().min(0).max(100),
        showBeforeEarned: z.boolean(),
        repeatable: z.boolean(),
        activityProperties: StringMapSchema.optional(),
      }),
    },
    async (input) => {
      try {
        return await postItem('achievement', buildAchievementCreateBody(input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_achievement',
    {
      title: 'Update a Game Center achievement',
      description:
        'PATCH a Game Center achievement: referenceName, points, showBeforeEarned, repeatable, activityProperties, or archived:true to hide a live achievement (Apple does not delete live ones). vendorIdentifier is immutable.',
      inputSchema: z.object({
        achievementId: z.string().min(1),
        referenceName: z.string().min(1).optional(),
        points: z.number().int().min(0).max(100).optional(),
        showBeforeEarned: z.boolean().optional(),
        repeatable: z.boolean().optional(),
        archived: z.boolean().optional(),
        activityProperties: StringMapSchema.nullable().optional(),
      }),
    },
    async (input) => {
      try {
        return await patchItem(
          'achievement',
          input.achievementId,
          buildAchievementPatchBody(input),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const recurrenceShape = {
    recurrenceStartDate: z
      .string()
      .min(1)
      .describe(
        'Recurring leaderboard: first start, ISO 8601 date-time (e.g. 2026-11-01T00:00:00Z).',
      ),
    recurrenceDuration: z
      .string()
      .regex(/^P/, 'ISO 8601 duration, e.g. P1D or PT12H')
      .describe('How long each occurrence runs, ISO 8601 duration (e.g. P7D).'),
    recurrenceRule: z
      .string()
      .min(1)
      .describe('RFC 5545 RRULE for how often it restarts (e.g. FREQ=WEEKLY;INTERVAL=1).'),
  };

  server.registerTool(
    'asc_post_game_center_leaderboard',
    {
      title: 'Create a Game Center leaderboard',
      description:
        'Create a Game Center leaderboard (v2) with its first version in one POST. Classic: omit the recurrence fields. Recurring: pass all three of recurrenceStartDate, recurrenceDuration, recurrenceRule. scoreRangeStart/End reject scores outside the range. Optionally add it to leaderboard sets at once (leaderboardSetIds). vendorIdentifier is immutable and never reusable.',
      inputSchema: z.object({
        ...ownerShape,
        referenceName: z.string().min(1),
        vendorIdentifier: VendorIdentifierSchema,
        defaultFormatter: LeaderboardFormatterSchema,
        submissionType: SubmissionTypeSchema,
        scoreSortType: ScoreSortTypeSchema,
        scoreRangeStart: NumericStringSchema.optional(),
        scoreRangeEnd: NumericStringSchema.optional(),
        recurrenceStartDate: recurrenceShape.recurrenceStartDate.optional(),
        recurrenceDuration: recurrenceShape.recurrenceDuration.optional(),
        recurrenceRule: recurrenceShape.recurrenceRule.optional(),
        visibility: LeaderboardVisibilitySchema.optional(),
        activityProperties: StringMapSchema.optional(),
        leaderboardSetIds: z.array(z.string().min(1)).min(1).optional(),
      }),
    },
    async (input) => {
      try {
        return await postItem('leaderboard', buildLeaderboardCreateBody(input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_leaderboard',
    {
      title: 'Update a Game Center leaderboard',
      description:
        'PATCH a Game Center leaderboard: referenceName, defaultFormatter, submissionType, scoreSortType, score range, recurrence, visibility (SHOW_FOR_ALL / HIDE_FOR_ALL), activityProperties, or archived:true to retire a live leaderboard (Apple does not delete live ones). Pass null to clear the score range or recurrence fields. vendorIdentifier is immutable. ⚠️ Changing sort or submission type on a live leaderboard changes how existing scores rank.',
      inputSchema: z.object({
        leaderboardId: z.string().min(1),
        referenceName: z.string().min(1).optional(),
        defaultFormatter: LeaderboardFormatterSchema.optional(),
        submissionType: SubmissionTypeSchema.optional(),
        scoreSortType: ScoreSortTypeSchema.optional(),
        scoreRangeStart: NumericStringSchema.nullable().optional(),
        scoreRangeEnd: NumericStringSchema.nullable().optional(),
        recurrenceStartDate: recurrenceShape.recurrenceStartDate.nullable().optional(),
        recurrenceDuration: recurrenceShape.recurrenceDuration.nullable().optional(),
        recurrenceRule: recurrenceShape.recurrenceRule.nullable().optional(),
        visibility: LeaderboardVisibilitySchema.optional(),
        archived: z.boolean().optional(),
        activityProperties: StringMapSchema.nullable().optional(),
      }),
    },
    async (input) => {
      try {
        return await patchItem(
          'leaderboard',
          input.leaderboardId,
          buildLeaderboardPatchBody(input),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_leaderboard_set',
    {
      title: 'Create a Game Center leaderboard set',
      description:
        'Create a Game Center leaderboard set (v2) with its first version in one POST — a named group of leaderboards shown together. Optionally seed it with leaderboardIds (in display order). vendorIdentifier is immutable and never reusable.',
      inputSchema: z.object({
        ...ownerShape,
        referenceName: z.string().min(1),
        vendorIdentifier: VendorIdentifierSchema,
        leaderboardIds: z.array(z.string().min(1)).min(1).optional(),
      }),
    },
    async (input) => {
      try {
        return await postItem('leaderboardSet', buildLeaderboardSetCreateBody(input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_leaderboard_set',
    {
      title: 'Rename a Game Center leaderboard set',
      description:
        'PATCH a leaderboard set referenceName (its only mutable attribute). Change its members with asc_add / asc_set / asc_remove_game_center_leaderboard_set_members.',
      inputSchema: z.object({
        leaderboardSetId: z.string().min(1),
        referenceName: z.string().min(1),
      }),
    },
    async ({ leaderboardSetId, referenceName }) => {
      try {
        return await patchItem(
          'leaderboardSet',
          leaderboardSetId,
          buildLeaderboardSetPatchBody(leaderboardSetId, referenceName),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ----- Leaderboard-set membership -----

  const membership = [
    {
      name: 'asc_add_game_center_leaderboard_set_members',
      method: 'POST',
      title: 'Add leaderboards to a set',
      verb: 'Added',
      description:
        'Add leaderboards to a leaderboard set (POST …/relationships/gameCenterLeaderboards). Existing members stay.',
    },
    {
      name: 'asc_set_game_center_leaderboard_set_members',
      method: 'PATCH',
      title: 'Replace (and reorder) the leaderboards of a set',
      verb: 'Set',
      description:
        'Replace the member list of a leaderboard set (PATCH …/relationships/gameCenterLeaderboards) — the list order becomes the display order. Leaderboards left out are removed from the set.',
    },
    {
      name: 'asc_remove_game_center_leaderboard_set_members',
      method: 'DELETE',
      title: 'Remove leaderboards from a set',
      verb: 'Removed',
      description:
        'Remove leaderboards from a leaderboard set (DELETE …/relationships/gameCenterLeaderboards). The leaderboards themselves stay.',
    },
  ] as const;

  for (const m of membership) {
    server.registerTool(
      m.name,
      {
        title: m.title,
        description: m.description,
        inputSchema: z.object({
          leaderboardSetId: z.string().min(1),
          leaderboardIds: z.array(z.string().min(1)).min(1),
        }),
      },
      async ({ leaderboardSetId, leaderboardIds }) => {
        try {
          await client.request<unknown>(
            `/v2/gameCenterLeaderboardSets/${enc(leaderboardSetId)}/relationships/gameCenterLeaderboards`,
            {
              method: m.method,
              body: JSON.stringify(buildLinkagesBody('gameCenterLeaderboards', leaderboardIds)),
            },
          );
          return textResult(
            `${m.verb} ${leaderboardIds.length} leaderboard(s) on set ${leaderboardSetId}.`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  // ----- Leaderboard-set member localizations -----

  server.registerTool(
    'asc_list_game_center_leaderboard_set_member_localizations',
    {
      title: 'List leaderboard-set member localizations',
      description:
        "List the per-locale names a leaderboard shows INSIDE a given leaderboard set (it can differ from the leaderboard's own name). Apple requires both ids.",
      inputSchema: z.object({
        leaderboardSetId: z.string().min(1),
        leaderboardId: z.string().min(1),
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ leaderboardSetId, leaderboardId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('filter[gameCenterLeaderboardSet]', leaderboardSetId);
      params.set('filter[gameCenterLeaderboard]', leaderboardId);
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          withQuery('/v1/gameCenterLeaderboardSetMemberLocalizations', params),
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestMemberLocalizations(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_leaderboard_set_member_localization',
    {
      title: 'Add a leaderboard-set member localization',
      description: 'Set the name one leaderboard shows inside one leaderboard set, for one locale.',
      inputSchema: z.object({
        leaderboardSetId: z.string().min(1),
        leaderboardId: z.string().min(1),
        locale: LocaleSchema,
        name: z.string().min(1),
      }),
    },
    async (input) => {
      try {
        const data = await client.request<unknown>(
          '/v1/gameCenterLeaderboardSetMemberLocalizations',
          {
            method: 'POST',
            body: JSON.stringify(buildMemberLocalizationCreateBody(input)),
          },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_leaderboard_set_member_localization',
    {
      title: 'Rename a leaderboard-set member localization',
      description: 'PATCH the name of a leaderboard-set member localization (locale is immutable).',
      inputSchema: z.object({ memberLocalizationId: z.string().min(1), name: z.string().min(1) }),
    },
    async ({ memberLocalizationId, name }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/gameCenterLeaderboardSetMemberLocalizations/${enc(memberLocalizationId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(buildMemberLocalizationPatchBody(memberLocalizationId, name)),
          },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_game_center_leaderboard_set_member_localization',
    {
      title: 'Delete a leaderboard-set member localization',
      description:
        'DELETE a leaderboard-set member localization; the leaderboard falls back to its own name in that set.',
      inputSchema: z.object({ memberLocalizationId: z.string().min(1) }),
    },
    async ({ memberLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/gameCenterLeaderboardSetMemberLocalizations/${enc(memberLocalizationId)}`,
          { method: 'DELETE' },
        );
        return textResult(`Deleted member localization ${memberLocalizationId}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ----- Scores -----

  server.registerTool(
    'asc_list_game_center_leaderboard_score_moderations',
    {
      title: 'List leaderboard entries for moderation',
      description:
        'List the score entries on a leaderboard with rank, score, player and blocked flag — the moderation view for hiding cheated scores. blocked:true/false filters on exists[blocked]. Hide one with asc_patch_game_center_score_moderation, or block the player outright with asc_patch_game_center_detail_player. ⚠️ Live 2026-10-24 Apple answered 404 PATH_ERROR for this path (in the spec, not switched on yet); the tool says so when it happens.',
      inputSchema: z.object({
        leaderboardId: z.string().min(1),
        blocked: z.boolean().optional().describe('exists[blocked]: true = only blocked entries.'),
        maxItems: MaxItemsSchema,
        raw: RawSchema,
      }),
    },
    async ({ leaderboardId, blocked, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('include', 'player');
      if (blocked !== undefined) params.set('exists[blocked]', String(blocked));
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          withQuery(
            `/v2/gameCenterLeaderboards/${enc(leaderboardId)}/gameCenterScoreModerations`,
            params,
          ),
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestScoreModerations(pages));
      } catch (err) {
        return notLiveResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_game_center_score_moderation',
    {
      title: 'Hide or restore a leaderboard entry',
      description:
        'PATCH a leaderboard score entry: blocked:true hides it from the leaderboard, blocked:false restores it. ⚠️ Changes what players see on a live leaderboard.',
      inputSchema: z.object({ scoreModerationId: z.string().min(1), blocked: z.boolean() }),
    },
    async ({ scoreModerationId, blocked }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/gameCenterScoreModerations/${enc(scoreModerationId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(buildScoreModerationPatchBody(scoreModerationId, blocked)),
          },
        );
        return textResult(
          `${blocked ? 'Hid' : 'Restored'} entry ${scoreModerationId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const playerSubmissionShape = {
    bundleId: z.string().min(1).describe('Bundle id of the game the score / progress comes from.'),
    scopedPlayerId: z
      .string()
      .min(1)
      .describe("The player's game-scoped player id (GKPlayer.gamePlayerID / teamPlayerID)."),
    vendorIdentifier: z
      .string()
      .min(1)
      .describe('vendorIdentifier of the leaderboard / achievement.'),
    submittedDate: z.string().min(1).optional().describe('ISO 8601 date-time; defaults to now.'),
    preReleased: z
      .boolean()
      .optional()
      .describe('true for an item not yet live (testing a pre-release leaderboard / achievement).'),
    challengeIds: z.array(z.string().min(1)).min(1).optional(),
  };

  server.registerTool(
    'asc_post_game_center_leaderboard_entry_submission',
    {
      title: 'Submit a leaderboard score (server-side)',
      description:
        'Submit a score for a player to a leaderboard from your server (POST /v1/gameCenterLeaderboardEntrySubmissions). For games that validate scores server-side. ⚠️ Writes a real entry a live leaderboard shows — use preReleased:true while testing.',
      inputSchema: z.object({
        ...playerSubmissionShape,
        score: NumericStringSchema,
        context: NumericStringSchema.optional().describe(
          'Optional 64-bit context integer stored with the score.',
        ),
      }),
    },
    async (input) => {
      try {
        const data = await client.request<unknown>('/v1/gameCenterLeaderboardEntrySubmissions', {
          method: 'POST',
          body: JSON.stringify(buildLeaderboardEntrySubmissionBody(input)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_game_center_player_achievement_submission',
    {
      title: 'Report achievement progress (server-side)',
      description:
        "Report a player's progress on an achievement from your server (POST /v1/gameCenterPlayerAchievementSubmissions); percentageAchieved 100 awards it. ⚠️ Awards a real achievement on a live game — use preReleased:true while testing.",
      inputSchema: z.object({
        ...playerSubmissionShape,
        percentageAchieved: z.number().int().min(0).max(100),
      }),
    },
    async (input) => {
      try {
        const data = await client.request<unknown>('/v1/gameCenterPlayerAchievementSubmissions', {
          method: 'POST',
          body: JSON.stringify(buildPlayerAchievementSubmissionBody(input)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
