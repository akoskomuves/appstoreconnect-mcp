#!/usr/bin/env tsx
// Live smoke test for the v0.8 offer-codes surface (v0.8.0 + v0.8.1). Not
// wired into the test suite — meant to be run by a human with real ASC creds
// in env, exercising the actual /v1/subscriptionOfferCodes,
// /oneTimeUseCodes, /customCodes, and /values endpoints.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-offer-codes.ts                       # enumerate apps/groups/subs
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-offer-codes.ts --sub <SUB_ID>        # campaign + batch + customCodes reads
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-offer-codes.ts --batch <BATCH_ID>    # exercise the /values endpoint specifically
//
// What this verifies (without writing to ASC):
//   1. The list endpoint /v1/subscriptions/{id}/offerCodes returns a shape
//      paginate() can walk. (Apple's relationship name drops the resource-type
//      prefix — same convention as /introductoryOffers and /promotionalOffers.
//      v0.8.0 shipped with the wrong path; live smoke caught it.)
//   2. The digest renders correctly with whatever rows came back.
//   3. If any campaigns exist, that `name` is in `data[].attributes` — the
//      assumption the asc_post pre-flight collision check depends on.
//   4. The /oneTimeUseCodes sub-resource also walks cleanly.
//   5. The /values endpoint serves text/csv (not JSON) — v0.8.0 fix.
//   6. v0.8.1: the /customCodes sub-resource walks cleanly, custom-code
//      attributes include customCode/numberOfCodes, and the new
//      autoRenewEnabled / productionCodeCount / sandboxCodeCount fields
//      surface on campaign list responses when Apple sends them.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestApps,
  digestOfferCodeCustomCodes,
  digestOfferCodeOneTimeUseBatches,
  digestOfferCodes,
  digestSubscriptionGroups,
  digestSubscriptions,
} from '../src/digest.js';
import { paginate } from '../src/jsonapi.js';

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
  console.log('  npx tsx scripts/smoke-offer-codes.ts --sub <SUB_ID>');
}

