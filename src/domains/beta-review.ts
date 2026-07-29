import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestBetaAppReviewDetails,
  digestBetaAppReviewSubmissions,
  digestPreReleaseVersions,
} from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  BetaAppReviewDetailIdSchema,
  BetaAppReviewSubmissionIdSchema,
  BuildIdSchema,
  ContactEmailSchema,
  ContactFirstNameSchema,
  ContactLastNameSchema,
  ContactPhoneSchema,
  DemoAccountNameSchema,
  DemoAccountPasswordSchema,
  PreReleaseVersionIdSchema,
  ReviewNotesSchema,
} from '../schemas.js';

// Beta-review surface: three loosely-related resources around the gating
// process for external TestFlight distribution.
//
//   1. BetaAppReviewSubmission — per-build review request. POST to gate
//      external testing on a build for the first time. Once Apple reviews
//      it (typically 24-48h), `betaReviewState` flips to APPROVED (or
//      REJECTED), and the build becomes distributable to external groups.
//      Subsequent builds of the same app generally inherit review state
//      automatically unless Apple flags them.
//   2. BetaAppReviewDetail — per-APP standing record (one per app, not
//      per-submission) carrying the contact info, demo account, sign-in-
//      required flag, and notes Apple's reviewer sees on every beta
//      submission for the app. Set this BEFORE submitting builds for
//      review; an empty record will fail review.
//   3. PreReleaseVersion — read-only resource grouping builds by version
//      train (e.g. "2.5.0" might have 5 builds attached). Useful for
//      filtering builds by version and finding the latest build of a
//      version.
//
// Apple-contract notes:
//   - BetaAppReviewSubmissionCreateRequest has NO attributes — only the
//     `build` relationship. Body builder must therefore NOT emit an
//     attributes block.
//   - BetaAppReviewDetailUpdateRequest has wire-key `demoAccountRequired`
//     (stripped from Swift's `isDemoAccountRequired`). All other attrs are
//     1:1 with the Swift property names.
//   - Demo account credentials sit in App Store Connect in cleartext and
//     are visible to Apple's reviewer. The DemoAccountPasswordSchema
//     description calls this out; treat the value as a throwaway.

const BETA_APP_REVIEW_SUBMISSION_FIELDS = 'betaReviewState,submittedDate';
const BETA_APP_REVIEW_DETAIL_FIELDS =
  'contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountName,demoAccountPassword,demoAccountRequired,notes';
const PRE_RELEASE_VERSION_FIELDS = 'version,platform';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- BetaAppReviewSubmission -----

export interface BetaAppReviewSubmissionCreateInput {
  buildId: string;
}

export function buildBetaAppReviewSubmissionCreateBody(
  input: BetaAppReviewSubmissionCreateInput,
): JSONAPIBody {
  // Apple's BetaAppReviewSubmissionCreateRequest has NO attributes block —
  // only the `build` relationship. Body builder omits attributes entirely
  // (sending {} would be valid but `data.attributes` MUST be absent on the
  // wire to mirror the Swift SDK shape).
  return {
    data: {
      type: 'betaAppReviewSubmissions',
      relationships: {
        build: { data: { type: 'builds', id: input.buildId } },
      },
    },
  };
}

// ----- BetaAppReviewDetail -----

export interface BetaAppReviewDetailPatchInput {
  betaAppReviewDetailId: string;
  contactFirstName?: string | undefined;
  contactLastName?: string | undefined;
  contactPhone?: string | undefined;
  contactEmail?: string | undefined;
  demoAccountName?: string | undefined;
  demoAccountPassword?: string | undefined;
  demoAccountRequired?: boolean | undefined;
  notes?: string | undefined;
}

