import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import {
  buildIncludedIndex,
  type CollectedPages,
  type Column,
  formatTable,
  type JSONAPIResource,
  lookupIncluded,
  paginate,
} from '../jsonapi.js';
import {
  AppIdSchema,
  AppStoreVersionIdSchema,
  FileNameSchema,
  FileSizeSchema,
  LocaleSchema,
  LocalFilePathSchema,
  SourceFileChecksumSchema,
} from '../schemas.js';
import {
  type AssetReserveResponse,
  computeFileMd5Hex,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// App Clips (App Store Connect API 4.5.1).
//
// Hierarchy:
//   app → appClips (one per App Clip target; created by uploading a build that
//         contains the clip, never through the API — there is no POST)
//     → appClipDefaultExperiences (the card shown for Safari banners, Messages
//       links and the default App Clip link; one per app version)
//         → appClipDefaultExperienceLocalizations (subtitle per locale)
//             → appClipHeaderImage (to-one card image)
//         → appClipAppStoreReviewDetail (to-one; invocation URLs for App Review)
//         → releaseWithAppStoreVersion (the version that ships this card)
//     → appClipAdvancedExperiences (per-URL cards: QR / NFC / Maps place cards)
//         → headerImage (appClipAdvancedExperienceImages, no parent relationship
//           at reserve time — reserve the image first, then link it)
//         → localizations (inline-created in included[], not a resource of
//           their own — no /v1/appClipAdvancedExperienceLocalizations path)
//   buildBundles → betaAppClipInvocations (TestFlight invocation URLs)
//     → betaAppClipInvocationLocalizations (title per locale)
//
// Wire notes pinned by tests/app-clips-body.test.ts:
//   * Both image types use the LEGACY three-step upload: reserve with fileName +
//     fileSize, PUT chunks, then PATCH sourceFileChecksum (hex MD5) +
//     uploaded=true. Not the Asset Library's checksum-free commit.
//   * Advanced experience + beta invocation create their localizations inline:
//     `included[]` items with `${N}` temp ids, linked from the relationship.
//     The advanced experience PATCH takes the same shape to replace them.
//   * AppClipDefaultExperience create has no required attributes; the attributes
//     block is omitted when `action` is absent.
//   * The two relationship PATCHes (version ↔ default experience) take a bare
//     `{ data: { type, id } }` linkage; the spec does not allow null, so the API
//     cannot unlink — link another experience / version instead.

const APP_CLIP_ACTIONS = ['OPEN', 'VIEW', 'PLAY'] as const;
const ADVANCED_STATUSES = ['RECEIVED', 'DEACTIVATED', 'APP_TRANSFER_IN_PROGRESS'] as const;
const PLACE_STATUSES = ['PENDING', 'MATCHED', 'NO_MATCH'] as const;
const ADVANCED_LANGUAGES = [
  'AR',
  'CA',
  'CS',
  'DA',
  'DE',
  'EL',
  'EN',
  'ES',
  'FI',
  'FR',
  'HE',
  'HI',
  'HR',
  'HU',
  'ID',
  'IT',
  'JA',
  'KO',
  'MS',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'RU',
  'SK',
  'SV',
  'TH',
  'TR',
  'UK',
  'VI',
  'ZH',
] as const;
const BUSINESS_CATEGORIES = [
  'AUTOMOTIVE',
  'BEAUTY',
  'BIKES',
  'BOOKS',
  'CASINO',
  'EDUCATION',
  'EDUCATION_JAPAN',
  'ENTERTAINMENT',
  'EV_CHARGER',
  'FINANCIAL_USD',
  'FINANCIAL_CNY',
  'FINANCIAL_GBP',
  'FINANCIAL_JPY',
  'FINANCIAL_EUR',
  'FITNESS',
  'FOOD_AND_DRINK',
  'GAS',
  'GROCERY',
  'HEALTH_AND_MEDICAL',
  'HOTEL_AND_TRAVEL',
  'MUSIC',
  'PARKING',
  'PET_SERVICES',
  'PROFESSIONAL_SERVICES',
  'SHOPPING',
  'TICKETING',
  'TRANSIT',
] as const;
const MAP_ACTIONS = [
  'BUY_TICKETS',
  'VIEW_AVAILABILITY',
  'VIEW_PRICING',
  'HOTEL_BOOK_ROOM',
  'PARKING_RESERVE_PARKING',
  'RESTAURANT_JOIN_WAITLIST',
  'RESTAURANT_ORDER_DELIVERY',
  'RESTAURANT_ORDER_FOOD',
  'RESTAURANT_ORDER_TAKEOUT',
  'RESTAURANT_RESERVATION',
  'SCHEDULE_APPOINTMENT',
  'RESTAURANT_VIEW_MENU',
  'THEATER_NOW_PLAYING',
  'AIRLINE_BOOK_TRAVEL',
  'AIRLINE_CHECK_IN',
  'AIRLINE_FLIGHT_STATUS',
  'APPLY',
  'BOOK',
  'BOOK_ACTIVITIES',
  'BOOK_RIDES',
  'BOOK_TEETIMES',
  'BOOK_TOURS',
  'CAREERS',
  'CHARGE_EV',
  'COUPONS',
  'DONATE',
  'EVENTS',
  'EVENTS_SHOWS',
  'EVENTS_SPORTS',
  'GIFT_CARD',
  'HOTEL_AMENITIES',
  'JOIN',
  'PARKING_AVAILABLE',
  'RESTAURANT_PICKUP',
  'RETAIL_SERVICE_QUOTE',
  'RETAIL_STORE_DELIVERY',
  'RETAIL_STORE_PICKUP',
  'RETAIL_STORE_SHOP',
  'SERVICES',
  'SUPPORT',
  'PAY_TO_PARK',
] as const;

// ----- Schemas -----

const AppClipIdSchema = z
  .string()
  .min(1)
  .describe('App Clip ID from asc_list_app_clips (one per App Clip target in the app).');
const DefaultExperienceIdSchema = z
  .string()
  .min(1)
  .describe('AppClipDefaultExperience ID from asc_list_app_clip_default_experiences.');
const DefaultExperienceLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppClipDefaultExperienceLocalization ID from asc_list_app_clip_default_experience_localizations.',
  );
const HeaderImageIdSchema = z.string().min(1).describe('AppClipHeaderImage ID.');
const ReviewDetailIdSchema = z.string().min(1).describe('AppClipAppStoreReviewDetail ID.');
const AdvancedExperienceIdSchema = z
  .string()
  .min(1)
  .describe('AppClipAdvancedExperience ID from asc_list_app_clip_advanced_experiences.');
const AdvancedExperienceImageIdSchema = z
  .string()
  .min(1)
  .describe('AppClipAdvancedExperienceImage ID (the header image of an advanced experience).');
const BetaInvocationIdSchema = z.string().min(1).describe('BetaAppClipInvocation ID.');
const BetaInvocationLocalizationIdSchema = z
  .string()
  .min(1)
  .describe('BetaAppClipInvocationLocalization ID.');

const AppClipActionSchema = z
  .enum(APP_CLIP_ACTIONS)
  .describe('The card button: OPEN, VIEW or PLAY.');
const AdvancedLanguageSchema = z
  .enum(ADVANCED_LANGUAGES)
  .describe('Two-letter language code of an advanced experience (EN, DE, JA, ZH, …).');
