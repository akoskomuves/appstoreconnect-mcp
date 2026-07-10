#!/usr/bin/env tsx
// Live smoke test for the v1.1.0 win-back-offers reads. Not wired into the test
// suite — meant to be run by a human with real ASC creds in env, exercising the
// actual /v1/winBackOffers endpoint surface.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-win-back-offers.ts                    # enumerate apps/groups/subs
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-win-back-offers.ts --sub <SUB_ID>     # run win-back-offer reads
//
// What this verifies (without writing to ASC):
//   1. The list endpoint /v1/subscriptions/{id}/winBackOffers exists and returns
//      a shape paginate() can walk (win-back is a newer surface — worth confirming
//      the path + field selector are accepted by Apple).
//   2. The `fields[winBackOffers]` selector this domain sends is accepted (a wrong
//      field name would surface as an Apple 400 here, not in production).
//   3. The digest renders correctly with whatever rows came back (incl. zero-row).
//   4. If any offers exist, that `offerId` is in `data[].attributes` — the
//      assumption the asc_post pre-flight collision check depends on.
//   5. If an offer exists, the per-offer /prices endpoint returns the expected
//      (territory, subscriptionPricePoint) relationship shape.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestApps,
  digestSubscriptionGroups,
  digestSubscriptions,
  digestWinBackOfferPrices,
  digestWinBackOffers,
} from '../src/digest.js';
import { paginate } from '../src/jsonapi.js';

const WIN_BACK_FIELDS =
  'offerId,referenceName,offerMode,duration,periodCount,priority,startDate,endDate';

async function enumerate(client: ReturnType<typeof createASCClient>): Promise<void> {
  console.log('=== Enumerate: apps ===\n');
  const apps = await paginate(client, '/v1/apps?limit=200', 200);
  console.log(digestApps(apps));
  console.log('');

  for (const app of apps.data) {
    console.log(
      `\n=== Subscription groups for app ${app.id} (${app.attributes?.['name'] ?? ''}) ===\n`,
    );
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
  console.log('  npx tsx scripts/smoke-win-back-offers.ts --sub <SUB_ID>');
}

async function smokeSub(
  client: ReturnType<typeof createASCClient>,
  subscriptionId: string,
): Promise<void> {
  console.log(`=== Win-back offers for subscription ${subscriptionId} ===\n`);

  const params = new URLSearchParams();
  params.set('include', 'prices');
  params.set('fields[winBackOffers]', WIN_BACK_FIELDS);
  params.set('limit', '200');
  const path = `/v1/subscriptions/${encodeURIComponent(
    subscriptionId,
  )}/winBackOffers?${params.toString()}`;
  const offers = await paginate(client, path, 200);

  console.log(
    `Raw paginate result: data=${offers.data.length}, included=${offers.included.length}, total=${offers.total ?? 'n/a'}, truncated=${offers.truncated}\n`,
  );
  console.log(
    '[ok]    /v1/subscriptions/{id}/winBackOffers + fields[winBackOffers] accepted by Apple.\n',
  );

  console.log('--- digestWinBackOffers ---\n');
  console.log(digestWinBackOffers(offers));
  console.log('');

  if (offers.data.length === 0) {
    console.log('[ok]    Zero-offer case — digest rendered without crashing.');
    console.log('[warn]  No win-back offers exist on this subscription, so the offerId-collision');
    console.log("        check and the /prices endpoint can't be exercised. To verify those,");
    console.log('        create a win-back offer in App Store Connect UI and re-run, or trust');
    console.log('        the OpenAPI spec.');
    return;
  }

  for (const offer of offers.data) {
    const offerId = offer.attributes?.['offerId'];
    const name = offer.attributes?.['referenceName'];
    const mode = offer.attributes?.['offerMode'];
    const duration = offer.attributes?.['duration'];
    const periods = offer.attributes?.['periodCount'];
    const priority = offer.attributes?.['priority'];
    console.log(`\n[offer] ${offer.id}`);
    console.log(`  offerId        = ${offerId ?? '(MISSING — collision-check would fail)'}`);
    console.log(`  referenceName  = ${name ?? '(missing)'}`);
    console.log(`  offerMode      = ${mode ?? '(missing)'}`);
    console.log(`  duration       = ${duration ?? '(missing)'}`);
    console.log(`  periodCount    = ${periods ?? '(missing)'}`);
    console.log(`  priority       = ${priority ?? '(missing)'}`);
    const pricesRel = offer.relationships?.['prices']?.data;
    const priceCount = Array.isArray(pricesRel) ? pricesRel.length : 'n/a';
    console.log(`  prices linkage = ${priceCount} entries (digest PRICES column source)`);

    if (!offerId) {
      console.log(`  [FAIL] offerId is NOT in attributes on the list response.`);
      console.log(`         The asc_post pre-flight collision check will silently fail to`);
      console.log(`         detect duplicates. Fix: adjust the fields[winBackOffers] selector.`);
    }

    console.log(`\n  --- prices on ${offer.id} ---`);
    const pricesPath = `/v1/winBackOffers/${encodeURIComponent(
      offer.id,
    )}/prices?include=territory,subscriptionPricePoint`;
    const prices = await paginate(client, pricesPath, 1000);
    console.log(`  raw: data=${prices.data.length}, included=${prices.included.length}\n`);
    console.log(digestWinBackOfferPrices(prices));

    let missingRels = 0;
    for (const p of prices.data) {
      const t = p.relationships?.['territory']?.data;
      const pp = p.relationships?.['subscriptionPricePoint']?.data;
      if (!t || !pp || Array.isArray(t) || Array.isArray(pp)) missingRels++;
    }
    if (missingRels > 0) {
      console.log(
        `  [FAIL] ${missingRels} price row(s) missing territory or subscriptionPricePoint relationship.`,
      );
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
