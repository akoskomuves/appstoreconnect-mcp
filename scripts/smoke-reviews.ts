#!/usr/bin/env tsx
// Live smoke for the v0.19 customer-reviews surface. STRICTLY READ-ONLY:
// review responses publish on the App Store — never drill the respond /
// delete tools against a live app from a smoke.
//
// Usage:
//   npx tsx scripts/smoke-reviews.ts <APP_ID>

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestCustomerReviewSummarizations, digestCustomerReviews } from '../src/digest.js';
import { buildReviewListQuery } from '../src/domains/customer-reviews.js';
import { paginate } from '../src/jsonapi.js';

async function main(): Promise<void> {
  const appId = process.argv[2];
  if (!appId) {
    console.error('Usage: npx tsx scripts/smoke-reviews.ts <APP_ID>');
    process.exit(1);
  }
  const client = createASCClient(loadConfig());

  console.log(`=== All reviews (newest first) on app ${appId} ===\n`);
  const all = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/customerReviews?${buildReviewListQuery({}).toString()}`,
    200,
  );
  console.log(digestCustomerReviews(all));

  console.log('\n=== Unanswered queue (exists[publishedResponse]=false) ===\n');
  const unanswered = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/customerReviews?${buildReviewListQuery({ hasPublishedResponse: false }).toString()}`,
    200,
  );
  console.log(digestCustomerReviews(unanswered));

  console.log('\n=== Low ratings (1-3★, sorted by rating) ===\n');
  const low = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/customerReviews?${buildReviewListQuery({ ratings: ['1', '2', '3'], sort: 'rating' }).toString()}`,
    200,
  );
  console.log(digestCustomerReviews(low));

  const first = all.data[0];
  if (first) {
    console.log(`\n=== Single review ${first.id} (include=response) ===\n`);
    const single = await client.request<{ data?: { attributes?: Record<string, unknown> } }>(
      `/v1/customerReviews/${encodeURIComponent(first.id)}?include=response`,
      { method: 'GET' },
    );
    console.log(JSON.stringify(single.data?.attributes ?? {}, null, 2));

    console.log(`\n=== Response of review ${first.id} (likely none) ===\n`);
    try {
      const resp = await client.request<unknown>(
        `/v1/customerReviews/${encodeURIComponent(first.id)}/response`,
        { method: 'GET' },
      );
      console.log(JSON.stringify(resp, null, 2).slice(0, 800));
    } catch (err) {
      console.log(`(error path: ${err instanceof Error ? err.message.split('\n')[0] : err})`);
    }
  } else {
    console.log('\n(no reviews on this app — single-review drill skipped)');
  }

  // Version-scoped list via the latest App Store version.
  console.log('\n=== Version-scoped list (latest version) ===\n');
  const versions = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?fields[appStoreVersions]=versionString,appVersionState&limit=1`,
    1,
  );
  const latest = versions.data[0];
  if (latest) {
    const scoped = await paginate(
      client,
      `/v1/appStoreVersions/${encodeURIComponent(latest.id)}/customerReviews?${buildReviewListQuery({}).toString()}`,
      200,
    );
    console.log(`version ${latest.attributes?.versionString} (${latest.id}):`);
    console.log(digestCustomerReviews(scoped));
  }

  console.log('\n=== Summarizations (IOS) ===\n');
  const sumParams = new URLSearchParams();
  sumParams.set(
    'fields[customerReviewSummarizations]',
    'createdDate,locale,platform,text,territory',
  );
  sumParams.set('filter[platform]', 'IOS');
  sumParams.set('limit', '200');
  const sums = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/customerReviewSummarizations?${sumParams.toString()}`,
    200,
  );
  console.log(digestCustomerReviewSummarizations(sums));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
