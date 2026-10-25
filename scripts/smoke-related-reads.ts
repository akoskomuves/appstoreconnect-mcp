#!/usr/bin/env tsx
// Live READ-ONLY smoke for the section-E part-2 reads: asc_get_related,
// the by-id reads, app info category slots, territory age ratings, price
// schedule prices, equalizations, TestFlight usage metrics, the performance
// overview, Android → iOS mappings and routing app coverage.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     SMOKE_APP_ID=<app id> npx tsx scripts/smoke-related-reads.ts
//
// Without SMOKE_APP_ID it uses the first app on the account. It never writes:
// the linkage tools, the Android mapping create/patch/delete and the
// resource PATCH/DELETEs change live state and are covered by unit tests only.
//
// Every ID is discovered, never hardcoded. A relationship with nothing behind
// it (no CI product, no routing coverage) is reported, not failed.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  APP_INFO_CATEGORY_SLOTS,
  BY_ID_READS,
  buildByIdPath,
  buildEqualizationsPath,
  buildPerformanceOverviewPath,
  buildPriceSchedulePricesPath,
  buildRelatedPath,
  buildTesterUsagePath,
  findRelatedRead,
  XCODE_OVERVIEW_ACCEPT,
} from '../src/domains/related-reads.js';
import { ASCError, ascErrorText } from '../src/errors.js';
import type { JSONAPIResource } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());

interface Doc {
  data?: JSONAPIResource | JSONAPIResource[] | null;
}

let failures = 0;
let checks = 0;

function describeDoc(doc: Doc | undefined): string {
  const d = doc?.data;
  if (d === undefined) return 'non-JSON:API body';
  if (d === null) return 'null (nothing linked)';
  if (Array.isArray(d)) return `${d.length} row(s)${d[0] ? ` of ${d[0].type}` : ''}`;
  return `${d.type} ${d.id}`;
}

async function get(label: string, path: string, init?: RequestInit): Promise<Doc | undefined> {
  checks += 1;
  try {
    const doc = await client.request<Doc>(path, init);
    console.log(`  ok   ${label} → ${describeDoc(doc)}`);
    return doc;
  } catch (err) {
    // A 404 on a to-one related read means "none" on some resources.
    if (err instanceof ASCError && err.status === 404) {
      console.log(`  none ${label} → 404`);
      return undefined;
    }
    // adjustedEqualizations only works on a subscription with a monthly-billed
    // plan; elsewhere Apple 409s "The upfront price point is invalid".
    if (
      err instanceof ASCError &&
      err.status === 409 &&
      ascErrorText(err).includes('upfront price point is invalid')
    ) {
      console.log(`  n/a  ${label} → 409 (no monthly-billed plan on this subscription)`);
      return undefined;
    }
    failures += 1;
    console.log(`  FAIL ${label}\n${ascErrorText(err)}`);
    return undefined;
  }
}

async function related(key: string, id: string | undefined, filters?: Record<string, string>) {
  if (!id) {
    console.log(`  skip ${key} (no parent id)`);
    return undefined;
  }
  const cfg = findRelatedRead(key);
  if (!cfg) throw new Error(`unknown key ${key}`);
  const built = buildRelatedPath(cfg, id, filters);
  if (!built.path) throw new Error(built.error);
  return get(`related ${key}`, built.path);
}

const first = (doc: Doc | undefined): JSONAPIResource | undefined =>
  Array.isArray(doc?.data) ? doc?.data[0] : (doc?.data ?? undefined);

