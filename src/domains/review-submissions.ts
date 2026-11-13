import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestReviewSubmissions } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AppStoreVersionIdSchema,
  InAppPurchaseIdSchema,
  PlatformSchema,
  ReviewSubmissionActionSchema,
  ReviewSubmissionIdSchema,
  ReviewSubmissionItemIdSchema,
  SubscriptionGroupIdSchema,
  SubscriptionIdSchema,
} from '../schemas.js';
import { EDITABLE_VERSION_STATES, pickLatestVersion } from './product-version-resolve.js';
import {
  type ProductVersionKind,
  productVersionListPath,
  productVersionResource,
} from './product-versions.js';

// Apple's V2 review submission surface. Replaces the legacy V1
// /v1/appStoreVersionSubmissions endpoint (single-version-only) with a
// multi-item flow that can bundle a version + IAPs + in-app events + custom
// product page versions + experiments into one Apple review.
//
// The V2 flow is multi-step:
//
//   1. POST /v1/reviewSubmissions {app rel, platform}
//      -> creates a draft submission, state=READY_FOR_REVIEW
//   2. POST /v1/reviewSubmissionItems {reviewSubmission rel + item rel}
//      for each item (an App Store version is the typical item; v0.11 only
//      wraps the appStoreVersion slot — IAPs/experiments/etc. land in
//      v0.13/v0.14 when those domains exist)
//   3. PATCH /v1/reviewSubmissions/{id} {submitted: true}
//      -> Apple flips state READY_FOR_REVIEW → WAITING_FOR_REVIEW
//   4. Apple reviews; state walks WAITING_FOR_REVIEW → IN_REVIEW →
//      COMPLETE (or UNRESOLVED_ISSUES)
//
// To cancel a submission in flight:
//   PATCH /v1/reviewSubmissions/{id} {canceled: true}
//   (only valid while state is WAITING_FOR_REVIEW or IN_REVIEW)
//
// Wire-key gotchas (verified against AvdLee Swift SDK):
//   - Swift `isSubmitted` → wire `submitted` (is-prefix stripped)
//   - Swift `isCanceled`  → wire `canceled`  (is-prefix stripped)
//   - submitted + canceled are MUTUALLY EXCLUSIVE per-PATCH. Body
//     builders enforce this; tool wraps the two as a single
//     ReviewSubmissionAction enum (submit | cancel).
//
// State enum (from ReviewSubmission entity):
//   READY_FOR_REVIEW    — draft; items can be added/removed
//   WAITING_FOR_REVIEW  — submitted; Apple has not picked it up yet
//   IN_REVIEW           — Apple is actively reviewing
//   UNRESOLVED_ISSUES   — Apple flagged something; dev needs to address
//   CANCELING           — cancel in progress
//   COMPLETING          — finalization in progress
//   COMPLETE            — done (approved + released, or finalized as
//                         rejected)

const REVIEW_SUBMISSION_FIELDS = 'platform,submittedDate,state';
const REVIEW_SUBMISSION_ITEM_FIELDS = 'state';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface ReviewSubmissionCreateInput {
  appId: string;
  platform?: 'IOS' | 'MAC_OS' | 'TV_OS' | 'WATCH_OS' | 'VISION_OS' | undefined;
}

