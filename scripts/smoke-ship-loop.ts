#!/usr/bin/env tsx
// Live smoke test for the v1.5.0 ship-loop reads. Not wired into the test
// suite — run by a human with real ASC creds in env. Read-only: none of the
// v1.5 write verbs (availability replace, release request, submissions, grace
// PATCH) are exercised here — they are all customer-facing or irreversible.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-ship-loop.ts <APP_ID> <SUBSCRIPTION_ID>
//
// What this verifies:
//   1. /v1/subscriptions/{id}/subscriptionAvailability exists + returns the
//      record (and whether its id matches the subscription id — the "Apple ids
//      are not opaque" question for this resource).
//   2. /v1/subscriptionAvailabilities/{id}/availableTerritories paginates and
//      digestTerritories renders bare ISO ids.
//   3. /v1/subscriptions/{id}/planAvailabilities exists (newer surface; may
//      legitimately be empty when the sub has no per-plan split).
//   4. /v2/inAppPurchases/{id}/inAppPurchaseAvailability — only if the app has
//      IAPs; skipped (and said so) otherwise.
//   5. /v1/appStoreVersions/{id}/appStoreReviewDetail returns the review card
//      (or data:null — Apple's established absent-to-one pattern) and, when
//      present, the attachments listing accepts our fields selector
//      (assetDeliveryState, NOT state — a wrong field 400s right here).
//   6. /v1/apps/{id}/subscriptionGracePeriod returns the config record.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestTerritories } from '../src/digest.js';
import { paginate } from '../src/jsonapi.js';

const [appId, subscriptionId] = process.argv.slice(2);
if (!appId || !subscriptionId) {
  console.error('Usage: smoke-ship-loop.ts <APP_ID> <SUBSCRIPTION_ID>');
  process.exit(1);
}

interface Resource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
}

const config = loadConfig();
const client = createASCClient(config);

function show(label: string, value: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  // 1+2: subscription availability + its territories.
  const subAvail = await client.request<{ data?: Resource }>(
    `/v1/subscriptions/${encodeURIComponent(subscriptionId as string)}/subscriptionAvailability`,
  );
  show('subscriptionAvailability', subAvail);
  const availId = subAvail.data?.id;
  if (availId) {
    console.log(
      `id ${availId === subscriptionId ? '==' : '!='} subscription id (${subscriptionId})`,
    );
    const territories = await paginate(
      client,
      `/v1/subscriptionAvailabilities/${encodeURIComponent(availId)}/availableTerritories?limit=200`,
      500,
    );
    show('availableTerritories (digest)', digestTerritories(territories));
  }

  // 3: plan availabilities.
  const plans = await paginate(
    client,
    `/v1/subscriptions/${encodeURIComponent(subscriptionId as string)}/planAvailabilities?limit=200`,
    200,
  );
  show('planAvailabilities', plans.data);

  // 4: IAP availability, if the app has IAPs.
  const iaps = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId as string)}/inAppPurchasesV2?limit=5`,
    5,
  );
  const iapId = (iaps.data[0] as Resource | undefined)?.id;
  if (iapId) {
    const iapAvail = await client.request<unknown>(
      `/v2/inAppPurchases/${encodeURIComponent(iapId)}/inAppPurchaseAvailability`,
    );
    show(`inAppPurchaseAvailability (IAP ${iapId})`, iapAvail);
  } else {
    console.log('\n=== inAppPurchaseAvailability: SKIPPED (app has no IAPs) ===');
  }

  // 5: review detail of the newest version + attachments listing.
  const versions = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId as string)}/appStoreVersions?limit=1`,
    1,
  );
  const version = versions.data[0] as Resource | undefined;
  if (version?.id) {
    const detail = await client.request<{ data?: Resource | null }>(
      `/v1/appStoreVersions/${encodeURIComponent(version.id)}/appStoreReviewDetail`,
    );
    show(`appStoreReviewDetail (version ${version.attributes?.versionString})`, detail);
    const detailId = detail.data?.id;
    if (detailId) {
      const attachments = await paginate(
        client,
        `/v1/appStoreReviewDetails/${encodeURIComponent(detailId)}/appStoreReviewAttachments?fields[appStoreReviewAttachments]=fileName,fileSize,sourceFileChecksum,assetDeliveryState&limit=200`,
        200,
      );
      show('appStoreReviewAttachments', attachments.data);
    } else {
      console.log('(no review detail on this version — attachments listing not drillable)');
    }
  }

  // 6: grace period.
  const grace = await client.request<unknown>(
    `/v1/apps/${encodeURIComponent(appId as string)}/subscriptionGracePeriod`,
  );
  show('subscriptionGracePeriod', grace);

  console.log('\nSmoke complete.');
}

main().catch((err) => {
  console.error('\nSMOKE FAILURE:', err instanceof Error ? err.message : err);
  if (err && typeof err === 'object' && 'details' in err) {
    console.error(JSON.stringify((err as { details: unknown }).details, null, 2));
  }
  process.exit(1);
});
