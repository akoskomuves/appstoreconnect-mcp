import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestBetaFeedbackCrashSubmissions,
  digestBetaFeedbackScreenshotSubmissions,
} from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  BetaFeedbackCrashSubmissionIdSchema,
  BetaFeedbackScreenshotSubmissionIdSchema,
  BetaTesterIdSchema,
  BuildIdSchema,
  FeedbackPlatformFilterSchema,
} from '../schemas.js';

// Beta feedback submissions are TESTER-created — a tester shakes the device /
// marks up a screenshot / agrees to share a crash in TestFlight, and Apple
// materializes a read-only record here. The API surface is list / get /
// delete only; there is no create or patch.
//
// Two sibling resources with near-identical device-context attributes:
//
//   - betaFeedbackScreenshotSubmissions: carries `screenshots` — an array of
//     { url, width, height, expirationDate }. The URLs are TIME-LIMITED
//     Apple-signed download links; re-fetch the submission when one expires.
//   - betaFeedbackCrashSubmissions: carries a `crashLog` relationship instead.
//     The log TEXT lives behind GET /v1/betaFeedbackCrashSubmissions/{id}/crashLog
//     (a betaCrashLogs resource with a single `logText` attribute).
//
// Wire-key gotchas (verified against AvdLee Swift SDK):
//   - Swift `buildBundleID` → wire `buildBundleId` (trailing-ID strip — the
//     same family as marketingURL→marketingUrl). Matters for fields[…] sparse
//     fieldsets; pinned in tests via the FIELDS constants below.
//   - DELETE on both resources is documented by Apple but MISSING from the
//     Swift SDK as of v0.16 — confirmed against Apple doc JSON 2026-06-10.
//
// Filters quirk: the build-version filter key is the DOTTED
// `filter[build.preReleaseVersion]` (filter on the related build's
// pre-release version string), not a flat key.

const FEEDBACK_COMMON_FIELDS =
  'createdDate,comment,email,deviceModel,osVersion,locale,timeZone,architecture,connectionType,pairedAppleWatch,appUptimeInMilliseconds,diskBytesAvailable,diskBytesTotal,batteryPercentage,screenWidthInPoints,screenHeightInPoints,appPlatform,devicePlatform,deviceFamily,buildBundleId,build,tester';

const SCREENSHOT_SUBMISSION_FIELDS = `${FEEDBACK_COMMON_FIELDS},screenshots`;
const CRASH_SUBMISSION_FIELDS = `${FEEDBACK_COMMON_FIELDS},crashLog`;

export interface FeedbackListFilters {
  deviceModels?: string[] | undefined;
  osVersions?: string[] | undefined;
  appPlatforms?: string[] | undefined;
  devicePlatforms?: string[] | undefined;
  buildIds?: string[] | undefined;
  preReleaseVersions?: string[] | undefined;
  testerIds?: string[] | undefined;
  newestFirst?: boolean | undefined;
}

export function buildFeedbackListQuery(
  kind: 'screenshot' | 'crash',
  filters: FeedbackListFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  const fieldsKey =
    kind === 'screenshot'
      ? 'fields[betaFeedbackScreenshotSubmissions]'
      : 'fields[betaFeedbackCrashSubmissions]';
  params.set(
    fieldsKey,
    kind === 'screenshot' ? SCREENSHOT_SUBMISSION_FIELDS : CRASH_SUBMISSION_FIELDS,
  );
  if (filters.deviceModels?.length) {
    params.set('filter[deviceModel]', filters.deviceModels.join(','));
  }
  if (filters.osVersions?.length) params.set('filter[osVersion]', filters.osVersions.join(','));
  if (filters.appPlatforms?.length) {
    params.set('filter[appPlatform]', filters.appPlatforms.join(','));
  }
  if (filters.devicePlatforms?.length) {
    params.set('filter[devicePlatform]', filters.devicePlatforms.join(','));
  }
  if (filters.buildIds?.length) params.set('filter[build]', filters.buildIds.join(','));
  if (filters.preReleaseVersions?.length) {
    // Dotted filter key — filter on the RELATED build's preReleaseVersion,
    // not an attribute of the submission itself.
    params.set('filter[build.preReleaseVersion]', filters.preReleaseVersions.join(','));
  }
  if (filters.testerIds?.length) params.set('filter[tester]', filters.testerIds.join(','));
  params.set('sort', filters.newestFirst === false ? 'createdDate' : '-createdDate');
  // LIVE-SMOKE FINDING (2026-06-10): without include, Apple omits the build
  // and tester relationship objects ENTIRELY (only crashLog/links come back),
  // even when the sparse fieldset asks for them — the digest's BUILD_ID /
  // TESTER_ID columns render empty. include materializes the data linkage.
  params.set('include', 'build,tester');
  params.set('limit', '200');
  return params;
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const listFilterInputSchema = z.object({
  appId: AppIdSchema,
  deviceModels: z
    .array(z.string().min(1))
    .optional()
    .describe('Filter by device model identifiers, e.g. ["iPhone15,2"].'),
  osVersions: z
    .array(z.string().min(1))
    .optional()
    .describe('Filter by OS version strings, e.g. ["17.4.1"].'),
  appPlatforms: z.array(FeedbackPlatformFilterSchema).optional(),
  devicePlatforms: z.array(FeedbackPlatformFilterSchema).optional(),
  buildIds: z
    .array(BuildIdSchema)
    .optional()
    .describe('Scope to specific builds — the usual triage entry point ("feedback on build N").'),
  preReleaseVersions: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Filter by the related build\'s pre-release version string (e.g. ["2.5.0"]). Dotted wire key filter[build.preReleaseVersion].',
    ),
  testerIds: z.array(BetaTesterIdSchema).optional(),
  newestFirst: z
    .boolean()
    .default(true)
    .describe('true (default): sort=-createdDate. false: oldest first.'),
  maxItems: z.number().int().positive().max(2000).default(200),
  raw: z.boolean().default(false),
});

