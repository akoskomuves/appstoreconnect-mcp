import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import {
  AppStoreVersionIdSchema,
  PhasedReleaseIdSchema,
  PhasedReleaseStateSchema,
} from '../schemas.js';

// AppStoreVersionPhasedRelease wire shape:
//
//   * AppStoreVersionPhasedReleaseCreateRequest: `attributes` block is
//     OPTIONAL in the Swift contract; only attr inside is the optional
//     `phasedReleaseState`. NO-ATTRS-BLOCK OMISSION: when state is not
//     provided, the body builder OMITS the entire `attributes` key (same
//     pattern as v0.9 AppInfo PATCH and v0.13 CPP Version Create).
//     Required relationship = appStoreVersion.
//
//   * AppStoreVersionPhasedReleaseUpdateRequest: only mutable attr is
//     `phasedReleaseState`. Apple's lifecycle:
//       INACTIVE (just created) → ACTIVE (rolling out)
//       ACTIVE ↔ PAUSED (developer pause / resume)
//       ACTIVE → COMPLETE (force 100% rollout)
//     Apple may also force-COMPLETE on its own after the 7-day window.
//     Refuses empty PATCH.
//
//   * No state machine gate — Apple's transitions are well-documented and
//     the API surface returns clear errors on invalid transitions. Pass
//     through to Apple.

const PHASED_RELEASE_FIELDS = 'phasedReleaseState,startDate,totalPauseDuration,currentDayNumber';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface PhasedReleaseCreateInput {
  appStoreVersionId: string;
  phasedReleaseState?: string | undefined;
}

export function buildPhasedReleaseCreateBody(input: PhasedReleaseCreateInput): JSONAPIBody {
  // No-attrs-block omission: when state is not provided, OMIT the entire
  // attributes key. Apple rejects bare attrs:{} on this endpoint (same
  // pattern as v0.9 AppInfo PATCH and v0.13 CPP Version Create).
  const relationships = {
    appStoreVersion: {
      data: { type: 'appStoreVersions', id: input.appStoreVersionId },
    },
  };
  if (input.phasedReleaseState === undefined) {
    return {
      data: {
        type: 'appStoreVersionPhasedReleases',
        relationships,
      },
    };
  }
  return {
    data: {
      type: 'appStoreVersionPhasedReleases',
      attributes: { phasedReleaseState: input.phasedReleaseState },
      relationships,
    },
  };
}

export interface PhasedReleasePatchInput {
  phasedReleaseId: string;
  phasedReleaseState: string;
}

export function buildPhasedReleasePatchBody(input: PhasedReleasePatchInput): JSONAPIBody {
  // Only mutable attr is state; caller already guards empty input.
  return {
    data: {
      type: 'appStoreVersionPhasedReleases',
      id: input.phasedReleaseId,
      attributes: { phasedReleaseState: input.phasedReleaseState },
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

export function registerPhasedRelease(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_get_app_store_version_phased_release',
    {
      title: 'Get the phased release for an App Store version',
      description:
        "Fetch the AppStoreVersionPhasedRelease attached to an AppStoreVersion. Returns the current phasedReleaseState (INACTIVE / ACTIVE / PAUSED / COMPLETE), startDate, totalPauseDuration (seconds the rollout has been paused), and currentDayNumber (how many days into Apple's 7-day rollout the release is on). Returns `{ data: null }` if no phased release is attached (NOT a 404).",
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
      }),
    },
    async ({ appStoreVersionId }) => {
      const path = `/v1/appStoreVersions/${encodeURIComponent(appStoreVersionId)}/appStoreVersionPhasedRelease?fields[appStoreVersionPhasedReleases]=${PHASED_RELEASE_FIELDS}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_store_version_phased_release',
    {
      title: 'Create / start a phased release on an App Store version',
      description:
        "Create a new AppStoreVersionPhasedRelease attached to an AppStoreVersion. Required: appStoreVersionId. Optional: phasedReleaseState — pass `ACTIVE` to start the rollout immediately, omit to land in INACTIVE. NO-ATTRS-BLOCK GOTCHA: when state is omitted, the body builder omits the entire `attributes` key (Apple rejects bare attrs:{}). Apple's rollout schedule: 1% day 1, 2% day 2, 5% day 3, 10% day 4, 20% day 5, 50% day 6, 100% day 7.",
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
        phasedReleaseState: PhasedReleaseStateSchema.optional(),
      }),
    },
    async (input) => {
      const body = buildPhasedReleaseCreateBody({
        appStoreVersionId: input.appStoreVersionId,
        ...(input.phasedReleaseState !== undefined
          ? { phasedReleaseState: input.phasedReleaseState }
          : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appStoreVersionPhasedReleases', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppStoreVersionPhasedRelease on version ${input.appStoreVersionId}${input.phasedReleaseState ? ` (state: ${input.phasedReleaseState})` : ''}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_store_version_phased_release',
    {
      title: 'Change the state of a phased release (pause / resume / complete)',
      description:
        "PATCH the phasedReleaseState on an existing AppStoreVersionPhasedRelease. Apple's valid transitions: INACTIVE → ACTIVE (start the rollout), ACTIVE ↔ PAUSED (developer pause / resume), ACTIVE → COMPLETE (force immediate 100% rollout). Apple rejects invalid transitions with a clear error — pass through. This is the only mutable attr.",
      inputSchema: z.object({
        phasedReleaseId: PhasedReleaseIdSchema,
        phasedReleaseState: PhasedReleaseStateSchema,
      }),
    },
    async (input) => {
      const body = buildPhasedReleasePatchBody({
        phasedReleaseId: input.phasedReleaseId,
        phasedReleaseState: input.phasedReleaseState,
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appStoreVersionPhasedReleases/${encodeURIComponent(input.phasedReleaseId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppStoreVersionPhasedRelease ${input.phasedReleaseId} → ${input.phasedReleaseState}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_store_version_phased_release',
    {
      title: 'Cancel / delete a phased release',
      description:
        'DELETE an AppStoreVersionPhasedRelease — cancels the staged rollout and reverts the version to standard immediate release (all users on the next App Store refresh). Apple may refuse if the rollout has already reached COMPLETE.',
      inputSchema: z.object({
        phasedReleaseId: PhasedReleaseIdSchema,
      }),
    },
    async ({ phasedReleaseId }) => {
      try {
        await client.request<unknown>(
          `/v1/appStoreVersionPhasedReleases/${encodeURIComponent(phasedReleaseId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted AppStoreVersionPhasedRelease ${phasedReleaseId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
