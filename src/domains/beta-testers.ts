import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestBetaTesters } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  BetaGroupIdSchema,
  BetaTesterIdSchema,
  BuildIdSchema,
  TesterEmailSchema,
  TesterFirstNameSchema,
  TesterLastNameSchema,
} from '../schemas.js';

// Beta testers. One BetaTester record per (team, email) — the email is the
// uniqueness key. A single tester can be in many groups across many apps.
//
// Two creation flows:
//   1. asc_post_beta_tester (POST /v1/betaTesters) — creates the BetaTester
//      record. Can optionally pre-assign to groups + builds in the same
//      atomic POST. Apple does NOT send an invite email from this endpoint
//      on its own; it just creates the record.
//   2. asc_post_beta_tester_invitation (POST /v1/betaTesterInvitations) —
//      THIS sends the invite email. Required: app. The `betaTester` rel
//      slot is marked DEPRECATED in Apple's contract (Swift SDK warning) —
//      Apple has been transitioning to per-(tester, app) invitations rather
//      than per-tester. We still support both shapes.
//
// Bulk invite pattern: there's no "bulk testers" endpoint per se. To onboard
// many testers at once, the practical flow is:
//   - POST /v1/betaTesters for each (idempotent on email — Apple returns
//     409/422 on duplicate; tool surfaces verbatim) with the target group
//     pre-assigned in the create body
//   - POST /v1/betaTesterInvitations for each (tester, app) pair to send
//     the email
// Both surfaces are exposed by separate tools below; orchestration is the
// caller's responsibility (the MCP server doesn't batch).
//
// Delete: standard. DELETE /v1/betaTesters/{id} removes the record entirely
// from the team. Apple does NOT support "remove from app but keep on team" —
// for that, remove from each group with asc_remove_beta_group_testers
// instead.

const BETA_TESTER_FIELDS = 'firstName,lastName,email,inviteType,state';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface BetaTesterCreateInput {
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  // Optional pre-assignment of groups + builds in the same POST.
  initialBetaGroupIds?: string[] | undefined;
  initialBuildIds?: string[] | undefined;
}

export function buildBetaTesterCreateBody(input: BetaTesterCreateInput): JSONAPIBody {
  // Apple's BetaTesterCreateRequest: email required, firstName/lastName
  // optional (encodeIfPresent). Optional to-many rels: betaGroups, builds.
  const attributes: Record<string, unknown> = { email: input.email };
  if (input.firstName !== undefined) attributes.firstName = input.firstName;
  if (input.lastName !== undefined) attributes.lastName = input.lastName;
  const relationships: Record<string, unknown> = {};
  if (input.initialBetaGroupIds && input.initialBetaGroupIds.length > 0) {
    relationships.betaGroups = {
      data: input.initialBetaGroupIds.map((id) => ({ type: 'betaGroups', id })),
    };
  }
  if (input.initialBuildIds && input.initialBuildIds.length > 0) {
    relationships.builds = {
      data: input.initialBuildIds.map((id) => ({ type: 'builds', id })),
    };
  }
  return {
    data: {
      type: 'betaTesters',
      attributes,
      ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
    },
  };
}

export interface BetaTesterInvitationInput {
  appId: string;
  // Optional per Apple's deprecation note in the Swift SDK. When present,
  // targets a specific existing BetaTester (legacy shape). When absent,
  // Apple uses just (app) — the modern shape.
  betaTesterId?: string | undefined;
}

