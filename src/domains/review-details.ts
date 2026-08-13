import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import {
  AppIdSchema,
  AppStoreReviewDetailIdSchema,
  AppStoreVersionIdSchema,
  GracePeriodDurationSchema,
  GracePeriodRenewalTypeSchema,
  SubscriptionGracePeriodIdSchema,
} from '../schemas.js';

// Ship-loop completeness: the pieces between "metadata is ready" and "build is
// live" that previously needed the ASC web UI.
//
//   * appStoreReviewDetails — the What-to-tell-App-Review card on a version:
//     contact person, demo account, notes. One per appStoreVersion (to-one);
//     POST creates it, PATCH updates, no DELETE. All attributes optional on
//     both verbs. Read through the version
//     (/v1/appStoreVersions/{id}/appStoreReviewDetail).
//     Review ATTACHMENTS (e.g. a demo video for App Review) are the
//     review-assets upload factory's 5th resource — see review-assets.ts.
//
//   * appStoreVersionReleaseRequests — POST-only resource that RELEASES an
//     approved (PENDING_DEVELOPER_RELEASE) version to the App Store now.
//     This is the manual "Release this version" click, automated.
//
//   * subscriptionGracePeriods — billing grace period config, one per app:
//     GET through /v1/apps/{id}/subscriptionGracePeriod, PATCH the flat
//     resource. Grace period id == the record Apple returns on the app read;
//     duration is enum (3 / 16 / 28 days), renewalType scopes it to paid-to-
//     paid renewals or all renewals.
//
// The three item-level submission POSTs (IAP / subscription / subscription
// group) live in review-submissions.ts with the rest of the submit flow.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export const REVIEW_DETAIL_ATTRIBUTE_KEYS = [
  'contactFirstName',
  'contactLastName',
  'contactPhone',
  'contactEmail',
  'demoAccountName',
  'demoAccountPassword',
  'demoAccountRequired',
  'notes',
] as const;

export interface ReviewDetailCreateInput {
  appStoreVersionId: string;
  attributes: Record<string, unknown>;
}

export function buildReviewDetailCreateBody(input: ReviewDetailCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.attributes)) {
    if (v !== undefined) attributes[k] = v;
  }
  return {
    data: {
      type: 'appStoreReviewDetails',
      attributes,
      relationships: {
        appStoreVersion: { data: { type: 'appStoreVersions', id: input.appStoreVersionId } },
      },
    },
  };
}

export interface ReviewDetailPatchInput {
  reviewDetailId: string;
  attributes: Record<string, unknown>;
}

export function buildReviewDetailPatchBody(input: ReviewDetailPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.attributes)) {
    if (v !== undefined) attributes[k] = v;
  }
  return {
    data: {
      type: 'appStoreReviewDetails',
      // Apple requires the id in the body as well as the URL (409 otherwise).
      id: input.reviewDetailId,
      attributes,
    },
  };
}

export function buildReleaseRequestBody(appStoreVersionId: string): JSONAPIBody {
  // Relationships-only create — no attributes block (same shape family as
  // endAppAvailabilityPreOrders).
  return {
    data: {
      type: 'appStoreVersionReleaseRequests',
      relationships: {
        appStoreVersion: { data: { type: 'appStoreVersions', id: appStoreVersionId } },
      },
    },
  };
}

export interface GracePeriodPatchInput {
  gracePeriodId: string;
  optIn?: boolean | undefined;
  sandboxOptIn?: boolean | undefined;
  duration?: string | undefined;
  renewalType?: string | undefined;
}

