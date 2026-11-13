import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestSubscriptions } from '../digest.js';
import { ascErrorText } from '../errors.js';
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
  LocaleSchema,
  OfferModeSchema,
  PricePointIdSchema,
  ReviewSubmissionIdSchema,
  SubscriptionIdSchema,
  SubscriptionOfferDurationSchema,
  SubscriptionPlanTypeSchema,
} from '../schemas.js';
import { relCount } from './product-versions.js';

// Retention messaging (App Store Connect API 4.6).
//
// When a subscriber starts to cancel an auto-renewable subscription (in the
// App Store's subscription management sheet), Apple can show them a RETENTION
// MESSAGE — a short header + body, optionally with an image — and, alongside
// it, discounted RETENTION OFFERS for the same subscription. Both are
// customer-facing: real subscribers on their way out see them.
//
// Resources (Apple's "Setting up retention messaging" article):
//
//   retentionMessages            The container. Belongs to one app, has an
//                                internal `referenceName` (≤ 64 chars, never
//                                shown to customers, immutable). At most 10
//                                per app. No state of its own.
//   retentionMessageVersions     The content App Review approves. Create body
//                                is relationships-only: the message, plus an
//                                optional `placement` (an App Asset Library
//                                placement) for an image; omit it for a
//                                text-only message. `state` runs
//                                PREPARE_FOR_SUBMISSION → READY_FOR_REVIEW →
//                                WAITING_FOR_REVIEW → IN_REVIEW → ACCEPTED /
//                                REJECTED → APPROVED (DEVELOPER_REJECTED when
//                                withdrawn). There is NO version number, and
//                                NO PATCH or DELETE: a version is permanent.
//                                To change approved content, make a new one.
//   retentionMessageLocalizations  `header` (≤ 66) + `body` (≤ 144) per
//                                `locale`, scoped to a version. PATCH can edit
//                                header/body, never locale. Apple refuses new
//                                localizations on an APPROVED version.
//   retentionOffers              A discount for a subscription: offerId (the
//                                StoreKit identifier), duration, offerMode,
//                                periodCount, eligibility (min paid months —
//                                1..24, 36, 48, 60 — and optional months to
//                                wait between offers, 2..24) and an optional
//                                targetSubscriptionPlanType. Prices are created
//                                inline in `included[]` as retentionOfferPrices
//                                carrying ONLY a subscriptionPricePoint (no
//                                territory — the price point implies it).
//                                PATCH is eligibility-only; everything else is
//                                immutable. At most 10 active offers per
//                                subscription per targetSubscriptionPlanType.
//
// Wiring, on the SUBSCRIPTION (not on the message):
//   subscriptions/{id}/relationships/retentionMessage        PATCH, to-one.
//       Assigns the message; replaces any existing one. A subscription has at
//       most one. The spec gives no way to clear it (data is non-nullable).
//   subscriptions/{id}/relationships/retentionMessageOffers  POST / DELETE.
//       Which of the subscription's retention offers are PRESENTED with the
//       message. Creating an offer does not present it.
//   subscriptions/{id}/retentionOffers                        GET. Every
//       retention offer created for the subscription, presented or not.
//
// Review: every retention message version goes through App Review before
// customers see it, as a reviewSubmissionItem with a `retentionMessageVersion`
// relationship (asc_post_retention_message_version_review_item here).
//
// Retention offers are distinct from the other three subscription offer types:
// introductory (new subscribers), promotional (existing/lapsed, via signed
// in-app redemption) and win-back (lapsed subscribers, surfaced by Apple).
// Retention offers are for CURRENT subscribers who are cancelling.

// ----- Constants -----

export const RETENTION_MESSAGE_VERSION_STATES = [
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'ACCEPTED',
  'APPROVED',
] as const;

// A version in one of these states is somewhere in App Review or live. ppp
// refuses to delete a localization of such a version, and refuses to delete a
// message that has one (unless force:true).
const REVIEW_OR_LIVE_STATES = new Set<string>([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'ACCEPTED',
  'APPROVED',
]);

// Apple's documented eligibility domains (Setting up retention messaging).
export const PAID_DURATION_MONTHS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 36, 48, 60,
] as const;

const MAX_MESSAGES_PER_APP = 10;

const MESSAGE_FIELDS = 'referenceName,versions,subscriptions';
const VERSION_FIELDS = 'state,retentionMessage,localizations,placement';
const LOCALIZATION_FIELDS = 'locale,header,body,retentionMessageVersion';
const OFFER_FIELDS =
  'referenceName,offerId,duration,offerMode,periodCount,customerEligibilityPaidSubscriptionDurationInMonths,customerEligibilityWaitBetweenOffersInMonths,targetSubscriptionPlanType,subscription,prices';

// ----- Schemas -----

const RetentionMessageIdSchema = z
  .string()
  .min(1)
  .describe('Retention message ID (retentionMessages), from asc_list_retention_messages.');

const RetentionMessageVersionIdSchema = z
  .string()
  .min(1)
  .describe(
    'Retention message version ID (retentionMessageVersions), from asc_list_retention_message_versions.',
  );

const RetentionMessageLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'Retention message localization ID (retentionMessageLocalizations), from asc_list_retention_message_version_localizations.',
  );

const RetentionOfferIdSchema = z
  .string()
  .min(1)
  .describe('Retention offer ID (retentionOffers), from asc_list_subscription_retention_offers.');

const HeaderSchema = z
  .string()
  .min(1)
  .max(66)
  .describe('Customer-facing headline of the retention message, up to 66 characters.');

const BodySchema = z
  .string()
  .min(1)
  .max(144)
  .describe('Customer-facing body text of the retention message, up to 144 characters.');

const PaidDurationSchema = z
  .number()
  .int()
  .refine((n) => (PAID_DURATION_MONTHS as readonly number[]).includes(n), {
    message: 'Apple accepts 1 to 24, 36, 48 or 60.',
  })
  .describe(
    'Eligibility: minimum months of paid subscription that make a subscriber eligible. Apple accepts 1 to 24, 36, 48 and 60.',
  );

