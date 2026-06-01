import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestBetaGroups } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  BetaGroupIdSchema,
  BetaGroupNameSchema,
  BetaTesterIdSchema,
  BuildIdSchema,
} from '../schemas.js';

// Beta groups bundle testers. Builds are assigned to groups (not directly to
// testers), so a group is the unit of "ship this build to these people."
// Apple has two kinds of group:
//
//   - INTERNAL: org members from App Store Connect Users & Access only. Up
//     to 100 testers. No beta-review required — internal builds go to these
//     testers immediately after processing. isInternalGroup=true on create.
//   - EXTERNAL: anyone with an email. Up to 10,000 testers. First external
//     distribution of any build requires Apple beta review (handled by the
//     beta-review sub-domain, not here). isInternalGroup=false (or omitted).
//
// Public links: external groups can be made redeemable via a public URL.
// `isPublicLinkEnabled` toggles the link; `isPublicLinkLimitEnabled` +
// `publicLinkLimit` cap how many testers can redeem before it auto-disables.
// Public links are external-group only — Apple rejects them on internal groups.
//
// Apple's wire-key quirks (Swift SDK -> JSON):
//   - `isInternalGroup` stays as `isInternalGroup` on the wire
//   - `hasAccessToAllBuilds` stays as `hasAccessToAllBuilds`
//   - `isPublicLinkEnabled` becomes `publicLinkEnabled` (is-prefix stripped)
//   - `isPublicLinkLimitEnabled` becomes `publicLinkLimitEnabled`
//   - `isFeedbackEnabled` becomes `feedbackEnabled`
//   - `isIosBuildsAvailableForAppleSiliconMac` becomes
//     `iosBuildsAvailableForAppleSiliconMac`
//   - `isIosBuildsAvailableForAppleVision` becomes
//     `iosBuildsAvailableForAppleVision`
// Body builders below MUST use the wire keys, not the Swift property names.
//
// Create-only vs patchable:
//   - Set at CREATE only (immutable after): isInternalGroup, hasAccessToAllBuilds
//   - Mutable via PATCH: name, publicLinkEnabled, publicLinkLimitEnabled,
//     publicLinkLimit, feedbackEnabled, iosBuildsAvailableForAppleSiliconMac,
//     iosBuildsAvailableForAppleVision

const BETA_GROUP_FIELDS =
  'name,createdDate,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLinkId,publicLinkLimitEnabled,publicLinkLimit,publicLink,feedbackEnabled,iosBuildsAvailableForAppleSiliconMac,iosBuildsAvailableForAppleVision';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
}

export interface BetaGroupCreateInput {
  appId: string;
  name: string;
  // Create-only attrs. Default Apple behavior when omitted: isInternalGroup=false
  // (external group), hasAccessToAllBuilds=false. Pass explicitly when the
  // intent is unambiguous.
  isInternalGroup?: boolean | undefined;
  hasAccessToAllBuilds?: boolean | undefined;
  // Mutable attrs that can also be set at create time as a convenience.
  publicLinkEnabled?: boolean | undefined;
  publicLinkLimitEnabled?: boolean | undefined;
  publicLinkLimit?: number | undefined;
  feedbackEnabled?: boolean | undefined;
  // Optional initial membership: pre-seed the group with testers + builds in
  // the same atomic POST.
  initialTesterIds?: string[] | undefined;
  initialBuildIds?: string[] | undefined;
}

export function buildBetaGroupCreateBody(input: BetaGroupCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = { name: input.name };
  if (input.isInternalGroup !== undefined) attributes.isInternalGroup = input.isInternalGroup;
  if (input.hasAccessToAllBuilds !== undefined) {
    attributes.hasAccessToAllBuilds = input.hasAccessToAllBuilds;
  }
  // Wire keys per Apple's contract — these are NOT the Swift property names.
  if (input.publicLinkEnabled !== undefined) {
    attributes.publicLinkEnabled = input.publicLinkEnabled;
  }
  if (input.publicLinkLimitEnabled !== undefined) {
    attributes.publicLinkLimitEnabled = input.publicLinkLimitEnabled;
  }
  if (input.publicLinkLimit !== undefined) attributes.publicLinkLimit = input.publicLinkLimit;
  if (input.feedbackEnabled !== undefined) attributes.feedbackEnabled = input.feedbackEnabled;

  const relationships: Record<string, unknown> = {
    app: { data: { type: 'apps', id: input.appId } },
  };
  if (input.initialTesterIds && input.initialTesterIds.length > 0) {
    relationships.betaTesters = {
      data: input.initialTesterIds.map((id) => ({ type: 'betaTesters', id })),
    };
  }
  if (input.initialBuildIds && input.initialBuildIds.length > 0) {
    relationships.builds = {
      data: input.initialBuildIds.map((id) => ({ type: 'builds', id })),
    };
  }

  return {
    data: {
      type: 'betaGroups',
      attributes,
      relationships,
    },
  };
}