export function buildReviewSubmissionCreateBody(input: ReviewSubmissionCreateInput): JSONAPIBody {
  // Apple's ReviewSubmissionCreateRequest: app rel REQUIRED, platform attr
  // optional (defaults to all platforms the app supports — but Apple's
  // docs recommend passing it explicitly).
  const attributes: Record<string, unknown> = {};
  if (input.platform !== undefined) attributes.platform = input.platform;
  return {
    data: {
      type: 'reviewSubmissions',
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export interface ReviewSubmissionPatchInput {
  reviewSubmissionId: string;
  action: 'submit' | 'cancel';
}

export function buildReviewSubmissionPatchBody(input: ReviewSubmissionPatchInput): JSONAPIBody {
  // Wire keys: `submitted` / `canceled` (stripped from Swift's
  // `isSubmitted` / `isCanceled`). Body builder converts the friendly
  // action enum into the right boolean. submitted + canceled are
  // mutually exclusive per Apple's contract — passing both rejects.
  const attributes: Record<string, unknown> = {};
  if (input.action === 'submit') attributes.submitted = true;
  else attributes.canceled = true;
  return {
    data: {
      type: 'reviewSubmissions',
      id: input.reviewSubmissionId,
      attributes,
    },
  };
}

// ReviewSubmissionItemCreateRequest is polymorphic: the reviewSubmission rel
// plus EXACTLY ONE item rel from this set (spec 4.6). Relationship key →
// wire type. Note appStoreVersionExperiment and appStoreVersionExperimentV2
// are two keys for the same `appStoreVersionExperiments` type.
export const REVIEW_SUBMISSION_ITEM_TYPES = {
  appStoreVersion: 'appStoreVersions',
  appCustomProductPageVersion: 'appCustomProductPageVersions',
  appStoreVersionExperiment: 'appStoreVersionExperiments',
  appStoreVersionExperimentV2: 'appStoreVersionExperiments',
  appEvent: 'appEvents',
  appAssetLibraryImage: 'appAssetLibraryImages',
  appAssetLibraryVideo: 'appAssetLibraryVideos',
  backgroundAssetVersion: 'backgroundAssetVersions',
  gameCenterAchievementVersion: 'gameCenterAchievementVersions',
  gameCenterActivityVersion: 'gameCenterActivityVersions',
  gameCenterChallengeVersion: 'gameCenterChallengeVersions',
  gameCenterLeaderboardSetVersion: 'gameCenterLeaderboardSetVersions',
  gameCenterLeaderboardVersion: 'gameCenterLeaderboardVersions',
  inAppPurchaseVersion: 'inAppPurchaseVersions',
  subscriptionVersion: 'subscriptionVersions',
  subscriptionGroupVersion: 'subscriptionGroupVersions',
  retentionMessageVersion: 'retentionMessageVersions',
} as const;

export type ReviewSubmissionItemType = keyof typeof REVIEW_SUBMISSION_ITEM_TYPES;

const ReviewSubmissionItemTypeSchema = z
  .enum(Object.keys(REVIEW_SUBMISSION_ITEM_TYPES) as [ReviewSubmissionItemType])
  .describe(
    'What the item is. For in-app purchases and subscriptions pass the VERSION (inAppPurchaseVersion / subscriptionVersion / subscriptionGroupVersion), not the product: find it with asc_list_iap_versions / asc_list_subscription_versions / asc_list_subscription_group_versions.',
  );

export interface ReviewSubmissionItemCreateInput {
  reviewSubmissionId: string;
  itemType: ReviewSubmissionItemType;
  itemId: string;
}

export function buildReviewSubmissionItemCreateBody(
  input: ReviewSubmissionItemCreateInput,
): JSONAPIBody {
  return {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: {
          data: { type: 'reviewSubmissions', id: input.reviewSubmissionId },
        },
        [input.itemType]: {
          data: { type: REVIEW_SUBMISSION_ITEM_TYPES[input.itemType], id: input.itemId },
        },
      },
    },
  };
}

// Submitting an in-app product. Apple removes the standalone
// inAppPurchaseSubmissions / subscriptionSubmissions /
// subscriptionGroupSubmissions endpoints "beginning in early 2027"; their
// replacement is a reviewSubmission whose item is the product's VERSION. The
// three asc_post_*_submission tools keep their names and do that flow.
//
// The one trap: a reviewSubmission is per app, and an app can already have a
// draft (READY_FOR_REVIEW) one holding other items, e.g. the next app
// version. Submitting that draft would send those items too. So without an
// explicit reviewSubmissionId the tool only ever submits a submission it
// created itself, and refuses when a draft already exists.
export type SubmissionTarget =
  | { action: 'add-to-given'; reviewSubmissionId: string }
  | { action: 'create' }
  | { action: 'refuse'; reason: string };

export function decideSubmissionTarget(
  openDraftIds: string[],
  reviewSubmissionId?: string | undefined,
): SubmissionTarget {
  if (reviewSubmissionId) return { action: 'add-to-given', reviewSubmissionId };
  if (openDraftIds.length === 0) return { action: 'create' };
  return {
    action: 'refuse',
    reason: `This app already has a draft review submission (${openDraftIds.join(', ')}). Submitting it would also send whatever else it holds, so the tool won't do that on its own. Pass reviewSubmissionId to add this item to that draft, then submit the draft with asc_patch_review_submission action: "submit" once it holds everything you mean to send.`,
  };
}

const SUBMIT_KIND: Record<
  ProductVersionKind,
  { itemType: ReviewSubmissionItemType; label: string }
> = {
  iap: { itemType: 'inAppPurchaseVersion', label: 'in-app purchase' },
  subscription: { itemType: 'subscriptionVersion', label: 'subscription' },
  subscriptionGroup: { itemType: 'subscriptionGroupVersion', label: 'subscription group' },
};

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerReviewSubmissions(server: McpServer, client: ASCClient): void {
  // ----- ReviewSubmission CRUD -----

  server.registerTool(
    'asc_list_review_submissions',
    {
      title: 'List review submissions',
      description:
        "List review submissions filtered by app. Filter[app]={appId} is required — Apple's collection isn't directly listable without it. Each row shows platform, state (READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW / UNRESOLVED_ISSUES / CANCELING / COMPLETING / COMPLETE), and submittedDate. Use to find an in-flight submission before patching (submit/cancel) or adding items.",
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[reviewSubmissions]', REVIEW_SUBMISSION_FIELDS);
      params.set('filter[app]', appId);
      params.set('limit', '200');
      const path = `/v1/reviewSubmissions?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestReviewSubmissions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_review_submission',
    {
      title: 'Get a review submission',
      description:
        'Fetch a single review submission with its items + app relationship expanded. Use to see the current state and which items (App Store versions, etc.) are attached. The items relationship surfaces ReviewSubmissionItem state (READY_FOR_REVIEW / ACCEPTED / APPROVED / REJECTED / REMOVED), useful for diagnosing partial-approval scenarios.',
      inputSchema: z.object({
        reviewSubmissionId: ReviewSubmissionIdSchema,
      }),
    },
    async ({ reviewSubmissionId }) => {
      const params = new URLSearchParams();
      params.set('include', 'items,app,appStoreVersionForReview');
      params.set('fields[reviewSubmissions]', REVIEW_SUBMISSION_FIELDS);
      params.set('fields[reviewSubmissionItems]', REVIEW_SUBMISSION_ITEM_FIELDS);
      const path = `/v1/reviewSubmissions/${encodeURIComponent(
        reviewSubmissionId,
      )}?${params.toString()}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_review_submission',
    {
      title: 'Create a review submission (draft)',
      description:
        'Create a DRAFT review submission on an app. Required: appId. Optional: platform (Apple recommends passing it; defaults to all platforms the app supports). ' +
        'The submission lands in READY_FOR_REVIEW state — you must add at least one item (asc_post_review_submission_item) before submitting. Submitting before adding items returns an Apple validation error. ' +
        'This is the V2 surface. The legacy V1 /v1/appStoreVersionSubmissions endpoint still exists but only supports single-version submissions and is being deprecated; new code should use V2.',
      inputSchema: z.object({
        appId: AppIdSchema,
        platform: PlatformSchema.optional().describe(
          'Optional but recommended. Without it, Apple submits all platforms the app supports — surprising behavior for cross-platform apps.',
        ),
      }),
    },
    async (input) => {
      const body = buildReviewSubmissionCreateBody({
        appId: input.appId,
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/reviewSubmissions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created draft review submission on app ${input.appId}.\n\n${JSON.stringify(data, null, 2)}\n\nNext: add at least one item with asc_post_review_submission_item, then submit with asc_patch_review_submission action: "submit".`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_review_submission',
    {
      title: 'Submit or cancel a review submission',
      description:
        "Trigger the submit or cancel action on a review submission. The action enum (submit | cancel) is the friendly wrapper around Apple's mutually-exclusive `submitted: true` / `canceled: true` wire fields. " +
        'submit: only valid in READY_FOR_REVIEW (Apple flips state to WAITING_FOR_REVIEW). cancel: only valid in WAITING_FOR_REVIEW or IN_REVIEW (Apple flips to CANCELING then COMPLETE). COMPLETE / COMPLETING / CANCELING / UNRESOLVED_ISSUES reject both — Apple already finished or is finishing the cycle. ' +
        "Wire-key gotcha: Apple strips the 'is' prefix on both attrs (`submitted`, `canceled`).",
      inputSchema: z.object({
        reviewSubmissionId: ReviewSubmissionIdSchema,
        action: ReviewSubmissionActionSchema,
      }),
    },
    async ({ reviewSubmissionId, action }) => {
      const body = buildReviewSubmissionPatchBody({ reviewSubmissionId, action });
      try {
        const data = await client.request<unknown>(
          `/v1/reviewSubmissions/${encodeURIComponent(reviewSubmissionId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        const verb = action === 'submit' ? 'Submitted' : 'Canceled';
        return {
          content: [
            {
              type: 'text',
              text: `${verb} review submission ${reviewSubmissionId}.\n\n${JSON.stringify(data, null, 2)}${action === 'submit' ? '\n\nApple typically takes 24-72h to review. Poll status with asc_get_review_submission.' : ''}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- ReviewSubmissionItem (the item slot) -----

  server.registerTool(
    'asc_post_review_submission_item',
    {
      title: 'Add an item to a review submission',
      description:
        'Add one item to a draft review submission (READY_FOR_REVIEW; once submitted the item set is frozen). One item per call, up to 200 items per submission; for more, create another submission. ' +
        'Pass itemType + itemId: an App Store version, custom product page version, in-app event, product page experiment, Asset Library image or video, Background Assets version, Game Center achievement / activity / challenge / leaderboard / leaderboard set version, retention message version, or an in-app purchase / subscription / subscription group VERSION. ' +
        'In-app purchases and subscriptions are submitted this way now; Apple removes the standalone submission endpoints in early 2027. appStoreVersionId alone still works as shorthand for itemType appStoreVersion.',
      inputSchema: z.object({
        reviewSubmissionId: ReviewSubmissionIdSchema,
        itemType: ReviewSubmissionItemTypeSchema.optional(),
        itemId: z.string().min(1).optional().describe('ID of the item named by itemType.'),
        appStoreVersionId: AppStoreVersionIdSchema.optional().describe(
          'Shorthand for itemType: "appStoreVersion" + itemId.',
        ),
      }),
    },
    async ({ reviewSubmissionId, itemType, itemId, appStoreVersionId }) => {
      const resolved =
        itemType && itemId
          ? { itemType, itemId }
          : !itemType && !itemId && appStoreVersionId
            ? { itemType: 'appStoreVersion' as const, itemId: appStoreVersionId }
            : null;
      if (!resolved) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass itemType + itemId together, or appStoreVersionId on its own.',
            },
          ],
          isError: true,
        };
      }
      const body = buildReviewSubmissionItemCreateBody({ reviewSubmissionId, ...resolved });
      try {
        const data = await client.request<unknown>('/v1/reviewSubmissionItems', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Added ${resolved.itemType} ${resolved.itemId} to review submission ${reviewSubmissionId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_review_submission_item',
    {
      title: 'Remove an item from a review submission',
      description:
        'DELETE a ReviewSubmissionItem from a draft submission. Only valid while the parent submission is READY_FOR_REVIEW — after submission, items cannot be removed (use asc_patch_review_submission action: "cancel" to cancel the whole submission).',
      inputSchema: z.object({
        reviewSubmissionItemId: ReviewSubmissionItemIdSchema,
      }),
    },
    async ({ reviewSubmissionItemId }) => {
      try {
        await client.request<unknown>(
          `/v1/reviewSubmissionItems/${encodeURIComponent(reviewSubmissionItemId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Removed item ${reviewSubmissionItemId} from its review submission.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- In-app product submission (via a review submission) -----

  for (const [kind, toolName, idKey, idSchema] of [
    ['iap', 'asc_post_iap_submission', 'iapId', InAppPurchaseIdSchema],
    ['subscription', 'asc_post_subscription_submission', 'subscriptionId', SubscriptionIdSchema],
    [
      'subscriptionGroup',
      'asc_post_subscription_group_submission',
      'subscriptionGroupId',
      SubscriptionGroupIdSchema,
    ],
  ] as const) {
    const { itemType, label } = SUBMIT_KIND[kind];
    server.registerTool(
      toolName,
      {
        title: `Submit a ${label} for review`,
        description:
          `Send a ${label}'s pending metadata (its latest editable version) to App Review. ` +
          `Apple removes the old standalone ${label} submission endpoint in early 2027, so this now goes through a review submission: the tool finds the ${label}'s latest version, creates a review submission on appId, adds the version as an item and submits it. ` +
          'If the app already has a draft review submission, the tool refuses rather than submit whatever else that draft holds; pass reviewSubmissionId to add the item to that draft instead (it is then NOT submitted; submit the draft yourself with asc_patch_review_submission). ' +
          (kind === 'subscriptionGroup'
            ? ''
            : `The ${label} needs complete metadata, including its review screenshot. `) +
          'Irreversible once submitted.',
        inputSchema: z.object({
          [idKey]: idSchema,
          appId: AppIdSchema.describe(
            `The app the ${label} belongs to. Required: Apple has no link from a ${label} back to its app.`,
          ),
          versionId: z
            .string()
            .min(1)
            .optional()
            .describe(`Submit this ${label} version instead of the latest one.`),
          reviewSubmissionId: ReviewSubmissionIdSchema.optional().describe(
            'Add the version to this existing draft submission instead of creating and submitting a new one.',
          ),
          platform: PlatformSchema.optional().describe(
            'Platform for a newly created review submission. Defaults to all platforms the app supports.',
          ),
        }),
      },
      async (args) => {
        const input = args as {
          appId: string;
          versionId?: string | undefined;
          reviewSubmissionId?: string | undefined;
          platform?: 'IOS' | 'MAC_OS' | 'TV_OS' | 'WATCH_OS' | 'VISION_OS' | undefined;
        };
        const productId = (args as Record<string, string>)[idKey] as string;
        try {
          let versionId = input.versionId;
          if (!versionId) {
            const latest = pickLatestVersion(
              (
                await paginate(
                  client,
                  `${productVersionListPath(kind, productId)}?fields[${productVersionResource(kind).type}]=version,state&limit=200`,
                  2000,
                )
              ).data.map((r) => ({
                id: r.id,
                version: typeof r.attributes?.version === 'number' ? r.attributes.version : null,
                state: typeof r.attributes?.state === 'string' ? r.attributes.state : null,
              })),
            );
            if (!latest || !EDITABLE_VERSION_STATES.has(latest.state ?? '')) {
              return {
                content: [
                  {
                    type: 'text',
                    text: latest
                      ? `Refused: nothing to submit. The ${label} ${productId}'s latest version (${latest.id}) is ${latest.state}. To change approved metadata, create a new version, edit it, then submit.`
                      : `Refused: the ${label} ${productId} has no version to submit.`,
                  },
                ],
                isError: true,
              };
            }
            versionId = latest.id;
          }

          const drafts = input.reviewSubmissionId
            ? []
            : (
                await paginate(
                  client,
                  `/v1/reviewSubmissions?filter[app]=${encodeURIComponent(input.appId)}&filter[state]=READY_FOR_REVIEW${input.platform ? `&filter[platform]=${input.platform}` : ''}&fields[reviewSubmissions]=state&limit=200`,
                  200,
                )
              ).data.map((r) => r.id);
          const target = decideSubmissionTarget(drafts, input.reviewSubmissionId);
          if (target.action === 'refuse') {
            return {
              content: [{ type: 'text', text: `Refused: ${target.reason}` }],
              isError: true,
            };
          }

          let submissionId: string;
          if (target.action === 'add-to-given') {
            submissionId = target.reviewSubmissionId;
          } else {
            const created = await client.request<{ data?: { id?: string } }>(
              '/v1/reviewSubmissions',
              {
                method: 'POST',
                body: JSON.stringify(
                  buildReviewSubmissionCreateBody({
                    appId: input.appId,
                    ...(input.platform !== undefined ? { platform: input.platform } : {}),
                  }),
                ),
              },
            );
            const id = created.data?.id;
            if (!id) throw new Error('Creating the review submission returned no id.');
            submissionId = id;
          }

          try {
            await client.request<unknown>('/v1/reviewSubmissionItems', {
              method: 'POST',
              body: JSON.stringify(
                buildReviewSubmissionItemCreateBody({
                  reviewSubmissionId: submissionId,
                  itemType,
                  itemId: versionId,
                }),
              ),
            });
          } catch (err) {
            const left =
              target.action === 'create'
                ? `\n\nThe empty draft review submission ${submissionId} was created and is left in place; add an item to it or ignore it.`
                : '';
            return {
              content: [{ type: 'text', text: `${formatASCError(err)}${left}` }],
              isError: true,
            };
          }

          if (target.action === 'add-to-given') {
            return {
              content: [
                {
                  type: 'text',
                  text: `Added ${label} version ${versionId} to draft review submission ${submissionId}. It is not submitted yet: submit the draft with asc_patch_review_submission action: "submit".`,
                },
              ],
            };
          }
          const submitted = await client.request<unknown>(
            `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`,
            {
              method: 'PATCH',
              body: JSON.stringify(
                buildReviewSubmissionPatchBody({
                  reviewSubmissionId: submissionId,
                  action: 'submit',
                }),
              ),
            },
          );
          return {
            content: [
              {
                type: 'text',
                text: `Submitted ${label} ${productId} (version ${versionId}) for review in review submission ${submissionId}.\n\n${JSON.stringify(submitted, null, 2)}`,
              },
            ],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
        }
      },
    );
  }
}