const WaitBetweenSchema = z
  .number()
  .int()
  .min(2)
  .max(24)
  .describe(
    'Eligibility: months a subscriber must wait before redeeming another retention offer for the same subscription, 2 to 24.',
  );

const ForceSchema = z
  .boolean()
  .default(false)
  .describe(
    "Skip ppp's client-side pre-check and send the DELETE anyway, letting Apple be the judge.",
  );

const REVIEW_NOTE =
  'Every retention message version goes through App Review before customers see it: add it to a review submission with asc_post_retention_message_version_review_item.';

const MODEL_NOTE =
  'Retention messages (API 4.6) are shown to subscribers who start to cancel an auto-renewable subscription: a header + body (optionally an image) per locale, optionally presented with discounted retention offers. Customer-facing. A message (internal referenceName, max 10 per app) holds versions; a version holds the localized text and goes through App Review; a subscription is assigned at most one message.';

// ----- Body builders -----

interface Ref {
  type: string;
  id: string;
}

export interface RetentionMessageCreateBody {
  data: {
    type: 'retentionMessages';
    attributes: { referenceName: string };
    relationships: { app: { data: Ref } };
  };
}

export function buildRetentionMessageCreateBody(
  appId: string,
  referenceName: string,
): RetentionMessageCreateBody {
  return {
    data: {
      type: 'retentionMessages',
      attributes: { referenceName },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  };
}

export interface RetentionMessageVersionCreateBody {
  data: {
    type: 'retentionMessageVersions';
    relationships: {
      retentionMessage: { data: Ref };
      placement?: { data: Ref };
    };
  };
}

export function buildRetentionMessageVersionCreateBody(
  retentionMessageId: string,
  placementId?: string | undefined,
): RetentionMessageVersionCreateBody {
  const relationships: RetentionMessageVersionCreateBody['data']['relationships'] = {
    retentionMessage: { data: { type: 'retentionMessages', id: retentionMessageId } },
  };
  if (placementId !== undefined) {
    relationships.placement = { data: { type: 'appAssetLibraryPlacements', id: placementId } };
  }
  return { data: { type: 'retentionMessageVersions', relationships } };
}

export interface RetentionMessageLocalizationCreateInput {
  versionId: string;
  locale: string;
  header?: string | undefined;
  body?: string | undefined;
}

export interface RetentionMessageLocalizationBody {
  data: {
    type: 'retentionMessageLocalizations';
    id?: string;
    attributes: Record<string, string | null>;
    relationships?: { retentionMessageVersion: { data: Ref } };
  };
}

export function buildRetentionMessageLocalizationCreateBody(
  input: RetentionMessageLocalizationCreateInput,
): RetentionMessageLocalizationBody {
  const attributes: Record<string, string> = { locale: input.locale };
  if (input.header !== undefined) attributes.header = input.header;
  if (input.body !== undefined) attributes.body = input.body;
  return {
    data: {
      type: 'retentionMessageLocalizations',
      attributes,
      relationships: {
        retentionMessageVersion: {
          data: { type: 'retentionMessageVersions', id: input.versionId },
        },
      },
    },
  };
}

export interface RetentionMessageLocalizationPatchInput {
  header?: string | null | undefined;
  body?: string | null | undefined;
}

export function buildRetentionMessageLocalizationPatchBody(
  localizationId: string,
  changes: RetentionMessageLocalizationPatchInput,
): RetentionMessageLocalizationBody {
  // header/body are nullable in Apple's update schema; null is sent through.
  // locale is not in the update schema at all.
  const attributes: Record<string, string | null> = {};
  if (changes.header !== undefined) attributes.header = changes.header;
  if (changes.body !== undefined) attributes.body = changes.body;
  return { data: { type: 'retentionMessageLocalizations', id: localizationId, attributes } };
}

export interface RetentionOfferCreateInput {
  subscriptionId: string;
  referenceName: string;
  offerId: string;
  duration: z.infer<typeof SubscriptionOfferDurationSchema>;
  offerMode: z.infer<typeof OfferModeSchema>;
  periodCount: number;
  customerEligibilityPaidSubscriptionDurationInMonths: number;
  customerEligibilityWaitBetweenOffersInMonths?: number | undefined;
  targetSubscriptionPlanType?: z.infer<typeof SubscriptionPlanTypeSchema> | undefined;
  pricePointIds: string[];
}

export interface RetentionOfferBody {
  data: {
    type: 'retentionOffers';
    id?: string;
    attributes: Record<string, unknown>;
    relationships?: {
      subscription: { data: Ref };
      prices: { data: Ref[] };
    };
  };
  included?: Array<{
    type: 'retentionOfferPrices';
    id: string;
    relationships: { subscriptionPricePoint: { data: Ref } };
  }>;
}

function tempId(n: number): string {
  // Apple's JSON:API local-ID convention: a literal `${name}` on the wire.
  // Built by concatenation so biome's noTemplateCurlyInString stays quiet.
  return `\${price${n}}`;
}

export function buildRetentionOfferCreateBody(
  input: RetentionOfferCreateInput,
): RetentionOfferBody {
  const attributes: Record<string, unknown> = {
    referenceName: input.referenceName,
    offerId: input.offerId,
    duration: input.duration,
    offerMode: input.offerMode,
    periodCount: input.periodCount,
    customerEligibilityPaidSubscriptionDurationInMonths:
      input.customerEligibilityPaidSubscriptionDurationInMonths,
  };
  if (input.customerEligibilityWaitBetweenOffersInMonths !== undefined) {
    attributes.customerEligibilityWaitBetweenOffersInMonths =
      input.customerEligibilityWaitBetweenOffersInMonths;
  }
  if (input.targetSubscriptionPlanType !== undefined) {
    attributes.targetSubscriptionPlanType = input.targetSubscriptionPlanType;
  }
  // Each inline price needs only the subscriptionPricePoint relationship; the
  // price point already pins the territory (unlike win-back / promo prices).
  const included = input.pricePointIds.map((pricePointId, i) => ({
    type: 'retentionOfferPrices' as const,
    id: tempId(i + 1),
    relationships: {
      subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: pricePointId } },
    },
  }));
  return {
    data: {
      type: 'retentionOffers',
      attributes,
      relationships: {
        subscription: { data: { type: 'subscriptions', id: input.subscriptionId } },
        prices: { data: included.map((p) => ({ type: p.type, id: p.id })) },
      },
    },
    included,
  };
}