export interface BetaGroupPatchInput {
  betaGroupId: string;
  name?: string | undefined;
  publicLinkEnabled?: boolean | undefined;
  publicLinkLimitEnabled?: boolean | undefined;
  publicLinkLimit?: number | undefined;
  feedbackEnabled?: boolean | undefined;
  iosBuildsAvailableForAppleSiliconMac?: boolean | undefined;
  iosBuildsAvailableForAppleVision?: boolean | undefined;
}

export function buildBetaGroupPatchBody(input: BetaGroupPatchInput): JSONAPIBody {
  // Apple's BetaGroupUpdateRequest accepts ONLY the seven attributes below.
  // isInternalGroup + hasAccessToAllBuilds are NOT patchable — set at create
  // only. Trying to PATCH them is rejected with ENTITY_ERROR.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.publicLinkEnabled !== undefined) {
    attributes.publicLinkEnabled = input.publicLinkEnabled;
  }
  if (input.publicLinkLimitEnabled !== undefined) {
    attributes.publicLinkLimitEnabled = input.publicLinkLimitEnabled;
  }
  if (input.publicLinkLimit !== undefined) attributes.publicLinkLimit = input.publicLinkLimit;
  if (input.feedbackEnabled !== undefined) attributes.feedbackEnabled = input.feedbackEnabled;
  if (input.iosBuildsAvailableForAppleSiliconMac !== undefined) {
    attributes.iosBuildsAvailableForAppleSiliconMac = input.iosBuildsAvailableForAppleSiliconMac;
  }
  if (input.iosBuildsAvailableForAppleVision !== undefined) {
    attributes.iosBuildsAvailableForAppleVision = input.iosBuildsAvailableForAppleVision;
  }
  return {
    data: {
      type: 'betaGroups',
      id: input.betaGroupId,
      attributes,
      relationships: {},
    },
  };
}

export interface RelationshipLinkageInput {
  betaGroupId: string;
  ids: string[];
  // 'betaTesters' or 'builds' — the JSON:API resource type the IDs reference.
  resourceType: 'betaTesters' | 'builds';
}

