#!/usr/bin/env tsx
// Live smoke test for the v0.6.0 promotional-offers reads. Not wired into the
// test suite — meant to be run by a human with real ASC creds in env, exercising
// the actual /v1/subscriptionPromotionalOffers endpoint surface.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-promo-offers.ts                    # enumerate apps/groups/subs
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-promo-offers.ts --sub <SUB_ID>     # run promo-offer reads
//
// What this verifies (without writing to ASC):
//   1. The list endpoint /v1/subscriptions/{id}/promotionalOffers returns a
//      shape paginate() can walk.
//   2. The digest renders correctly with whatever rows came back (including
//      zero-row case).
//   3. If any offers exist, that `offerCode` is in `data[].attributes` — the
//      assumption the asc_post pre-flight collision check depends on.
//   4. The 10-offer cap counting matches what `existing.data.length` returns
//      (i.e. that Apple doesn't surface archived/deleted offers in the same
//      response in a way that would over-count).
//   5. If an offer exists, the per-offer /prices endpoint also returns the
//      expected (territory, subscriptionPricePoint) relationship shape.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestPromotionalOfferPrices,
  digestPromotionalOffers,
  digestSubscriptionGroups,
  digestSubscriptions,
  digestApps,
} from '../src/digest.js';
import { paginate } from '../src/jsonapi.js';

async function enumerate(client: ReturnType<typeof createASCClient>): Promise<void> {
  console.log('=== Enumerate: apps ===\n');
  const apps = await paginate(client, '/v1/apps?limit=200', 200);
  console.log(digestApps(apps));
  console.log('');

  for (const app of apps.data) {
    console.log(`\n=== Subscription groups for app ${app.id} (${app.attributes?.['name'] ?? ''}) ===\n`);
    const groups = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(app.id)}/subscriptionGroups?limit=200`,
      200,
    );
    if (groups.data.length === 0) {
      console.log('(no groups — app has no auto-renewable subs)');
      continue;
    }
    console.log(digestSubscriptionGroups(groups));

    for (const group of groups.data) {
      console.log(`\n  -- Subscriptions in group ${group.id} --\n`);
      const subs = await paginate(
        client,
        `/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions?limit=200`,
        200,
      );
      if (subs.data.length === 0) {
        console.log('  (no subscriptions in this group)');
      } else {
        console.log(digestSubscriptions(subs));
      }
    }
  }
  console.log('\n\nPick a subscription ID from above and re-run:');
  console.log('  npx tsx scripts/smoke-promo-offers.ts --sub <SUB_ID>');
}

async function smokeSub(
  client: ReturnType<typeof createASCClient>,
  subscriptionId: string,
): Promise<void> {
  console.log(`=== Promo offers for subscription ${subscriptionId} ===\n`);

  const params = new URLSearchParams();
  params.set('include', 'prices');
  params.set('limit', '200');
  const path = `/v1/subscriptions/${encodeURIComponent(
    subscriptionId,
  )}/promotionalOffers?${params.toString()}`;
  const offers = await paginate(client, path, 200);

  console.log(`Raw paginate result: data=${offers.data.length}, included=${offers.included.length}, total=${offers.total ?? 'n/a'}, truncated=${offers.truncated}\n`);

  console.log('--- digestPromotionalOffers ---\n');
  console.log(digestPromotionalOffers(offers));
  console.log('');

  console.log('--- Verifications ---');
  console.log(`[count] existing.data.length = ${offers.data.length} (used by 10-offer pre-flight)`);

  if (offers.data.length === 0) {
    console.log('[ok]    Zero-offer case — digest rendered without crashing.');
    console.log('[warn]  No offers exist on this subscription, so the offerCode-collision');
    console.log('        check and the /prices endpoint can\'t be exercised. To verify those,');
    console.log('        either create a promo offer manually in App Store Connect UI and');
    console.log('        re-run, or trust the OpenAPI spec.');
    return;
  }

  // For each offer, verify the assumptions the writes depend on.
  for (const offer of offers.data) {
    const code = offer.attributes?.['offerCode'];
    const name = offer.attributes?.['name'];
    const mode = offer.attributes?.['offerMode'];
    const duration = offer.attributes?.['duration'];
    const periods = offer.attributes?.['numberOfPeriods'];
    console.log(`\n[offer] ${offer.id}`);
    console.log(`  offerCode      = ${code ?? '(MISSING — collision-check would fail)'}`);
    console.log(`  name           = ${name ?? '(missing)'}`);
    console.log(`  offerMode      = ${mode ?? '(missing)'}`);
    console.log(`  duration       = ${duration ?? '(missing)'}`);
    console.log(`  numberOfPeriods= ${periods ?? '(missing — expected for non-PAY_AS_YOU_GO)'}`);
    const pricesRel = offer.relationships?.['prices']?.data;
    const priceCount = Array.isArray(pricesRel) ? pricesRel.length : 'n/a';
    console.log(`  prices linkage = ${priceCount} entries (digest PRICES column source)`);

    if (!code) {
      console.log(`  [FAIL] offerCode is NOT in attributes on the list response.`);
      console.log(`         The asc_post pre-flight collision check will silently fail to`);
      console.log(`         detect duplicates against this offer. Fix: request fields[…]`);
      console.log(`         explicitly in the pre-flight list, OR adjust the field path.`);
    }

    // Verify /prices endpoint shape — the dependency for patch-prices add/remove modes
    // and for the apply path's verification step.
    console.log(`\n  --- prices on ${offer.id} ---`);
    const pricesPath = `/v1/subscriptionPromotionalOffers/${encodeURIComponent(
      offer.id,
    )}/prices?include=territory,subscriptionPricePoint`;
    const prices = await paginate(client, pricesPath, 1000);
    console.log(`  raw: data=${prices.data.length}, included=${prices.included.length}\n`);
    console.log(digestPromotionalOfferPrices(prices));

    // Verify each price row has the relationships fetchCurrentPrices expects.
    let missingRels = 0;
    for (const p of prices.data) {
      const t = p.relationships?.['territory']?.data;
      const pp = p.relationships?.['subscriptionPricePoint']?.data;
      if (!t || !pp || Array.isArray(t) || Array.isArray(pp)) missingRels++;
    }
    if (missingRels > 0) {
      console.log(`  [FAIL] ${missingRels} price row(s) missing territory or subscriptionPricePoint`);
      console.log(`         relationship. patch-prices add/remove modes would drop those rows.`);
    } else if (prices.data.length > 0) {
      console.log(`  [ok]   All ${prices.data.length} price rows have the expected relationships.`);
    }
  }
}

async function main(): Promise<void> {
  let subscriptionId: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sub' && args[i + 1]) {
      subscriptionId = args[i + 1];
      i++;
    }
  }

  const config = loadConfig();
  const client = createASCClient(config);

  if (subscriptionId) {
    await smokeSub(client, subscriptionId);
  } else {
    await enumerate(client);
  }
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