export interface RetentionOfferPatchInput {
  customerEligibilityPaidSubscriptionDurationInMonths?: number | undefined;
  customerEligibilityWaitBetweenOffersInMonths?: number | null | undefined;
}

export function buildRetentionOfferPatchBody(
  retentionOfferId: string,
  changes: RetentionOfferPatchInput,
): RetentionOfferBody {
  // Eligibility is the only mutable part of a retention offer.
  const attributes: Record<string, unknown> = {};
  if (changes.customerEligibilityPaidSubscriptionDurationInMonths !== undefined) {
    attributes.customerEligibilityPaidSubscriptionDurationInMonths =
      changes.customerEligibilityPaidSubscriptionDurationInMonths;
  }
  if (changes.customerEligibilityWaitBetweenOffersInMonths !== undefined) {
    attributes.customerEligibilityWaitBetweenOffersInMonths =
      changes.customerEligibilityWaitBetweenOffersInMonths;
  }
  return { data: { type: 'retentionOffers', id: retentionOfferId, attributes } };
}

export interface SubscriptionRetentionMessageLinkageBody {
  data: { type: 'retentionMessages'; id: string };
}

export function buildSubscriptionRetentionMessageLinkageBody(
  retentionMessageId: string,
): SubscriptionRetentionMessageLinkageBody {
  return { data: { type: 'retentionMessages', id: retentionMessageId } };
}

export interface RetentionMessageOffersLinkageBody {
  data: Array<{ type: 'retentionOffers'; id: string }>;
}

export function buildRetentionMessageOffersLinkageBody(
  retentionOfferIds: string[],
): RetentionMessageOffersLinkageBody {
  return { data: retentionOfferIds.map((id) => ({ type: 'retentionOffers' as const, id })) };
}

export interface RetentionMessageReviewItemBody {
  data: {
    type: 'reviewSubmissionItems';
    relationships: {
      reviewSubmission: { data: Ref };
      retentionMessageVersion: { data: Ref };
    };
  };
}

export function buildRetentionMessageReviewItemBody(
  reviewSubmissionId: string,
  versionId: string,
): RetentionMessageReviewItemBody {
  return {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: reviewSubmissionId } },
        retentionMessageVersion: { data: { type: 'retentionMessageVersions', id: versionId } },
      },
    },
  };
}

// ----- Pre-check gates (pure, so tests can pin them) -----

export interface DeleteGate {
  allow: boolean;
  reason?: string;
  next?: string;
}

export function evaluateRetentionMessageDeleteGate(
  versionStates: string[],
  assignedSubscriptionCount: number,
): DeleteGate {
  if (assignedSubscriptionCount > 0) {
    return {
      allow: false,
      reason: `The message is assigned to ${assignedSubscriptionCount} subscription(s); once approved, cancelling subscribers of those see it.`,
      next: 'Assign a different message to those subscriptions with asc_set_subscription_retention_message first (the spec has no way to clear the assignment), or retry with force:true.',
    };
  }
  const busy = versionStates.filter((s) => REVIEW_OR_LIVE_STATES.has(s));
  if (busy.length > 0) {
    return {
      allow: false,
      reason: `The message has version(s) in review or approved: ${busy.join(', ')}.`,
      next: 'Withdraw the review submission first, or retry with force:true if the approved content should go.',
    };
  }
  return { allow: true };
}

export function evaluateRetentionLocalizationDeleteGate(
  versionState: string | undefined,
): DeleteGate {
  if (versionState && REVIEW_OR_LIVE_STATES.has(versionState)) {
    return {
      allow: false,
      reason: `Its version is ${versionState}; that text is in review or live.`,
      next: 'Versions cannot be edited once submitted. Create a new version with asc_post_retention_message_version and write its localizations instead.',
    };
  }
  return { allow: true };
}

export function evaluateRetentionOfferDeleteGate(presented: boolean): DeleteGate {
  if (presented) {
    return {
      allow: false,
      reason:
        "The offer is in its subscription's retention message offers, so cancelling subscribers can be shown it.",
      next: 'Remove it first with asc_remove_subscription_retention_message_offers, or retry with force:true.',
    };
  }
  return { allow: true };
}

// ----- Digests -----

function attr(r: JSONAPIResource, key: string): string {
  const v = r.attributes?.[key];
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function relIds(r: JSONAPIResource, key: string): string[] {
  const data = r.relationships?.[key]?.data;
  if (Array.isArray(data)) return data.map((d) => d.id);
  return data ? [data.id] : [];
}

function footer(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ' (truncated — pass maxItems to fetch more)' : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

export function digestRetentionMessages(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'REFERENCE_NAME' },
    { header: 'VERSION_STATES' },
    { header: 'SUBSCRIPTIONS' },
    { header: 'MESSAGE_ID' },
  ];
  const rows = pages.data.map((m) => {
    const states = relIds(m, 'versions').map(
      (id) =>
        attr(lookupIncluded(index, 'retentionMessageVersions', id) ?? { type: '', id }, 'state') ||
        '?',
    );
    const subs = relIds(m, 'subscriptions').map((id) => {
      const sub = lookupIncluded(index, 'subscriptions', id);
      return sub ? attr(sub, 'productId') || id : id;
    });
    return [
      attr(m, 'referenceName'),
      states.length ? states.join(', ') : '(none)',
      subs.length ? subs.join(', ') : '(none)',
      m.id,
    ];
  });
  return `${footer(pages, 'retention messages')}\n\n${formatTable(columns, rows)}`;
}

export function digestRetentionMessageVersions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'STATE' },
    { header: 'LOCS', align: 'right' },
    { header: 'PLACEMENT' },
    { header: 'VERSION_ID' },
  ];
  const rows = pages.data.map((v) => [
    attr(v, 'state'),
    relCount(v, 'localizations'),
    relIds(v, 'placement')[0] ?? '',
    v.id,
  ]);
  return `${footer(pages, 'retention message versions')}\n\n${formatTable(columns, rows)}`;
}

