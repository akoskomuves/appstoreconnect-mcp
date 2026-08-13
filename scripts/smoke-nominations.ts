#!/usr/bin/env tsx

// Live smoke test for the v1.9.0 featuring-nominations tools. This one DOES
// drill the write path: DRAFT nominations are developer-side-only config —
// invisible to customers and to Apple's editorial team until submitted:true —
// so a create→get→patch→delete cycle is safe under the smoke protocol's
// dev-only-config exception. `submitted` stays false throughout and the
// finally block always deletes the draft.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-nominations.ts <APP_ID>

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestNominations } from '../src/digest.js';
import { buildNominationCreateBody, buildNominationPatchBody } from '../src/domains/nominations.js';
import { paginate } from '../src/jsonapi.js';

const [appId] = process.argv.slice(2);
if (!appId) {
  console.error('Usage: smoke-nominations.ts <APP_ID>');
  process.exit(1);
}

const client = createASCClient(loadConfig());

async function main(): Promise<void> {
  const list = await paginate(
    client,
    // filter[state] is REQUIRED and single-valued (both caught live 2026-08-13).
    '/v1/nominations?fields[nominations]=name,type,description,createdDate,lastModifiedDate,submittedDate,state,publishStartDate,publishEndDate,deviceFamilies,locales,hasInAppEvents,launchInSelectMarketsFirst,notes,preOrderEnabled&filter[state]=DRAFT&sort=-lastModifiedDate&limit=200',
    200,
  );
  console.log('=== existing nominations ===\n' + digestNominations(list));

  let draftId: string | undefined;
  try {
    const createBody = buildNominationCreateBody(
      {
        name: 'ppp smoke draft — safe to delete',
        type: 'APP_ENHANCEMENTS',
        description:
          'Wire-shape smoke draft created by scripts/smoke-nominations.ts. Never submitted.',
        submitted: false,
        // Full date-TIME required — a bare '2027-01-01' 409s (caught live).
        publishStartDate: '2027-01-01T00:00:00Z',
        launchInSelectMarketsFirst: false,
        appIds: [appId as string],
      },
      {},
    );
    const created = await client.request<{
      data?: { id?: string; attributes?: { state?: string } };
    }>('/v1/nominations', { method: 'POST', body: JSON.stringify(createBody) });
    draftId = created.data?.id;
    console.log(`\n=== created draft ${draftId} (state=${created.data?.attributes?.state}) ===`);

    // Apple requires submitted|archived on EVERY patch (caught live) —
    // submitted:false re-states "still a draft" alongside the edit.
    const patchBody = buildNominationPatchBody(
      draftId as string,
      { notes: 'patched by smoke', submitted: false },
      {},
    );
    const patched = await client.request<{
      data?: { attributes?: { notes?: string; state?: string } };
    }>(`/v1/nominations/${draftId}`, { method: 'PATCH', body: JSON.stringify(patchBody) });
    console.log(
      `=== patched: notes=${JSON.stringify(patched.data?.attributes?.notes)} state=${patched.data?.attributes?.state} ===`,
    );
  } finally {
    if (draftId) {
      await client.request<void>(`/v1/nominations/${draftId}`, { method: 'DELETE' });
      console.log(`=== deleted draft ${draftId} ===`);
    }
  }
  console.log('\nSmoke complete (full draft cycle verified; nothing submitted).');
}

main().catch((err) => {
  console.error('\nSMOKE FAILURE:', err instanceof Error ? err.message : err);
  if (err && typeof err === 'object' && 'details' in err) {
    console.error(JSON.stringify((err as { details: unknown }).details, null, 2));
  }
  process.exit(1);
});
