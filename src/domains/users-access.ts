import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestActors,
  digestUserInvitations,
  digestUsers,
  digestVisibleApps,
} from '../digest-users-access.js';
import { ASCError, ascErrorText } from '../errors.js';
import { type JSONAPIResource, paginate } from '../jsonapi.js';
import { AppIdSchema } from '../schemas.js';

// Users & Access — the team members of the App Store Connect account, their
// pending invitations, and actors (who did what, as returned by other
// resources' `actor` relationships).
//
// POLICY: reads are free, writes are gated. Every tool that changes the team
// (invite, cancel an invitation, change a user's roles / app visibility /
// provisioning, remove a user, add / replace / remove visible apps) REFUSES
// unless the caller passes `confirm: true`. The refusal is a dry run: it sends
// NOTHING to Apple, looks up the target, and says exactly what would change
// and for whom. A removed user or a changed role locks a real person out of
// the account, so the gate is never skipped implicitly — no default, no
// "force", no inference from other arguments.
//
// Apple rules baked into the tools:
//   * `roles` on PATCH /v1/users/{id} REPLACES the whole role list. Sending
//     [DEVELOPER] to an ADMIN demotes them; the refusal spells out lost and
//     gained roles.
//   * PATCH /v1/users/{id}/relationships/visibleApps REPLACES the set; POST
//     adds, DELETE removes only the ids in the body.
//   * visibleApps only matters while allAppsVisible is false — ADMIN,
//     FINANCE and ACCOUNT_HOLDER (and anyone with allAppsVisible) see every
//     app regardless.
//   * There is no PATCH on invitations: to change one, cancel (DELETE) and
//     re-invite. Accepted invitations become users and disappear from the list.
//   * Apple refuses to remove or modify the Account Holder via the API.

const USER_FIELDS =
  'username,firstName,lastName,roles,allAppsVisible,provisioningAllowed,visibleApps';
const INVITATION_FIELDS =
  'email,firstName,lastName,expirationDate,roles,allAppsVisible,provisioningAllowed,visibleApps';
const ACTOR_FIELDS = 'actorType,userFirstName,userLastName,userEmail,apiKeyId';
const APP_FIELDS = 'name,bundleId';

export const USER_ROLES = [
  'ADMIN',
  'FINANCE',
  'ACCOUNT_HOLDER',
  'SALES',
  'MARKETING',
  'APP_MANAGER',
  'DEVELOPER',
  'ACCESS_TO_REPORTS',
  'CUSTOMER_SUPPORT',
  'CREATE_APPS',
  'CLOUD_MANAGED_DEVELOPER_ID',
  'CLOUD_MANAGED_APP_DISTRIBUTION',
  'GENERATE_INDIVIDUAL_KEYS',
] as const;

const UserRoleSchema = z.enum(USER_ROLES);
type UserRole = z.infer<typeof UserRoleSchema>;

const UserIdSchema = z.string().min(1).describe('User resource id (from asc_list_users).');
const UserInvitationIdSchema = z
  .string()
  .min(1)
  .describe('User invitation id (from asc_list_user_invitations).');
const ActorIdSchema = z.string().min(1).describe('Actor id (from an `actor` relationship).');

const ConfirmSchema = z
  .boolean()
  .default(false)
  .describe(
    'TEAM-CHANGE GATE. Must be exactly true to send this write. Without it the tool sends NOTHING to Apple and returns what would change and for whom. Pass true only after the account owner approved that exact change — it can lock a real person out of the account.',
  );

const maxItemsSchema = z.number().int().positive().max(2000).default(500);

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

interface LinkageBody {
  data: Array<{ type: 'apps'; id: string }>;
}

// ----- Body builders -----

export interface UserPatchInput {
  userId: string;
  roles?: UserRole[] | undefined;
  allAppsVisible?: boolean | undefined;
  provisioningAllowed?: boolean | undefined;
  visibleAppIds?: string[] | undefined;
}

export function buildUserPatchBody(input: UserPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.roles !== undefined) attributes.roles = input.roles;
  if (input.allAppsVisible !== undefined) attributes.allAppsVisible = input.allAppsVisible;
  if (input.provisioningAllowed !== undefined)
    attributes.provisioningAllowed = input.provisioningAllowed;
  const body: JSONAPIBody = { data: { type: 'users', id: input.userId } };
  if (Object.keys(attributes).length > 0) body.data.attributes = attributes;
  if (input.visibleAppIds !== undefined) {
    body.data.relationships = {
      visibleApps: { data: input.visibleAppIds.map((id) => ({ type: 'apps', id })) },
    };
  }
  return body;
}

