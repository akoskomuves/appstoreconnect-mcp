import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestBetaRecruitmentCriterionOptions } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  BetaGroupIdSchema,
  BetaRecruitmentCriterionIdSchema,
  DeviceFamilyOsVersionFilterSchema,
} from '../schemas.js';

// Beta recruitment criteria gate WHO can auto-join an external beta group
// through its public link: only devices matching one of the
// deviceFamilyOsVersionFilters windows can redeem. Apple's UI calls this
// "criteria for public link recruitment".
//
// Resource shape quirks:
//
//   - TO-ONE: a beta group has at most ONE criterion record. Read it via
//     GET /v1/betaGroups/{id}/betaRecruitmentCriteria (note: path segment is
//     plural but the response is a SINGLE resource, not a list). Create a
//     second one for the same group and Apple rejects it — PATCH the
//     existing record instead.
//   - LIVE-SMOKE FINDINGS (2026-06-10), group WITHOUT a criterion:
//       * GET …/betaRecruitmentCriteria → 409 ENTITY_ERROR.RELATIONSHIP
//         .INVALID, detail "BetaRecruitmentCriteria with id '<THE GROUP
//         ID>' does not exist" — NOT an empty 200 or clean 404. The error
//         resolving the criterion BY THE GROUP'S OWN ID is strong evidence
//         the criterion shares its id with the beta group (4th shared-ID
//         quirk, same family as v0.15 AppAvailabilityV2.id == app.id) —
//         unconfirmed by a live create, treat as likely.
//       * GET …/betaRecruitmentCriterionCompatibleBuildCheck → 404 with
//         id 'Not Defined'. Both tools catch these and say "no criterion
//         yet" instead of dumping the raw error.
//   - Lifecycle lives on /v1/betaRecruitmentCriteria: POST (with betaGroup
//     relationship) / PATCH /{id} / DELETE /{id}. DELETE is documented by
//     Apple but missing from the Swift SDK as of v0.16 (confirmed against
//     Apple doc JSON 2026-06-10) — same SDK lag as the feedback DELETEs.
//   - CreateRequest attributes are REQUIRED (deviceFamilyOsVersionFilters is
//     non-optional in the Swift contract) — no no-attrs-omission case here.
//   - Filter wire keys are verbatim camelCase: deviceFamily /
//     minimumOsInclusive / maximumOsInclusive. No is-prefix or URL strips.
//
// Companion read surfaces:
//   - GET /v1/betaRecruitmentCriterionOptions — the valid OS versions per
//     device family (what Apple will accept in min/max).
//   - GET /v1/betaGroups/{id}/betaRecruitmentCriterionCompatibleBuildCheck —
//     hasCompatibleBuild: whether the group currently has a build that
//     matching devices could actually install. Criteria with no compatible
//     build means public-link joiners would see nothing.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface RecruitmentFilterInput {
  deviceFamily: string;
  minimumOsInclusive?: string | undefined;
  maximumOsInclusive?: string | undefined;
}

function filterToWire(f: RecruitmentFilterInput): Record<string, unknown> {
  return {
    deviceFamily: f.deviceFamily,
    ...(f.minimumOsInclusive !== undefined ? { minimumOsInclusive: f.minimumOsInclusive } : {}),
    ...(f.maximumOsInclusive !== undefined ? { maximumOsInclusive: f.maximumOsInclusive } : {}),
  };
}

export interface RecruitmentCriterionCreateInput {
  betaGroupId: string;
  filters: RecruitmentFilterInput[];
}

export function buildBetaRecruitmentCriterionCreateBody(
  input: RecruitmentCriterionCreateInput,
): JSONAPIBody {
  // Attributes block is REQUIRED on this create (Swift contract has it
  // non-optional) — unlike the v0.15 omission cases.
  return {
    data: {
      type: 'betaRecruitmentCriteria',
      attributes: {
        deviceFamilyOsVersionFilters: input.filters.map(filterToWire),
      },
      relationships: {
        betaGroup: { data: { type: 'betaGroups', id: input.betaGroupId } },
      },
    },
  };
}

