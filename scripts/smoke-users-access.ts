#!/usr/bin/env tsx
// Live smoke for Users & Access, the legal agreements and Pass Type /
// Merchant IDs.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-users-access.ts
//
// READS ONLY. Nothing here POSTs, PATCHes or DELETEs:
//   * Users & Access writes change who can reach the account — never drilled.
//     The gated tools are run WITHOUT confirm against the real API through a
//     client that throws on any non-GET, so the smoke proves the refusal path
//     (real lookups, real names in the refusal text) and that no write leaves.
//   * EULA / beta license text is customer- and tester-visible.
//   * Pass Type / Merchant ID writes are portal config with real consequences.
//
// Every ID is discovered, never hardcoded. The output prints team members'
// names to this terminal only — don't paste it anywhere public.

import type { McpServer } from '@modelcontextprotocol/server';
import type { ASCClient } from '../src/client.js';
import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestActors,
  digestBetaLicenseAgreements,
  digestIdentifierRecords,
  digestLinkedCertificates,
  digestUserInvitations,
  digestUsers,
  digestVisibleApps,
} from '../src/digest-users-access.js';
import { registerUsersAccess } from '../src/domains/users-access.js';
import { ascErrorText } from '../src/errors.js';
import { type JSONAPIResource, paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());
let failures = 0;

function section(label: string): void {
  console.log(`\n=== ${label} ===\n`);
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    failures += 1;
    console.log(`✗ ${label}: ${ascErrorText(err)}`);
  }
}

/** A client that refuses every write — the gate drill must never reach Apple with one. */
const readOnlyClient: ASCClient = {
  ...client,
  request: async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET';
    if (method !== 'GET') throw new Error(`SMOKE BUG: a gated tool tried ${method} ${path}`);
    return client.request<T>(path, init);
  },
};