export function buildBetaAppReviewDetailPatchBody(
  input: BetaAppReviewDetailPatchInput,
): JSONAPIBody {
  // All attrs are encodeIfPresent. Wire-key note: `demoAccountRequired` is
  // the on-the-wire name (Swift strips the `is` prefix here). All other
  // attrs are 1:1 with the Swift names.
  const attributes: Record<string, unknown> = {};
  if (input.contactFirstName !== undefined) attributes.contactFirstName = input.contactFirstName;
  if (input.contactLastName !== undefined) attributes.contactLastName = input.contactLastName;
  if (input.contactPhone !== undefined) attributes.contactPhone = input.contactPhone;
  if (input.contactEmail !== undefined) attributes.contactEmail = input.contactEmail;
  if (input.demoAccountName !== undefined) attributes.demoAccountName = input.demoAccountName;
  if (input.demoAccountPassword !== undefined) {
    attributes.demoAccountPassword = input.demoAccountPassword;
  }
  if (input.demoAccountRequired !== undefined) {
    attributes.demoAccountRequired = input.demoAccountRequired;
  }
  if (input.notes !== undefined) attributes.notes = input.notes;
  return {
    data: {
      type: 'betaAppReviewDetails',
      id: input.betaAppReviewDetailId,
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

export function registerBetaReview(server: McpServer, client: ASCClient): void {
  // ----- BetaAppReviewSubmission -----

  server.registerTool(
    'asc_list_beta_app_review_submissions',
    {
      title: 'List beta app review submissions',
      description:
        "List beta-app-review submissions across the team, with the optional buildId filter to narrow to a single build's submissions (typically 0 or 1 per build — re-submissions are rare). Each row shows betaReviewState (WAITING_FOR_REVIEW / IN_REVIEW / APPROVED / REJECTED) and submittedDate.",
      inputSchema: z.object({
        buildId: BuildIdSchema.optional().describe(
          "Optional filter to one build. Apple's filter[build]={id} parameter on /v1/betaAppReviewSubmissions.",
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[betaAppReviewSubmissions]', BETA_APP_REVIEW_SUBMISSION_FIELDS);
      params.set('limit', '200');
      if (buildId) params.set('filter[build]', buildId);
      const path = `/v1/betaAppReviewSubmissions?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBetaAppReviewSubmissions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_app_review_submission',
    {
      title: 'Get a beta app review submission',
      description:
        'Fetch a single BetaAppReviewSubmission with the build relationship expanded. Use to check current betaReviewState — APPROVED unlocks external distribution, REJECTED requires re-submission after fixes.',
      inputSchema: z.object({
        betaAppReviewSubmissionId: BetaAppReviewSubmissionIdSchema,
      }),
    },
    async ({ betaAppReviewSubmissionId }) => {
      const path = `/v1/betaAppReviewSubmissions/${encodeURIComponent(betaAppReviewSubmissionId)}?include=build`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_beta_app_review_submission',
    {
      title: 'Submit a build for beta review',
      description:
        'Submit a build for Apple beta review. Required: buildId. The body has NO attributes — only the build relationship. Once submitted, betaReviewState walks WAITING_FOR_REVIEW → IN_REVIEW → APPROVED (or REJECTED), typically over 24-48h. ' +
        "Preconditions Apple enforces server-side: build must be VALID processingState, the per-app BetaAppReviewDetail must have contact info + demo account (if demoAccountRequired=true), and the BetaAppLocalization for at least one locale must exist. The MCP server does NOT pre-flight these — Apple's error message is the source of truth.",
      inputSchema: z.object({
        buildId: BuildIdSchema,
      }),
    },
    async ({ buildId }) => {
      const body = buildBetaAppReviewSubmissionCreateBody({ buildId });
      try {
        const data = await client.request<unknown>('/v1/betaAppReviewSubmissions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Submitted build ${buildId} for beta review.\n\n${JSON.stringify(data, null, 2)}\n\nTrack status via asc_get_beta_app_review_submission against the returned ID; review typically takes 24-48h.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- BetaAppReviewDetail -----

  server.registerTool(
    'asc_list_beta_app_review_details',
    {
      title: 'List beta app review details (typically one per app)',
      description:
        'List BetaAppReviewDetail records. Filter by appId to scope to one app (typically returns one record per app). The detail record persists across builds — same contact info + demo account + notes are reused for every submission unless you patch it.',
      inputSchema: z.object({
        appId: AppIdSchema.optional().describe(
          "Optional filter. Apple's filter[app]={id} parameter on /v1/betaAppReviewDetails.",
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[betaAppReviewDetails]', BETA_APP_REVIEW_DETAIL_FIELDS);
      params.set('limit', '200');
      if (appId) params.set('filter[app]', appId);
      const path = `/v1/betaAppReviewDetails?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBetaAppReviewDetails(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_app_review_detail',
    {
      title: 'Get a beta app review detail',
      description:
        'Fetch the per-app BetaAppReviewDetail. Returns contact info + demo account + notes + demoAccountRequired flag. Apple stores demo passwords in cleartext on this record — treat it as a secret; rotate after each review cycle.',
      inputSchema: z.object({
        betaAppReviewDetailId: BetaAppReviewDetailIdSchema,
      }),
    },
    async ({ betaAppReviewDetailId }) => {
      const path = `/v1/betaAppReviewDetails/${encodeURIComponent(betaAppReviewDetailId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_beta_app_review_detail',
    {
      title: 'Patch a beta app review detail',
      description:
        "Update the contact info, demo account, and notes on a BetaAppReviewDetail. All eight attrs are individually optional (encodeIfPresent). Set demoAccountRequired=true ONLY when the app gates content behind login — Apple's reviewer will use the demo credentials. Set demoAccountRequired=false to skip demo credential rendering on the review tool (omit demoAccountName/Password if so). " +
        'Wire-key note: `demoAccountRequired` is the on-the-wire name (Apple strips the `is` prefix). Tool layer refuses empty PATCH.',
      inputSchema: z.object({
        betaAppReviewDetailId: BetaAppReviewDetailIdSchema,
        contactFirstName: ContactFirstNameSchema.optional(),
        contactLastName: ContactLastNameSchema.optional(),
        contactPhone: ContactPhoneSchema.optional(),
        contactEmail: ContactEmailSchema.optional(),
        demoAccountName: DemoAccountNameSchema.optional(),
        demoAccountPassword: DemoAccountPasswordSchema.optional(),
        demoAccountRequired: z
          .boolean()
          .optional()
          .describe(
            'true: Apple reviewer is shown demo credentials. Requires demoAccountName + demoAccountPassword to be set (current values, or pass in the same PATCH). false: reviewer reaches the app without credentials.',
          ),
        notes: ReviewNotesSchema.optional(),
      }),
    },
    async (input) => {
      const anyField = [
        input.contactFirstName,
        input.contactLastName,
        input.contactPhone,
        input.contactEmail,
        input.demoAccountName,
        input.demoAccountPassword,
        input.demoAccountRequired,
        input.notes,
      ].some((v) => v !== undefined);
      if (!anyField) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one attribute to mutate. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildBetaAppReviewDetailPatchBody({
        betaAppReviewDetailId: input.betaAppReviewDetailId,
        ...(input.contactFirstName !== undefined
          ? { contactFirstName: input.contactFirstName }
          : {}),
        ...(input.contactLastName !== undefined ? { contactLastName: input.contactLastName } : {}),
        ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
        ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
        ...(input.demoAccountName !== undefined ? { demoAccountName: input.demoAccountName } : {}),
        ...(input.demoAccountPassword !== undefined
          ? { demoAccountPassword: input.demoAccountPassword }
          : {}),
        ...(input.demoAccountRequired !== undefined
          ? { demoAccountRequired: input.demoAccountRequired }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/betaAppReviewDetails/${encodeURIComponent(input.betaAppReviewDetailId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched BetaAppReviewDetail ${input.betaAppReviewDetailId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- PreReleaseVersion (read-only) -----

  server.registerTool(
    'asc_list_pre_release_versions',
    {
      title: 'List pre-release versions',
      description:
        'List pre-release versions (one per version string Apple has seen, across all platforms). Pass appId to scope to one app. Useful for grouping builds by version train (e.g. find every build of "2.5.0"). The /v1/preReleaseVersions resource is read-only — Apple creates and ages these records automatically based on uploaded builds.',
      inputSchema: z.object({
        appId: AppIdSchema.optional().describe(
          'Optional. When provided, list via /v1/apps/{id}/preReleaseVersions (scoped).',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[preReleaseVersions]', PRE_RELEASE_VERSION_FIELDS);
      params.set('limit', '200');
      const path = appId
        ? `/v1/apps/${encodeURIComponent(appId)}/preReleaseVersions?${params.toString()}`
        : `/v1/preReleaseVersions?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestPreReleaseVersions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_pre_release_version',
    {
      title: 'Get a pre-release version',
      description:
        'Fetch a single PreReleaseVersion with its builds relationship expanded. Returns version + platform + the to-many builds linkage. Read-only.',
      inputSchema: z.object({
        preReleaseVersionId: PreReleaseVersionIdSchema,
      }),
    },
    async ({ preReleaseVersionId }) => {
      const path = `/v1/preReleaseVersions/${encodeURIComponent(preReleaseVersionId)}?include=builds,app`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