export function buildRelationshipLinkageBody(input: RelationshipLinkageInput): {
  data: Array<{ type: string; id: string }>;
} {
  // Apple's linkage POST/DELETE on /v1/betaGroups/{id}/relationships/{rel}
  // takes a flat to-many body shape — no attributes, no parent data wrapper.
  // POST adds the IDs to the existing membership; DELETE removes only the
  // listed IDs (it's not a "clear all" — pass every ID explicitly).
  return {
    data: input.ids.map((id) => ({ type: input.resourceType, id })),
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

function publicLinkSanityCheck(args: {
  publicLinkEnabled?: boolean | undefined;
  publicLinkLimitEnabled?: boolean | undefined;
  publicLinkLimit?: number | undefined;
  isInternalGroup?: boolean | undefined;
}): string | null {
  // Public links are external-group only — Apple rejects them on internal
  // groups. Catch the obvious collision client-side.
  if (
    args.isInternalGroup === true &&
    (args.publicLinkEnabled === true || args.publicLinkLimit !== undefined)
  ) {
    return 'Refused: public links are not supported on internal groups (isInternalGroup=true). Drop publicLinkEnabled / publicLinkLimit, or set isInternalGroup=false.';
  }
  // publicLinkLimitEnabled=true without publicLinkLimit is a state Apple
  // rejects. Surface a clearer message.
  if (args.publicLinkLimitEnabled === true && args.publicLinkLimit === undefined) {
    return 'Refused: publicLinkLimitEnabled=true requires publicLinkLimit to be set (the redemption cap). Either pass publicLinkLimit, or omit publicLinkLimitEnabled.';
  }
  return null;
}

export function registerBetaGroups(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_beta_groups',
    {
      title: 'List beta groups',
      description:
        'List beta groups. Pass appId to scope to a single app (the common case). Each row shows name, kind (INT/EXT), tester-count via the betaTesters relationship if requested, public-link state, and ID. Use to find a group before assigning a build or inviting testers.',
      inputSchema: {
        appId: AppIdSchema.optional().describe(
          'When provided, list via /v1/apps/{id}/betaGroups (scoped). When omitted, list via /v1/betaGroups (team-wide across all apps).',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[betaGroups]', BETA_GROUP_FIELDS);
      params.set('limit', '200');
      const path = appId
        ? `/v1/apps/${encodeURIComponent(appId)}/betaGroups?${params.toString()}`
        : `/v1/betaGroups?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBetaGroups(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_group',
    {
      title: 'Get a beta group',
      description:
        "Fetch a single beta group with relationships expanded (app + builds + betaTesters). Use to see the full membership before adding/removing testers or builds. Apple's tester list under a group can be large — paginate via asc_list_beta_testers with the group filter if you need the full list cleanly.",
      inputSchema: {
        betaGroupId: BetaGroupIdSchema,
      },
    },
    async ({ betaGroupId }) => {
      const path = `/v1/betaGroups/${encodeURIComponent(
        betaGroupId,
      )}?include=app,builds,betaTesters`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_beta_group',
    {
      title: 'Create a beta group',
      description:
        'Create a beta group on an app. Required: name + appId. Optional: isInternalGroup (default false → external), hasAccessToAllBuilds (default false), public-link settings (external only), feedbackEnabled, and pre-seeded testers/builds. ' +
        "isInternalGroup and hasAccessToAllBuilds are IMMUTABLE after create — pick them carefully. To change later, delete and re-create. Pre-seeded testers/builds are added atomically; passing IDs that don't exist or aren't valid (e.g. expired build) rejects the whole POST.",
      inputSchema: {
        appId: AppIdSchema,
        name: BetaGroupNameSchema,
        isInternalGroup: z
          .boolean()
          .optional()
          .describe(
            'true: org members only, no review, up to 100 testers. false (default): external group, up to 10,000 testers, first external distribution requires beta review. IMMUTABLE post-create.',
          ),
        hasAccessToAllBuilds: z
          .boolean()
          .optional()
          .describe(
            'true: group auto-receives every new build for the app. false (default): builds must be explicitly assigned via asc_add_beta_group_builds. IMMUTABLE post-create.',
          ),
        publicLinkEnabled: z
          .boolean()
          .optional()
          .describe(
            'EXTERNAL groups only. true: Apple generates a redeemable public URL. publicLink + publicLinkId appear on the resource after creation.',
          ),
        publicLinkLimitEnabled: z
          .boolean()
          .optional()
          .describe(
            'EXTERNAL groups only. true: cap redemptions via publicLinkLimit. Requires publicLinkLimit to be set in the same call.',
          ),
        publicLinkLimit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'EXTERNAL groups only. Maximum number of public-link redemptions. After this many testers redeem, Apple disables the link.',
          ),
        feedbackEnabled: z
          .boolean()
          .optional()
          .describe(
            'true (default Apple behavior): testers can submit feedback via TestFlight. false: feedback button hidden for this group.',
          ),
        initialTesterIds: z
          .array(BetaTesterIdSchema)
          .optional()
          .describe(
            "Optional: pre-seed the group with these tester IDs in the same atomic POST. Existing BetaTester records only — use asc_post_beta_tester to invite first if they don't exist yet.",
          ),
        initialBuildIds: z
          .array(BuildIdSchema)
          .optional()
          .describe(
            'Optional: pre-seed the group with these build IDs (assign them to the group at creation). All builds must be in VALID processingState; Apple rejects FAILED/INVALID builds.',
          ),
      },
    },
    async (input) => {
      const refusal = publicLinkSanityCheck({
        ...(input.publicLinkEnabled !== undefined
          ? { publicLinkEnabled: input.publicLinkEnabled }
          : {}),
        ...(input.publicLinkLimitEnabled !== undefined
          ? { publicLinkLimitEnabled: input.publicLinkLimitEnabled }
          : {}),
        ...(input.publicLinkLimit !== undefined ? { publicLinkLimit: input.publicLinkLimit } : {}),
        ...(input.isInternalGroup !== undefined ? { isInternalGroup: input.isInternalGroup } : {}),
      });
      if (refusal) {
        return { content: [{ type: 'text', text: refusal }], isError: true };
      }
      const body = buildBetaGroupCreateBody({
        appId: input.appId,
        name: input.name,
        ...(input.isInternalGroup !== undefined ? { isInternalGroup: input.isInternalGroup } : {}),
        ...(input.hasAccessToAllBuilds !== undefined
          ? { hasAccessToAllBuilds: input.hasAccessToAllBuilds }
          : {}),
        ...(input.publicLinkEnabled !== undefined
          ? { publicLinkEnabled: input.publicLinkEnabled }
          : {}),
        ...(input.publicLinkLimitEnabled !== undefined
          ? { publicLinkLimitEnabled: input.publicLinkLimitEnabled }
          : {}),
        ...(input.publicLinkLimit !== undefined ? { publicLinkLimit: input.publicLinkLimit } : {}),
        ...(input.feedbackEnabled !== undefined ? { feedbackEnabled: input.feedbackEnabled } : {}),
        ...(input.initialTesterIds && input.initialTesterIds.length > 0
          ? { initialTesterIds: input.initialTesterIds }
          : {}),
        ...(input.initialBuildIds && input.initialBuildIds.length > 0
          ? { initialBuildIds: input.initialBuildIds }
          : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/betaGroups', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created beta group "${input.name}" on app ${input.appId}.\n\n${JSON.stringify(
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

  server.registerTool(
    'asc_patch_beta_group',
    {
      title: 'Patch a beta group',
      description:
        "Mutate a beta group's attributes. Apple PATCH on this resource accepts name, public-link state (publicLinkEnabled/publicLinkLimitEnabled/publicLinkLimit), feedbackEnabled, and the Apple Silicon Mac / Apple Vision build-availability flags. " +
        'isInternalGroup and hasAccessToAllBuilds are IMMUTABLE — Apple rejects them in PATCH bodies. Tester and build membership is managed via the dedicated linkage tools (asc_add_beta_group_testers, asc_add_beta_group_builds, etc.) — not through this PATCH.',
      inputSchema: {
        betaGroupId: BetaGroupIdSchema,
        name: BetaGroupNameSchema.optional(),
        publicLinkEnabled: z.boolean().optional(),
        publicLinkLimitEnabled: z.boolean().optional(),
        publicLinkLimit: z.number().int().positive().optional(),
        feedbackEnabled: z.boolean().optional(),
        iosBuildsAvailableForAppleSiliconMac: z
          .boolean()
          .optional()
          .describe(
            'true: iOS builds in this group can be installed on Apple Silicon Macs (TestFlight for Mac). false: iOS-only on this group.',
          ),
        iosBuildsAvailableForAppleVision: z
          .boolean()
          .optional()
          .describe('true: iOS builds in this group can be installed on Apple Vision Pro.'),
      },
    },
    async (input) => {
      const refusal = publicLinkSanityCheck({
        ...(input.publicLinkEnabled !== undefined
          ? { publicLinkEnabled: input.publicLinkEnabled }
          : {}),
        ...(input.publicLinkLimitEnabled !== undefined
          ? { publicLinkLimitEnabled: input.publicLinkLimitEnabled }
          : {}),
        ...(input.publicLinkLimit !== undefined ? { publicLinkLimit: input.publicLinkLimit } : {}),
      });
      if (refusal) {
        return { content: [{ type: 'text', text: refusal }], isError: true };
      }
      // Tool-layer guard against an empty PATCH (Apple's API would return
      // the unchanged resource — wasted round-trip).
      const anyField = [
        input.name,
        input.publicLinkEnabled,
        input.publicLinkLimitEnabled,
        input.publicLinkLimit,
        input.feedbackEnabled,
        input.iosBuildsAvailableForAppleSiliconMac,
        input.iosBuildsAvailableForAppleVision,
      ].some((v) => v !== undefined);
      if (!anyField) {
        return {
          content: [
            {
              type: 'text',
              text: "Refused: pass at least one attribute to mutate. Apple's PATCH on /v1/betaGroups is no-op without an attributes payload.",
            },
          ],
          isError: true,
        };
      }
      const body = buildBetaGroupPatchBody({
        betaGroupId: input.betaGroupId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.publicLinkEnabled !== undefined
          ? { publicLinkEnabled: input.publicLinkEnabled }
          : {}),
        ...(input.publicLinkLimitEnabled !== undefined
          ? { publicLinkLimitEnabled: input.publicLinkLimitEnabled }
          : {}),
        ...(input.publicLinkLimit !== undefined ? { publicLinkLimit: input.publicLinkLimit } : {}),
        ...(input.feedbackEnabled !== undefined ? { feedbackEnabled: input.feedbackEnabled } : {}),
        ...(input.iosBuildsAvailableForAppleSiliconMac !== undefined
          ? { iosBuildsAvailableForAppleSiliconMac: input.iosBuildsAvailableForAppleSiliconMac }
          : {}),
        ...(input.iosBuildsAvailableForAppleVision !== undefined
          ? { iosBuildsAvailableForAppleVision: input.iosBuildsAvailableForAppleVision }
          : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/betaGroups/${encodeURIComponent(input.betaGroupId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched beta group ${input.betaGroupId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_beta_group',
    {
      title: 'Delete a beta group',
      description:
        'DELETE a beta group. Apple supports DELETE on this resource (unlike offer codes). All tester + build linkages are removed atomically. Testers themselves are NOT deleted — they remain as BetaTester records, just unassigned from this group. Builds are NOT affected.',
      inputSchema: {
        betaGroupId: BetaGroupIdSchema,
      },
    },
    async ({ betaGroupId }) => {
      try {
        await client.request<unknown>(`/v1/betaGroups/${encodeURIComponent(betaGroupId)}`, {
          method: 'DELETE',
        });
        return {
          content: [
            {
              type: 'text',
              text: `Deleted beta group ${betaGroupId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Tester linkage -----

  server.registerTool(
    'asc_add_beta_group_testers',
    {
      title: 'Add beta testers to a group',
      description:
        'Add existing BetaTester records to a beta group via POST /v1/betaGroups/{id}/relationships/betaTesters. Pass tester IDs (NOT emails — use asc_post_beta_tester to look up or create from an email). Idempotent on the wire (re-adding a member is a no-op). Apple does not push a fresh invite email on re-add.',
      inputSchema: {
        betaGroupId: BetaGroupIdSchema,
        testerIds: z
          .array(BetaTesterIdSchema)
          .min(1)
          .describe('At least one tester ID. Each must already exist as a BetaTester record.'),
      },
    },
    async ({ betaGroupId, testerIds }) => {
      const body = buildRelationshipLinkageBody({
        betaGroupId,
        ids: testerIds,
        resourceType: 'betaTesters',
      });
      try {
        await client.request<unknown>(
          `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/betaTesters`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Added ${testerIds.length} tester${testerIds.length === 1 ? '' : 's'} to beta group ${betaGroupId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_remove_beta_group_testers',
    {
      title: 'Remove beta testers from a group',
      description:
        'Remove testers from a beta group via DELETE /v1/betaGroups/{id}/relationships/betaTesters. Pass only the IDs you want removed — Apple uses the body, not a "clear all" semantic. The BetaTester records themselves are NOT deleted (use asc_delete_beta_tester for that). Removed testers immediately lose access to the group\'s builds in TestFlight.',
      inputSchema: {
        betaGroupId: BetaGroupIdSchema,
        testerIds: z.array(BetaTesterIdSchema).min(1),
      },
    },
    async ({ betaGroupId, testerIds }) => {
      const body = buildRelationshipLinkageBody({
        betaGroupId,
        ids: testerIds,
        resourceType: 'betaTesters',
      });
      try {
        await client.request<unknown>(
          `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/betaTesters`,
          { method: 'DELETE', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Removed ${testerIds.length} tester${testerIds.length === 1 ? '' : 's'} from beta group ${betaGroupId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Build linkage -----

  server.registerTool(
    'asc_add_beta_group_builds',
    {
      title: 'Assign builds to a beta group',
      description:
        'Assign builds to a beta group via POST /v1/betaGroups/{id}/relationships/builds. Builds must be in VALID processingState; Apple rejects PROCESSING/FAILED/INVALID. For external groups, the first build to be distributed externally must clear beta review (handled by the beta-review sub-domain). Use asc_patch_build_beta_detail to control autoNotifyEnabled per build.',
      inputSchema: {
        betaGroupId: BetaGroupIdSchema,
        buildIds: z
          .array(BuildIdSchema)
          .min(1)
          .describe('At least one build ID, all in VALID processingState.'),
      },
    },
    async ({ betaGroupId, buildIds }) => {
      const body = buildRelationshipLinkageBody({
        betaGroupId,
        ids: buildIds,
        resourceType: 'builds',
      });
      try {
        await client.request<unknown>(
          `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/builds`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Assigned ${buildIds.length} build${buildIds.length === 1 ? '' : 's'} to beta group ${betaGroupId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_remove_beta_group_builds',
    {
      title: 'Unassign builds from a beta group',
      description:
        'Unassign builds from a beta group via DELETE /v1/betaGroups/{id}/relationships/builds. The build itself is not deleted; only the group→build linkage is removed. Testers in the group lose visibility of these builds in TestFlight.',
      inputSchema: {
        betaGroupId: BetaGroupIdSchema,
        buildIds: z.array(BuildIdSchema).min(1),
      },
    },
    async ({ betaGroupId, buildIds }) => {
      const body = buildRelationshipLinkageBody({
        betaGroupId,
        ids: buildIds,
        resourceType: 'builds',
      });
      try {
        await client.request<unknown>(
          `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/builds`,
          { method: 'DELETE', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Unassigned ${buildIds.length} build${buildIds.length === 1 ? '' : 's'} from beta group ${betaGroupId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