async function main(): Promise<void> {
  let users: JSONAPIResource[] = [];

  section('Users');
  await step('list users', async () => {
    const pages = await paginate(
      client,
      '/v1/users?fields[users]=username,firstName,lastName,roles,allAppsVisible,provisioningAllowed,visibleApps&include=visibleApps&limit[visibleApps]=50&limit=200',
      500,
    );
    users = pages.data;
    console.log(digestUsers(pages));
  });

  const scoped = users.find((u) => u.attributes?.allAppsVisible === false) ?? users[0];
  if (scoped) {
    await step('get user', async () => {
      const res = await client.request<{ data: JSONAPIResource }>(
        `/v1/users/${scoped.id}?include=visibleApps&fields[apps]=name,bundleId`,
      );
      console.log(`✓ get user ${res.data.id} roles=${JSON.stringify(res.data.attributes?.roles)}`);
    });
    await step('user visible apps', async () => {
      const pages = await paginate(
        client,
        `/v1/users/${scoped.id}/visibleApps?fields[apps]=name,bundleId&limit=200`,
        500,
      );
      console.log(digestVisibleApps(pages));
    });
  }

  section('User invitations');
  await step('list invitations', async () => {
    const pages = await paginate(
      client,
      '/v1/userInvitations?fields[userInvitations]=email,firstName,lastName,expirationDate,roles,allAppsVisible,provisioningAllowed,visibleApps&include=visibleApps&limit=200',
      500,
    );
    console.log(digestUserInvitations(pages));
    const first = pages.data[0];
    if (first) {
      const apps = await paginate(
        client,
        `/v1/userInvitations/${first.id}/visibleApps?limit=200`,
        200,
      );
      console.log(`✓ invitation ${first.id} visible apps: ${apps.data.length}`);
    }
  });

  section('Team-change gate drill (no confirm → refusal, writes blocked)');
  if (scoped) {
    const tools = new Map<
      string,
      (
        a: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    >();
    registerUsersAccess(
      {
        registerTool: (n: string, _d: unknown, h: never) => tools.set(n, h),
      } as unknown as McpServer,
      readOnlyClient,
    );
    const drills: Array<[string, Record<string, unknown>]> = [
      ['asc_delete_user', { userId: scoped.id }],
      ['asc_patch_user', { userId: scoped.id, roles: ['DEVELOPER'] }],
      ['asc_set_user_visible_apps', { userId: scoped.id, appIds: [] }],
    ];
    for (const [name, args] of drills) {
      await step(`gate ${name}`, async () => {
        const res = await tools.get(name)?.(args);
        const text = res?.content[0]?.text ?? '';
        if (!res?.isError || !text.startsWith('REFUSED — NOTHING WAS SENT')) {
          throw new Error(`${name} did not refuse:\n${text}`);
        }
        console.log(
          `✓ ${name} refused. Refusal text:\n${text
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n')}\n`,
        );
      });
    }
  }

  section('Actors (via review submissions)');
  await step('actors', async () => {
    const apps = await client.request<{ data: JSONAPIResource[] }>(
      '/v1/apps?limit=5&fields[apps]=name',
    );
    const ids = new Set<string>();
    for (const app of apps.data) {
      const subs = await client.request<{ data: JSONAPIResource[] }>(
        `/v1/reviewSubmissions?filter[app]=${app.id}&fields[reviewSubmissions]=submittedByActor,lastUpdatedByActor&include=submittedByActor&limit=5`,
      );
      for (const s of subs.data) {
        for (const key of ['submittedByActor', 'lastUpdatedByActor']) {
          const d = s.relationships?.[key]?.data;
          if (d && !Array.isArray(d)) ids.add(d.id);
        }
      }
      if (ids.size > 0) break;
    }
    if (ids.size === 0) {
      console.log('(no actor ids found on recent review submissions — skipped)');
      return;
    }
    const pages = await paginate(
      client,
      `/v1/actors?filter[id]=${[...ids].join(',')}&fields[actors]=actorType,userFirstName,userLastName,userEmail,apiKeyId`,
      50,
    );
    console.log(digestActors(pages));
    const one = [...ids][0] ?? '';
    const got = await client.request<{ data: JSONAPIResource }>(
      `/v1/actors/${encodeURIComponent(one)}`,
    );
    console.log(`✓ get actor ${got.data.id} type=${String(got.data.attributes?.actorType)}`);
  });

  section('End user license agreements');
  await step('app EULAs', async () => {
    const apps = await client.request<{ data: JSONAPIResource[] }>(
      '/v1/apps?limit=200&fields[apps]=name',
    );
    let custom = 0;
    let standard = 0;
    for (const app of apps.data) {
      try {
        const res = await client.request<{ data: JSONAPIResource | null }>(
          `/v1/apps/${app.id}/endUserLicenseAgreement?fields[endUserLicenseAgreements]=agreementText,app,territories`,
        );
        // No custom EULA answers 200 with data: null (not 404).
        if (!res.data) {
          standard += 1;
          continue;
        }
        custom += 1;
        if (custom === 1) {
          const eulaId = res.data.id;
          const got = await client.request<{ data: JSONAPIResource }>(
            `/v1/endUserLicenseAgreements/${eulaId}?include=territories&limit[territories]=50`,
          );
          const terr = await paginate(
            client,
            `/v1/endUserLicenseAgreements/${eulaId}/territories?limit=200`,
            500,
          );
          console.log(
            `✓ app ${app.id} custom EULA ${got.data.id}: ${String(got.data.attributes?.agreementText ?? '').length} chars, ${terr.data.length} territories`,
          );
        }
      } catch (err) {
        if (ascErrorText(err).includes(' 404 ')) standard += 1;
        else throw err;
      }
    }
    console.log(
      `✓ ${apps.data.length} apps: ${custom} custom EULA, ${standard} standard (data: null or 404)`,
    );
  });

  section('Beta license agreements');
  await step('beta license agreements', async () => {
    const pages = await paginate(
      client,
      '/v1/betaLicenseAgreements?fields[betaLicenseAgreements]=agreementText,app&include=app&fields[apps]=name&limit=200',
      500,
    );
    console.log(digestBetaLicenseAgreements(pages));
    const first = pages.data[0];
    if (!first) return;
    const got = await client.request<{ data: JSONAPIResource }>(
      `/v1/betaLicenseAgreements/${first.id}?include=app`,
    );
    const app = await client.request<{ data: JSONAPIResource }>(
      `/v1/betaLicenseAgreements/${first.id}/app`,
    );
    const viaApp = await client.request<{ data: JSONAPIResource }>(
      `/v1/apps/${app.data.id}/betaLicenseAgreement`,
    );
    console.log(
      `✓ get ${got.data.id}; its app ${app.data.id}; app→agreement ${viaApp.data.id} (${viaApp.data.id === first.id ? 'matches' : 'MISMATCH'})`,
    );
  });

  for (const [kind, label] of [
    ['passTypeIds', 'Pass Type IDs'],
    ['merchantIds', 'Merchant IDs'],
  ] as const) {
    section(label);
    await step(label, async () => {
      const pages = await paginate(
        client,
        `/v1/${kind}?fields[${kind}]=name,identifier,certificates&limit=200`,
        500,
      );
      console.log(digestIdentifierRecords(pages, label));
      const first = pages.data[0];
      if (!first) return;
      await client.request(`/v1/${kind}/${first.id}?include=certificates`);
      const certs = await paginate(client, `/v1/${kind}/${first.id}/certificates?limit=200`, 200);
      console.log(digestLinkedCertificates(certs));
    });
  }

  section('Done');
  console.log(failures === 0 ? '✓ all reads clean' : `✗ ${failures} step(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

await main();