const BusinessCategorySchema = z.enum(BUSINESS_CATEGORIES);
const InvocationUrlSchema = z.string().url();

const PlaceSchema = z
  .object({
    placeId: z.string().optional(),
    names: z.array(z.string()).optional(),
    mainAddress: z
      .object({
        fullAddress: z.string().optional(),
        structuredAddress: z
          .object({
            streetAddress: z.array(z.string()).optional(),
            floor: z.string().optional(),
            neighborhood: z.string().optional(),
            locality: z.string().optional(),
            stateProvince: z.string().optional(),
            postalCode: z.string().optional(),
            countryCode: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    displayPoint: z
      .object({
        coordinates: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
        source: z.enum(['CALCULATED', 'MANUALLY_PLACED']).optional(),
      })
      .optional(),
    mapAction: z.enum(MAP_ACTIONS).optional(),
    relationship: z.enum(['OWNER', 'AUTHORIZED', 'OTHER']).optional(),
    phoneNumber: z
      .object({
        number: z.string().optional(),
        type: z.enum(['FAX', 'LANDLINE', 'MOBILE', 'TOLLFREE']).optional(),
        intent: z.string().optional(),
      })
      .optional(),
    homePage: z.string().optional(),
    categories: z.array(z.string()).optional(),
  })
  .describe(
    'Apple Maps place card for a location-based advanced experience: names, address, display point, mapAction (the place-card button), your relationship to the business, phone, home page.',
  );

const AdvancedLocalizationSchema = z.object({
  language: AdvancedLanguageSchema,
  title: z.string().min(1).optional().describe('Card title (Apple limit: 30 characters).'),
  subtitle: z.string().min(1).optional().describe('Card subtitle (Apple limit: 56 characters).'),
});

const BetaInvocationLocalizationSchema = z.object({
  locale: LocaleSchema,
  title: z.string().min(1),
});

type AppClipAction = (typeof APP_CLIP_ACTIONS)[number];
type AdvancedLanguage = (typeof ADVANCED_LANGUAGES)[number];
type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];
type Place = z.infer<typeof PlaceSchema>;
type AdvancedLocalization = z.infer<typeof AdvancedLocalizationSchema>;

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
  included?: Array<{ type: string; id: string; attributes: Record<string, unknown> }>;
}

function tempId(n: number): string {
  // Apple's JSON:API temp-ID convention for inline-created resources: literal
  // `${N}` strings on the wire. Concatenated so biome's
  // noTemplateCurlyInString rule doesn't false-flag it.
  return `\${${n}}`;
}

function linkage(type: string, id: string) {
  return { data: { type, id } };
}

// ----- Body builders: default experiences -----

export interface DefaultExperienceCreateInput {
  appClipId: string;
  action?: AppClipAction | undefined;
  releaseWithAppStoreVersionId?: string | undefined;
  templateDefaultExperienceId?: string | undefined;
}

export function buildDefaultExperienceCreateBody(input: DefaultExperienceCreateInput): JSONAPIBody {
  const relationships: Record<string, unknown> = {
    appClip: linkage('appClips', input.appClipId),
  };
  if (input.releaseWithAppStoreVersionId !== undefined) {
    relationships.releaseWithAppStoreVersion = linkage(
      'appStoreVersions',
      input.releaseWithAppStoreVersionId,
    );
  }
  if (input.templateDefaultExperienceId !== undefined) {
    relationships.appClipDefaultExperienceTemplate = linkage(
      'appClipDefaultExperiences',
      input.templateDefaultExperienceId,
    );
  }
  const data: JSONAPIBody['data'] = { type: 'appClipDefaultExperiences', relationships };
  if (input.action !== undefined) data.attributes = { action: input.action };
  return { data };
}

export interface DefaultExperiencePatchInput {
  id: string;
  action?: AppClipAction | undefined;
  releaseWithAppStoreVersionId?: string | undefined;
}

export function buildDefaultExperiencePatchBody(input: DefaultExperiencePatchInput): JSONAPIBody {
  if (input.action === undefined && input.releaseWithAppStoreVersionId === undefined) {
    throw new Error('Nothing to update: pass action and/or releaseWithAppStoreVersionId');
  }
  const data: JSONAPIBody['data'] = { type: 'appClipDefaultExperiences', id: input.id };
  if (input.action !== undefined) data.attributes = { action: input.action };
  if (input.releaseWithAppStoreVersionId !== undefined) {
    data.relationships = {
      releaseWithAppStoreVersion: linkage('appStoreVersions', input.releaseWithAppStoreVersionId),
    };
  }
  return { data };
}

export function buildDefaultExperienceReleaseVersionLinkage(appStoreVersionId: string) {
  return linkage('appStoreVersions', appStoreVersionId);
}

export function buildAppStoreVersionDefaultExperienceLinkage(defaultExperienceId: string) {
  return linkage('appClipDefaultExperiences', defaultExperienceId);
}

// ----- Body builders: default experience localizations -----

export function buildDefaultExperienceLocalizationCreateBody(input: {
  defaultExperienceId: string;
  locale: string;
  subtitle?: string | undefined;
}): JSONAPIBody {
  const attributes: Record<string, unknown> = { locale: input.locale };
  if (input.subtitle !== undefined) attributes.subtitle = input.subtitle;
  return {
    data: {
      type: 'appClipDefaultExperienceLocalizations',
      attributes,
      relationships: {
        appClipDefaultExperience: linkage('appClipDefaultExperiences', input.defaultExperienceId),
      },
    },
  };
}

export function buildDefaultExperienceLocalizationPatchBody(
  id: string,
  subtitle: string,
): JSONAPIBody {
  return { data: { type: 'appClipDefaultExperienceLocalizations', id, attributes: { subtitle } } };
}

// ----- Body builders: review details -----

export function buildReviewDetailCreateBody(input: {
  defaultExperienceId: string;
  invocationUrls?: string[] | undefined;
}): JSONAPIBody {
  const data: JSONAPIBody['data'] = {
    type: 'appClipAppStoreReviewDetails',
    relationships: {
      appClipDefaultExperience: linkage('appClipDefaultExperiences', input.defaultExperienceId),
    },
  };
  if (input.invocationUrls !== undefined) {
    data.attributes = { invocationUrls: input.invocationUrls };
  }
  return { data };
}

export function buildReviewDetailPatchBody(id: string, invocationUrls: string[]): JSONAPIBody {
  return { data: { type: 'appClipAppStoreReviewDetails', id, attributes: { invocationUrls } } };
}

// ----- Body builders: images (legacy three-step upload) -----

const IMAGE = {
  header: { type: 'appClipHeaderImages', path: '/v1/appClipHeaderImages', label: 'header image' },
  advanced: {
    type: 'appClipAdvancedExperienceImages',
    path: '/v1/appClipAdvancedExperienceImages',
    label: 'advanced experience image',
  },
} as const;

type ImageKind = keyof typeof IMAGE;

export interface AppClipImageReserveInput {
  kind: ImageKind;
  fileName: string;
  fileSize: number;
  /** Required for header images (the parent localization); unused for advanced images. */
  defaultExperienceLocalizationId?: string | undefined;
}

export function buildAppClipImageReserveBody(input: AppClipImageReserveInput): JSONAPIBody {
  const data: JSONAPIBody['data'] = {
    type: IMAGE[input.kind].type,
    attributes: { fileName: input.fileName, fileSize: input.fileSize },
  };
  if (input.kind === 'header') {
    if (!input.defaultExperienceLocalizationId) {
      throw new Error('A header image needs defaultExperienceLocalizationId');
    }
    data.relationships = {
      appClipDefaultExperienceLocalization: linkage(
        'appClipDefaultExperienceLocalizations',
        input.defaultExperienceLocalizationId,
      ),
    };
  } else if (input.defaultExperienceLocalizationId !== undefined) {
    throw new Error('An advanced experience image has no parent at reserve time');
  }
  return { data };
}

export function buildAppClipImageCommitBody(input: {
  kind: ImageKind;
  id: string;
  sourceFileChecksum?: string | undefined;
  uploaded?: boolean | undefined;
}): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.sourceFileChecksum !== undefined) {
    attributes.sourceFileChecksum = input.sourceFileChecksum;
  }
  if (input.uploaded !== undefined) attributes.uploaded = input.uploaded;
  if (Object.keys(attributes).length === 0) {
    throw new Error('Nothing to update: pass sourceFileChecksum and/or uploaded');
  }
  return { data: { type: IMAGE[input.kind].type, id: input.id, attributes } };
}