function pickFilters(input: {
  deviceModels?: string[] | undefined;
  osVersions?: string[] | undefined;
  appPlatforms?: string[] | undefined;
  devicePlatforms?: string[] | undefined;
  buildIds?: string[] | undefined;
  preReleaseVersions?: string[] | undefined;
  testerIds?: string[] | undefined;
  newestFirst?: boolean | undefined;
}): FeedbackListFilters {
  return {
    ...(input.deviceModels?.length ? { deviceModels: input.deviceModels } : {}),
    ...(input.osVersions?.length ? { osVersions: input.osVersions } : {}),
    ...(input.appPlatforms?.length ? { appPlatforms: input.appPlatforms } : {}),
    ...(input.devicePlatforms?.length ? { devicePlatforms: input.devicePlatforms } : {}),
    ...(input.buildIds?.length ? { buildIds: input.buildIds } : {}),
    ...(input.preReleaseVersions?.length ? { preReleaseVersions: input.preReleaseVersions } : {}),
    ...(input.testerIds?.length ? { testerIds: input.testerIds } : {}),
    ...(input.newestFirst !== undefined ? { newestFirst: input.newestFirst } : {}),
  };
}

export function registerBetaFeedback(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_beta_feedback_screenshot_submissions',
    {
      title: 'List beta feedback screenshot submissions',
      description:
        'List screenshot feedback testers sent from TestFlight via GET /v1/apps/{id}/betaFeedbackScreenshotSubmissions. Each row shows created date, device, OS, comment preview, screenshot count, and build/tester linkage. Filter by build to triage feedback per release ("summarize feedback on build 132"). Read-only resource — testers create these from the device.',
      inputSchema: listFilterInputSchema,
    },
    async (input) => {
      const params = buildFeedbackListQuery('screenshot', pickFilters(input));
      const path = `/v1/apps/${encodeURIComponent(input.appId)}/betaFeedbackScreenshotSubmissions?${params.toString()}`;
      try {
        const pages = await paginate(client, path, input.maxItems);
        const text = input.raw
          ? JSON.stringify(pages, null, 2)
          : digestBetaFeedbackScreenshotSubmissions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_feedback_screenshot_submission',
    {
      title: 'Get a beta feedback screenshot submission',
      description:
        'Fetch one screenshot feedback submission with full device context (connection type, battery, disk, uptime, screen size) and the screenshots array — each entry carries url + width + height + expirationDate. The URLs are time-limited Apple-signed download links; if one has expired, re-run this tool for fresh URLs. include=build,tester for triage context.',
      inputSchema: z.object({
        screenshotSubmissionId: BetaFeedbackScreenshotSubmissionIdSchema,
      }),
    },
    async ({ screenshotSubmissionId }) => {
      const path = `/v1/betaFeedbackScreenshotSubmissions/${encodeURIComponent(
        screenshotSubmissionId,
      )}?include=build,tester`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_beta_feedback_screenshot_submission',
    {
      title: 'Delete a beta feedback screenshot submission',
      description:
        'DELETE /v1/betaFeedbackScreenshotSubmissions/{id}. Permanently removes the feedback record and its screenshot images from App Store Connect — same as dismissing it in the TestFlight feedback UI. Irreversible; the tester is not notified.',
      inputSchema: z.object({
        screenshotSubmissionId: BetaFeedbackScreenshotSubmissionIdSchema,
      }),
    },
    async ({ screenshotSubmissionId }) => {
      try {
        await client.request<unknown>(
          `/v1/betaFeedbackScreenshotSubmissions/${encodeURIComponent(screenshotSubmissionId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Deleted beta feedback screenshot submission ${screenshotSubmissionId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
  server.registerTool(
    'asc_list_beta_feedback_crash_submissions',
    {
      title: 'List beta feedback crash submissions',
      description:
        'List crash feedback testers agreed to share from TestFlight via GET /v1/apps/{id}/betaFeedbackCrashSubmissions. Same filters as the screenshot list (build, tester, device, OS, platform). Each record has a crashLog relationship — pull the log text with asc_get_beta_feedback_crash_log. Read-only resource.',
      inputSchema: listFilterInputSchema,
    },
    async (input) => {
      const params = buildFeedbackListQuery('crash', pickFilters(input));
      const path = `/v1/apps/${encodeURIComponent(input.appId)}/betaFeedbackCrashSubmissions?${params.toString()}`;
      try {
        const pages = await paginate(client, path, input.maxItems);
        const text = input.raw
          ? JSON.stringify(pages, null, 2)
          : digestBetaFeedbackCrashSubmissions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_feedback_crash_submission',
    {
      title: 'Get a beta feedback crash submission',
      description:
        'Fetch one crash feedback submission with full device context. include=build,tester for triage context. This returns the submission METADATA only — for the crash log text itself use asc_get_beta_feedback_crash_log.',
      inputSchema: z.object({
        crashSubmissionId: BetaFeedbackCrashSubmissionIdSchema,
      }),
    },
    async ({ crashSubmissionId }) => {
      const path = `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(
        crashSubmissionId,
      )}?include=build,tester`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_feedback_crash_log',
    {
      title: 'Get the crash log for a crash feedback submission',
      description:
        'GET /v1/betaFeedbackCrashSubmissions/{id}/crashLog — returns the betaCrashLogs resource whose logText attribute is the full symbolicated-or-raw crash log. Logs can be large; output is capped at maxChars (default 200k) with a truncation note. Use after asc_list_beta_feedback_crash_submissions to drill into a specific crash. NOTE: Apple stores logs for a limited time — older submissions 404 here even though their metadata still lists (observed live on ~4-month-old submissions); the submission record itself remains readable.',
      inputSchema: z.object({
        crashSubmissionId: BetaFeedbackCrashSubmissionIdSchema,
        maxChars: z
          .number()
          .int()
          .positive()
          .max(1_000_000)
          .default(200_000)
          .describe(
            'Cap on returned log characters. The full log stays on Apple; re-fetch with a higher cap if needed.',
          ),
      }),
    },
    async ({ crashSubmissionId, maxChars }) => {
      const path = `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(
        crashSubmissionId,
      )}/crashLog`;
      try {
        const data = await client.request<{
          data?: { id?: string; attributes?: { logText?: string } };
        }>(path, { method: 'GET' });
        const logText = data?.data?.attributes?.logText;
        if (!logText) {
          return {
            content: [
              {
                type: 'text',
                text: `Crash log resource for submission ${crashSubmissionId} has no logText (Apple may still be processing it).\n\n${JSON.stringify(data, null, 2)}`,
              },
            ],
          };
        }
        const truncated = logText.length > maxChars;
        const body = truncated
          ? `${logText.slice(0, maxChars)}\n\n[truncated at ${maxChars} of ${logText.length} chars — re-run with a higher maxChars for the rest]`
          : logText;
        return { content: [{ type: 'text', text: body }] };
      } catch (err) {
        // LIVE-SMOKE FINDING (2026-06-10): Apple 404s the crashLog related
        // link on older submissions ("no resource of type 'betaCrashLogs'")
        // even though the URL matches Apple's own relationships.crashLog
        // links.related — the log has expired server-side (or was never
        // attached). Surface that instead of a bare NOT_FOUND.
        if (err instanceof ASCError && err.status === 404) {
          return {
            content: [
              {
                type: 'text',
                text: `Apple has no crash log stored for submission ${crashSubmissionId} — logs expire server-side after a while (or the log was never attached). The submission metadata is still readable via asc_get_beta_feedback_crash_submission.\n\n${formatASCError(err)}`,
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_beta_feedback_crash_submission',
    {
      title: 'Delete a beta feedback crash submission',
      description:
        'DELETE /v1/betaFeedbackCrashSubmissions/{id}. Permanently removes the crash feedback record (including its crash log) from App Store Connect. Irreversible; the tester is not notified.',
      inputSchema: z.object({
        crashSubmissionId: BetaFeedbackCrashSubmissionIdSchema,
      }),
    },
    async ({ crashSubmissionId }) => {
      try {
        await client.request<unknown>(
          `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(crashSubmissionId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted beta feedback crash submission ${crashSubmissionId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