export function buildGracePeriodPatchBody(input: GracePeriodPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.optIn !== undefined) attributes.optIn = input.optIn;
  if (input.sandboxOptIn !== undefined) attributes.sandboxOptIn = input.sandboxOptIn;
  if (input.duration !== undefined) attributes.duration = input.duration;
  if (input.renewalType !== undefined) attributes.renewalType = input.renewalType;
  return {
    data: {
      type: 'subscriptionGracePeriods',
      id: input.gracePeriodId,
      attributes,
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

// Shared attribute schemas for the create + patch tools, so the two can't
// drift. All optional — Apple accepts a bare review detail.
const REVIEW_DETAIL_ATTRIBUTE_SCHEMAS = {
  contactFirstName: z.string().optional().describe('App Review contact person, first name.'),
  contactLastName: z.string().optional().describe('App Review contact person, last name.'),
  contactPhone: z
    .string()
    .optional()
    .describe('App Review contact phone, international format (+36301234567).'),
  contactEmail: z.string().optional().describe('App Review contact email.'),
  demoAccountName: z.string().optional().describe('Demo account username for the reviewer.'),
  demoAccountPassword: z.string().optional().describe('Demo account password for the reviewer.'),
  demoAccountRequired: z
    .boolean()
    .optional()
    .describe('Whether App Review needs the demo account to reach the full app.'),
  notes: z
    .string()
    .optional()
    .describe('Free-form notes for the reviewer (max ~4000 chars in the UI).'),
};

export function registerReviewDetails(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_get_app_store_review_detail',
    {
      title: 'Get the App Review detail of a version',
      description:
        'Fetch the appStoreReviewDetail of an App Store version — App Review contact info, demo account, notes, plus the detail id needed for PATCH and for attaching review attachments. To-one per version; Apple returns data:null when none exists yet (create with asc_post_app_store_review_detail).',
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
      }),
    },
    async ({ appStoreVersionId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/appStoreVersions/${encodeURIComponent(appStoreVersionId)}/appStoreReviewDetail`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_store_review_detail',
    {
      title: 'Create the App Review detail of a version',
      description:
        'Create the appStoreReviewDetail for an App Store version (to-one — Apple 409s if one already exists; PATCH instead). All attributes optional: contact person, demo account (set demoAccountRequired=true when the reviewer needs it), notes. Demo-account credentials go to App Review only, not the public store.',
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
        ...REVIEW_DETAIL_ATTRIBUTE_SCHEMAS,
      }),
    },
    async (input) => {
      const { appStoreVersionId, ...attributes } = input;
      const body = buildReviewDetailCreateBody({ appStoreVersionId, attributes });
      try {
        const data = await client.request<unknown>('/v1/appStoreReviewDetails', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_store_review_detail',
    {
      title: 'Update the App Review detail',
      description:
        'PATCH an appStoreReviewDetail by id (get it from asc_get_app_store_review_detail). Apple merges — omitted attributes keep their current value; send an empty string to clear a text field. Pass at least one attribute.',
      inputSchema: z.object({
        reviewDetailId: AppStoreReviewDetailIdSchema,
        ...REVIEW_DETAIL_ATTRIBUTE_SCHEMAS,
      }),
    },
    async (input) => {
      const { reviewDetailId, ...rest } = input;
      const attributes = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(attributes).length === 0) {
        return {
          content: [{ type: 'text', text: 'Refused: pass at least one review-detail attribute.' }],
          isError: true,
        };
      }
      const body = buildReviewDetailPatchBody({ reviewDetailId, attributes });
      try {
        const data = await client.request<unknown>(
          `/v1/appStoreReviewDetails/${encodeURIComponent(reviewDetailId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_store_version_release_request',
    {
      title: 'Release an approved version to the App Store now',
      description:
        '⚠️ CUSTOMER-FACING: POST an appStoreVersionReleaseRequest to release a version that App Review has approved (state PENDING_DEVELOPER_RELEASE) to the public App Store immediately — the automated form of the manual "Release this version" click. Only valid for versions whose release option was "manually release"; there is no undo — once live, rollback means shipping a new version. Confirm the version id and intent before calling.',
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema.describe(
          'The PENDING_DEVELOPER_RELEASE version to release publicly. Verify with asc_get_app_store_version first.',
        ),
      }),
    },
    async ({ appStoreVersionId }) => {
      const body = buildReleaseRequestBody(appStoreVersionId);
      try {
        const data = await client.request<unknown>('/v1/appStoreVersionReleaseRequests', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Release requested for version ${appStoreVersionId} — Apple begins publishing it to the App Store.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_subscription_grace_period',
    {
      title: 'Get the billing grace period of an app',
      description:
        "Fetch an app's subscriptionGracePeriod — whether billing grace period is opted in (production + sandbox separately), its duration (THREE_DAYS / SIXTEEN_DAYS / TWENTY_EIGHT_DAYS) and renewalType (ALL_RENEWALS / PAID_TO_PAID_ONLY). Grace period keeps subscribers entitled while Apple retries a failed renewal payment. Returns the record id needed for PATCH.",
      inputSchema: z.object({
        appId: AppIdSchema,
      }),
    },
    async ({ appId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/apps/${encodeURIComponent(appId)}/subscriptionGracePeriod`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription_grace_period',
    {
      title: 'Update the billing grace period of an app',
      description:
        "PATCH an app's subscriptionGracePeriod (id from asc_get_subscription_grace_period): optIn / sandboxOptIn toggles, duration (THREE_DAYS / SIXTEEN_DAYS / TWENTY_EIGHT_DAYS), renewalType (ALL_RENEWALS / PAID_TO_PAID_ONLY). Affects real billing behaviour for existing subscribers — during grace the user keeps access while Apple retries payment and the developer keeps being paid. Pass at least one attribute.",
      inputSchema: z.object({
        gracePeriodId: SubscriptionGracePeriodIdSchema,
        optIn: z.boolean().optional().describe('Enable grace period in production.'),
        sandboxOptIn: z.boolean().optional().describe('Enable grace period in sandbox.'),
        duration: GracePeriodDurationSchema.optional(),
        renewalType: GracePeriodRenewalTypeSchema.optional(),
      }),
    },
    async ({ gracePeriodId, optIn, sandboxOptIn, duration, renewalType }) => {
      if (
        optIn === undefined &&
        sandboxOptIn === undefined &&
        duration === undefined &&
        renewalType === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of optIn, sandboxOptIn, duration, renewalType.',
            },
          ],
          isError: true,
        };
      }
      const body = buildGracePeriodPatchBody({
        gracePeriodId,
        optIn,
        sandboxOptIn,
        duration,
        renewalType,
      });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionGracePeriods/${encodeURIComponent(gracePeriodId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched grace period ${gracePeriodId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
