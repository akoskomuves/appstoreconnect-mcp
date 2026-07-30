import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppStoreVersions } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AppStoreVersionIdSchema,
  BuildIdSchema,
  CopyrightSchema,
  EarliestReleaseDateSchema,
  PlatformSchema,
  ReleaseTypeSchema,
  ReviewTypeSchema,
  VersionStringSchema,
} from '../schemas.js';

// App Store Versions are the "release-track" version records — distinct from
// the TestFlight-track PreReleaseVersion. One per (app, platform, versionString)
// Apple has seen, carrying release-track copy (release notes via localizations,
// copyright, releaseType MANUAL/AFTER_APPROVAL/SCHEDULED, reviewType
// APP_STORE/NOTARIZATION) and the review state machine.
//
// v0.10: read tools only.
// v0.11: full write surface — POST / PATCH / DELETE — closes the release
// lifecycle. The actual "submit for review" gate lives in
// review-submissions.ts (V2 surface) — POST a ReviewSubmission, add the
// version as a ReviewSubmissionItem, then PATCH the submission with
// submitted=true.
//
// Wire-key quirks (verified against Swift SDK):
//   - Swift `isDownloadable` → wire `downloadable` (is-prefix stripped).
//   - `usesIdfa` is marked deprecated in the Swift SDK but Apple still
//     returns it; surface it verbatim.
//
// Mutability (Apple's state machine):
//   - PREPARE_FOR_SUBMISSION / *_REJECTED / DEVELOPER_REMOVED_FROM_SALE
//     → all attrs mutable (the editable set)
//   - READY_FOR_SALE / PENDING_DEVELOPER_RELEASE / REPLACED_WITH_NEW_VERSION
//     / REMOVED_FROM_SALE → only specific attrs mutable (varies per attr
//     — Apple's docs are not exhaustive). Pre-check on PATCH would need a
//     per-field-per-state matrix; deferred to a future patch.
//   - WAITING_FOR_REVIEW / IN_REVIEW / PROCESSING_FOR_APP_STORE → nothing
//     mutable
//
// DELETE is gated client-side: only editable states allow it. Frozen and
// promo-only states refuse to delete (a deleted live version would orphan
// customers).

const APP_STORE_VERSION_FIELDS =
  'platform,versionString,appStoreState,appVersionState,copyright,reviewType,releaseType,earliestReleaseDate,downloadable,createdDate';

// State sets shared with the localization-state-gate logic (kept inline
// here to avoid a separate file shuffle; consider extracting to a shared
// state-gates module if more domains adopt the pattern).
const VERSION_FROZEN_STATES = new Set<string>([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PROCESSING_FOR_APP_STORE',
]);

const VERSION_PROMO_OR_LIVE_STATES = new Set<string>([
  'READY_FOR_SALE',
  'PENDING_DEVELOPER_RELEASE',
  'REPLACED_WITH_NEW_VERSION',
  'REMOVED_FROM_SALE',
]);

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface AppStoreVersionCreateInput {
  appId: string;
  platform: 'IOS' | 'MAC_OS' | 'TV_OS' | 'WATCH_OS' | 'VISION_OS';
  versionString: string;
  copyright?: string | undefined;
  reviewType?: 'APP_STORE' | 'NOTARIZATION' | undefined;
  releaseType?: 'MANUAL' | 'AFTER_APPROVAL' | 'SCHEDULED' | undefined;
  earliestReleaseDate?: string | undefined;
  buildId?: string | undefined;
}

export function buildAppStoreVersionCreateBody(input: AppStoreVersionCreateInput): JSONAPIBody {
  // Required: platform + versionString + app rel. All other attrs are
  // encodeIfPresent. The build rel is optional at create — Apple lets you
  // attach a build either at create time or via PATCH later.
  const attributes: Record<string, unknown> = {
    platform: input.platform,
    versionString: input.versionString,
  };
  if (input.copyright !== undefined) attributes.copyright = input.copyright;
  if (input.reviewType !== undefined) attributes.reviewType = input.reviewType;
  if (input.releaseType !== undefined) attributes.releaseType = input.releaseType;
  if (input.earliestReleaseDate !== undefined) {
    attributes.earliestReleaseDate = input.earliestReleaseDate;
  }
  const relationships: Record<string, unknown> = {
    app: { data: { type: 'apps', id: input.appId } },
  };
  if (input.buildId !== undefined) {
    relationships.build = { data: { type: 'builds', id: input.buildId } };
  }
  return {
    data: {
      type: 'appStoreVersions',
      attributes,
      relationships,
    },
  };
}