export function digestRetentionMessageLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'HEADER' },
    { header: 'BODY' },
    { header: 'LOCALIZATION_ID' },
  ];
  const rows = pages.data.map((l) => [attr(l, 'locale'), attr(l, 'header'), attr(l, 'body'), l.id]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${footer(pages, 'localizations')}\n\n${formatTable(columns, rows)}`;
}

export function digestRetentionOffers(pages: CollectedPages, label = 'retention offers'): string {
  const columns: Column[] = [
    { header: 'REFERENCE_NAME' },
    { header: 'OFFER_ID' },
    { header: 'MODE' },
    { header: 'DURATION' },
    { header: 'PERIODS', align: 'right' },
    { header: 'MIN_PAID_MO', align: 'right' },
    { header: 'WAIT_MO', align: 'right' },
    { header: 'PLAN' },
    { header: 'PRICES', align: 'right' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((o) => [
    attr(o, 'referenceName'),
    attr(o, 'offerId'),
    attr(o, 'offerMode'),
    attr(o, 'duration'),
    attr(o, 'periodCount'),
    attr(o, 'customerEligibilityPaidSubscriptionDurationInMonths'),
    attr(o, 'customerEligibilityWaitBetweenOffersInMonths'),
    attr(o, 'targetSubscriptionPlanType'),
    relCount(o, 'prices'),
    o.id,
  ]);
  return `${footer(pages, label)}\n\n${formatTable(columns, rows)}`;
}

export function digestRetentionOfferPrices(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'CCY' },
    { header: 'AMOUNT', align: 'right' },
    { header: 'POINT_ID' },
    { header: 'PRICE_ID' },
  ];
  const rows = pages.data.map((p) => {
    const terrId = relIds(p, 'territory')[0];
    const pointId = relIds(p, 'subscriptionPricePoint')[0];
    const terr = lookupIncluded(index, 'territories', terrId);
    const point = lookupIncluded(index, 'subscriptionPricePoints', pointId);
    return [
      terrId ?? '',
      terr ? attr(terr, 'currency') : '',
      point ? attr(point, 'customerPrice') : '',
      pointId ?? '',
      p.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${footer(pages, 'retention offer prices')}\n\n${formatTable(columns, rows)}`;
}

// ----- Query builders -----

export function buildRetentionMessageListQuery(): URLSearchParams {
  const params = new URLSearchParams();
  params.set('fields[retentionMessages]', MESSAGE_FIELDS);
  params.set('include', 'versions,subscriptions');
  params.set('fields[retentionMessageVersions]', 'state');
  params.set('fields[subscriptions]', 'name,productId');
  params.set('limit[versions]', '50');
  params.set('limit[subscriptions]', '50');
  params.set('limit', '200');
  return params;
}

export function buildRetentionOfferListQuery(): URLSearchParams {
  const params = new URLSearchParams();
  params.set('fields[retentionOffers]', OFFER_FIELDS);
  params.set('limit', '200');
  return params;
}

// ----- Helpers -----

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(err: unknown, prefix = '') {
  return {
    content: [{ type: 'text' as const, text: `${prefix}${ascErrorText(err)}` }],
    isError: true,
  };
}

