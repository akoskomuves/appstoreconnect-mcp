import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestReviewSubmissions } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AppStoreVersionIdSchema,
  PlatformSchema,
  ReviewSubmissionActionSchema,
  ReviewSubmissionIdSchema,
  ReviewSubmissionItemIdSchema,
} from '../schemas.js';

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

export interface ReviewSubmissionItemCreateInput {
  reviewSubmissionId: string;
  appStoreVersionId: string;
}

export function buildReviewSubmissionItemCreateBody(
  input: ReviewSubmissionItemCreateInput,
): JSONAPIBody {
  // ReviewSubmissionItemCreateRequest: reviewSubmission rel REQUIRED;
  // exactly ONE item-type rel required from the polymorphic set
  // (appStoreVersion / appCustomProductPageVersion / appEvent / etc.).
  // v0.11 only exposes the appStoreVersion slot; the other slots will be
  // wrapped when those domains ship.
  return {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: {
          data: { type: 'reviewSubmissions', id: input.reviewSubmissionId },
        },
        appStoreVersion: {
          data: { type: 'appStoreVersions', id: input.appStoreVersionId },
        },
      },
    },
  };
}

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
      title: 'Add an App Store version to a review submission',
      description:
        'Add an App Store version as an item under a draft review submission. The parent submission must be in READY_FOR_REVIEW state (drafts only — once submitted, the item set is frozen). One item per call. ' +
        "v0.11 only exposes the appStoreVersion slot; Apple's ReviewSubmissionItem is polymorphic and also accepts IAPs, in-app events, custom product page versions, and experiments — those slots will be wrapped when those domains ship in v0.12+.",
      inputSchema: z.object({
        reviewSubmissionId: ReviewSubmissionIdSchema,
        appStoreVersionId: AppStoreVersionIdSchema,
      }),
    },
    async ({ reviewSubmissionId, appStoreVersionId }) => {
      const body = buildReviewSubmissionItemCreateBody({
        reviewSubmissionId,
        appStoreVersionId,
      });
      try {
        const data = await client.request<unknown>('/v1/reviewSubmissionItems', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Added App Store version ${appStoreVersionId} to review submission ${reviewSubmissionId}.\n\n${JSON.stringify(data, null, 2)}`,
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
}