async function smokeSub(
  client: ReturnType<typeof createASCClient>,
  subscriptionId: string,
): Promise<void> {
  console.log(`=== Offer-code campaigns for subscription ${subscriptionId} ===\n`);

  // Relationship path on /v1/subscriptions/{id} is `/offerCodes` (Apple drops
  // the type-name prefix on relationships, same convention as
  // /introductoryOffers and /promotionalOffers). The resource collection at
  // /v1/subscriptionOfferCodes does keep the prefix.
  const params = new URLSearchParams();
  params.set('include', 'prices');
  params.set('limit', '200');
  const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/offerCodes?${params.toString()}`;

  let campaigns: Awaited<ReturnType<typeof paginate>>;
  try {
    campaigns = await paginate(client, path, 200);
  } catch (err) {
    console.log(`[FAIL] List endpoint ${path}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
    console.log(
      '       If this is a 404, the URL path is wrong — try /offerCodes (no subscription prefix).',
    );
    return;
  }

  console.log(
    `Raw paginate result: data=${campaigns.data.length}, included=${campaigns.included.length}, total=${campaigns.total ?? 'n/a'}, truncated=${campaigns.truncated}\n`,
  );

  console.log('--- digestOfferCodes ---\n');
  console.log(digestOfferCodes(campaigns));
  console.log('');

  console.log('--- Verifications ---');
  console.log(
    `[count] existing.data.length = ${campaigns.data.length} (used by 10-campaign pre-flight)`,
  );

  if (campaigns.data.length === 0) {
    console.log('[ok]    Zero-campaign case — digest rendered without crashing.');
    console.log('[warn]  No campaigns exist, so the name-collision check and the');
    console.log("        /oneTimeUseCodes + /values endpoints can't be exercised.");
    console.log('        To verify those, either create a campaign manually in App Store');
    console.log('        Connect UI and re-run, or trust the OpenAPI spec.');
    return;
  }

  for (const campaign of campaigns.data) {
    const name = campaign.attributes?.['name'];
    const elig = campaign.attributes?.['customerEligibilities'];
    const offerElig = campaign.attributes?.['offerEligibility'];
    const mode = campaign.attributes?.['offerMode'];
    const duration = campaign.attributes?.['duration'];
    const periods = campaign.attributes?.['numberOfPeriods'];
    const active = campaign.attributes?.['active'];
    // v0.8.1 surfaces. Apple may omit any of these on a sparse-fieldset
    // response — undefined here just means "not in the response", not
    // "Apple doesn't expose it".
    const autoRenew = campaign.attributes?.['autoRenewEnabled'];
    const prodCount = campaign.attributes?.['productionCodeCount'];
    const sbxCount = campaign.attributes?.['sandboxCodeCount'];
    const totalCount = campaign.attributes?.['totalNumberOfCodes'];
    console.log(`\n[campaign] ${campaign.id}`);
    console.log(`  name             = ${name ?? '(MISSING — collision-check would fail)'}`);
    console.log(`  customerEligib   = ${JSON.stringify(elig) ?? '(missing)'}`);
    console.log(`  offerEligibility = ${offerElig ?? '(missing)'}`);
    console.log(`  offerMode        = ${mode ?? '(missing)'}`);
    console.log(`  duration         = ${duration ?? '(missing)'}`);
    console.log(`  numberOfPeriods  = ${periods ?? '(n/a unless PAY_AS_YOU_GO)'}`);
    console.log(`  active           = ${active ?? '(missing)'}`);
    console.log(`  autoRenewEnabled = ${autoRenew ?? '(absent — pre-v0.8.1 or sparse fieldset)'}`);
    console.log(`  productionCodes  = ${prodCount ?? '(absent)'}`);
    console.log(`  sandboxCodes     = ${sbxCount ?? '(absent)'}`);
    console.log(`  totalCodes       = ${totalCount ?? '(absent)'}`);
    const pricesRel = campaign.relationships?.['prices']?.data;
    const priceCount = Array.isArray(pricesRel) ? pricesRel.length : 'n/a';
    console.log(`  prices linkage   = ${priceCount} entries (digest PRICES column source)`);

    if (!name) {
      console.log('  [FAIL] `name` is NOT in attributes on the list response.');
      console.log('         The asc_post pre-flight collision check will silently fail to');
      console.log('         detect duplicates. Fix: pin fields[…] in the pre-flight list, OR');
      console.log('         adjust the field path.');
    }

    // Walk one-time-use batches.
    console.log(`\n  --- one-time-use batches on ${campaign.id} ---`);
    const batchesPath = `/v1/subscriptionOfferCodes/${encodeURIComponent(
      campaign.id,
    )}/oneTimeUseCodes?limit=200`;
    let batches: Awaited<ReturnType<typeof paginate>>;
    try {
      batches = await paginate(client, batchesPath, 200);
    } catch (err) {
      console.log(`  [FAIL] ${batchesPath}`);
      console.log(`         ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    console.log(`  raw: data=${batches.data.length}\n`);
    console.log(digestOfferCodeOneTimeUseBatches(batches));

    if (batches.data.length === 0) {
      console.log('  [warn] No batches yet — /values export cannot be exercised on this');
      console.log('         campaign. Create a batch manually or pass --batch <ID> for a');
      console.log('         specific known batch.');
    } else {
      const first = batches.data[0];
      if (first) {
        console.log(`\n  --- /values on first batch ${first.id} (sample) ---`);
        await smokeValues(client, first.id);
      }
    }

    // v0.8.1: walk custom (multi-use) codes. These are independent of the
    // one-time-use batches above — same parent campaign, different child
    // resource type. The customCode string is on the resource itself (no
    // separate /values export step like one-time-use batches need).
    console.log(`\n  --- custom (multi-use) codes on ${campaign.id} ---`);
    const customCodesPath = `/v1/subscriptionOfferCodes/${encodeURIComponent(
      campaign.id,
    )}/customCodes?limit=200`;
    let customCodes: Awaited<ReturnType<typeof paginate>>;
    try {
      customCodes = await paginate(client, customCodesPath, 200);
    } catch (err) {
      console.log(`  [FAIL] ${customCodesPath}`);
      console.log(`         ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    console.log(`  raw: data=${customCodes.data.length}\n`);
    console.log(digestOfferCodeCustomCodes(customCodes));

    if (customCodes.data.length === 0) {
      console.log('  [warn] No custom codes yet — create one with');
      console.log('         asc_post_subscription_offer_code_custom_code to exercise the');
      console.log('         create+patch surfaces.');
    } else {
      const sampleCC = customCodes.data[0];
      const cc = sampleCC?.attributes?.['customCode'];
      const cap = sampleCC?.attributes?.['numberOfCodes'];
      if (cc === undefined) {
        console.log(
          '  [FAIL] customCode missing from list response — list tool digest will render blank.',
        );
      } else {
        console.log(`  [ok]   sample customCode = "${cc}" (cap ${cap ?? '?'})`);
      }
    }
  }
}

async function smokeValues(
  client: ReturnType<typeof createASCClient>,
  batchId: string,
): Promise<void> {
  // v0.8.0 live smoke discovered Apple serves /values as text/csv directly,
  // not JSON:API. The export tool was switched to client.requestText (which
  // defaults Accept: text/csv); the smoke script now mirrors that. Surface
  // the first few non-empty CSV lines as a sample so a malformed/empty
  // response is obvious.
  const path = `/v1/subscriptionOfferCodeOneTimeUseCodes/${encodeURIComponent(batchId)}/values`;
  let csv: string;
  try {
    csv = await client.requestText(path, { method: 'GET' });
  } catch (err) {
    console.log(`  [FAIL] ${path}`);
    console.log(`         ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    console.log('  [FAIL] /values returned an empty CSV — no header row.');
    console.log(`         raw bytes (first 200): ${JSON.stringify(csv.slice(0, 200))}`);
    return;
  }
  console.log(`  [ok]   /values served ${lines.length} CSV line(s), first 3:`);
  for (const line of lines.slice(0, 3)) {
    console.log(`         ${line}`);
  }
  if (lines.length > 3) {
    console.log(`         … (+${lines.length - 3} more)`);
  }
}

async function main(): Promise<void> {
  let subscriptionId: string | undefined;
  let batchId: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sub' && args[i + 1]) {
      subscriptionId = args[i + 1];
      i++;
    } else if (args[i] === '--batch' && args[i + 1]) {
      batchId = args[i + 1];
      i++;
    }
  }

  const config = loadConfig();
  const client = createASCClient(config);

  if (batchId) {
    console.log(`=== /values smoke for batch ${batchId} ===\n`);
    await smokeValues(client, batchId);
  } else if (subscriptionId) {
    await smokeSub(client, subscriptionId);
  } else {
    await enumerate(client);
  }
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
