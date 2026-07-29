import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestBuilds } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  BuildBetaDetailIdSchema,
  BuildIdSchema,
  ProcessingStateSchema,
} from '../schemas.js';

// TestFlight builds — the central resource for the entire TestFlight surface.
// Every other v0.9 resource (beta groups, beta testers, localizations, review
// submissions) ultimately references a build. Apple ingests builds via
// Xcode/altool/Transporter; the API exposes them read + retire-only (you
// cannot upload via /v1/builds, only inspect and PATCH the expired flag).
//
// Lifecycle:
//   1. Developer uploads .ipa via Xcode → Apple kicks off ingest.
//   2. processingState walks PROCESSING → VALID (typically 5–30 min). FAILED
//      or INVALID means the build never reaches testers.
//   3. Build expires 90 days after upload (auto). PATCH expired=true retires
//      it earlier — useful when revoking a build with a security issue.
//   4. BuildBetaDetail (a 1:1 companion resource) carries autoNotifyEnabled
//      + internalBuildState + externalBuildState. Only autoNotifyEnabled is
//      mutable on this resource; the two state attrs are Apple-managed
//      reflections of beta-review status.
//
// Build PATCH attributes that Apple actually accepts:
//   - expired (the "retire" flag). One-way in practice — Apple does not
//     "un-expire" builds (probably can be flipped back to false but the
//     90-day clock keeps ticking; tested in smoke).
//   - usesNonExemptEncryption (compliance flag, required before some app
//     review flows; can be set if the build was uploaded without it).

const BUILD_FIELDS =
  'version,uploadedDate,expirationDate,expired,minOsVersion,processingState,buildAudienceType,usesNonExemptEncryption';
const BUILD_BETA_DETAIL_FIELDS = 'autoNotifyEnabled,internalBuildState,externalBuildState';

export interface BuildPatchInput {
  buildId: string;
  expired?: boolean | undefined;
  usesNonExemptEncryption?: boolean | undefined;
}

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
}

export function buildBuildPatchBody(input: BuildPatchInput): JSONAPIBody {
  // Apple's BuildUpdateRequest schema accepts ONLY expired +
  // usesNonExemptEncryption. Both are encodeIfPresent — omit when caller
  // didn't pass them so we don't accidentally toggle an unrelated flag.
  const attributes: Record<string, unknown> = {};
  if (input.expired !== undefined) attributes.expired = input.expired;
  if (input.usesNonExemptEncryption !== undefined) {
    attributes.usesNonExemptEncryption = input.usesNonExemptEncryption;
  }
  return {
    data: {
      type: 'builds',
      id: input.buildId,
      attributes,
      relationships: {},
    },
  };
}

export interface BuildBetaDetailPatchInput {
  buildBetaDetailId: string;
  autoNotifyEnabled: boolean;
}