// ----- Body builders: advanced experiences -----

function buildAdvancedLocalizationsIncluded(localizations: AdvancedLocalization[]) {
  return localizations.map((l, i) => {
    const attributes: Record<string, unknown> = { language: l.language };
    if (l.title !== undefined) attributes.title = l.title;
    if (l.subtitle !== undefined) attributes.subtitle = l.subtitle;
    return { type: 'appClipAdvancedExperienceLocalizations', id: tempId(i + 1), attributes };
  });
}

export interface AdvancedExperienceCreateInput {
  appClipId: string;
  link: string;
  isPoweredBy: boolean;
  defaultLanguage: AdvancedLanguage;
  headerImageId: string;
  localizations: AdvancedLocalization[];
  action?: AppClipAction | undefined;
  businessCategory?: BusinessCategory | undefined;
  place?: Place | undefined;
}

export function buildAdvancedExperienceCreateBody(
  input: AdvancedExperienceCreateInput,
): JSONAPIBody {
  if (input.localizations.length === 0) {
    throw new Error('An advanced experience needs at least one localization');
  }
  // Wire key is `isPoweredBy` — Apple does NOT strip the `is` prefix on this one.
  const attributes: Record<string, unknown> = {
    link: input.link,
    isPoweredBy: input.isPoweredBy,
    defaultLanguage: input.defaultLanguage,
  };
  if (input.action !== undefined) attributes.action = input.action;
  if (input.businessCategory !== undefined) attributes.businessCategory = input.businessCategory;
  if (input.place !== undefined) attributes.place = input.place;
  const included = buildAdvancedLocalizationsIncluded(input.localizations);
  return {
    data: {
      type: 'appClipAdvancedExperiences',
      attributes,
      relationships: {
        appClip: linkage('appClips', input.appClipId),
        headerImage: linkage('appClipAdvancedExperienceImages', input.headerImageId),
        localizations: { data: included.map((r) => ({ type: r.type, id: r.id })) },
      },
    },
    included,
  };
}

export interface AdvancedExperiencePatchInput {
  id: string;
  action?: AppClipAction | undefined;
  isPoweredBy?: boolean | undefined;
  businessCategory?: BusinessCategory | undefined;
  defaultLanguage?: AdvancedLanguage | undefined;
  place?: Place | undefined;
  removed?: boolean | undefined;
  headerImageId?: string | undefined;
  localizations?: AdvancedLocalization[] | undefined;
}

export function buildAdvancedExperiencePatchBody(input: AdvancedExperiencePatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.action !== undefined) attributes.action = input.action;
  if (input.isPoweredBy !== undefined) attributes.isPoweredBy = input.isPoweredBy;
  if (input.businessCategory !== undefined) attributes.businessCategory = input.businessCategory;
  if (input.defaultLanguage !== undefined) attributes.defaultLanguage = input.defaultLanguage;
  if (input.place !== undefined) attributes.place = input.place;
  if (input.removed !== undefined) attributes.removed = input.removed;

  const relationships: Record<string, unknown> = {};
  if (input.headerImageId !== undefined) {
    relationships.headerImage = linkage('appClipAdvancedExperienceImages', input.headerImageId);
  }
  let included: JSONAPIBody['included'];
  if (input.localizations !== undefined) {
    if (input.localizations.length === 0) {
      throw new Error('localizations, when passed, must list at least one');
    }
    included = buildAdvancedLocalizationsIncluded(input.localizations);
    relationships.localizations = { data: included.map((r) => ({ type: r.type, id: r.id })) };
  }
  if (Object.keys(attributes).length === 0 && Object.keys(relationships).length === 0) {
    throw new Error('Nothing to update');
  }
  const data: JSONAPIBody['data'] = { type: 'appClipAdvancedExperiences', id: input.id };
  if (Object.keys(attributes).length > 0) data.attributes = attributes;
  if (Object.keys(relationships).length > 0) data.relationships = relationships;
  return included ? { data, included } : { data };
}

// ----- Body builders: beta invocations -----

export function buildBetaInvocationCreateBody(input: {
  buildBundleId: string;
  url: string;
  localizations: Array<{ locale: string; title: string }>;
}): JSONAPIBody {
  if (input.localizations.length === 0) {
    throw new Error('A beta App Clip invocation needs at least one localization');
  }
  const included = input.localizations.map((l, i) => ({
    type: 'betaAppClipInvocationLocalizations',
    id: tempId(i + 1),
    attributes: { locale: l.locale, title: l.title },
  }));
  return {
    data: {
      type: 'betaAppClipInvocations',
      attributes: { url: input.url },
      relationships: {
        buildBundle: linkage('buildBundles', input.buildBundleId),
        betaAppClipInvocationLocalizations: {
          data: included.map((r) => ({ type: r.type, id: r.id })),
        },
      },
    },
    included,
  };
}

export function buildBetaInvocationPatchBody(id: string, url: string): JSONAPIBody {
  return { data: { type: 'betaAppClipInvocations', id, attributes: { url } } };
}

export function buildBetaInvocationLocalizationCreateBody(input: {
  invocationId: string;
  locale: string;
  title: string;
}): JSONAPIBody {
  return {
    data: {
      type: 'betaAppClipInvocationLocalizations',
      attributes: { locale: input.locale, title: input.title },
      relationships: {
        betaAppClipInvocation: linkage('betaAppClipInvocations', input.invocationId),
      },
    },
  };
}

export function buildBetaInvocationLocalizationPatchBody(id: string, title: string): JSONAPIBody {
  return { data: { type: 'betaAppClipInvocationLocalizations', id, attributes: { title } } };
}

// ----- Digests -----

function attr<T>(r: JSONAPIResource, key: string): T | undefined {
  return r.attributes?.[key] as T | undefined;
}

function relId(r: JSONAPIResource, key: string): string | undefined {
  const d = r.relationships?.[key]?.data;
  if (!d || Array.isArray(d)) return undefined;
  return d.id;
}