export interface UserInvitationCreateInput {
  email: string;
  firstName: string;
  lastName: string;
  roles: UserRole[];
  allAppsVisible?: boolean | undefined;
  provisioningAllowed?: boolean | undefined;
  visibleAppIds?: string[] | undefined;
}

export function buildUserInvitationCreateBody(input: UserInvitationCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    roles: input.roles,
  };
  if (input.allAppsVisible !== undefined) attributes.allAppsVisible = input.allAppsVisible;
  if (input.provisioningAllowed !== undefined)
    attributes.provisioningAllowed = input.provisioningAllowed;
  const body: JSONAPIBody = { data: { type: 'userInvitations', attributes } };
  if (input.visibleAppIds !== undefined) {
    body.data.relationships = {
      visibleApps: { data: input.visibleAppIds.map((id) => ({ type: 'apps', id })) },
    };
  }
  return body;
}

export function buildVisibleAppsLinkageBody(appIds: string[]): LinkageBody {
  return { data: appIds.map((id) => ({ type: 'apps', id })) };
}

// ----- The team-change gate -----

/** What the refusal knows about the person a write targets. */
export interface TeamMemberSnapshot {
  id: string;
  kind: 'user' | 'invitation';
  name?: string | undefined;
  login?: string | undefined;
  roles?: string[] | undefined;
  allAppsVisible?: boolean | undefined;
  provisioningAllowed?: boolean | undefined;
  visibleApps?: Array<{ id: string; name?: string | undefined }> | undefined;
}

export interface TeamChange {
  /** Imperative headline, e.g. "REMOVE this user from the team". */
  action: string;
  target?: TeamMemberSnapshot | undefined;
  /** Fallback when the target could not be looked up. */
  targetId?: string | undefined;
  changes: string[];
  warnings?: string[] | undefined;
  /** Set when the pre-check lookup failed; the refusal still stands. */
  lookupError?: string | undefined;
}

export function describeTarget(change: TeamChange): string {
  const t = change.target;
  if (!t) return `${change.targetId ?? '(unknown)'} (could not be looked up)`;
  const who = [t.name, t.login ? `<${t.login}>` : undefined].filter(Boolean).join(' ');
  const label = t.kind === 'user' ? 'user id' : 'invitation id';
  const current =
    t.roles !== undefined
      ? `\n  current roles: ${t.roles.join(', ') || '(none)'}${t.allAppsVisible ? ' · sees ALL apps' : ''}`
      : '';
  return `${who || '(no name)'} — ${label} ${t.id}${current}`;
}

/**
 * The refusal text. It must make three things unmissable: nothing was sent,
 * exactly what would change for whom, and the one way to proceed.
 */
export function teamChangeRefusal(change: TeamChange): string {
  const lines = [
    'REFUSED — NOTHING WAS SENT TO APPLE. This call changes who can access the App Store Connect team, so it needs confirm: true.',
    '',
    `Would ${change.action}`,
    `For: ${describeTarget(change)}`,
    '',
    'Exact change:',
    ...change.changes.map((c) => `  - ${c}`),
  ];
  if (change.warnings && change.warnings.length > 0) {
    lines.push('', ...change.warnings.map((w) => `⚠️ ${w}`));
  }
  if (change.lookupError) {
    lines.push('', `Note: the target lookup failed (${change.lookupError}).`);
  }
  lines.push(
    '',
    'A removed user or a changed role can lock a real person out of the account. Show this to the account owner; only if they approve exactly this change, re-run the same call with confirm: true.',
  );
  return lines.join('\n');
}

function appLabel(id: string, known: TeamMemberSnapshot['visibleApps']): string {
  const name = known?.find((a) => a.id === id)?.name;
  return name ? `${name} (${id})` : id;
}

