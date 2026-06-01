#!/usr/bin/env tsx
// Live smoke test for the v0.10.0 localization surface. Not wired into the
// test suite — meant to be run by a human with real ASC creds in env,
// exercising the actual /v1/appStoreVersions,
// /v1/appStoreVersionLocalizations, /v1/subscriptionLocalizations,
// /v1/inAppPurchaseLocalizations, and /v2/inAppPurchases endpoints.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-localizations.ts                          # enumerate apps
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-localizations.ts --app <APP_ID>           # walk every localization surface on one app
//
// READ-ONLY by default. To exercise writes, use the MCP tools through a
// Claude session — reload the MCP from the local build first, same pattern
// as v0.8.x / v0.9 cycles.
//
// What this verifies (against the live API):
//   1. /v1/apps/{id}/appStoreVersions returns rows with versionString +
//      platform + appStoreState + releaseType + createdDate.
//   2. /v1/appStoreVersions/{id}/appStoreVersionLocalizations walks; per
//      locale the digest renders whatsNew/description/keywords/promo lengths.
//   3. Wire-key correctness on AppStoreVersionLocalization: marketingUrl /
//      supportUrl are camelCase, NOT all-caps marketingURL/supportURL.
//   4. /v1/subscriptions/{id}/subscriptionLocalizations walks (per
//      subscription within a group). State enum visible.
//   5. /v2/inAppPurchases/{id}/inAppPurchaseLocalizations walks (per IAP
//      from the v2 IAP surface). Wire-key check: relationship name is
//      `inAppPurchaseV2` but resource type is `inAppPurchases` (no V2).

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestAppStoreVersionLocalizations,
  digestAppStoreVersions,
  digestApps,
  digestIapLocalizations,
  digestIaps,
  digestSubscriptionGroups,
  digestSubscriptionLocalizations,
  digestSubscriptions,
} from '../src/digest.js';
import { paginate } from '../src/jsonapi.js';

async function enumerate(client: ReturnType<typeof createASCClient>): Promise<void> {
  console.log('=== Enumerate: apps ===\n');
  const apps = await paginate(client, '/v1/apps?limit=200', 200);
  console.log(digestApps(apps));
  console.log('\nPick an app ID from above and re-run:');
  console.log('  npx tsx scripts/smoke-localizations.ts --app <APP_ID>');
}

async function smokeApp(client: ReturnType<typeof createASCClient>, appId: string): Promise<void> {
  console.log(`=== Localization surface for app ${appId} ===\n`);

  // 1. App Store versions
  console.log('--- App Store versions (newest first) ---\n');
  let versions: Awaited<ReturnType<typeof paginate>>;
  try {
    versions = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(
        appId,
      )}/appStoreVersions?fields[appStoreVersions]=platform,versionString,appStoreState,appVersionState,releaseType,createdDate&sort=-createdDate&limit=20`,
      20,
    );
    console.log(digestAppStoreVersions(versions));
  } catch (err) {
    console.log(`[FAIL] appStoreVersions: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2. App Store version localizations on the newest version
  const firstVersion = versions.data[0];
  if (firstVersion) {
    console.log(`\n--- Localizations on newest version ${firstVersion.id} ---\n`);
    try {
      const versionLocs = await paginate(
        client,
        `/v1/appStoreVersions/${encodeURIComponent(
          firstVersion.id,
        )}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=description,locale,keywords,marketingUrl,promotionalText,supportUrl,whatsNew&limit=100`,
        100,
      );
      console.log(digestAppStoreVersionLocalizations(versionLocs));
      const firstLoc = versionLocs.data[0];
      if (firstLoc?.attributes) {
        const attrs = firstLoc.attributes as Record<string, unknown>;
        const hasCamel = 'marketingUrl' in attrs || 'supportUrl' in attrs;
        const hasCaps = 'marketingURL' in attrs || 'supportURL' in attrs;
        console.log(
          `\n[wire-key] marketingUrl/supportUrl present: ${hasCamel} · all-caps form present: ${hasCaps} (expected: camelCase yes, all-caps no)`,
        );
      }
    } catch (err) {
      console.log(
        `[FAIL] appStoreVersionLocalizations: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 3. Subscription groups -> first subscription -> its localizations
  console.log('\n--- Subscription groups ---\n');
  let groups: Awaited<ReturnType<typeof paginate>>;
  try {
    groups = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?limit=20`,
      20,
    );
    if (groups.data.length === 0) {
      console.log('(no subscription groups on this app — skipping subscription localizations)');
    } else {
      console.log(digestSubscriptionGroups(groups));
      const firstGroup = groups.data[0];
      if (firstGroup) {
        console.log(`\n  -- Subscriptions in group ${firstGroup.id} --\n`);
        const subs = await paginate(
          client,
          `/v1/subscriptionGroups/${encodeURIComponent(firstGroup.id)}/subscriptions?limit=20`,
          20,
        );
        if (subs.data.length > 0) {
          console.log(digestSubscriptions(subs));
          const firstSub = subs.data[0];
          if (firstSub) {
            console.log(`\n  -- Localizations on subscription ${firstSub.id} --\n`);
            try {
              const subLocs = await paginate(
                client,
                `/v1/subscriptions/${encodeURIComponent(
                  firstSub.id,
                )}/subscriptionLocalizations?fields[subscriptionLocalizations]=name,locale,description,state&limit=100`,
                100,
              );
              console.log(digestSubscriptionLocalizations(subLocs));
            } catch (err) {
              console.log(
                `[FAIL] subscriptionLocalizations: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      }
    }
  } catch (err) {
    console.log(`[FAIL] subscriptionGroups: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. v2 IAPs -> first IAP -> its localizations
  console.log('\n--- v2 IAPs ---\n');
  try {
    const iaps = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(appId)}/inAppPurchasesV2?limit=20`,
      20,
    );
    if (iaps.data.length === 0) {
      console.log('(no v2 IAPs on this app — skipping IAP localizations)');
    } else {
      console.log(digestIaps(iaps));
      const firstIap = iaps.data[0];
      if (firstIap) {
        console.log(`\n  -- Localizations on IAP ${firstIap.id} --\n`);
        try {
          const iapLocs = await paginate(
            client,
            `/v2/inAppPurchases/${encodeURIComponent(
              firstIap.id,
            )}/inAppPurchaseLocalizations?fields[inAppPurchaseLocalizations]=name,locale,description,state&limit=100`,
            100,
          );
          console.log(digestIapLocalizations(iapLocs));
        } catch (err) {
          console.log(
            `[FAIL] inAppPurchaseLocalizations: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    console.log(`[FAIL] inAppPurchasesV2: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('\n\n=== Smoke complete ===');
  console.log(
    'To exercise WRITES (post/patch/delete), use the MCP tools via a Claude session — reload the MCP from the local build first.',
  );
}

async function main(): Promise<void> {
  let appId: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--app' && args[i + 1]) {
      appId = args[i + 1];
      i++;
    }
  }

  const config = loadConfig();
  const client = createASCClient(config);

  if (appId) {
    await smokeApp(client, appId);
  } else {
    await enumerate(client);
  }
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