function relCount(r: JSONAPIResource, key: string): string {
  const d = r.relationships?.[key]?.data;
  return Array.isArray(d) ? String(d.length) : '';
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function footer(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ' (truncated — set raw:true or raise maxItems)' : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

function table(pages: CollectedPages, label: string, columns: Column[], rows: string[][]): string {
  if (pages.data.length === 0) return `0 ${label}`;
  return `${footer(pages, label)}\n\n${formatTable(columns, rows)}`;
}

export function digestAppClips(pages: CollectedPages): string {
  const rows = pages.data.map((c) => [
    str(attr(c, 'bundleId')),
    relCount(c, 'appClipDefaultExperiences'),
    c.id,
  ]);
  return table(
    pages,
    'App Clips',
    [{ header: 'BUNDLE_ID' }, { header: 'DEFAULT_EXPERIENCES', align: 'right' }, { header: 'ID' }],
    rows,
  );
}

export function digestDefaultExperiences(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const rows = pages.data.map((e) => {
    const versionId = relId(e, 'releaseWithAppStoreVersion');
    const version = lookupIncluded(index, 'appStoreVersions', versionId);
    return [
      str(attr(e, 'action')),
      version ? `${str(attr(version, 'versionString'))} (${versionId})` : str(versionId),
      relCount(e, 'appClipDefaultExperienceLocalizations'),
      str(relId(e, 'appClipAppStoreReviewDetail')),
      e.id,
    ];
  });
  return table(
    pages,
    'default experiences',
    [
      { header: 'ACTION' },
      { header: 'RELEASE_VERSION' },
      { header: 'LOCALES', align: 'right' },
      { header: 'REVIEW_DETAIL' },
      { header: 'ID' },
    ],
    rows,
  );
}

export function digestDefaultExperienceLocalizations(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const rows = pages.data.map((l) => {
    const imageId = relId(l, 'appClipHeaderImage');
    const image = lookupIncluded(index, 'appClipHeaderImages', imageId);
    const state = image
      ? str(attr<{ state?: string }>(image, 'assetDeliveryState')?.state)
      : imageId
        ? '?'
        : '';
    return [
      str(attr(l, 'locale')),
      str(attr(l, 'subtitle')),
      imageId ? `${imageId}${state ? ` ${state}` : ''}` : '',
      l.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return table(
    pages,
    'default experience localizations',
    [{ header: 'LOCALE' }, { header: 'SUBTITLE' }, { header: 'HEADER_IMAGE' }, { header: 'ID' }],
    rows,
  );
}

export function digestAdvancedExperiences(pages: CollectedPages): string {
  const rows = pages.data.map((e) => [
    str(attr(e, 'link')),
    str(attr(e, 'status')),
    str(attr(e, 'placeStatus')),
    str(attr(e, 'action')),
    str(attr(e, 'businessCategory')),
    str(attr(e, 'defaultLanguage')),
    relCount(e, 'localizations'),
    str(attr(e, 'version')),
    e.id,
  ]);
  return table(
    pages,
    'advanced experiences',
    [
      { header: 'LINK' },
      { header: 'STATUS' },
      { header: 'PLACE' },
      { header: 'ACTION' },
      { header: 'CATEGORY' },
      { header: 'LANG' },
      { header: 'LOCS', align: 'right' },
      { header: 'VER', align: 'right' },
      { header: 'ID' },
    ],
    rows,
  );
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

const DEFAULT_EXPERIENCE_INCLUDE =
  'appClip,releaseWithAppStoreVersion,appClipDefaultExperienceLocalizations,appClipAppStoreReviewDetail';
const ADVANCED_INCLUDE = 'headerImage,localizations';
const MaxItemsSchema = z.number().int().positive().max(2000).default(200);

export function registerAppClips(server: McpServer, client: ASCClient): void {
  async function getJson(path: string) {
    try {
      const data = await client.request<unknown>(path, { method: 'GET' });
      return textResult(JSON.stringify(data, null, 2));
    } catch (err) {
      return errorResult(err);
    }
  }

  async function send(method: 'POST' | 'PATCH', path: string, body: unknown, done: string) {
    try {
      const data = await client.request<unknown>(path, { method, body: JSON.stringify(body) });
      return textResult(`${done}\n\n${JSON.stringify(data ?? null, null, 2)}`);
    } catch (err) {
      return errorResult(err);
    }
  }

  async function remove(path: string, done: string) {
    try {
      await client.request<unknown>(path, { method: 'DELETE' });
      return textResult(done);
    } catch (err) {
      return errorResult(err);
    }
  }

  // ----- App Clips -----

  server.registerTool(
    'asc_list_app_clips',
    {
      title: "List an app's App Clips",
      description:
        'List the App Clips of an app (one per App Clip target). An App Clip record appears after a build containing the clip is uploaded; the API cannot create one. Each row: the clip bundle ID and how many default experiences it has. Next: asc_list_app_clip_default_experiences / asc_list_app_clip_advanced_experiences.',
      inputSchema: z.object({
        appId: AppIdSchema,
        bundleId: z.string().min(1).optional().describe('filter[bundleId] — the clip bundle ID.'),
        maxItems: MaxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, bundleId, maxItems, raw }) => {
      const params = new URLSearchParams();
      if (bundleId) params.set('filter[bundleId]', bundleId);
      params.set('include', 'appClipDefaultExperiences');
      params.set('fields[appClipDefaultExperiences]', 'action');
      params.set('limit[appClipDefaultExperiences]', '50');
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/apps/${encodeURIComponent(appId)}/appClips?${params.toString()}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestAppClips(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_app_clip',
    {
      title: 'Get an App Clip',
      description: 'Fetch one App Clip (bundle ID) with its app and default experiences included.',
      inputSchema: z.object({ appClipId: AppClipIdSchema }),
    },
    async ({ appClipId }) =>
      getJson(
        `/v1/appClips/${encodeURIComponent(appClipId)}?include=app,appClipDefaultExperiences&fields[apps]=name,bundleId`,
      ),
  );

  // ----- Default experiences -----

  server.registerTool(
    'asc_list_app_clip_default_experiences',
    {
      title: 'List App Clip default experiences',
      description:
        "List an App Clip's default experiences — the card shown for Safari Smart App Banners, Messages links and the default App Clip link. One per app version: each row shows the action (OPEN / VIEW / PLAY), the version it releases with, the localization count and the review detail ID. withReleaseVersion=true keeps only experiences linked to a version (exists[releaseWithAppStoreVersion]).",
      inputSchema: z.object({
        appClipId: AppClipIdSchema,
        withReleaseVersion: z.boolean().optional(),
        maxItems: MaxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ appClipId, withReleaseVersion, maxItems, raw }) => {
      const params = new URLSearchParams();
      if (withReleaseVersion !== undefined) {
        params.set('exists[releaseWithAppStoreVersion]', String(withReleaseVersion));
      }
      params.set('include', 'releaseWithAppStoreVersion');
      params.set('fields[appStoreVersions]', 'versionString,platform,appVersionState');
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/appClips/${encodeURIComponent(appClipId)}/appClipDefaultExperiences?${params.toString()}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestDefaultExperiences(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_app_clip_default_experience',
    {
      title: 'Get an App Clip default experience',
      description:
        'Fetch one default experience with its App Clip, release version, localizations and App Review detail included.',
      inputSchema: z.object({ defaultExperienceId: DefaultExperienceIdSchema }),
    },
    async ({ defaultExperienceId }) =>
      getJson(
        `/v1/appClipDefaultExperiences/${encodeURIComponent(defaultExperienceId)}?include=${DEFAULT_EXPERIENCE_INCLUDE}`,
      ),
  );

  server.registerTool(
    'asc_post_app_clip_default_experience',
    {
      title: 'Create an App Clip default experience',
      description:
        "Create a default experience for an App Clip. action is the card button (OPEN / VIEW / PLAY). releaseWithAppStoreVersionId ties it to the app version that ships it (an editable version). templateDefaultExperienceId copies an existing experience's localizations and header images — the usual way to carry the card forward to a new version. Then add localizations (asc_post_app_clip_default_experience_localization), a header image per localization and the App Review detail.",
      inputSchema: z.object({
        appClipId: AppClipIdSchema,
        action: AppClipActionSchema.optional(),
        releaseWithAppStoreVersionId: AppStoreVersionIdSchema.optional(),
        templateDefaultExperienceId: DefaultExperienceIdSchema.optional(),
      }),
    },
    async (input) => {
      try {
        return send(
          'POST',
          '/v1/appClipDefaultExperiences',
          buildDefaultExperienceCreateBody(input),
          `Created default experience for App Clip ${input.appClipId}.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_app_clip_default_experience',
    {
      title: 'Update an App Clip default experience',
      description:
        'Change the action (OPEN / VIEW / PLAY) and/or the app version the default experience releases with. Pass at least one.',
      inputSchema: z.object({
        defaultExperienceId: DefaultExperienceIdSchema,
        action: AppClipActionSchema.optional(),
        releaseWithAppStoreVersionId: AppStoreVersionIdSchema.optional(),
      }),
    },
    async ({ defaultExperienceId, ...rest }) => {
      try {
        return send(
          'PATCH',
          `/v1/appClipDefaultExperiences/${encodeURIComponent(defaultExperienceId)}`,
          buildDefaultExperiencePatchBody({ id: defaultExperienceId, ...rest }),
          `Patched default experience ${defaultExperienceId}.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_app_clip_default_experience',
    {
      title: 'Delete an App Clip default experience',
      description:
        'DELETE a default experience with its localizations, header images and review detail. Only an experience not yet live can be deleted.',
      inputSchema: z.object({ defaultExperienceId: DefaultExperienceIdSchema }),
    },
    async ({ defaultExperienceId }) =>
      remove(
        `/v1/appClipDefaultExperiences/${encodeURIComponent(defaultExperienceId)}`,
        `Deleted default experience ${defaultExperienceId}.`,
      ),
  );

  server.registerTool(
    'asc_get_app_clip_default_experience_release_version',
    {
      title: 'Get the version an App Clip default experience releases with',
      description:
        'Fetch the App Store version linked to a default experience (releaseWithAppStoreVersion). Returns data: null when none is linked.',
      inputSchema: z.object({ defaultExperienceId: DefaultExperienceIdSchema }),
    },
    async ({ defaultExperienceId }) =>
      getJson(
        `/v1/appClipDefaultExperiences/${encodeURIComponent(defaultExperienceId)}/releaseWithAppStoreVersion?fields[appStoreVersions]=platform,versionString,appVersionState,appStoreState,createdDate`,
      ),
  );

  server.registerTool(
    'asc_patch_app_clip_default_experience_release_version',
    {
      title: 'Link an App Clip default experience to a version',
      description:
        'Set the App Store version a default experience releases with (PATCH relationships/releaseWithAppStoreVersion). Same link as asc_patch_app_store_version_app_clip_default_experience, set from the experience side. The API cannot unlink — link another version instead.',
      inputSchema: z.object({
        defaultExperienceId: DefaultExperienceIdSchema,
        appStoreVersionId: AppStoreVersionIdSchema,
      }),
    },
    async ({ defaultExperienceId, appStoreVersionId }) =>
      send(
        'PATCH',
        `/v1/appClipDefaultExperiences/${encodeURIComponent(defaultExperienceId)}/relationships/releaseWithAppStoreVersion`,
        buildDefaultExperienceReleaseVersionLinkage(appStoreVersionId),
        `Default experience ${defaultExperienceId} now releases with version ${appStoreVersionId}.`,
      ),
  );

  server.registerTool(
    'asc_get_app_store_version_app_clip_default_experience',
    {
      title: "Get an App Store version's App Clip default experience",
      description:
        'Fetch the App Clip default experience attached to an App Store version, with its localizations and review detail included. Returns data: null when the version has none.',
      inputSchema: z.object({ appStoreVersionId: AppStoreVersionIdSchema }),
    },
    async ({ appStoreVersionId }) =>
      getJson(
        `/v1/appStoreVersions/${encodeURIComponent(appStoreVersionId)}/appClipDefaultExperience?include=appClip,appClipDefaultExperienceLocalizations,appClipAppStoreReviewDetail`,
      ),
  );

  server.registerTool(
    'asc_patch_app_store_version_app_clip_default_experience',
    {
      title: 'Attach an App Clip default experience to a version',
      description:
        'Attach a default experience to an App Store version (PATCH /v1/appStoreVersions/{id}/relationships/appClipDefaultExperience). The version must be editable. The API cannot detach — attach another experience instead. ⚠️ Changes the App Clip card that ships with that version.',
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
        defaultExperienceId: DefaultExperienceIdSchema,
      }),
    },
    async ({ appStoreVersionId, defaultExperienceId }) =>
      send(
        'PATCH',
        `/v1/appStoreVersions/${encodeURIComponent(appStoreVersionId)}/relationships/appClipDefaultExperience`,
        buildAppStoreVersionDefaultExperienceLinkage(defaultExperienceId),
        `Version ${appStoreVersionId} now uses default experience ${defaultExperienceId}.`,
      ),
  );

  // ----- Default experience localizations -----

  server.registerTool(
    'asc_list_app_clip_default_experience_localizations',
    {
      title: 'List App Clip default experience localizations',
      description:
        "List a default experience's localizations: locale, card subtitle and the header image (ID + delivery state). Filter with locale.",
      inputSchema: z.object({
        defaultExperienceId: DefaultExperienceIdSchema,
        locale: z.array(LocaleSchema).min(1).optional(),
        maxItems: MaxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ defaultExperienceId, locale, maxItems, raw }) => {
      const params = new URLSearchParams();
      if (locale?.length) params.set('filter[locale]', locale.join(','));
      params.set('include', 'appClipHeaderImage');
      params.set('fields[appClipHeaderImages]', 'fileName,assetDeliveryState');
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/appClipDefaultExperiences/${encodeURIComponent(defaultExperienceId)}/appClipDefaultExperienceLocalizations?${params.toString()}`,
          maxItems,
        );
        return textResult(
          raw ? JSON.stringify(pages, null, 2) : digestDefaultExperienceLocalizations(pages),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_app_clip_default_experience_localization',
    {
      title: 'Get an App Clip default experience localization',
      description: 'Fetch one localization with its default experience and header image included.',
      inputSchema: z.object({ localizationId: DefaultExperienceLocalizationIdSchema }),
    },
    async ({ localizationId }) =>
      getJson(
        `/v1/appClipDefaultExperienceLocalizations/${encodeURIComponent(localizationId)}?include=appClipDefaultExperience,appClipHeaderImage`,
      ),
  );

  server.registerTool(
    'asc_post_app_clip_default_experience_localization',
    {
      title: 'Create an App Clip default experience localization',
      description:
        'Add a locale to a default experience, with the card subtitle (Apple limit: 56 characters). Then upload its header image with asc_upload_app_clip_header_image.',
      inputSchema: z.object({
        defaultExperienceId: DefaultExperienceIdSchema,
        locale: LocaleSchema,
        subtitle: z.string().min(1).optional(),
      }),
    },
    async (input) =>
      send(
        'POST',
        '/v1/appClipDefaultExperienceLocalizations',
        buildDefaultExperienceLocalizationCreateBody(input),
        `Created ${input.locale} localization on default experience ${input.defaultExperienceId}.`,
      ),
  );

  server.registerTool(
    'asc_patch_app_clip_default_experience_localization',
    {
      title: 'Update an App Clip default experience localization',
      description: 'Change the card subtitle of one localization. The locale cannot change.',
      inputSchema: z.object({
        localizationId: DefaultExperienceLocalizationIdSchema,
        subtitle: z.string().min(1),
      }),
    },
    async ({ localizationId, subtitle }) =>
      send(
        'PATCH',
        `/v1/appClipDefaultExperienceLocalizations/${encodeURIComponent(localizationId)}`,
        buildDefaultExperienceLocalizationPatchBody(localizationId, subtitle),
        `Patched localization ${localizationId}.`,
      ),
  );

  server.registerTool(
    'asc_delete_app_clip_default_experience_localization',
    {
      title: 'Delete an App Clip default experience localization',
      description: 'DELETE one localization (and its header image) from a default experience.',
      inputSchema: z.object({ localizationId: DefaultExperienceLocalizationIdSchema }),
    },
    async ({ localizationId }) =>
      remove(
        `/v1/appClipDefaultExperienceLocalizations/${encodeURIComponent(localizationId)}`,
        `Deleted localization ${localizationId}.`,
      ),
  );

  // ----- App Store review detail -----

  server.registerTool(
    'asc_get_app_clip_app_store_review_detail',
    {
      title: 'Get an App Clip App Store review detail',
      description:
        "Fetch the App Review detail of a default experience — the invocation URLs App Review uses to open the clip. Pass reviewDetailId, or defaultExperienceId to fetch the experience's (data: null when it has none).",
      inputSchema: z.object({
        reviewDetailId: ReviewDetailIdSchema.optional(),
        defaultExperienceId: DefaultExperienceIdSchema.optional(),
      }),
    },
    async ({ reviewDetailId, defaultExperienceId }) => {
      if ((reviewDetailId === undefined) === (defaultExperienceId === undefined)) {
        return errorResult(new Error('Pass exactly one of reviewDetailId or defaultExperienceId'));
      }
      return getJson(
        reviewDetailId
          ? `/v1/appClipAppStoreReviewDetails/${encodeURIComponent(reviewDetailId)}?include=appClipDefaultExperience`
          : `/v1/appClipDefaultExperiences/${encodeURIComponent(defaultExperienceId ?? '')}/appClipAppStoreReviewDetail`,
      );
    },
  );

  server.registerTool(
    'asc_post_app_clip_app_store_review_detail',
    {
      title: 'Create an App Clip App Store review detail',
      description:
        'Create the App Review detail of a default experience: the invocation URLs (https) App Review opens to test the clip. One per default experience.',
      inputSchema: z.object({
        defaultExperienceId: DefaultExperienceIdSchema,
        invocationUrls: z.array(InvocationUrlSchema).min(1).optional(),
      }),
    },
    async (input) =>
      send(
        'POST',
        '/v1/appClipAppStoreReviewDetails',
        buildReviewDetailCreateBody(input),
        `Created review detail on default experience ${input.defaultExperienceId}.`,
      ),
  );

  server.registerTool(
    'asc_patch_app_clip_app_store_review_detail',
    {
      title: 'Update an App Clip App Store review detail',
      description:
        'Replace the invocation URLs of an App Clip review detail. The list you pass is the whole new list.',
      inputSchema: z.object({
        reviewDetailId: ReviewDetailIdSchema,
        invocationUrls: z.array(InvocationUrlSchema),
      }),
    },
    async ({ reviewDetailId, invocationUrls }) =>
      send(
        'PATCH',
        `/v1/appClipAppStoreReviewDetails/${encodeURIComponent(reviewDetailId)}`,
        buildReviewDetailPatchBody(reviewDetailId, invocationUrls),
        `Patched review detail ${reviewDetailId}.`,
      ),
  );

  // ----- Header images (default experience) -----

  server.registerTool(
    'asc_get_app_clip_header_image',
    {
      title: 'Get an App Clip header image',
      description:
        "Fetch a default experience header image: fileName, fileSize, assetDeliveryState, imageAsset once processed, and uploadOperations[] while AWAITING_UPLOAD. Pass headerImageId, or localizationId to fetch that localization's image (data: null when none).",
      inputSchema: z.object({
        headerImageId: HeaderImageIdSchema.optional(),
        localizationId: DefaultExperienceLocalizationIdSchema.optional(),
      }),
    },
    async ({ headerImageId, localizationId }) => {
      if ((headerImageId === undefined) === (localizationId === undefined)) {
        return errorResult(new Error('Pass exactly one of headerImageId or localizationId'));
      }
      return getJson(
        headerImageId
          ? `/v1/appClipHeaderImages/${encodeURIComponent(headerImageId)}?include=appClipDefaultExperienceLocalization`
          : `/v1/appClipDefaultExperienceLocalizations/${encodeURIComponent(localizationId ?? '')}/appClipHeaderImage`,
      );
    },
  );

  server.registerTool(
    'asc_post_app_clip_header_image',
    {
      title: 'Reserve an App Clip header image upload (raw step 1)',
      description:
        'RAW step 1 of the header image upload for one default experience localization: reserves fileName + fileSize and returns uploadOperations[]. PUT each with asc_upload_asset_chunk, then commit with asc_patch_app_clip_header_image (sourceFileChecksum + uploaded=true). Most callers should use asc_upload_app_clip_header_image.',
      inputSchema: z.object({
        localizationId: DefaultExperienceLocalizationIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
      }),
    },
    async ({ localizationId, fileName, fileSize }) => {
      try {
        return send(
          'POST',
          IMAGE.header.path,
          buildAppClipImageReserveBody({
            kind: 'header',
            fileName,
            fileSize,
            defaultExperienceLocalizationId: localizationId,
          }),
          `Reserved header image ${fileName} (${fileSize} bytes). Next: PUT each uploadOperation, then PATCH sourceFileChecksum + uploaded=true.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_app_clip_header_image',
    {
      title: 'Delete an App Clip header image',
      description: 'DELETE the header image of a default experience localization.',
      inputSchema: z.object({ headerImageId: HeaderImageIdSchema }),
    },
    async ({ headerImageId }) =>
      remove(
        `${IMAGE.header.path}/${encodeURIComponent(headerImageId)}`,
        `Deleted header image ${headerImageId}.`,
      ),
  );

  // ----- Advanced experience images -----

  server.registerTool(
    'asc_get_app_clip_advanced_experience_image',
    {
      title: 'Get an App Clip advanced experience image',
      description:
        'Fetch an advanced experience header image: fileName, fileSize, assetDeliveryState, imageAsset once processed, and uploadOperations[] while AWAITING_UPLOAD.',
      inputSchema: z.object({ imageId: AdvancedExperienceImageIdSchema }),
    },
    async ({ imageId }) => getJson(`${IMAGE.advanced.path}/${encodeURIComponent(imageId)}`),
  );

  server.registerTool(
    'asc_post_app_clip_advanced_experience_image',
    {
      title: 'Reserve an App Clip advanced experience image (raw step 1)',
      description:
        'RAW step 1 of the advanced experience image upload. The image has no parent at reserve time: reserve, PUT chunks (asc_upload_asset_chunk), commit (asc_patch_app_clip_advanced_experience_image), then pass its ID as headerImageId when creating or patching the advanced experience. Most callers should use asc_upload_app_clip_advanced_experience_image.',
      inputSchema: z.object({ fileName: FileNameSchema, fileSize: FileSizeSchema }),
    },
    async ({ fileName, fileSize }) =>
      send(
        'POST',
        IMAGE.advanced.path,
        buildAppClipImageReserveBody({ kind: 'advanced', fileName, fileSize }),
        `Reserved advanced experience image ${fileName} (${fileSize} bytes).`,
      ),
  );

  for (const kind of ['header', 'advanced'] as const) {
    const m = IMAGE[kind];
    const toolKind = kind === 'header' ? 'header_image' : 'advanced_experience_image';
    server.registerTool(
      `asc_patch_app_clip_${toolKind}`,
      {
        title: `Commit an App Clip ${m.label} (raw step 3)`,
        description: `RAW step 3: PATCH the ${m.label} with sourceFileChecksum (lowercase hex MD5 of the whole file) + uploaded=true to commit the reservation. Pass at least one. The composite asc_upload_app_clip_${toolKind} does this for you.`,
        inputSchema: z.object({
          imageId: z.string().min(1),
          sourceFileChecksum: SourceFileChecksumSchema.optional(),
          uploaded: z.boolean().optional(),
        }),
      },
      async ({ imageId, sourceFileChecksum, uploaded }) => {
        try {
          return send(
            'PATCH',
            `${m.path}/${encodeURIComponent(imageId)}`,
            buildAppClipImageCommitBody({ kind, id: imageId, sourceFileChecksum, uploaded }),
            `Patched ${m.label} ${imageId}.`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  async function uploadImage(
    kind: ImageKind,
    localFilePath: string,
    opts: {
      fileName?: string | undefined;
      localizationId?: string | undefined;
    },
  ) {
    const m = IMAGE[kind];
    const resolvedPath = expandHomePath(localFilePath);
    try {
      const fileSize = await readFileSizeBytes(resolvedPath);
      const fileName = opts.fileName ?? resolvedPath.split('/').pop() ?? 'image.png';
      const reserved = await client.request<AssetReserveResponse>(m.path, {
        method: 'POST',
        body: JSON.stringify(
          buildAppClipImageReserveBody({
            kind,
            fileName,
            fileSize,
            defaultExperienceLocalizationId: opts.localizationId,
          }),
        ),
      });
      const imageId = reserved.data?.id;
      const operations = reserved.data?.attributes?.uploadOperations ?? [];
      if (!imageId) throw new Error(`Reserve response missing ${m.label} id`);
      if (operations.length === 0) {
        throw new Error('Reserve response missing uploadOperations[] — cannot upload');
      }
      const executed = await executeAllUploadOperations(operations, resolvedPath);
      const checksum = await computeFileMd5Hex(resolvedPath);
      const committed = await client.request<unknown>(`${m.path}/${encodeURIComponent(imageId)}`, {
        method: 'PATCH',
        body: JSON.stringify(
          buildAppClipImageCommitBody({
            kind,
            id: imageId,
            sourceFileChecksum: checksum,
            uploaded: true,
          }),
        ),
      });
      const next =
        kind === 'advanced'
          ? ` Next: pass headerImageId=${imageId} to asc_post_app_clip_advanced_experience or asc_patch_app_clip_advanced_experience.`
          : '';
      return textResult(
        `Uploaded ${fileName} → ${m.label} ${imageId}.${next}\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(committed, null, 2)}`,
      );
    } catch (err) {
      return errorResult(err);
    }
  }

  server.registerTool(
    'asc_upload_app_clip_header_image',
    {
      title: 'Upload an App Clip header image (composite)',
      description:
        "Composite tool. Reads localFilePath, reserves a header image on one default experience localization, PUTs every chunk to Apple storage, then commits with the file's MD5 + uploaded=true. The image must be a 3:2 PNG or JPEG without transparency; Apple checks the size while processing (see assetDeliveryState). A localization holds one; delete the old one first to replace it.",
      inputSchema: z.object({
        localizationId: DefaultExperienceLocalizationIdSchema,
        localFilePath: LocalFilePathSchema,
        fileName: FileNameSchema.optional().describe('Defaults to basename(localFilePath).'),
      }),
    },
    async ({ localizationId, localFilePath, fileName }) =>
      uploadImage('header', localFilePath, { fileName, localizationId }),
  );

  server.registerTool(
    'asc_upload_app_clip_advanced_experience_image',
    {
      title: 'Upload an App Clip advanced experience image (composite)',
      description:
        "Composite tool. Reads localFilePath, reserves an advanced experience image, PUTs every chunk, then commits with the file's MD5 + uploaded=true. Returns the image ID to pass as headerImageId to asc_post_app_clip_advanced_experience / asc_patch_app_clip_advanced_experience. Same image rules as the default experience header (3:2 PNG or JPEG, no transparency).",
      inputSchema: z.object({
        localFilePath: LocalFilePathSchema,
        fileName: FileNameSchema.optional().describe('Defaults to basename(localFilePath).'),
      }),
    },
    async ({ localFilePath, fileName }) => uploadImage('advanced', localFilePath, { fileName }),
  );

  // ----- Advanced experiences -----

  server.registerTool(
    'asc_list_app_clip_advanced_experiences',
    {
      title: 'List App Clip advanced experiences',
      description:
        "List an App Clip's advanced experiences — per-URL cards for App Clip Codes, NFC tags, QR codes and Apple Maps place cards. Each row: invocation link, status (RECEIVED / DEACTIVATED / APP_TRANSFER_IN_PROGRESS), place match status, action, business category, default language, localization count and version. Filters: status, placeStatus, action.",
      inputSchema: z.object({
        appClipId: AppClipIdSchema,
        status: z.array(z.enum(ADVANCED_STATUSES)).min(1).optional(),
        placeStatus: z.array(z.enum(PLACE_STATUSES)).min(1).optional(),
        action: z.array(AppClipActionSchema).min(1).optional(),
        maxItems: MaxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ appClipId, status, placeStatus, action, maxItems, raw }) => {
      const params = new URLSearchParams();
      if (status?.length) params.set('filter[status]', status.join(','));
      if (placeStatus?.length) params.set('filter[placeStatus]', placeStatus.join(','));
      if (action?.length) params.set('filter[action]', action.join(','));
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/appClips/${encodeURIComponent(appClipId)}/appClipAdvancedExperiences?${params.toString()}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestAdvancedExperiences(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_app_clip_advanced_experience',
    {
      title: 'Get an App Clip advanced experience',
      description:
        'Fetch one advanced experience with its header image and localizations (language, title, subtitle) included, plus the place card when it has one.',
      inputSchema: z.object({ advancedExperienceId: AdvancedExperienceIdSchema }),
    },
    async ({ advancedExperienceId }) =>
      getJson(
        `/v1/appClipAdvancedExperiences/${encodeURIComponent(advancedExperienceId)}?include=${ADVANCED_INCLUDE}`,
      ),
  );

  server.registerTool(
    'asc_post_app_clip_advanced_experience',
    {
      title: 'Create an App Clip advanced experience',
      description:
        'Create an advanced experience: a card for one invocation URL (link, https, under a domain the clip has associated). Required: link, isPoweredBy (show "Powered by <app>"), defaultLanguage, a committed header image (upload it first with asc_upload_app_clip_advanced_experience_image) and at least one localization (language + title + subtitle), created inline. Optional: action, businessCategory, and place (an Apple Maps place card) for a location-based experience. ⚠️ Goes live for that URL once Apple processes it.',
      inputSchema: z.object({
        appClipId: AppClipIdSchema,
        link: InvocationUrlSchema,
        isPoweredBy: z.boolean(),
        defaultLanguage: AdvancedLanguageSchema,
        headerImageId: AdvancedExperienceImageIdSchema,
        localizations: z.array(AdvancedLocalizationSchema).min(1),
        action: AppClipActionSchema.optional(),
        businessCategory: BusinessCategorySchema.optional(),
        place: PlaceSchema.optional(),
      }),
    },
    async (input) => {
      try {
        return send(
          'POST',
          '/v1/appClipAdvancedExperiences',
          buildAdvancedExperienceCreateBody(input),
          `Created advanced experience for ${input.link}.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_app_clip_advanced_experience',
    {
      title: 'Update an App Clip advanced experience',
      description:
        'Update an advanced experience: action, isPoweredBy, businessCategory, defaultLanguage, place, a new headerImageId, or localizations (the list replaces the current ones — pass all of them). removed=true takes the experience down. The link cannot change. Pass at least one field.',
      inputSchema: z.object({
        advancedExperienceId: AdvancedExperienceIdSchema,
        action: AppClipActionSchema.optional(),
        isPoweredBy: z.boolean().optional(),
        businessCategory: BusinessCategorySchema.optional(),
        defaultLanguage: AdvancedLanguageSchema.optional(),
        place: PlaceSchema.optional(),
        removed: z.boolean().optional(),
        headerImageId: AdvancedExperienceImageIdSchema.optional(),
        localizations: z.array(AdvancedLocalizationSchema).min(1).optional(),
      }),
    },
    async ({ advancedExperienceId, ...rest }) => {
      try {
        return send(
          'PATCH',
          `/v1/appClipAdvancedExperiences/${encodeURIComponent(advancedExperienceId)}`,
          buildAdvancedExperiencePatchBody({ id: advancedExperienceId, ...rest }),
          `Patched advanced experience ${advancedExperienceId}.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ----- TestFlight: beta App Clip invocations -----

  server.registerTool(
    'asc_get_beta_app_clip_invocation',
    {
      title: 'Get a beta App Clip invocation',
      description:
        'Fetch one TestFlight App Clip invocation (the URL testers open the clip with) with its localized titles included.',
      inputSchema: z.object({ invocationId: BetaInvocationIdSchema }),
    },
    async ({ invocationId }) =>
      getJson(
        `/v1/betaAppClipInvocations/${encodeURIComponent(invocationId)}?include=betaAppClipInvocationLocalizations`,
      ),
  );

  server.registerTool(
    'asc_post_beta_app_clip_invocation',
    {
      title: 'Create a beta App Clip invocation',
      description:
        "Add a TestFlight invocation to a build's App Clip: the URL testers open the clip with, and its title per locale (created inline, at least one). buildBundleId is the App Clip's build bundle in the build (the build's buildBundles relationship), not the bundle ID string.",
      inputSchema: z.object({
        buildBundleId: z.string().min(1).describe('BuildBundle resource ID of the App Clip.'),
        url: InvocationUrlSchema,
        localizations: z.array(BetaInvocationLocalizationSchema).min(1),
      }),
    },
    async (input) => {
      try {
        return send(
          'POST',
          '/v1/betaAppClipInvocations',
          buildBetaInvocationCreateBody(input),
          `Created beta invocation ${input.url}.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_beta_app_clip_invocation',
    {
      title: 'Update a beta App Clip invocation',
      description: 'Change the URL of a TestFlight App Clip invocation.',
      inputSchema: z.object({ invocationId: BetaInvocationIdSchema, url: InvocationUrlSchema }),
    },
    async ({ invocationId, url }) =>
      send(
        'PATCH',
        `/v1/betaAppClipInvocations/${encodeURIComponent(invocationId)}`,
        buildBetaInvocationPatchBody(invocationId, url),
        `Patched beta invocation ${invocationId}.`,
      ),
  );

  server.registerTool(
    'asc_delete_beta_app_clip_invocation',
    {
      title: 'Delete a beta App Clip invocation',
      description: 'DELETE a TestFlight App Clip invocation and its localized titles.',
      inputSchema: z.object({ invocationId: BetaInvocationIdSchema }),
    },
    async ({ invocationId }) =>
      remove(
        `/v1/betaAppClipInvocations/${encodeURIComponent(invocationId)}`,
        `Deleted beta invocation ${invocationId}.`,
      ),
  );

  server.registerTool(
    'asc_post_beta_app_clip_invocation_localization',
    {
      title: 'Add a beta App Clip invocation title',
      description: 'Add a localized title to a TestFlight App Clip invocation.',
      inputSchema: z.object({
        invocationId: BetaInvocationIdSchema,
        locale: LocaleSchema,
        title: z.string().min(1),
      }),
    },
    async (input) =>
      send(
        'POST',
        '/v1/betaAppClipInvocationLocalizations',
        buildBetaInvocationLocalizationCreateBody(input),
        `Added ${input.locale} title to invocation ${input.invocationId}.`,
      ),
  );

  server.registerTool(
    'asc_patch_beta_app_clip_invocation_localization',
    {
      title: 'Update a beta App Clip invocation title',
      description: 'Change one localized title of a TestFlight App Clip invocation.',
      inputSchema: z.object({
        localizationId: BetaInvocationLocalizationIdSchema,
        title: z.string().min(1),
      }),
    },
    async ({ localizationId, title }) =>
      send(
        'PATCH',
        `/v1/betaAppClipInvocationLocalizations/${encodeURIComponent(localizationId)}`,
        buildBetaInvocationLocalizationPatchBody(localizationId, title),
        `Patched invocation title ${localizationId}.`,
      ),
  );

  server.registerTool(
    'asc_delete_beta_app_clip_invocation_localization',
    {
      title: 'Delete a beta App Clip invocation title',
      description: 'DELETE one localized title from a TestFlight App Clip invocation.',
      inputSchema: z.object({ localizationId: BetaInvocationLocalizationIdSchema }),
    },
    async ({ localizationId }) =>
      remove(
        `/v1/betaAppClipInvocationLocalizations/${encodeURIComponent(localizationId)}`,
        `Deleted invocation title ${localizationId}.`,
      ),
  );
}
