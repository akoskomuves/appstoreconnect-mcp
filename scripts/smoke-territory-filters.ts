#!/usr/bin/env tsx
// Live smoke for the v1.10.0 surfaces. Read-only — no writes anywhere.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-territory-filters.ts
//
// Covers:
//   1. digestCiWorkflow — renders a real workflow, and proves the sparse
//      fieldsets actually shrink the payload rather than just hiding it.
//   2. territoryId on the price lister, including the truncated-scan guard
//      (the regression where a small maxItems reported a real territory as
//      having no price at all).
//   3. territoryId on the introductory-offer lister, including the wildcard
//      rule — an all-territories offer must survive a single-territory view.
//
// Every ID is discovered, never hardcoded: this runs against whatever account
// the credentials belong to.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestCiWorkflow, digestIntroOffers, digestSubscriptionPrices } from '../src/digest.js';
import {
  FULL_TERRITORY_SCAN,
  filterPagesByTerritory,
  paginate,
  territoryFilterNote,
} from '../src/jsonapi.js';

const client = createASCClient(loadConfig());
const TERRITORY = process.env.SMOKE_TERRITORY ?? 'USA';

function section(label: string): void {
  console.log(`\n=== ${label} ===`);
}

interface Doc {
  data?: { id?: string; attributes?: Record<string, unknown> } | Array<{ id?: string }>;
}

async function main(): Promise<void> {
  // ---- 1. digestCiWorkflow ----
  const products = await client.request<Doc>('/v1/ciProducts?limit=5');
  const productId = Array.isArray(products.data) ? products.data[0]?.id : undefined;
  if (productId) {
    const workflows = await client.request<Doc>(`/v1/ciProducts/${productId}/workflows?limit=5`);
    const workflowId = Array.isArray(workflows.data) ? workflows.data[0]?.id : undefined;
    if (workflowId) {
      const include = 'include=repository,xcodeVersion,macOsVersion';
      const sparse = await client.request<never>(
        `/v1/ciWorkflows/${workflowId}?${include}` +
          '&fields[ciXcodeVersions]=name,version' +
          '&fields[ciMacOsVersions]=name,version' +
          '&fields[scmRepositories]=ownerName,repositoryName,defaultBranch',
      );
      const unsparse = await client.request<never>(`/v1/ciWorkflows/${workflowId}?${include}`);
      const digest = digestCiWorkflow(sparse);
      section('digestCiWorkflow');
      console.log(digest);
      console.log(
        `\nsizes — raw(no fieldsets)=${JSON.stringify(unsparse).length} chars` +
          ` · raw(sparse)=${JSON.stringify(sparse).length}` +
          ` · digest=${digest.length}`,
      );
    }
  } else {
    console.log('\nNo Xcode Cloud products on this account — workflow digest not exercised.');
  }

  // ---- 2 + 3. territory filters ----
  const apps = await client.request<Doc>('/v1/apps?limit=200&fields[apps]=bundleId');
  const appIds = Array.isArray(apps.data) ? apps.data.map((a) => a.id) : [];
  let subscriptionId: string | undefined;
  for (const appId of appIds) {
    const groups = await client.request<Doc>(`/v1/apps/${appId}/subscriptionGroups?limit=5`);
    const groupId = Array.isArray(groups.data) ? groups.data[0]?.id : undefined;
    if (!groupId) continue;
    const subs = await client.request<Doc>(
      `/v1/subscriptionGroups/${groupId}/subscriptions?limit=5`,
    );
    subscriptionId = Array.isArray(subs.data) ? subs.data[0]?.id : undefined;
    if (subscriptionId) break;
  }
  if (!subscriptionId) {
    console.log('\nNo subscriptions on this account — territory filters not exercised.');
    return;
  }

  const pricePath = `/v1/subscriptions/${subscriptionId}/prices?include=subscriptionPricePoint,territory`;
  const all = await paginate(client, pricePath, FULL_TERRITORY_SCAN);
  const narrowed = filterPagesByTerritory(all, TERRITORY);
  section(`prices filtered to ${TERRITORY}`);
  console.log(
    territoryFilterNote(TERRITORY, narrowed.data.length, all.data.length, all.truncated).trim(),
  );
  console.log(digestSubscriptionPrices(narrowed));

  // The regression the code review caught: with a small ceiling the requested
  // territory may never be reached, and an empty table would read as "this
  // territory has no price". The note must say INCOMPLETE SCAN instead.
  const short = await paginate(client, pricePath, 25);
  const shortNarrowed = filterPagesByTerritory(short, TERRITORY);
  section('truncated-scan guard (ceiling 25)');
  console.log(
    territoryFilterNote(
      TERRITORY,
      shortNarrowed.data.length,
      short.data.length,
      short.truncated,
    ).trim(),
  );

  const offers = await paginate(
    client,
    `/v1/subscriptions/${subscriptionId}/introductoryOffers?include=territory,subscriptionPricePoint&limit=200`,
    FULL_TERRITORY_SCAN,
  );
  const offersNarrowed = filterPagesByTerritory(offers, TERRITORY, true);
  const wildcards = offers.data.filter((r) => !r.relationships?.['territory']?.data).length;
  section(`introductory offers filtered to ${TERRITORY}`);
  console.log(`total=${offers.data.length} · wildcards=${wildcards}`);
  console.log(
    territoryFilterNote(
      TERRITORY,
      offersNarrowed.data.length,
      offers.data.length,
      offers.truncated,
      true,
    ).trim(),
  );
  if (offersNarrowed.data.length > 0) console.log(digestIntroOffers(offersNarrowed));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