export function describeRolesChange(
  current: string[] | undefined,
  next: string[],
): { changes: string[]; warnings: string[] } {
  const changes = [`roles REPLACED with: ${next.join(', ') || '(none)'}`];
  const warnings: string[] = [];
  if (current !== undefined) {
    const lost = current.filter((r) => !next.includes(r));
    const gained = next.filter((r) => !current.includes(r));
    changes.push(`  was: ${current.join(', ') || '(none)'}`);
    if (lost.length > 0) changes.push(`  LOSES: ${lost.join(', ')}`);
    if (gained.length > 0) changes.push(`  GAINS: ${gained.join(', ')}`);
    if (lost.length === 0 && gained.length === 0) changes.push('  (no role difference)');
    if (lost.includes('ADMIN'))
      warnings.push('This removes ADMIN — they lose Users & Access, agreements and API keys.');
  } else {
    warnings.push(
      'Current roles unknown — roles is a full replacement, anything not listed is removed.',
    );
  }
  if (next.includes('ADMIN') && !(current ?? []).includes('ADMIN')) {
    warnings.push('This grants ADMIN — full control of the team, including removing other users.');
  }
  return { changes, warnings };
}

export function describeUserPatch(
  current: TeamMemberSnapshot | undefined,
  input: Omit<UserPatchInput, 'userId'>,
): { changes: string[]; warnings: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (input.roles !== undefined) {
    const r = describeRolesChange(current?.roles, input.roles);
    changes.push(...r.changes);
    warnings.push(...r.warnings);
  }
  if (input.allAppsVisible !== undefined) {
    changes.push(
      `allAppsVisible: ${current?.allAppsVisible === undefined ? '?' : String(current.allAppsVisible)} → ${String(input.allAppsVisible)}`,
    );
    if (input.allAppsVisible === false && input.visibleAppIds === undefined) {
      warnings.push(
        'allAppsVisible → false without visibleAppIds: they keep only the apps already in their visible list (possibly none).',
      );
    }
  }
  if (input.provisioningAllowed !== undefined) {
    changes.push(
      `provisioningAllowed (certificates / profiles access): ${current?.provisioningAllowed === undefined ? '?' : String(current.provisioningAllowed)} → ${String(input.provisioningAllowed)}`,
    );
  }
  if (input.visibleAppIds !== undefined) {
    changes.push(...describeVisibleAppsChange('replace', current, input.visibleAppIds).changes);
  }
  return { changes, warnings };
}

export type VisibleAppsMode = 'add' | 'replace' | 'remove';

export function describeVisibleAppsChange(
  mode: VisibleAppsMode,
  current: TeamMemberSnapshot | undefined,
  appIds: string[],
): { changes: string[]; warnings: string[] } {
  const known = current?.visibleApps;
  const list = (ids: string[]) =>
    ids.length === 0 ? '(none)' : ids.map((id) => appLabel(id, known)).join(', ');
  const changes: string[] = [];
  const warnings: string[] = [];
  if (mode === 'add') changes.push(`visible apps ADDED: ${list(appIds)}`);
  if (mode === 'remove') changes.push(`visible apps REMOVED: ${list(appIds)}`);
  if (mode === 'replace') {
    changes.push(`visible apps REPLACED with: ${list(appIds)}`);
    if (known !== undefined) {
      const lost = known.filter((a) => !appIds.includes(a.id)).map((a) => a.id);
      if (lost.length > 0) changes.push(`  LOSES access to: ${list(lost)}`);
    }
    if (appIds.length === 0) warnings.push('An empty list removes access to every app.');
  }
  if (current?.allAppsVisible) {
    warnings.push(
      'This person currently sees ALL apps (allAppsVisible or an all-app role), so the visible-apps list has no effect until allAppsVisible is false.',
    );
  }
  return { changes, warnings };
}

// ----- Pre-check lookups -----

