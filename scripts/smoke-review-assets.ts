#!/usr/bin/env tsx
// Live smoke test for the v1.2.0 review-assets reads (IAP + subscription images
// and App Store review screenshots). Run by a human with real ASC creds in env.
//
// Usage:
//   …creds… npx tsx scripts/smoke-review-assets.ts                 # enumerate apps → IAPs + subs
//   …creds… npx tsx scripts/smoke-review-assets.ts --iap <IAP_ID>  # IAP images + review screenshot
//   …creds… npx tsx scripts/smoke-review-assets.ts --sub <SUB_ID>  # subscription images + review screenshot
//
// Verifies (without writing): the four read paths exist and return walkable
// shapes, the images list digest renders (incl. zero-row), and the to-one
// review-screenshot link returns either a resource or null data cleanly.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestApps, digestReviewAssets } from '../src/digest.js';
import { paginate } from '../src/jsonapi.js';

async function enumerate(client: ReturnType<typeof createASCClient>): Promise<void> {
  const apps = await paginate(client, '/v1/apps?limit=200', 200);
  console.log(digestApps(apps));
  for (const app of apps.data) {
    console.log(`\n=== ${app.attributes?.['name'] ?? app.id} (${app.id}) ===`);
    const iaps = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(app.id)}/inAppPurchasesV2?fields[inAppPurchases]=name,productId,state&limit=200`,
      200,
    );
    console.log(`  IAPs (${iaps.data.length}):`);
    for (const i of iaps.data) {
      console.log(
        `    ${i.id}  ${i.attributes?.['name'] ?? ''} [${i.attributes?.['state'] ?? ''}]`,
      );
    }
    const subs = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(app.id)}/subscriptionGroups?limit=200`,
      200,
    );
    for (const g of subs.data) {
      const gs = await paginate(
        client,
        `/v1/subscriptionGroups/${encodeURIComponent(g.id)}/subscriptions?fields[subscriptions]=name&limit=200`,
        200,
      );
      for (const s of gs.data) {
        console.log(`    SUB ${s.id}  ${s.attributes?.['name'] ?? ''}`);
      }
    }
  }
  console.log('\nRe-run with --iap <IAP_ID> or --sub <SUB_ID>.');
}

async function smokeImages(
  client: ReturnType<typeof createASCClient>,
  parentPath: string,
  label: string,
): Promise<void> {
  console.log(`\n--- ${label} images ---`);
  const pages = await paginate(
    client,
    `${parentPath}/images?fields[${label.includes('IAP') ? 'inAppPurchaseImages' : 'subscriptionImages'}]=fileName,fileSize,sourceFileChecksum,state&limit=200`,
    200,
  );
  console.log(`[ok] images list accepted — data=${pages.data.length}`);
  console.log(digestReviewAssets(pages, `${label} images`));
}

async function smokeReviewScreenshot(
  client: ReturnType<typeof createASCClient>,
  parentPath: string,
  label: string,
): Promise<void> {
  console.log(`\n--- ${label} review screenshot (to-one) ---`);
  const res = await client.request<{ data?: { id?: string } | null }>(
    `${parentPath}/appStoreReviewScreenshot`,
    { method: 'GET' },
  );
  console.log(
    `[ok] appStoreReviewScreenshot link accepted — ${res.data ? `present (${res.data.id})` : 'none (null data)'}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let iapId: string | undefined;
  let subId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iap' && args[i + 1]) iapId = args[++i];
    if (args[i] === '--sub' && args[i + 1]) subId = args[++i];
  }
  const client = createASCClient(loadConfig());

  if (!iapId && !subId) {
    await enumerate(client);
    return;
  }
  if (iapId) {
    const base = `/v2/inAppPurchases/${encodeURIComponent(iapId)}`;
    await smokeImages(client, base, 'IAP');
    await smokeReviewScreenshot(client, base, 'IAP');
  }
  if (subId) {
    const base = `/v1/subscriptions/${encodeURIComponent(subId)}`;
    await smokeImages(client, base, 'Subscription');
    await smokeReviewScreenshot(client, base, 'Subscription');
  }
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