export interface AppStoreVersionPatchInput {
  appStoreVersionId: string;
  versionString?: string | undefined;
  copyright?: string | undefined;
  reviewType?: 'APP_STORE' | 'NOTARIZATION' | undefined;
  releaseType?: 'MANUAL' | 'AFTER_APPROVAL' | 'SCHEDULED' | undefined;
  earliestReleaseDate?: string | undefined;
  downloadable?: boolean | undefined;
  buildId?: string | undefined;
  // Pass `null` to clear the build relationship (Apple supports this).
  // undefined means "leave build relationship alone".
  clearBuild?: boolean | undefined;
}

export function buildAppStoreVersionPatchBody(input: AppStoreVersionPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.versionString !== undefined) attributes.versionString = input.versionString;
  if (input.copyright !== undefined) attributes.copyright = input.copyright;
  if (input.reviewType !== undefined) attributes.reviewType = input.reviewType;
  if (input.releaseType !== undefined) attributes.releaseType = input.releaseType;
  if (input.earliestReleaseDate !== undefined) {
    attributes.earliestReleaseDate = input.earliestReleaseDate;
  }
  // Wire key: `downloadable` (Apple strips Swift's `is` prefix).
  if (input.downloadable !== undefined) attributes.downloadable = input.downloadable;

  const relationships: Record<string, unknown> = {};
  if (input.buildId !== undefined) {
    relationships.build = { data: { type: 'builds', id: input.buildId } };
  } else if (input.clearBuild === true) {
    // Explicitly clear the build relationship — Apple accepts data: null.
    relationships.build = { data: null };
  }
  const body: JSONAPIBody = {
    data: {
      type: 'appStoreVersions',
      id: input.appStoreVersionId,
      attributes,
    },
  };
  if (Object.keys(relationships).length > 0) body.data.relationships = relationships;
  return body;
}

// ----- DELETE pre-check (state gate) -----

export interface DeleteGateResult {
  allow: boolean;
  state: string | undefined;
  reason?: string;
  nextEditablePath?: string;
}

export function evaluateVersionDeleteGate(state: string | undefined): DeleteGateResult {
  if (!state) return { allow: true, state };
  if (VERSION_FROZEN_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `version is in ${state} — Apple holds it during review/processing`,
      nextEditablePath:
        'Cancel the review submission first (asc_patch_review_submission with action: "cancel"), then retry the delete once the state returns to a draft state.',
    };
  }
  if (VERSION_PROMO_OR_LIVE_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `version is in ${state} — deleting a live or release-pending version would orphan customers, and Apple rejects DELETE in this state`,
      nextEditablePath:
        'A released version cannot be deleted. To remove the app from sale, use the App Availability surface (coming in v0.15) or remove the app from sale in App Store Connect UI. To replace this version, create a NEW App Store version (asc_post_app_store_version) with a higher versionString.',
    };
  }
  return { allow: true, state };
}

function formatDeleteRefusal(g: DeleteGateResult): string {
  return [
    `Refused: App Store Version DELETE blocked by current state.`,
    ``,
    `State:  ${g.state ?? '(unknown)'}`,
    `Reason: ${g.reason ?? ''}`,
    ``,
    `Next:   ${g.nextEditablePath ?? ''}`,
  ].join('\n');
}

