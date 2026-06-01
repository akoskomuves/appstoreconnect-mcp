import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppStoreVersions } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import { AppIdSchema, AppStoreVersionIdSchema, PlatformSchema } from '../schemas.js';

// App Store Versions are the "release-track" version records — distinct from
// the TestFlight-track PreReleaseVersion. One per (app, platform, versionString)
// Apple has seen, carrying release-track copy (release notes via localizations,
// copyright, releaseType MANUAL/AFTER_APPROVAL/SCHEDULED, reviewType
// APP_STORE/NOTARIZATION) and the review state machine.
//
// This sub-domain is READ-ONLY. Version create/update/delete and submission
// flows are heavy enough to deserve their own domain later; v0.10 only needs
// the read surface so callers can find a version ID before localizing it.
//
// Wire-key quirks (verified against Swift SDK):
//   - Swift `isDownloadable` → wire `downloadable` (is-prefix stripped).
//   - `usesIdfa` is marked deprecated in the Swift SDK but Apple still
//     returns it; surface it verbatim.

const APP_STORE_VERSION_FIELDS =
  'platform,versionString,appStoreState,appVersionState,copyright,reviewType,releaseType,earliestReleaseDate,downloadable,createdDate';

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerAppStoreVersions(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_app_store_versions',
    {
      title: 'List App Store versions for an app',
      description:
        'List App Store versions for ONE app. appId is required — Apple\'s /v1/appStoreVersions collection is write-only on the GET side (returns FORBIDDEN_ERROR: "does not allow GET_COLLECTION"), so the only way to enumerate versions is via the per-app relationship path /v1/apps/{id}/appStoreVersions. Returns rows with platform, versionString, current state, and IDs in Apple\'s default order (no `sort` parameter is accepted on this path — Apple rejects it). Use raw:true and post-sort client-side if a specific order is needed.',
      inputSchema: {
        appId: AppIdSchema,
        platform: PlatformSchema.optional().describe(
          'Optional filter — narrow to one platform (IOS/MAC_OS/TV_OS/WATCH_OS/VISION_OS).',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, platform, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appStoreVersions]', APP_STORE_VERSION_FIELDS);
      params.set('limit', '200');
      // Apple rejects `sort` on this endpoint (PARAMETER_ERROR.ILLEGAL).
      // Default response order is acceptable; raw:true + client-side sort
      // is the escape hatch.
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
      inputSchema: {
        appStoreVersionId: AppStoreVersionIdSchema,
      },
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
}