function refusal(what: string, gate: DeleteGate) {
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Refused: ${what} DELETE blocked by the pre-check.`,
          '',
          `Reason: ${gate.reason ?? ''}`,
          `Next:   ${gate.next ?? ''}`,
          '',
          'If you are sure, retry with force:true — the pre-check is skipped and Apple decides.',
        ].join('\n'),
      },
    ],
    isError: true,
  };
}

const UNGUARDED =
  'Note: the pre-check could not run (its GET failed), so this DELETE went out unguarded — Apple was the only gate.\n\n';

const enc = encodeURIComponent;

// ----- Registration -----

export function registerRetentionMessages(server: McpServer, client: ASCClient): void {
  // --- Messages ---

  server.registerTool(
    'asc_list_retention_messages',
    {
      title: 'List retention messages',
      description: `List an app's retention messages with each one's version states and the subscriptions it is assigned to. ${MODEL_NOTE}`,
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(200).default(50),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/apps/${enc(appId)}/retentionMessages?${buildRetentionMessageListQuery()}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestRetentionMessages(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_retention_message',
    {
      title: 'Get a retention message',
      description:
        'Fetch one retention message with its versions (and their states) and assigned subscriptions included.',
      inputSchema: z.object({ retentionMessageId: RetentionMessageIdSchema }),
    },
    async ({ retentionMessageId }) => {
      const params = new URLSearchParams();
      params.set('include', 'versions,subscriptions');
      params.set('fields[retentionMessageVersions]', VERSION_FIELDS);
      try {
        const data = await client.request<unknown>(
          `/v1/retentionMessages/${enc(retentionMessageId)}?${params}`,
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_retention_message',
    {
      title: 'Create a retention message',
      description: `Create a retention message for an app. ${MODEL_NOTE} The referenceName (up to 64 characters) is internal, never shown to customers, and cannot be changed later. Next: asc_post_retention_message_version, then its localizations, then submit the version for review and assign the message to a subscription with asc_set_subscription_retention_message. ppp pre-flights Apple's 10-per-app cap and refuses a duplicate referenceName. dryRun returns the body and the existing messages without writing.`,
      inputSchema: z.object({
        appId: AppIdSchema,
        referenceName: z
          .string()
          .min(1)
          .max(64)
          .describe('Internal name, up to 64 characters. Not shown to customers. Immutable.'),
        dryRun: z.boolean().default(false),
      }),
    },
    async ({ appId, referenceName, dryRun }) => {
      const body = buildRetentionMessageCreateBody(appId, referenceName);
      let existing: CollectedPages;
      try {
        existing = await paginate(
          client,
          `/v1/apps/${enc(appId)}/retentionMessages?${buildRetentionMessageListQuery()}`,
          200,
        );
      } catch (err) {
        return errorResult(err, 'Pre-flight failed (could not list existing retention messages): ');
      }
      const table = digestRetentionMessages(existing);
      const dupe = existing.data.find((m) => attr(m, 'referenceName') === referenceName);
      const full = existing.data.length >= MAX_MESSAGES_PER_APP;
      const problem = dupe
        ? `referenceName "${referenceName}" is already used by retention message ${dupe.id}.`
        : full
          ? `the app already has ${existing.data.length} retention messages (Apple's cap is ${MAX_MESSAGES_PER_APP}). Delete one first.`
          : '';
      if (dryRun) {
        return textResult(
          `Dry run — would POST /v1/retentionMessages:\n\n${JSON.stringify(body, null, 2)}\n\n${table}${
            problem ? `\n\nA real call would be refused: ${problem}` : ''
          }`,
        );
      }
      if (problem) {
        return {
          content: [{ type: 'text' as const, text: `Refused: ${problem}\n\n${table}` }],
          isError: true,
        };
      }
      try {
        const data = await client.request<unknown>('/v1/retentionMessages', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_retention_message',
    {
      title: 'Delete a retention message',
      description:
        'Delete a retention message (and with it its versions and localizations). Customer-facing: if it is assigned to a subscription and approved, cancelling subscribers stop seeing it. ' +
        'ppp pre-checks with one GET and refuses when the message is assigned to any subscription, or has a version WAITING_FOR_REVIEW / IN_REVIEW / ACCEPTED / APPROVED. ' +
        'Pass force:true to skip the pre-check and let Apple judge; the gate is ppp policy, not an Apple rule.',
      inputSchema: z.object({
        retentionMessageId: RetentionMessageIdSchema,
        force: ForceSchema,
      }),
    },
    async ({ retentionMessageId, force }) => {
      let note = '';
      if (!force) {
        try {
          const params = new URLSearchParams();
          params.set('fields[retentionMessages]', MESSAGE_FIELDS);
          params.set('include', 'versions,subscriptions');
          params.set('fields[retentionMessageVersions]', 'state');
          params.set('limit[versions]', '50');
          params.set('limit[subscriptions]', '50');
          const res = await client.request<{
            data: JSONAPIResource;
            included?: JSONAPIResource[];
          }>(`/v1/retentionMessages/${enc(retentionMessageId)}?${params}`);
          const index = buildIncludedIndex(res.included ?? []);
          const states = relIds(res.data, 'versions').map((id) => {
            const v = lookupIncluded(index, 'retentionMessageVersions', id);
            return v ? attr(v, 'state') : '';
          });
          const subs = relIds(res.data, 'subscriptions').length;
          const gate = evaluateRetentionMessageDeleteGate(states, subs);
          if (!gate.allow) return refusal('Retention message', gate);
        } catch {
          note = UNGUARDED;
        }
      }
      try {
        await client.request<void>(`/v1/retentionMessages/${enc(retentionMessageId)}`, {
          method: 'DELETE',
        });
        return textResult(`${note}Deleted retention message ${retentionMessageId}.`);
      } catch (err) {
        return errorResult(err, note);
      }
    },
  );

  server.registerTool(
    'asc_list_retention_message_subscriptions',
    {
      title: "List a retention message's subscriptions",
      description:
        'List the auto-renewable subscriptions a retention message is assigned to. Each subscription has at most one retention message; assign with asc_set_subscription_retention_message.',
      inputSchema: z.object({
        retentionMessageId: RetentionMessageIdSchema,
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ retentionMessageId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/retentionMessages/${enc(retentionMessageId)}/subscriptions?limit=200`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestSubscriptions(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Versions ---

  server.registerTool(
    'asc_list_retention_message_versions',
    {
      title: 'List retention message versions',
      description: `List the versions of a retention message with state, localization count and image placement. Versions have no number and cannot be edited or deleted after creation; to change approved content, create a new version. ${REVIEW_NOTE}`,
      inputSchema: z.object({
        retentionMessageId: RetentionMessageIdSchema,
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ retentionMessageId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[retentionMessageVersions]', VERSION_FIELDS);
      params.set('include', 'localizations');
      params.set('fields[retentionMessageLocalizations]', 'locale');
      params.set('limit[localizations]', '50');
      params.set('limit', '200');
      try {
        const pages = await paginate(
          client,
          `/v1/retentionMessages/${enc(retentionMessageId)}/versions?${params}`,
          maxItems,
        );
        return textResult(
          raw ? JSON.stringify(pages, null, 2) : digestRetentionMessageVersions(pages),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_retention_message_version',
    {
      title: 'Get a retention message version',
      description: `Fetch one retention message version (state) with its message, localizations (locale, header, body) and image placement included. Use it to follow a version through review: PREPARE_FOR_SUBMISSION → READY_FOR_REVIEW → WAITING_FOR_REVIEW → IN_REVIEW → ACCEPTED or REJECTED → APPROVED (DEVELOPER_REJECTED when withdrawn).`,
      inputSchema: z.object({ versionId: RetentionMessageVersionIdSchema }),
    },
    async ({ versionId }) => {
      const params = new URLSearchParams();
      params.set('include', 'retentionMessage,localizations,placement');
      params.set('fields[retentionMessageLocalizations]', LOCALIZATION_FIELDS);
      params.set('limit[localizations]', '50');
      try {
        const data = await client.request<unknown>(
          `/v1/retentionMessageVersions/${enc(versionId)}?${params}`,
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_retention_message_version',
    {
      title: 'Create a retention message version',
      description: `Create a new content version of a retention message. It starts in PREPARE_FOR_SUBMISSION. Optional placementId shows an image: an App Asset Library placement made for this message (asc_post_asset_library_placement); omit it for a text-only message. Versions cannot be edited or deleted afterwards, so a stray draft stays. Next: add localizations with asc_post_retention_message_localization. ${REVIEW_NOTE} ppp refuses while the message already has a PREPARE_FOR_SUBMISSION version (edit that one). dryRun returns the body and existing versions without writing.`,
      inputSchema: z.object({
        retentionMessageId: RetentionMessageIdSchema,
        placementId: z
          .string()
          .min(1)
          .optional()
          .describe('appAssetLibraryPlacements ID for the message image. Omit for text only.'),
        dryRun: z.boolean().default(false),
      }),
    },
    async ({ retentionMessageId, placementId, dryRun }) => {
      const body = buildRetentionMessageVersionCreateBody(retentionMessageId, placementId);
      let existing: CollectedPages;
      try {
        existing = await paginate(
          client,
          `/v1/retentionMessages/${enc(retentionMessageId)}/versions?fields[retentionMessageVersions]=${VERSION_FIELDS}&limit=200`,
          200,
        );
      } catch (err) {
        return errorResult(err, 'Pre-flight failed (could not list existing versions): ');
      }
      const table = digestRetentionMessageVersions(existing);
      const open = existing.data.find((v) => attr(v, 'state') === 'PREPARE_FOR_SUBMISSION');
      if (dryRun) {
        return textResult(
          `Dry run — would POST /v1/retentionMessageVersions:\n\n${JSON.stringify(body, null, 2)}\n\n${table}${
            open ? `\n\nA real call would be refused: version ${open.id} is still open.` : ''
          }`,
        );
      }
      if (open) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Refused: retention message ${retentionMessageId} already has an open version ${open.id} (PREPARE_FOR_SUBMISSION). Edit its localizations instead; versions cannot be deleted.\n\n${table}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const data = await client.request<unknown>('/v1/retentionMessageVersions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_retention_message_version_placement',
    {
      title: "Get a retention message version's image placement",
      description:
        'Fetch the App Asset Library placement (the image) of a retention message version, with the image or video included. Returns { data: null } for a text-only version.',
      inputSchema: z.object({ versionId: RetentionMessageVersionIdSchema }),
    },
    async ({ versionId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/retentionMessageVersions/${enc(versionId)}/placement?include=image,video`,
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_retention_message_version_review_item',
    {
      title: 'Submit a retention message version for review',
      description:
        'Add a retention message version to a review submission (POST /v1/reviewSubmissionItems with the retentionMessageVersion relationship). All retention message versions go through App Review before customers see them. Create or find the submission with the review-submission tools, add this item, then submit the submission with asc_patch_review_submission. Track progress with asc_get_retention_message_version.',
      inputSchema: z.object({
        reviewSubmissionId: ReviewSubmissionIdSchema,
        versionId: RetentionMessageVersionIdSchema,
      }),
    },
    async ({ reviewSubmissionId, versionId }) => {
      try {
        const data = await client.request<unknown>('/v1/reviewSubmissionItems', {
          method: 'POST',
          body: JSON.stringify(buildRetentionMessageReviewItemBody(reviewSubmissionId, versionId)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Localizations ---

  server.registerTool(
    'asc_list_retention_message_version_localizations',
    {
      title: "List a retention message version's localizations",
      description:
        'List the localized text of one retention message version: locale, header (up to 66 characters) and body (up to 144). This is what cancelling subscribers read.',
      inputSchema: z.object({
        versionId: RetentionMessageVersionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ versionId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/retentionMessageVersions/${enc(versionId)}/localizations?fields[retentionMessageLocalizations]=${LOCALIZATION_FIELDS}&limit=200`,
          maxItems,
        );
        return textResult(
          raw ? JSON.stringify(pages, null, 2) : digestRetentionMessageLocalizations(pages),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_retention_message_localization',
    {
      title: 'Get a retention message localization',
      description:
        'Fetch one retention message localization with its version (and state) included.',
      inputSchema: z.object({ localizationId: RetentionMessageLocalizationIdSchema }),
    },
    async ({ localizationId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/retentionMessageLocalizations/${enc(localizationId)}?include=retentionMessageVersion`,
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_retention_message_localization',
    {
      title: 'Create a retention message localization',
      description: `Add one locale's customer-facing text to a retention message version: header (up to 66 characters) and body (up to 144). Apple refuses localizations on an APPROVED version; ppp checks the state first. One localization per locale. ${REVIEW_NOTE}`,
      inputSchema: z.object({
        versionId: RetentionMessageVersionIdSchema,
        locale: LocaleSchema,
        header: HeaderSchema,
        body: BodySchema,
      }),
    },
    async (input) => {
      try {
        const res = await client.request<{ data?: { attributes?: { state?: string } } }>(
          `/v1/retentionMessageVersions/${enc(input.versionId)}?fields[retentionMessageVersions]=state`,
        );
        const state = res.data?.attributes?.state;
        if (state === 'APPROVED') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Refused: version ${input.versionId} is APPROVED, and Apple does not accept new localizations on an approved version. Create a new version with asc_post_retention_message_version.`,
              },
            ],
            isError: true,
          };
        }
      } catch (err) {
        return errorResult(err, 'Pre-flight failed (could not read the version): ');
      }
      try {
        const data = await client.request<unknown>('/v1/retentionMessageLocalizations', {
          method: 'POST',
          body: JSON.stringify(buildRetentionMessageLocalizationCreateBody(input)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_retention_message_localization',
    {
      title: 'Update a retention message localization',
      description:
        "Edit the header and/or body of a retention message localization. The locale can't change; delete and re-create for that. Pass null to clear a field. Text of a version in review or approved is not editable; make a new version instead.",
      inputSchema: z.object({
        localizationId: RetentionMessageLocalizationIdSchema,
        header: HeaderSchema.nullable().optional(),
        body: BodySchema.nullable().optional(),
      }),
    },
    async ({ localizationId, header, body }) => {
      if (header === undefined && body === undefined) {
        return {
          content: [
            { type: 'text' as const, text: 'No changes provided. Pass header and/or body.' },
          ],
          isError: true,
        };
      }
      try {
        const data = await client.request<unknown>(
          `/v1/retentionMessageLocalizations/${enc(localizationId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(
              buildRetentionMessageLocalizationPatchBody(localizationId, { header, body }),
            ),
          },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_retention_message_localization',
    {
      title: 'Delete a retention message localization',
      description:
        'Delete one locale from a retention message version. ppp reads the parent version first and refuses when it is WAITING_FOR_REVIEW / IN_REVIEW / ACCEPTED / APPROVED (that text is in review or live; make a new version instead). Pass force:true to skip the pre-check and let Apple judge.',
      inputSchema: z.object({
        localizationId: RetentionMessageLocalizationIdSchema,
        force: ForceSchema,
      }),
    },
    async ({ localizationId, force }) => {
      let note = '';
      if (!force) {
        try {
          const res = await client.request<{
            data: JSONAPIResource;
            included?: JSONAPIResource[];
          }>(
            `/v1/retentionMessageLocalizations/${enc(localizationId)}?include=retentionMessageVersion&fields[retentionMessageVersions]=state`,
          );
          const versionId = relIds(res.data, 'retentionMessageVersion')[0];
          const version = lookupIncluded(
            buildIncludedIndex(res.included ?? []),
            'retentionMessageVersions',
            versionId,
          );
          const gate = evaluateRetentionLocalizationDeleteGate(
            version ? attr(version, 'state') : undefined,
          );
          if (!gate.allow) return refusal('Retention message localization', gate);
        } catch {
          note = UNGUARDED;
        }
      }
      try {
        await client.request<void>(`/v1/retentionMessageLocalizations/${enc(localizationId)}`, {
          method: 'DELETE',
        });
        return textResult(`${note}Deleted retention message localization ${localizationId}.`);
      } catch (err) {
        return errorResult(err, note);
      }
    },
  );

  // --- Offers ---

  server.registerTool(
    'asc_list_subscription_retention_offers',
    {
      title: 'List subscription retention offers',
      description:
        'List every retention offer created for a subscription, presented or not. Retention offers are discounts shown with the retention message to CURRENT subscribers who start to cancel (intro offers target new subscribers, promotional offers redeem in-app, win-back offers target lapsed subscribers). Creating one does not present it; asc_list_subscription_retention_message_offers shows the ones that are.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/subscriptions/${enc(subscriptionId)}/retentionOffers?${buildRetentionOfferListQuery()}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestRetentionOffers(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_list_subscription_retention_message_offers',
    {
      title: 'List the retention offers a subscription presents',
      description:
        "List the retention offers presented with a subscription's retention message — the subset of asc_list_subscription_retention_offers that cancelling subscribers can actually be shown. Change it with asc_add_subscription_retention_message_offers / asc_remove_subscription_retention_message_offers.",
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/subscriptions/${enc(subscriptionId)}/retentionMessageOffers?${buildRetentionOfferListQuery()}`,
          maxItems,
        );
        return textResult(
          raw
            ? JSON.stringify(pages, null, 2)
            : digestRetentionOffers(pages, 'presented retention offers'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_retention_offer',
    {
      title: 'Get a retention offer',
      description: 'Fetch one retention offer with its subscription and prices included.',
      inputSchema: z.object({ retentionOfferId: RetentionOfferIdSchema }),
    },
    async ({ retentionOfferId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/retentionOffers/${enc(retentionOfferId)}?include=subscription,prices`,
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_list_retention_offer_prices',
    {
      title: 'List retention offer prices',
      description:
        'List the per-territory prices of a retention offer (territory, currency, amount, subscription price point). Prices are fixed when the offer is created.',
      inputSchema: z.object({
        retentionOfferId: RetentionOfferIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ retentionOfferId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/retentionOffers/${enc(retentionOfferId)}/prices?include=territory,subscriptionPricePoint&limit=200`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestRetentionOfferPrices(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_retention_offer',
    {
      title: 'Create a retention offer',
      description:
        'Create a retention offer: a discount for an auto-renewable subscription that can be presented with its retention message to subscribers who start to cancel. Customer-facing once presented. ' +
        'Prices go in one atomic POST: one subscription price point per territory (asc_list_subscription_price_points); no territory field, the price point implies it. ' +
        'Only the two eligibility fields can change later (asc_patch_retention_offer); everything else, prices included, is fixed. Apple allows at most 10 active retention offers per subscription per targetSubscriptionPlanType. ' +
        'Creating an offer does not present it: add it with asc_add_subscription_retention_message_offers. ppp refuses an offerId already used by another retention offer on the subscription.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        referenceName: z.string().min(1).describe('Internal name for the offer. Immutable.'),
        offerId: z
          .string()
          .min(1)
          .describe('Offer identifier StoreKit uses, unique within the subscription. Immutable.'),
        duration: SubscriptionOfferDurationSchema,
        offerMode: OfferModeSchema,
        periodCount: z
          .number()
          .int()
          .positive()
          .describe('Number of offer periods (duration × periodCount = offer length).'),
        customerEligibilityPaidSubscriptionDurationInMonths: PaidDurationSchema,
        customerEligibilityWaitBetweenOffersInMonths: WaitBetweenSchema.optional(),
        targetSubscriptionPlanType: SubscriptionPlanTypeSchema.optional().describe(
          'Plan type people subscribe to after the offer ends: MONTHLY or UPFRONT. Optional, immutable.',
        ),
        pricePointIds: z
          .array(PricePointIdSchema)
          .min(1)
          .describe('One subscription price point ID per territory the offer is priced in.'),
      }),
    },
    async (input) => {
      try {
        const existing = await paginate(
          client,
          `/v1/subscriptions/${enc(input.subscriptionId)}/retentionOffers?fields[retentionOffers]=offerId&limit=200`,
          200,
        );
        const clash = existing.data.find((o) => attr(o, 'offerId') === input.offerId);
        if (clash) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Refused: offerId "${input.offerId}" is already used by retention offer ${clash.id} on this subscription. Pick another identifier.`,
              },
            ],
            isError: true,
          };
        }
      } catch (err) {
        return errorResult(err, 'Pre-flight failed (could not list existing retention offers): ');
      }
      try {
        const data = await client.request<unknown>('/v1/retentionOffers', {
          method: 'POST',
          body: JSON.stringify(buildRetentionOfferCreateBody(input)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_retention_offer',
    {
      title: 'Update a retention offer',
      description:
        "Change a retention offer's eligibility, the only mutable part: customerEligibilityPaidSubscriptionDurationInMonths (1 to 24, 36, 48, 60) and customerEligibilityWaitBetweenOffersInMonths (2 to 24, or null to clear). For anything else, delete and re-create.",
      inputSchema: z.object({
        retentionOfferId: RetentionOfferIdSchema,
        customerEligibilityPaidSubscriptionDurationInMonths: PaidDurationSchema.optional(),
        customerEligibilityWaitBetweenOffersInMonths: WaitBetweenSchema.nullable().optional(),
      }),
    },
    async ({ retentionOfferId, ...changes }) => {
      if (Object.values(changes).every((v) => v === undefined)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No changes provided. Pass customerEligibilityPaidSubscriptionDurationInMonths and/or customerEligibilityWaitBetweenOffersInMonths.',
            },
          ],
          isError: true,
        };
      }
      try {
        const data = await client.request<unknown>(`/v1/retentionOffers/${enc(retentionOfferId)}`, {
          method: 'PATCH',
          body: JSON.stringify(buildRetentionOfferPatchBody(retentionOfferId, changes)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_retention_offer',
    {
      title: 'Delete a retention offer',
      description:
        "Delete a retention offer. ppp first checks whether the offer is among its subscription's presented retention message offers and refuses if so (cancelling subscribers can be shown it); remove it with asc_remove_subscription_retention_message_offers first. Pass force:true to skip the pre-check and let Apple judge.",
      inputSchema: z.object({
        retentionOfferId: RetentionOfferIdSchema,
        force: ForceSchema,
      }),
    },
    async ({ retentionOfferId, force }) => {
      let note = '';
      if (!force) {
        try {
          const res = await client.request<{ data: JSONAPIResource }>(
            `/v1/retentionOffers/${enc(retentionOfferId)}?include=subscription&fields[retentionOffers]=subscription`,
          );
          const subscriptionId = relIds(res.data, 'subscription')[0];
          if (subscriptionId === undefined) throw new Error('no subscription linkage');
          const presented = await paginate(
            client,
            `/v1/subscriptions/${enc(subscriptionId)}/retentionMessageOffers?fields[retentionOffers]=offerId&limit=200`,
            2000,
          );
          const gate = evaluateRetentionOfferDeleteGate(
            presented.data.some((o) => o.id === retentionOfferId),
          );
          if (!gate.allow) return refusal('Retention offer', gate);
        } catch {
          note = UNGUARDED;
        }
      }
      try {
        await client.request<void>(`/v1/retentionOffers/${enc(retentionOfferId)}`, {
          method: 'DELETE',
        });
        return textResult(`${note}Deleted retention offer ${retentionOfferId}.`);
      } catch (err) {
        return errorResult(err, note);
      }
    },
  );

  // --- Subscription wiring ---

  server.registerTool(
    'asc_get_subscription_retention_message',
    {
      title: "Get a subscription's retention message",
      description:
        'Fetch the retention message assigned to a subscription (at most one), with its versions included. Reports "none assigned" when Apple answers data: null.',
      inputSchema: z.object({ subscriptionId: SubscriptionIdSchema }),
    },
    async ({ subscriptionId }) => {
      try {
        const data = await client.request<{ data?: unknown }>(
          `/v1/subscriptions/${enc(subscriptionId)}/retentionMessage?include=versions&fields[retentionMessageVersions]=state`,
        );
        if (data?.data === null || data?.data === undefined) {
          return textResult(`Subscription ${subscriptionId} has no retention message assigned.`);
        }
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_set_subscription_retention_message',
    {
      title: "Set a subscription's retention message",
      description:
        'PATCH /v1/subscriptions/{id}/relationships/retentionMessage — assign a retention message to a subscription. Customer-facing: once the message has an APPROVED version, subscribers who start to cancel this subscription see it. Replaces any message already assigned (a subscription has at most one). The API has no way to un-assign; assign another message or delete the message. Read the current one first with asc_get_subscription_retention_message.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        retentionMessageId: RetentionMessageIdSchema,
      }),
    },
    async ({ subscriptionId, retentionMessageId }) => {
      try {
        await client.requestText(
          `/v1/subscriptions/${enc(subscriptionId)}/relationships/retentionMessage`,
          {
            method: 'PATCH',
            headers: { accept: 'application/json' },
            body: JSON.stringify(buildSubscriptionRetentionMessageLinkageBody(retentionMessageId)),
          },
        );
        return textResult(
          `Assigned retention message ${retentionMessageId} to subscription ${subscriptionId}.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  for (const verb of ['add', 'remove'] as const) {
    const method = verb === 'add' ? 'POST' : 'DELETE';
    server.registerTool(
      `asc_${verb}_subscription_retention_message_offers`,
      {
        title:
          verb === 'add'
            ? 'Present retention offers with a subscription message'
            : 'Stop presenting retention offers with a subscription message',
        description:
          `${method} /v1/subscriptions/{id}/relationships/retentionMessageOffers — ` +
          (verb === 'add'
            ? "add retention offers to the set presented with the subscription's retention message. Customer-facing: cancelling subscribers can then be shown these discounts. The offers must belong to this subscription (asc_list_subscription_retention_offers). Re-adding is a no-op."
            : "remove retention offers from the set presented with the subscription's retention message. Only the listed offers are removed; the offers themselves are not deleted."),
        inputSchema: z.object({
          subscriptionId: SubscriptionIdSchema,
          retentionOfferIds: z.array(RetentionOfferIdSchema).min(1),
        }),
      },
      async ({ subscriptionId, retentionOfferIds }) => {
        try {
          await client.requestText(
            `/v1/subscriptions/${enc(subscriptionId)}/relationships/retentionMessageOffers`,
            {
              method,
              headers: { accept: 'application/json' },
              body: JSON.stringify(buildRetentionMessageOffersLinkageBody(retentionOfferIds)),
            },
          );
          return textResult(
            `${verb === 'add' ? 'Added' : 'Removed'} ${retentionOfferIds.length} retention offer(s) ${verb === 'add' ? 'to' : 'from'} subscription ${subscriptionId}'s retention message offers.`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }
}