function str(r: JSONAPIResource, key: string): string | undefined {
  const v = r.attributes?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function snapshotFromResource(
  r: JSONAPIResource,
  kind: TeamMemberSnapshot['kind'],
  apps?: JSONAPIResource[],
): TeamMemberSnapshot {
  const name = [str(r, 'firstName'), str(r, 'lastName')].filter(Boolean).join(' ');
  const rolesAttr = r.attributes?.roles;
  const allApps = r.attributes?.allAppsVisible;
  const prov = r.attributes?.provisioningAllowed;
  return {
    id: r.id,
    kind,
    name: name || undefined,
    login: kind === 'user' ? str(r, 'username') : str(r, 'email'),
    roles: Array.isArray(rolesAttr) ? (rolesAttr as string[]) : undefined,
    allAppsVisible: typeof allApps === 'boolean' ? allApps : undefined,
    provisioningAllowed: typeof prov === 'boolean' ? prov : undefined,
    visibleApps: apps?.map((a) => ({ id: a.id, name: str(a, 'name') })),
  };
}

async function lookupUser(
  client: ASCClient,
  userId: string,
  withApps: boolean,
): Promise<{ target?: TeamMemberSnapshot; lookupError?: string }> {
  try {
    const res = await client.request<{ data: JSONAPIResource }>(
      `/v1/users/${encodeURIComponent(userId)}?fields[users]=${USER_FIELDS}`,
    );
    let apps: JSONAPIResource[] | undefined;
    if (withApps) {
      const pages = await paginate(
        client,
        `/v1/users/${encodeURIComponent(userId)}/visibleApps?fields[apps]=${APP_FIELDS}&limit=200`,
        2000,
      );
      apps = pages.data;
    }
    return { target: snapshotFromResource(res.data, 'user', apps) };
  } catch (err) {
    return { lookupError: ascErrorText(err) };
  }
}

async function lookupInvitation(
  client: ASCClient,
  invitationId: string,
): Promise<{ target?: TeamMemberSnapshot; lookupError?: string }> {
  try {
    const res = await client.request<{ data: JSONAPIResource }>(
      `/v1/userInvitations/${encodeURIComponent(invitationId)}?fields[userInvitations]=${INVITATION_FIELDS}`,
    );
    return { target: snapshotFromResource(res.data, 'invitation') };
  } catch (err) {
    return { lookupError: ascErrorText(err) };
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

function explainUsers403(err: unknown): string | undefined {
  if (!(err instanceof ASCError) || err.status !== 403) return undefined;
  return `403 FORBIDDEN — Users & Access needs an API key with the ADMIN role. Generate one in App Store Connect → Users and Access → Integrations, or make this change in the Users and Access UI.\n\n${formatASCError(err)}`;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function fail(err: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: explainUsers403(err) ?? formatASCError(err) }],
    isError: true,
  };
}

function refuse(change: TeamChange): ToolResult {
  return { content: [{ type: 'text', text: teamChangeRefusal(change) }], isError: true };
}

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function hasAccountHolder(t: TeamMemberSnapshot | undefined): boolean {
  return t?.roles?.includes('ACCOUNT_HOLDER') ?? false;
}

const ACCOUNT_HOLDER_WARNING =
  'This person is the ACCOUNT HOLDER. Apple refuses to modify or remove the Account Holder through the API; ownership moves only in the Apple Developer account UI.';

export function registerUsersAccess(server: McpServer, client: ASCClient): void {
  // ----- Users: reads -----

  server.registerTool(
    'asc_list_users',
    {
      title: 'List team users',
      description:
        "List the App Store Connect team's users with roles, app visibility (ALL or the visible app ids) and provisioning access. Filter by username (exact email), roles, or an app id the user can see. Read-only. Requires an Admin-role API key.",
      inputSchema: z.object({
        username: z.string().optional().describe('Exact username (the Apple ID email).'),
        roles: z.array(UserRoleSchema).optional().describe('Users holding ANY of these roles.'),
        visibleAppId: AppIdSchema.optional().describe('Users who can see this app.'),
        sort: z.enum(['username', '-username', 'lastName', '-lastName']).optional(),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ username, roles, visibleAppId, sort, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[users]', USER_FIELDS);
      params.set('include', 'visibleApps');
      params.set('limit[visibleApps]', '50');
      params.set('limit', '200');
      if (username) params.set('filter[username]', username);
      if (roles && roles.length > 0) params.set('filter[roles]', roles.join(','));
      if (visibleAppId) params.set('filter[visibleApps]', visibleAppId);
      if (sort) params.set('sort', sort);
      try {
        const pages = await paginate(client, `/v1/users?${params.toString()}`, maxItems);
        return {
          content: [
            { type: 'text', text: raw ? JSON.stringify(pages, null, 2) : digestUsers(pages) },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_user',
    {
      title: 'Get a team user',
      description:
        'Fetch one user with roles, allAppsVisible, provisioningAllowed and the visible-app ids. Read-only.',
      inputSchema: z.object({ userId: UserIdSchema }),
    },
    async ({ userId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/users/${encodeURIComponent(userId)}?fields[users]=${USER_FIELDS}&include=visibleApps&fields[apps]=${APP_FIELDS}&limit[visibleApps]=50`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_list_user_visible_apps',
    {
      title: 'List the apps a user can see',
      description:
        "List the apps in a user's visible-apps list. Meaningless while the user has allAppsVisible (or an all-app role like ADMIN) — they see every app then. Read-only.",
      inputSchema: z.object({
        userId: UserIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ userId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/users/${encodeURIComponent(userId)}/visibleApps?fields[apps]=${APP_FIELDS}&limit=200`,
          maxItems,
        );
        return {
          content: [
            { type: 'text', text: raw ? JSON.stringify(pages, null, 2) : digestVisibleApps(pages) },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- Users: gated writes -----

  server.registerTool(
    'asc_patch_user',
    {
      title: "Change a user's roles or app access (confirm-gated)",
      description:
        "🔒 TEAM-CHANGE GATE: refuses and sends nothing unless confirm: true; the refusal shows exactly what would change for whom. Change a user's roles, allAppsVisible, provisioningAllowed and/or visible apps. `roles` REPLACES the whole role list (anything not listed is removed); `visibleAppIds` REPLACES the visible set. Pass at least one field. Changing a role can lock a real person out of the account.",
      inputSchema: z.object({
        userId: UserIdSchema,
        roles: z
          .array(UserRoleSchema)
          .min(1)
          .optional()
          .describe('FULL new role list — replaces the current one.'),
        allAppsVisible: z.boolean().optional(),
        provisioningAllowed: z
          .boolean()
          .optional()
          .describe('Access to certificates, identifiers and profiles (Developer role).'),
        visibleAppIds: z
          .array(AppIdSchema)
          .optional()
          .describe('FULL new visible-app list — replaces the current one.'),
        confirm: ConfirmSchema,
      }),
    },
    async ({ userId, roles, allAppsVisible, provisioningAllowed, visibleAppIds, confirm }) => {
      if (
        roles === undefined &&
        allAppsVisible === undefined &&
        provisioningAllowed === undefined &&
        visibleAppIds === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of roles, allAppsVisible, provisioningAllowed, visibleAppIds.',
            },
          ],
          isError: true,
        };
      }
      const patch = { roles, allAppsVisible, provisioningAllowed, visibleAppIds };
      if (confirm !== true) {
        const { target, lookupError } = await lookupUser(
          client,
          userId,
          visibleAppIds !== undefined,
        );
        const { changes, warnings } = describeUserPatch(target, patch);
        if (hasAccountHolder(target)) warnings.unshift(ACCOUNT_HOLDER_WARNING);
        return refuse({
          action: "CHANGE this user's access.",
          target,
          targetId: userId,
          changes,
          warnings,
          lookupError,
        });
      }
      try {
        const data = await client.request<unknown>(`/v1/users/${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          body: JSON.stringify(buildUserPatchBody({ userId, ...patch })),
        });
        return json(data);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_user',
    {
      title: 'Remove a user from the team (confirm-gated)',
      description:
        '🔒 TEAM-CHANGE GATE: refuses and sends nothing unless confirm: true; the refusal names the person and their current roles. Removes the user from the App Store Connect team — they lose all access immediately. Re-adding means a new invitation. Apple refuses to remove the Account Holder.',
      inputSchema: z.object({ userId: UserIdSchema, confirm: ConfirmSchema }),
    },
    async ({ userId, confirm }) => {
      if (confirm !== true) {
        const { target, lookupError } = await lookupUser(client, userId, false);
        const warnings = hasAccountHolder(target) ? [ACCOUNT_HOLDER_WARNING] : [];
        return refuse({
          action: 'REMOVE this user from the team.',
          target,
          targetId: userId,
          changes: [
            'the user is deleted from the team and loses ALL App Store Connect access immediately',
            'undo = send a new invitation (asc_post_user_invitation), which they must accept',
          ],
          warnings,
          lookupError,
        });
      }
      try {
        await client.request<void>(`/v1/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        return { content: [{ type: 'text', text: `Removed user ${userId} from the team.` }] };
      } catch (err) {
        return fail(err);
      }
    },
  );

  const visibleAppsTool = (
    name: string,
    title: string,
    mode: VisibleAppsMode,
    method: 'POST' | 'PATCH' | 'DELETE',
    summary: string,
  ) =>
    server.registerTool(
      name,
      {
        title,
        description: `🔒 TEAM-CHANGE GATE: refuses and sends nothing unless confirm: true; the refusal lists the apps by name and what the user loses. ${summary} Has no effect while the user has allAppsVisible (or an all-app role like ADMIN).`,
        inputSchema: z.object({
          userId: UserIdSchema,
          appIds: z.array(AppIdSchema).min(mode === 'replace' ? 0 : 1),
          confirm: ConfirmSchema,
        }),
      },
      async ({ userId, appIds, confirm }) => {
        if (confirm !== true) {
          const { target, lookupError } = await lookupUser(client, userId, true);
          const { changes, warnings } = describeVisibleAppsChange(mode, target, appIds);
          if (hasAccountHolder(target)) warnings.unshift(ACCOUNT_HOLDER_WARNING);
          return refuse({
            action: `CHANGE which apps this user can see (${mode}).`,
            target,
            targetId: userId,
            changes,
            warnings,
            lookupError,
          });
        }
        try {
          await client.request<void>(
            `/v1/users/${encodeURIComponent(userId)}/relationships/visibleApps`,
            { method, body: JSON.stringify(buildVisibleAppsLinkageBody(appIds)) },
          );
          return {
            content: [
              {
                type: 'text',
                text: `Visible apps of user ${userId}: ${mode} ${appIds.length} app(s) done.`,
              },
            ],
          };
        } catch (err) {
          return fail(err);
        }
      },
    );

  visibleAppsTool(
    'asc_add_user_visible_apps',
    'Give a user access to apps (confirm-gated)',
    'add',
    'POST',
    "Adds apps to the user's visible-apps list; existing ones stay.",
  );
  visibleAppsTool(
    'asc_set_user_visible_apps',
    "Replace a user's visible apps (confirm-gated)",
    'replace',
    'PATCH',
    "REPLACES the user's visible-apps list with exactly appIds — every app not listed is removed. An empty list removes all.",
  );
  visibleAppsTool(
    'asc_remove_user_visible_apps',
    "Remove a user's access to apps (confirm-gated)",
    'remove',
    'DELETE',
    "Removes only the listed apps from the user's visible-apps list.",
  );

  // ----- Invitations -----

  server.registerTool(
    'asc_list_user_invitations',
    {
      title: 'List pending user invitations',
      description:
        'List invitations that have not been accepted yet (accepted ones become users). Filter by email, roles or a visible app id. Read-only.',
      inputSchema: z.object({
        email: z.string().optional(),
        roles: z.array(UserRoleSchema).optional(),
        visibleAppId: AppIdSchema.optional(),
        sort: z.enum(['email', '-email', 'lastName', '-lastName']).optional(),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ email, roles, visibleAppId, sort, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[userInvitations]', INVITATION_FIELDS);
      params.set('include', 'visibleApps');
      params.set('limit[visibleApps]', '50');
      params.set('limit', '200');
      if (email) params.set('filter[email]', email);
      if (roles && roles.length > 0) params.set('filter[roles]', roles.join(','));
      if (visibleAppId) params.set('filter[visibleApps]', visibleAppId);
      if (sort) params.set('sort', sort);
      try {
        const pages = await paginate(client, `/v1/userInvitations?${params.toString()}`, maxItems);
        return {
          content: [
            {
              type: 'text',
              text: raw ? JSON.stringify(pages, null, 2) : digestUserInvitations(pages),
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_user_invitation',
    {
      title: 'Get a user invitation',
      description:
        'Fetch one pending invitation with roles, expiry and visible-app ids. Read-only.',
      inputSchema: z.object({ invitationId: UserInvitationIdSchema }),
    },
    async ({ invitationId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/userInvitations/${encodeURIComponent(invitationId)}?fields[userInvitations]=${INVITATION_FIELDS}&include=visibleApps&fields[apps]=${APP_FIELDS}&limit[visibleApps]=50`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_list_user_invitation_visible_apps',
    {
      title: 'List the apps an invitation grants',
      description: 'List the apps a pending invitation will make visible. Read-only.',
      inputSchema: z.object({
        invitationId: UserInvitationIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ invitationId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/userInvitations/${encodeURIComponent(invitationId)}/visibleApps?fields[apps]=${APP_FIELDS}&limit=200`,
          maxItems,
        );
        return {
          content: [
            { type: 'text', text: raw ? JSON.stringify(pages, null, 2) : digestVisibleApps(pages) },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_post_user_invitation',
    {
      title: 'Invite a person to the team (confirm-gated)',
      description:
        "🔒 TEAM-CHANGE GATE: refuses and sends nothing unless confirm: true; the refusal shows who would be invited with which roles and apps. Sends an App Store Connect invitation email. Without allAppsVisible: true (or an all-app role like ADMIN / FINANCE), pass visibleAppIds — otherwise the person sees no apps. Invitations can't be edited: cancel and re-invite.",
      inputSchema: z.object({
        email: z.string().email(),
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        roles: z.array(UserRoleSchema).min(1),
        allAppsVisible: z.boolean().optional(),
        provisioningAllowed: z.boolean().optional(),
        visibleAppIds: z.array(AppIdSchema).optional(),
        confirm: ConfirmSchema,
      }),
    },
    async (input) => {
      const { confirm, ...invite } = input;
      if (confirm !== true) {
        const warnings: string[] = [];
        if (invite.roles.includes('ADMIN')) {
          warnings.push(
            'This grants ADMIN — full control of the team, including removing other users.',
          );
        }
        if (
          invite.allAppsVisible !== true &&
          !invite.roles.some((r) => ['ADMIN', 'FINANCE', 'ACCOUNT_HOLDER'].includes(r)) &&
          (invite.visibleAppIds ?? []).length === 0
        ) {
          warnings.push(
            'No visible apps and allAppsVisible is not true — the person would see no apps.',
          );
        }
        return refuse({
          action: 'INVITE a new person to the team (an email goes out immediately).',
          target: {
            id: '(new)',
            kind: 'invitation',
            name: `${invite.firstName} ${invite.lastName}`,
            login: invite.email,
          },
          changes: [
            `roles: ${invite.roles.join(', ')}`,
            `allAppsVisible: ${String(invite.allAppsVisible ?? false)}`,
            ...(invite.visibleAppIds !== undefined
              ? [`visible apps: ${invite.visibleAppIds.join(', ') || '(none)'}`]
              : []),
            ...(invite.provisioningAllowed !== undefined
              ? [`provisioningAllowed: ${String(invite.provisioningAllowed)}`]
              : []),
          ],
          warnings,
        });
      }
      try {
        const data = await client.request<unknown>('/v1/userInvitations', {
          method: 'POST',
          body: JSON.stringify(buildUserInvitationCreateBody(invite)),
        });
        return json(data);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_user_invitation',
    {
      title: 'Cancel a pending invitation (confirm-gated)',
      description:
        '🔒 TEAM-CHANGE GATE: refuses and sends nothing unless confirm: true; the refusal names the invitee. Cancels a pending invitation — the emailed link stops working. Already-accepted invitations are users; remove those with asc_delete_user.',
      inputSchema: z.object({ invitationId: UserInvitationIdSchema, confirm: ConfirmSchema }),
    },
    async ({ invitationId, confirm }) => {
      if (confirm !== true) {
        const { target, lookupError } = await lookupInvitation(client, invitationId);
        return refuse({
          action: 'CANCEL this pending invitation.',
          target,
          targetId: invitationId,
          changes: [
            'the invitation is deleted; the emailed link stops working',
            'undo = invite again',
          ],
          lookupError,
        });
      }
      try {
        await client.request<void>(`/v1/userInvitations/${encodeURIComponent(invitationId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Cancelled invitation ${invitationId}.` }] };
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- Actors -----

  server.registerTool(
    'asc_list_actors',
    {
      title: 'List actors',
      description:
        "Resolve actors — the 'who' behind changes (a USER, an API_KEY, XCODE_CLOUD or APPLE). Apple requires filter[id]: pass the actor ids you got from another resource's actor relationship. Read-only.",
      inputSchema: z.object({
        actorIds: z
          .array(ActorIdSchema)
          .min(1)
          .describe('Actor ids to resolve (filter[id] is required by Apple).'),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ actorIds, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[actors]', ACTOR_FIELDS);
      params.set('filter[id]', actorIds.join(','));
      params.set('limit', '200');
      try {
        const pages = await paginate(client, `/v1/actors?${params.toString()}`, maxItems);
        return {
          content: [
            { type: 'text', text: raw ? JSON.stringify(pages, null, 2) : digestActors(pages) },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_actor',
    {
      title: 'Get an actor',
      description: 'Fetch one actor (type, user name/email or API key id). Read-only.',
      inputSchema: z.object({ actorId: ActorIdSchema }),
    },
    async ({ actorId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/actors/${encodeURIComponent(actorId)}?fields[actors]=${ACTOR_FIELDS}`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
