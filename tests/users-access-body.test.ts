import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ASCClient } from '../src/client.js';
import {
  buildUserInvitationCreateBody,
  buildUserPatchBody,
  buildVisibleAppsLinkageBody,
  describeRolesChange,
  describeVisibleAppsChange,
  registerUsersAccess,
  teamChangeRefusal,
} from '../src/domains/users-access.js';
import { ASCError } from '../src/errors.js';

// Users & Access policy: reads are free, writes are gated. Load-bearing rules:
//   1. Every team-changing tool sends NOTHING but GETs unless confirm === true.
//   2. The refusal names the person (name + login + id) and the exact change.
//   3. With confirm: true the write goes out with the pinned body.
//   4. A failed target lookup still refuses — it never falls through to a write.

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

const USER = {
  data: {
    type: 'users',
    id: 'U1',
    attributes: {
      username: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      roles: ['ADMIN', 'DEVELOPER'],
      allAppsVisible: false,
      provisioningAllowed: true,
    },
  },
};

const VISIBLE_APPS = {
  data: [
    { type: 'apps', id: '111', attributes: { name: 'Alpha', bundleId: 'com.example.alpha' } },
    { type: 'apps', id: '222', attributes: { name: 'Beta', bundleId: 'com.example.beta' } },
  ],
  links: {},
};

const INVITATION = {
  data: {
    type: 'userInvitations',
    id: 'I1',
    attributes: {
      email: 'sam@example.com',
      firstName: 'Sam',
      lastName: 'Lee',
      roles: ['MARKETING'],
    },
  },
};

function harness(opts: { failLookups?: boolean } = {}) {
  const tools = new Map<string, Handler>();
  const calls: Call[] = [];
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  const client = {
    request: async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({
        path,
        method,
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (method !== 'GET') return method === 'DELETE' ? undefined : { data: { id: 'ok' } };
      if (opts.failLookups)
        throw new ASCError(404, 'App Store Connect API 404 on GET', 'NOT_FOUND');
      if (path.includes('/visibleApps')) return VISIBLE_APPS;
      if (path.startsWith('/v1/userInvitations/')) return INVITATION;
      return USER;
    },
  } as unknown as ASCClient;
  registerUsersAccess(server, client);
  const call = async (name: string, args: Record<string, unknown>) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`no tool ${name}`);
    return handler(args);
  };
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { tools, call, calls, writes };
}

const GATED: Array<[string, Record<string, unknown>]> = [
  ['asc_patch_user', { userId: 'U1', roles: ['DEVELOPER'] }],
  ['asc_delete_user', { userId: 'U1' }],
  ['asc_add_user_visible_apps', { userId: 'U1', appIds: ['333'] }],
  ['asc_set_user_visible_apps', { userId: 'U1', appIds: ['111'] }],
  ['asc_remove_user_visible_apps', { userId: 'U1', appIds: ['222'] }],
  [
    'asc_post_user_invitation',
    {
      email: 'new@example.com',
      firstName: 'New',
      lastName: 'Person',
      roles: ['DEVELOPER'],
      visibleAppIds: ['111'],
    },
  ],
  ['asc_delete_user_invitation', { invitationId: 'I1' }],
];

describe('team-change gate — refusal paths', () => {
  it.each(GATED)('%s sends no write without confirm', async (name, args) => {
    const h = harness();
    const res = await h.call(name, args);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/^REFUSED — NOTHING WAS SENT TO APPLE/);
    expect(res.content[0]?.text).toContain('confirm: true');
    expect(h.writes()).toEqual([]);
  });

  it.each(GATED)('%s refuses with confirm: false too', async (name, args) => {
    const h = harness();
    const res = await h.call(name, { ...args, confirm: false });
    expect(res.isError).toBe(true);
    expect(h.writes()).toEqual([]);
  });

  it.each(GATED)('%s still refuses when the target lookup fails', async (name, args) => {
    const h = harness({ failLookups: true });
    const res = await h.call(name, args);
    expect(res.isError).toBe(true);
    expect(h.writes()).toEqual([]);
  });

  it('a failed lookup names the id and the lookup error', async () => {
    const h = harness({ failLookups: true });
    const text = (await h.call('asc_delete_user', { userId: 'U9' })).content[0]?.text ?? '';
    expect(text).toContain('U9 (could not be looked up)');
    expect(text).toContain('NOT_FOUND');
  });

  it('delete refusal names the person and their current roles', async () => {
    const h = harness();
    const text = (await h.call('asc_delete_user', { userId: 'U1' })).content[0]?.text ?? '';
    expect(text).toContain('REMOVE this user from the team');
    expect(text).toContain('Jane Doe <jane@example.com> — user id U1');
    expect(text).toContain('current roles: ADMIN, DEVELOPER');
  });

  it('role-change refusal shows lost roles and the ADMIN warning', async () => {
    const h = harness();
    const text =
      (await h.call('asc_patch_user', { userId: 'U1', roles: ['DEVELOPER'] })).content[0]?.text ??
      '';
    expect(text).toContain('roles REPLACED with: DEVELOPER');
    expect(text).toContain('LOSES: ADMIN');
    expect(text).toContain('This removes ADMIN');
  });

  it('visible-apps replace refusal lists the apps lost by name', async () => {
    const h = harness();
    const text =
      (await h.call('asc_set_user_visible_apps', { userId: 'U1', appIds: ['111'] })).content[0]
        ?.text ?? '';
    expect(text).toContain('visible apps REPLACED with: Alpha (111)');
    expect(text).toContain('LOSES access to: Beta (222)');
  });

  it('invitation refusal names the invitee, roles and apps', async () => {
    const h = harness();
    const text =
      (
        await h.call('asc_post_user_invitation', {
          email: 'new@example.com',
          firstName: 'New',
          lastName: 'Person',
          roles: ['ADMIN'],
        })
      ).content[0]?.text ?? '';
    expect(text).toContain('New Person <new@example.com>');
    expect(text).toContain('roles: ADMIN');
    expect(text).toContain('This grants ADMIN');
  });

  it('cancel-invitation refusal names the invitee', async () => {
    const h = harness();
    const text =
      (await h.call('asc_delete_user_invitation', { invitationId: 'I1' })).content[0]?.text ?? '';
    expect(text).toContain('Sam Lee <sam@example.com> — invitation id I1');
  });

  it('patch with no fields refuses before any request', async () => {
    const h = harness();
    const res = await h.call('asc_patch_user', { userId: 'U1', confirm: true });
    expect(res.isError).toBe(true);
    expect(h.calls).toEqual([]);
  });
});