export function buildBuildBetaDetailPatchBody(input: BuildBetaDetailPatchInput): JSONAPIBody {
  // BuildBetaDetailUpdateRequest accepts ONLY autoNotifyEnabled — the
  // internal/external build state attrs are Apple-managed (set by beta
  // review state transitions) and rejected if you try to PATCH them.
  return {
    data: {
      type: 'buildBetaDetails',
      id: input.buildBetaDetailId,
      attributes: { autoNotifyEnabled: input.autoNotifyEnabled },
      relationships: {},
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

export function registerBuilds(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_builds',
    {
      title: 'List TestFlight builds',
      description:
        "List TestFlight builds. Pass appId to scope to a single app (the common case — Apple paginates global build lists across the whole team). Optional processingState filter narrows to a single state (VALID is usually what you want — that's the testable subset). The digest shows version + processingState + uploadedDate + expiration in a compact table.",
      inputSchema: z.object({
        appId: AppIdSchema.optional().describe(
          'When provided, list via /v1/apps/{id}/builds (scoped). When omitted, list via /v1/builds (team-wide — typically large; pair with processingState to narrow).',
        ),
        processingState: ProcessingStateSchema.optional().describe(
          'Optional filter. VALID = builds Apple has accepted and that can be distributed. PROCESSING = still being ingested. FAILED/INVALID = unusable.',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, processingState, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[builds]', BUILD_FIELDS);
      params.set('limit', '200');
      // Apple accepts `sort` on the team-wide /v1/builds collection but
      // REJECTS it on the per-app relationship path /v1/apps/{id}/builds
      // (PARAMETER_ERROR.ILLEGAL). digestBuilds always client-side-sorts
      // newest first, so this is purely an Apple-side optimization for the
      // team-wide path; on the per-app path the client-side sort suffices.
      if (!appId) params.set('sort', '-uploadedDate');
      if (processingState) params.set('filter[processingState]', processingState);
      const path = appId
        ? `/v1/apps/${encodeURIComponent(appId)}/builds?${params.toString()}`
        : `/v1/builds?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBuilds(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_build',
    {
      title: 'Get a TestFlight build',
      description:
        'Fetch a single build with relationships expanded (app + preReleaseVersion + buildBetaDetail + betaBuildLocalizations + betaGroups + betaAppReviewSubmission). Useful before deciding to retire, assign to a group, or submit for beta review.',
      inputSchema: z.object({
        buildId: BuildIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildId, raw: _raw }) => {
      const path = `/v1/builds/${encodeURIComponent(
        buildId,
      )}?include=app,preReleaseVersion,buildBetaDetail,betaBuildLocalizations,betaGroups,betaAppReviewSubmission`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_build',
    {
      title: 'Patch a TestFlight build (expire / encryption flag)',
      description:
        "Mutate a build's `expired` flag (retire a build early — Apple normally expires 90 days after upload, but security holes or broken releases warrant immediate retirement) or `usesNonExemptEncryption` (compliance flag required before some submissions). " +
        "Apple's PATCH schema on this resource ONLY accepts these two attributes — version/minOsVersion/processingState/etc are all immutable. Pass at least one of the two flags; omitting both no-ops at the wire (Apple returns the unchanged resource).",
      inputSchema: z.object({
        buildId: BuildIdSchema,
        expired: z
          .boolean()
          .optional()
          .describe(
            'true to expire the build immediately (testers can no longer install). Apple does technically allow setting it back to false within the 90-day window, but the original expirationDate clock still applies.',
          ),
        usesNonExemptEncryption: z
          .boolean()
          .optional()
          .describe(
            'Compliance flag. Set to declare the build uses encryption outside the OS-provided exemptions (e.g. custom crypto). Many TestFlight flows refuse external distribution until this is explicitly set true or false.',
          ),
      }),
    },
    async ({ buildId, expired, usesNonExemptEncryption }) => {
      if (expired === undefined && usesNonExemptEncryption === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: "Refused: pass at least one of `expired` or `usesNonExemptEncryption`. Apple's PATCH on /v1/builds only mutates these two attributes; a no-op PATCH wastes a round-trip.",
            },
          ],
          isError: true,
        };
      }
      const body = buildBuildPatchBody({
        buildId,
        ...(expired !== undefined ? { expired } : {}),
        ...(usesNonExemptEncryption !== undefined ? { usesNonExemptEncryption } : {}),
      });
      try {
        const data = await client.request<unknown>(`/v1/builds/${encodeURIComponent(buildId)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        const actions = [
          expired !== undefined ? `expired=${expired}` : null,
          usesNonExemptEncryption !== undefined
            ? `usesNonExemptEncryption=${usesNonExemptEncryption}`
            : null,
        ]
          .filter(Boolean)
          .join(', ');
        return {
          content: [
            {
              type: 'text',
              text: `Patched build ${buildId}: ${actions}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_build_beta_detail',
    {
      title: "Get a build's BuildBetaDetail companion record",
      description:
        'Fetch the BuildBetaDetail for a build — carries `autoNotifyEnabled` (whether Apple auto-pushes the build to assigned testers on availability) + `internalBuildState` + `externalBuildState` (Apple-managed beta-review reflections). The state fields are read-only; PATCH this resource via asc_patch_build_beta_detail to toggle autoNotifyEnabled.',
      inputSchema: z.object({
        buildBetaDetailId: BuildBetaDetailIdSchema,
      }),
    },
    async ({ buildBetaDetailId }) => {
      const params = new URLSearchParams();
      params.set('fields[buildBetaDetails]', BUILD_BETA_DETAIL_FIELDS);
      const path = `/v1/buildBetaDetails/${encodeURIComponent(
        buildBetaDetailId,
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
    'asc_patch_build_beta_detail',
    {
      title: "Patch a build's BuildBetaDetail (auto-notify flag)",
      description:
        'Toggle `autoNotifyEnabled` on a BuildBetaDetail — when true, Apple pushes a TestFlight notification to every assigned tester the moment the build clears review + processing. ' +
        "Apple's PATCH schema on this resource ONLY accepts autoNotifyEnabled; internal/external build state attrs are Apple-managed reflections of review state and rejected from PATCH bodies.",
      inputSchema: z.object({
        buildBetaDetailId: BuildBetaDetailIdSchema,
        autoNotifyEnabled: z
          .boolean()
          .describe(
            'true: Apple auto-pushes notifications to testers when the build becomes available. false: testers only see the build when they manually refresh TestFlight or you trigger a notification separately.',
          ),
      }),
    },
    async ({ buildBetaDetailId, autoNotifyEnabled }) => {
      const body = buildBuildBetaDetailPatchBody({ buildBetaDetailId, autoNotifyEnabled });
      try {
        const data = await client.request<unknown>(
          `/v1/buildBetaDetails/${encodeURIComponent(buildBetaDetailId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Set autoNotifyEnabled=${autoNotifyEnabled} on BuildBetaDetail ${buildBetaDetailId}.\n\n${JSON.stringify(
                data,
                null,
                2,
              )}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