export interface RecruitmentCriterionPatchInput {
  criterionId: string;
  filters: RecruitmentFilterInput[];
}

export function buildBetaRecruitmentCriterionPatchBody(
  input: RecruitmentCriterionPatchInput,
): JSONAPIBody {
  // PATCH replaces the WHOLE filter array — Apple has no per-entry add or
  // remove. Callers must send the complete desired set.
  return {
    data: {
      type: 'betaRecruitmentCriteria',
      id: input.criterionId,
      attributes: {
        deviceFamilyOsVersionFilters: input.filters.map(filterToWire),
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

export function registerBetaRecruitment(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_get_beta_group_recruitment_criterion',
    {
      title: 'Get the recruitment criterion of a beta group',
      description:
        "GET /v1/betaGroups/{id}/betaRecruitmentCriteria — the group's single recruitment criterion (a beta group has at most one; the plural path segment is Apple's naming, the response is one resource). Returns deviceFamilyOsVersionFilters + lastModifiedDate. When the group has NO criterion yet, Apple answers 409 ENTITY_ERROR (observed live) — this tool translates that to a clear 'no criterion yet' message; create one with asc_post_beta_recruitment_criterion.",
      inputSchema: z.object({
        betaGroupId: BetaGroupIdSchema,
      }),
    },
    async ({ betaGroupId }) => {
      const path = `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/betaRecruitmentCriteria`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        // LIVE-SMOKE FINDING (2026-06-10): no-criterion groups return 409
        // ENTITY_ERROR.RELATIONSHIP.INVALID ("BetaRecruitmentCriteria with
        // id '<groupId>' does not exist"), not an empty 200 or clean 404.
        if (err instanceof ASCError && (err.status === 409 || err.status === 404)) {
          return {
            content: [
              {
                type: 'text',
                text: `Beta group ${betaGroupId} has no recruitment criterion yet — its public link (if enabled) accepts any device. Create one with asc_post_beta_recruitment_criterion.\n\n${formatASCError(err)}`,
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
    'asc_post_beta_recruitment_criterion',
    {
      title: 'Create a recruitment criterion on a beta group',
      description:
        'POST /v1/betaRecruitmentCriteria — gate public-link auto-recruitment on a beta group to devices matching the given device-family + OS-version windows. The group should be EXTERNAL with the public link enabled (see asc_patch_beta_group) for the criterion to have any effect. One criterion per group — if one already exists, PATCH it instead. Valid OS versions per family: asc_list_beta_recruitment_criterion_options. After creating, sanity-check with asc_get_beta_recruitment_compatible_build_check that matching devices can actually install a build.',
      inputSchema: z.object({
        betaGroupId: BetaGroupIdSchema,
        filters: z
          .array(DeviceFamilyOsVersionFilterSchema)
          .min(1)
          .describe(
            'At least one device-family window. A device joins if it matches ANY entry (OR semantics).',
          ),
      }),
    },
    async ({ betaGroupId, filters }) => {
      const body = buildBetaRecruitmentCriterionCreateBody({
        betaGroupId,
        filters: filters.map((f) => ({
          deviceFamily: f.deviceFamily,
          ...(f.minimumOsInclusive !== undefined
            ? { minimumOsInclusive: f.minimumOsInclusive }
            : {}),
          ...(f.maximumOsInclusive !== undefined
            ? { maximumOsInclusive: f.maximumOsInclusive }
            : {}),
        })),
      });
      try {
        const data = await client.request<unknown>('/v1/betaRecruitmentCriteria', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created recruitment criterion on beta group ${betaGroupId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_beta_recruitment_criterion',
    {
      title: 'Patch a recruitment criterion',
      description:
        'PATCH /v1/betaRecruitmentCriteria/{id} — REPLACES the whole deviceFamilyOsVersionFilters array (no per-entry add/remove on the wire). Read the current set first with asc_get_beta_group_recruitment_criterion, then send the complete desired set.',
      inputSchema: z.object({
        criterionId: BetaRecruitmentCriterionIdSchema,
        filters: z
          .array(DeviceFamilyOsVersionFilterSchema)
          .min(1)
          .describe('The COMPLETE replacement set — entries not listed here are dropped.'),
      }),
    },
    async ({ criterionId, filters }) => {
      const body = buildBetaRecruitmentCriterionPatchBody({
        criterionId,
        filters: filters.map((f) => ({
          deviceFamily: f.deviceFamily,
          ...(f.minimumOsInclusive !== undefined
            ? { minimumOsInclusive: f.minimumOsInclusive }
            : {}),
          ...(f.maximumOsInclusive !== undefined
            ? { maximumOsInclusive: f.maximumOsInclusive }
            : {}),
        })),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/betaRecruitmentCriteria/${encodeURIComponent(criterionId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched recruitment criterion ${criterionId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_beta_recruitment_criterion',
    {
      title: 'Delete a recruitment criterion',
      description:
        'DELETE /v1/betaRecruitmentCriteria/{id} — remove the criterion entirely; the public link goes back to accepting ANY device. The beta group and its public link are untouched.',
      inputSchema: z.object({
        criterionId: BetaRecruitmentCriterionIdSchema,
      }),
    },
    async ({ criterionId }) => {
      try {
        await client.request<unknown>(
          `/v1/betaRecruitmentCriteria/${encodeURIComponent(criterionId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [{ type: 'text', text: `Deleted recruitment criterion ${criterionId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_beta_recruitment_criterion_options',
    {
      title: 'List valid recruitment criterion options',
      description:
        'GET /v1/betaRecruitmentCriterionOptions — the device families and OS versions Apple currently accepts in deviceFamilyOsVersionFilters. Consult before creating/patching a criterion so min/max values are valid.',
      inputSchema: z.object({
        maxItems: z.number().int().positive().max(500).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ maxItems, raw }) => {
      const path = `/v1/betaRecruitmentCriterionOptions?limit=200`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestBetaRecruitmentCriterionOptions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_recruitment_compatible_build_check',
    {
      title: 'Check recruitment criteria against available builds',
      description:
        'GET /v1/betaGroups/{id}/betaRecruitmentCriterionCompatibleBuildCheck — hasCompatibleBuild tells you whether the group currently distributes at least one build that devices matching the recruitment criteria could install. false means public-link joiners who pass the criteria would find NO installable build — fix the criteria or assign a compatible build before promoting the link. 404s when the group has no criterion at all (observed live) — the check only exists once a criterion does.',
      inputSchema: z.object({
        betaGroupId: BetaGroupIdSchema,
      }),
    },
    async ({ betaGroupId }) => {
      const path = `/v1/betaGroups/${encodeURIComponent(
        betaGroupId,
      )}/betaRecruitmentCriterionCompatibleBuildCheck`;
      try {
        const data = await client.request<{
          data?: { attributes?: { hasCompatibleBuild?: boolean } };
        }>(path, { method: 'GET' });
        const has = data?.data?.attributes?.hasCompatibleBuild;
        const verdict =
          has === true
            ? 'hasCompatibleBuild=true — devices matching the recruitment criteria can install at least one of this group’s builds.'
            : has === false
              ? 'hasCompatibleBuild=false — NO build in this group is installable by devices matching the criteria. Loosen the criteria or assign a compatible build.'
              : 'Apple returned no hasCompatibleBuild value.';
        return {
          content: [{ type: 'text', text: `${verdict}\n\n${JSON.stringify(data, null, 2)}` }],
        };
      } catch (err) {
        // LIVE-SMOKE FINDING (2026-06-10): on a group with no criterion this
        // endpoint 404s with "no resource of type 'betaRecruitmentCriteria'
        // with id 'Not Defined'" — the check only exists once a criterion does.
        if (err instanceof ASCError && err.status === 404) {
          return {
            content: [
              {
                type: 'text',
                text: `Beta group ${betaGroupId} has no recruitment criterion, so there is nothing to check against — the compatible-build check only exists once a criterion does. Create one with asc_post_beta_recruitment_criterion first.\n\n${formatASCError(err)}`,
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