describe('team-change gate — confirmed writes', () => {
  it('asc_delete_user with confirm: true sends exactly one DELETE', async () => {
    const h = harness();
    const res = await h.call('asc_delete_user', { userId: 'U1', confirm: true });
    expect(res.isError).toBeUndefined();
    expect(h.calls).toEqual([{ path: '/v1/users/U1', method: 'DELETE' }]);
  });

  it('asc_patch_user with confirm: true sends the pinned body', async () => {
    const h = harness();
    await h.call('asc_patch_user', { userId: 'U1', roles: ['DEVELOPER'], confirm: true });
    expect(h.writes()).toEqual([
      {
        path: '/v1/users/U1',
        method: 'PATCH',
        body: { data: { type: 'users', id: 'U1', attributes: { roles: ['DEVELOPER'] } } },
      },
    ]);
  });

  it.each([
    ['asc_add_user_visible_apps', 'POST'],
    ['asc_set_user_visible_apps', 'PATCH'],
    ['asc_remove_user_visible_apps', 'DELETE'],
  ])('%s with confirm: true uses %s on the relationship', async (name, method) => {
    const h = harness();
    await h.call(name, { userId: 'U1', appIds: ['111'], confirm: true });
    expect(h.writes()).toEqual([
      {
        path: '/v1/users/U1/relationships/visibleApps',
        method,
        body: { data: [{ type: 'apps', id: '111' }] },
      },
    ]);
  });

  it('asc_post_user_invitation with confirm: true posts the invitation', async () => {
    const h = harness();
    await h.call('asc_post_user_invitation', {
      email: 'new@example.com',
      firstName: 'New',
      lastName: 'Person',
      roles: ['DEVELOPER'],
      confirm: true,
    });
    expect(h.writes()[0]?.path).toBe('/v1/userInvitations');
    expect(h.writes()[0]?.method).toBe('POST');
  });

  it('reads are not gated', async () => {
    const h = harness();
    const res = await h.call('asc_get_user', { userId: 'U1' });
    expect(res.isError).toBeUndefined();
  });
});

describe('body builders', () => {
  it('buildUserPatchBody sends only supplied attributes and the visibleApps relationship', () => {
    expect(buildUserPatchBody({ userId: 'U1', provisioningAllowed: false })).toEqual({
      data: { type: 'users', id: 'U1', attributes: { provisioningAllowed: false } },
    });
    expect(buildUserPatchBody({ userId: 'U1', visibleAppIds: ['1', '2'] })).toEqual({
      data: {
        type: 'users',
        id: 'U1',
        relationships: {
          visibleApps: {
            data: [
              { type: 'apps', id: '1' },
              { type: 'apps', id: '2' },
            ],
          },
        },
      },
    });
  });

  it('buildUserInvitationCreateBody carries required attrs and omits unset optionals', () => {
    expect(
      buildUserInvitationCreateBody({
        email: 'a@example.com',
        firstName: 'A',
        lastName: 'B',
        roles: ['DEVELOPER'],
      }),
    ).toEqual({
      data: {
        type: 'userInvitations',
        attributes: { email: 'a@example.com', firstName: 'A', lastName: 'B', roles: ['DEVELOPER'] },
      },
    });
    const withApps = buildUserInvitationCreateBody({
      email: 'a@example.com',
      firstName: 'A',
      lastName: 'B',
      roles: ['DEVELOPER'],
      allAppsVisible: false,
      visibleAppIds: ['9'],
    });
    expect(withApps.data.attributes?.allAppsVisible).toBe(false);
    expect(withApps.data.relationships).toEqual({
      visibleApps: { data: [{ type: 'apps', id: '9' }] },
    });
  });

  it('buildVisibleAppsLinkageBody is a bare to-many linkage', () => {
    expect(buildVisibleAppsLinkageBody(['1'])).toEqual({ data: [{ type: 'apps', id: '1' }] });
  });
});

describe('change descriptions', () => {
  it('describeRolesChange warns when current roles are unknown', () => {
    const r = describeRolesChange(undefined, ['DEVELOPER']);
    expect(r.warnings.join(' ')).toContain('full replacement');
  });

  it('describeVisibleAppsChange flags allAppsVisible as a no-op', () => {
    const r = describeVisibleAppsChange('add', { id: 'U1', kind: 'user', allAppsVisible: true }, [
      '1',
    ]);
    expect(r.warnings.join(' ')).toContain('no effect');
  });

  it('teamChangeRefusal includes warnings and the confirm instruction', () => {
    const text = teamChangeRefusal({
      action: 'do a thing.',
      targetId: 'X',
      changes: ['a'],
      warnings: ['careful'],
    });
    expect(text).toContain('⚠️ careful');
    expect(text).toContain('re-run the same call with confirm: true');
  });
});