export function buildBetaTesterInvitationBody(input: BetaTesterInvitationInput): JSONAPIBody {
  // BetaTesterInvitationCreateRequest has NO attributes — only relationships.
  // The wire shape is { data: { type, relationships } } with no `attributes`
  // key at all. The body builder must therefore not emit an attributes block.
  const relationships: Record<string, unknown> = {
    app: { data: { type: 'apps', id: input.appId } },
  };
  if (input.betaTesterId !== undefined) {
    relationships.betaTester = { data: { type: 'betaTesters', id: input.betaTesterId } };
  }
  return {
    data: {
      type: 'betaTesterInvitations',
      relationships,
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

export function registerBetaTesters(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_beta_testers',
    {
      title: 'List beta testers',
      description:
        'List beta testers. Pass appId to scope to one app, betaGroupId to scope to one group, or omit both for team-wide. Each row shows email + firstName + lastName + invite state. Use the digest to find a tester ID before adding/removing from groups or removing from the team.',
      inputSchema: {
        appId: AppIdSchema.optional().describe(
          'When provided, list via /v1/apps/{id}/betaTesters (scoped to one app). Mutually exclusive with betaGroupId.',
        ),
        betaGroupId: BetaGroupIdSchema.optional().describe(
          'When provided, list via /v1/betaGroups/{id}/betaTesters (scoped to one group). Mutually exclusive with appId.',
        ),
        maxItems: z.number().int().positive().max(5000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, betaGroupId, maxItems, raw }) => {
      if (appId && betaGroupId) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at most one of appId / betaGroupId. They scope to different endpoints; pick one.',
            },
          ],
          isError: true,
        };
      }
      const params = new URLSearchParams();
      params.set('fields[betaTesters]', BETA_TESTER_FIELDS);
      params.set('limit', '200');
      const path = appId
        ? `/v1/apps/${encodeURIComponent(appId)}/betaTesters?${params.toString()}`
        : betaGroupId
          ? `/v1/betaGroups/${encodeURIComponent(betaGroupId)}/betaTesters?${params.toString()}`
          : `/v1/betaTesters?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBetaTesters(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_tester',
    {
      title: 'Get a beta tester',
      description:
        'Fetch a single beta tester with relationships expanded (apps + betaGroups + builds). Use to inspect which groups and apps a tester has been onboarded to before changing membership.',
      inputSchema: {
        betaTesterId: BetaTesterIdSchema,
      },
    },
    async ({ betaTesterId }) => {
      const path = `/v1/betaTesters/${encodeURIComponent(betaTesterId)}?include=apps,betaGroups,builds`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_beta_tester',
    {
      title: 'Create a beta tester record',
      description:
        'Create a BetaTester record from an email. Apple uses the email as the uniqueness key per team; a duplicate email surfaces as an API error verbatim. ' +
        'This endpoint creates the record but does NOT send an invite email — that requires a separate call to asc_post_beta_tester_invitation. ' +
        'Optional: pre-assign the tester to betaGroups and/or builds in the same atomic POST (the IDs you pass become to-many relationships at create time).',
      inputSchema: {
        email: TesterEmailSchema,
        firstName: TesterFirstNameSchema.optional(),
        lastName: TesterLastNameSchema.optional(),
        initialBetaGroupIds: z
          .array(BetaGroupIdSchema)
          .optional()
          .describe(
            'Optional: assign the new tester to these existing groups atomically. All groups must already exist; create them with asc_post_beta_group first.',
          ),
        initialBuildIds: z
          .array(BuildIdSchema)
          .optional()
          .describe(
            'Optional: grant the new tester direct access to these specific builds (in addition to whatever their group memberships grant). Builds must be VALID.',
          ),
      },
    },
    async (input) => {
      const body = buildBetaTesterCreateBody({
        email: input.email,
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.initialBetaGroupIds && input.initialBetaGroupIds.length > 0
          ? { initialBetaGroupIds: input.initialBetaGroupIds }
          : {}),
        ...(input.initialBuildIds && input.initialBuildIds.length > 0
          ? { initialBuildIds: input.initialBuildIds }
          : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/betaTesters', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created beta tester record for ${input.email}.\n\n${JSON.stringify(
                data,
                null,
                2,
              )}\n\nNote: this only creates the record. To send the invite email, follow up with asc_post_beta_tester_invitation.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_beta_tester',
    {
      title: 'Delete a beta tester',
      description:
        'DELETE a beta tester record from the team. All group memberships and build accesses for this tester are removed atomically. The tester loses access to every app + build they had. To remove a tester from only ONE group while keeping them on others, use asc_remove_beta_group_testers instead — DELETE on /v1/betaTesters/{id} is team-wide nuclear.',
      inputSchema: {
        betaTesterId: BetaTesterIdSchema,
      },
    },
    async ({ betaTesterId }) => {
      try {
        await client.request<unknown>(`/v1/betaTesters/${encodeURIComponent(betaTesterId)}`, {
          method: 'DELETE',
        });
        return {
          content: [
            {
              type: 'text',
              text: `Deleted beta tester ${betaTesterId} (removed from all groups + apps on this team).`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_beta_tester_invitation',
    {
      title: 'Send / resend a beta tester invitation email',
      description:
        'Send (or resend) the TestFlight invite email for a tester on a specific app. Required: appId. ' +
        "betaTesterId is OPTIONAL and Apple has marked it DEPRECATED in the contract — the modern flow targets just (app), and the tester is resolved by the email on the BetaTester record they're a member of. Pass betaTesterId only if you need the legacy per-tester invitation shape. " +
        "POST /v1/betaTesterInvitations. The body carries NO attributes — only relationships (app + optionally betaTester). Apple's email delivery is fire-and-forget; retry by re-calling this tool.",
      inputSchema: {
        appId: AppIdSchema,
        betaTesterId: BetaTesterIdSchema.optional().describe(
          'Optional / deprecated per Apple. Pass to target a specific BetaTester record; omit for the modern (app-only) flow.',
        ),
      },
    },
    async (input) => {
      const body = buildBetaTesterInvitationBody({
        appId: input.appId,
        ...(input.betaTesterId !== undefined ? { betaTesterId: input.betaTesterId } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/betaTesterInvitations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const target = input.betaTesterId
          ? `tester ${input.betaTesterId} on app ${input.appId}`
          : `app ${input.appId} (no specific tester — modern flow)`;
        return {
          content: [
            {
              type: 'text',
              text: `Sent beta tester invitation for ${target}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