async function fetchVersionState(
  client: ASCClient,
  appStoreVersionId: string,
): Promise<string | undefined> {
  const path =
    `/v1/appStoreVersions/${encodeURIComponent(appStoreVersionId)}` +
    `?fields[appStoreVersions]=appStoreState,appVersionState`;
  try {
    const res = await client.request<{
      data?: { attributes?: { appStoreState?: string; appVersionState?: string } };
    }>(path, { method: 'GET' });
    return res?.data?.attributes?.appStoreState ?? res?.data?.attributes?.appVersionState;
  } catch {
    return undefined;
  }
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerAppStoreVersions(server: McpServer, client: ASCClient): void {
  // ----- Reads (v0.10) -----

  server.registerTool(
    'asc_list_app_store_versions',
    {
      title: 'List App Store versions for an app',
      description:
        'List App Store versions for ONE app. appId is required — Apple\'s /v1/appStoreVersions collection is write-only on the GET side (returns FORBIDDEN_ERROR: "does not allow GET_COLLECTION"), so the only way to enumerate versions is via the per-app relationship path /v1/apps/{id}/appStoreVersions. Returns rows with platform, versionString, current state, and IDs in Apple\'s default order (no `sort` parameter is accepted on this path — Apple rejects it). Use raw:true and post-sort client-side if a specific order is needed.',
      inputSchema: z.object({
        appId: AppIdSchema,
        platform: PlatformSchema.optional().describe(
          'Optional filter — narrow to one platform (IOS/MAC_OS/TV_OS/WATCH_OS/VISION_OS).',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, platform, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appStoreVersions]', APP_STORE_VERSION_FIELDS);
      params.set('limit', '200');
      if (platform) params.set('filter[platform]', platform);
      const path = `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppStoreVersions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_store_version',
    {
      title: 'Get an App Store version',
      description:
        "Fetch a single App Store version with relationships expanded (app + appStoreVersionLocalizations + build). Use to see which locales already have copy and which still need localizing — the appStoreVersionLocalizations to-many relationship is the typical entry point for the v0.10 'translate release notes into N locales' workflow.",
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
      }),
    },
    async ({ appStoreVersionId }) => {
      const path = `/v1/appStoreVersions/${encodeURIComponent(
        appStoreVersionId,
      )}?include=app,appStoreVersionLocalizations,build`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Writes (v0.11) -----

  server.registerTool(
    'asc_post_app_store_version',
    {
      title: 'Create an App Store version',
      description:
        'Create a new App Store version on an app. Required: appId + platform + versionString. The versionString must compare HIGHER than every prior version for this (app, platform) — Apple rejects duplicates or decreasing values. Optional: copyright, reviewType (APP_STORE default / NOTARIZATION for macOS notarization-only), releaseType (MANUAL / AFTER_APPROVAL / SCHEDULED), earliestReleaseDate (required if releaseType=SCHEDULED). ' +
        'Optional buildId attaches a build at create time — useful for the end-to-end flow "TestFlight build → App Store version → submit for review". The build must be in VALID processingState and APP_STORE_ELIGIBLE buildAudienceType. ' +
        'After create, the version sits in PREPARE_FOR_SUBMISSION. Add localizations (asc_post_app_store_version_localization) for at least the primary locale, then create a review submission (asc_post_review_submission + asc_post_review_submission_item) and submit it.',
      inputSchema: z.object({
        appId: AppIdSchema,
        platform: PlatformSchema,
        versionString: VersionStringSchema,
        copyright: CopyrightSchema.optional(),
        reviewType: ReviewTypeSchema.optional(),
        releaseType: ReleaseTypeSchema.optional(),
        earliestReleaseDate: EarliestReleaseDateSchema.optional().describe(
          'Required when releaseType=SCHEDULED. Must be at least 24h in the future. ISO 8601 timestamp with timezone.',
        ),
        buildId: BuildIdSchema.optional().describe(
          'Optional: attach a build at create time. The build must be VALID + APP_STORE_ELIGIBLE. Can also be attached later via asc_patch_app_store_version.',
        ),
      }),
    },
    async (input) => {
      // Cross-field check: SCHEDULED release without earliestReleaseDate is
      // an immediate Apple reject. Catch client-side with a clearer message.
      if (input.releaseType === 'SCHEDULED' && input.earliestReleaseDate === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: releaseType=SCHEDULED requires earliestReleaseDate. Pass an ISO 8601 timestamp at least 24h in the future.',
            },
          ],
          isError: true,
        };
      }
      const body = buildAppStoreVersionCreateBody({
        appId: input.appId,
        platform: input.platform,
        versionString: input.versionString,
        ...(input.copyright !== undefined ? { copyright: input.copyright } : {}),
        ...(input.reviewType !== undefined ? { reviewType: input.reviewType } : {}),
        ...(input.releaseType !== undefined ? { releaseType: input.releaseType } : {}),
        ...(input.earliestReleaseDate !== undefined
          ? { earliestReleaseDate: input.earliestReleaseDate }
          : {}),
        ...(input.buildId !== undefined ? { buildId: input.buildId } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appStoreVersions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created App Store version ${input.versionString} on app ${input.appId} (platform ${input.platform}).\n\n${JSON.stringify(data, null, 2)}\n\nNext: add localizations (asc_post_app_store_version_localization), then submit for review (asc_post_review_submission → asc_post_review_submission_item → asc_patch_review_submission with action: "submit").`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_store_version',
    {
      title: 'Patch an App Store version',
      description:
        'Mutate version-level attributes: versionString, copyright, reviewType, releaseType, earliestReleaseDate, downloadable. Plus the build relationship (attach/swap/clear). All attrs are encodeIfPresent (only what you pass is sent). Wire-key gotcha: Swift `isDownloadable` → wire `downloadable`. ' +
        "STATE GATING IS DEFERRED — Apple's field-by-state matrix is not exhaustively documented and the rules vary (e.g. versionString is immutable post-release, but releaseType + earliestReleaseDate are mutable in PENDING_DEVELOPER_RELEASE to allow rescheduling). The tool does NOT pre-check; Apple's 409 STATE_ERROR is surfaced verbatim. Use asc_get_app_store_version first to inspect the current state and field set.",
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
        versionString: VersionStringSchema.optional(),
        copyright: CopyrightSchema.optional(),
        reviewType: ReviewTypeSchema.optional(),
        releaseType: ReleaseTypeSchema.optional(),
        earliestReleaseDate: EarliestReleaseDateSchema.optional(),
        downloadable: z
          .boolean()
          .optional()
          .describe(
            'Wire key `downloadable`. Controls whether the version is downloadable from the App Store — toggling false effectively pulls the version while keeping the record.',
          ),
        buildId: BuildIdSchema.optional().describe(
          'Attach or swap the build on this version. Mutually exclusive with clearBuild.',
        ),
        clearBuild: z
          .boolean()
          .optional()
          .describe(
            'Pass true to clear the build relationship (Apple accepts data: null on the build rel). Useful when swapping builds — first clear, then re-attach. Mutually exclusive with buildId.',
          ),
      }),
    },
    async (input) => {
      if (input.buildId !== undefined && input.clearBuild === true) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at most one of buildId / clearBuild=true. They are mutually exclusive.',
            },
          ],
          isError: true,
        };
      }
      const anyAttr =
        input.versionString !== undefined ||
        input.copyright !== undefined ||
        input.reviewType !== undefined ||
        input.releaseType !== undefined ||
        input.earliestReleaseDate !== undefined ||
        input.downloadable !== undefined;
      const anyRel = input.buildId !== undefined || input.clearBuild === true;
      if (!anyAttr && !anyRel) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one attribute or buildId/clearBuild. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildAppStoreVersionPatchBody({
        appStoreVersionId: input.appStoreVersionId,
        ...(input.versionString !== undefined ? { versionString: input.versionString } : {}),
        ...(input.copyright !== undefined ? { copyright: input.copyright } : {}),
        ...(input.reviewType !== undefined ? { reviewType: input.reviewType } : {}),
        ...(input.releaseType !== undefined ? { releaseType: input.releaseType } : {}),
        ...(input.earliestReleaseDate !== undefined
          ? { earliestReleaseDate: input.earliestReleaseDate }
          : {}),
        ...(input.downloadable !== undefined ? { downloadable: input.downloadable } : {}),
        ...(input.buildId !== undefined ? { buildId: input.buildId } : {}),
        ...(input.clearBuild === true ? { clearBuild: true } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appStoreVersions/${encodeURIComponent(input.appStoreVersionId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched App Store version ${input.appStoreVersionId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_store_version',
    {
      title: 'Delete an App Store version',
      description:
        'DELETE an App Store version. Allowed only when the version is in an editable state (PREPARE_FOR_SUBMISSION, *_REJECTED, INVALID_BINARY, DEVELOPER_REMOVED_FROM_SALE). The tool pre-checks the state with one GET and refuses client-side for frozen states (under review) or live states (READY_FOR_SALE — would orphan customers; release-pending — Apple rejects).',
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
      }),
    },
    async ({ appStoreVersionId }) => {
      const state = await fetchVersionState(client, appStoreVersionId);
      const gate = evaluateVersionDeleteGate(state);
      if (!gate.allow) {
        return {
          content: [{ type: 'text', text: formatDeleteRefusal(gate) }],
          isError: true,
        };
      }
      try {
        await client.request<unknown>(
          `/v1/appStoreVersions/${encodeURIComponent(appStoreVersionId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Deleted App Store version ${appStoreVersionId} (state was ${gate.state ?? 'unknown'}).`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