async function main(): Promise<void> {
  const appId = process.env.SMOKE_APP_ID ?? first(await get('apps', '/v1/apps?limit=1'))?.id ?? '';
  if (!appId) throw new Error('no apps on this account');

  console.log('\n=== builds / TestFlight ===');
  const build = first(
    await get('builds', `/v1/builds?filter[app]=${appId}&limit=1&sort=-uploadedDate`),
  );
  for (const rel of [
    'app',
    'appStoreVersion',
    'betaAppReviewSubmission',
    'buildBetaDetail',
    'icons',
    'individualTesters',
    'preReleaseVersion',
  ]) {
    await related(`builds.${rel}`, build?.id);
  }
  const detail = first(await related('builds.buildBetaDetail', build?.id));
  await related('buildBetaDetails.build', detail?.id);
  const prv = first(await related('builds.preReleaseVersion', build?.id));
  await related('preReleaseVersions.app', prv?.id);
  await related('preReleaseVersions.builds', prv?.id);

  const group = first(await get('beta groups', `/v1/apps/${appId}/betaGroups?limit=1`));
  await related('betaGroups.app', group?.id);
  await related('betaGroups.builds', group?.id);
  const tester = first(await get('beta testers', `/v1/betaTesters?filter[apps]=${appId}&limit=1`));
  for (const rel of ['apps', 'betaGroups', 'builds'])
    await related(`betaTesters.${rel}`, tester?.id);

  const loc = first(
    await get('beta app localizations', `/v1/apps/${appId}/betaAppLocalizations?limit=1`),
  );
  await related('betaAppLocalizations.app', loc?.id);
  const brd = first(
    await get('beta app review detail', `/v1/betaAppReviewDetails?filter[app]=${appId}`),
  );
  await related('betaAppReviewDetails.app', brd?.id);

  console.log('\n=== usage metrics ===');
  for (const input of [
    { appId, period: 'P30D' as const },
    ...(group ? [{ betaGroupId: group.id, period: 'P30D' as const }] : []),
    ...(tester ? [{ betaTesterId: tester.id, appId, period: 'P30D' as const }] : []),
  ]) {
    const built = buildTesterUsagePath(input);
    if (built.path) await get(`betaTesterUsages ${Object.keys(input)[0]}`, built.path);
  }
  if (group) await get('publicLinkUsages', `/v1/betaGroups/${group.id}/metrics/publicLinkUsages`);
  if (build) await get('betaBuildUsages', `/v1/builds/${build.id}/metrics/betaBuildUsages`);

  console.log('\n=== app info / version ===');
  const info = first(await get('app infos', `/v1/apps/${appId}/appInfos?limit=1`));
  if (info) {
    for (const slot of APP_INFO_CATEGORY_SLOTS)
      await get(`appInfos.${slot}`, `/v1/appInfos/${info.id}/${slot}`);
    await get(
      'territoryAgeRatings',
      `/v1/appInfos/${info.id}/territoryAgeRatings?limit=5&include=territory`,
    );
  }
  const category = first(
    await get('appInfos.primaryCategory', `/v1/appInfos/${info?.id}/primaryCategory`),
  );
  await related('appCategories.subcategories', category?.id);
  await related('appCategories.parent', category?.id);

  const version = first(await get('versions', `/v1/apps/${appId}/appStoreVersions?limit=1`));
  await related('appStoreVersions.build', version?.id);
  await related('appStoreVersions.appStoreVersionExperimentsV2', version?.id);
  if (version) {
    await get('routingAppCoverage', `/v1/appStoreVersions/${version.id}/routingAppCoverage`);
  }

  console.log('\n=== pricing ===');
  await related('appPriceSchedules.baseTerritory', appId);
  for (const kind of ['manual', 'automatic'] as const) {
    await get(
      `app ${kind} prices`,
      buildPriceSchedulePricesPath('appPriceSchedules', appId, kind, { territory: 'USA' }),
    );
  }
  const point = first(
    await get('app price points', `/v1/apps/${appId}/appPricePoints?limit=1&filter[territory]=USA`),
  );
  if (point) {
    const v3 = BY_ID_READS.find((c) => c.tool === 'asc_get_app_price_point_v3');
    if (v3) await get('v3 app price point', buildByIdPath(v3, point.id));
    await get(
      'app equalizations',
      buildEqualizationsPath({ kind: 'app', pricePointId: point.id, territory: 'GBR' }),
    );
  }
  const iap = first(await get('IAPs', `/v1/apps/${appId}/inAppPurchasesV2?limit=1`));
  if (iap) {
    await related('inAppPurchasePriceSchedules.baseTerritory', iap.id);
    await get(
      'IAP manual prices',
      buildPriceSchedulePricesPath('inAppPurchasePriceSchedules', iap.id, 'manual', {}),
    );
    await related('inAppPurchases.content', iap.id);
    await related('inAppPurchases.promotedPurchase', iap.id);
  }
  const group0 = first(
    await get('subscription groups', `/v1/apps/${appId}/subscriptionGroups?limit=1`),
  );
  const sub = group0
    ? first(await get('subscriptions', `/v1/subscriptionGroups/${group0.id}/subscriptions?limit=1`))
    : undefined;
  await related('subscriptions.promotedPurchase', sub?.id);
  if (sub) {
    const sp = first(
      await get(
        'subscription price points',
        `/v1/subscriptions/${sub.id}/pricePoints?limit=1&filter[territory]=USA`,
      ),
    );
    if (sp) {
      await get(
        'subscription equalizations',
        buildEqualizationsPath({ kind: 'subscription', pricePointId: sp.id, territory: 'GBR' }),
      );
      await get(
        'subscription adjustedEqualizations',
        buildEqualizationsPath({
          kind: 'subscription',
          pricePointId: sp.id,
          adjusted: true,
          planType: 'MONTHLY',
          territory: 'GBR',
        }),
      );
    }
    const code = first(await get('offer codes', `/v1/subscriptions/${sub.id}/offerCodes?limit=1`));
    await related('subscriptionOfferCodes.prices', code?.id, { territory: 'USA' });
  }

  console.log('\n=== provisioning / Xcode Cloud ===');
  const bundle = first(await get('bundle ids', '/v1/bundleIds?limit=1'));
  for (const rel of ['app', 'bundleIdCapabilities', 'profiles'])
    await related(`bundleIds.${rel}`, bundle?.id);
  const profile = first(await get('profiles', '/v1/profiles?limit=1'));
  for (const rel of ['bundleId', 'certificates', 'devices'])
    await related(`profiles.${rel}`, profile?.id);
  const ciProduct = first(await related('apps.ciProduct', appId));
  if (ciProduct) {
    const byId = BY_ID_READS.find((c) => c.tool === 'asc_get_ci_product');
    if (byId) await get('ci product by id', buildByIdPath(byId, ciProduct.id));
    for (const rel of ['app', 'primaryRepositories', 'additionalRepositories']) {
      await related(`ciProducts.${rel}`, ciProduct.id);
    }
    const wf = first(await get('ci workflows', `/v1/ciProducts/${ciProduct.id}/workflows?limit=1`));
    await related('ciWorkflows.repository', wf?.id);
  }
  const xcode = first(await get('ci xcode versions', '/v1/ciXcodeVersions?limit=1'));
  await related('ciXcodeVersions.macOsVersions', xcode?.id);
  const mac = first(await get('ci macOS versions', '/v1/ciMacOsVersions?limit=1'));
  await related('ciMacOsVersions.xcodeVersions', mac?.id);

  console.log('\n=== review / encryption / tags ===');
  const submission = first(
    await get('review submissions', `/v1/reviewSubmissions?filter[app]=${appId}&limit=1`),
  );
  await related('reviewSubmissions.items', submission?.id);
  const decl = first(
    await get(
      'encryption declarations',
      `/v1/appEncryptionDeclarations?filter[app]=${appId}&limit=1`,
    ),
  );
  await related('appEncryptionDeclarations.appEncryptionDeclarationDocument', decl?.id);
  const tag = first(await get('app tags', `/v1/apps/${appId}/appTags?limit=1`));
  await related('appTags.territories', tag?.id);

  console.log('\n=== 4.5 / mappings ===');
  await get('performanceOverviews', buildPerformanceOverviewPath(appId), {
    headers: { accept: XCODE_OVERVIEW_ACCEPT },
  });
  await get('androidToIosAppMappingDetails', `/v1/apps/${appId}/androidToIosAppMappingDetails`);

  console.log(`\n${checks} checks, ${failures} failure(s).`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(ascErrorText(err));
  process.exitCode = 1;
});
