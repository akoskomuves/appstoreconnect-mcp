#!/usr/bin/env tsx
// Live smoke for the 1.17 move off Apple's product-scoped v1 IAP / subscription
// localization, image and submission endpoints (removed beginning in early
// 2027). READS ONLY: never creates a version, localization, image or review
// submission — those are customer-facing.
//
// Usage:
//   …creds… npx tsx scripts/smoke-version-migration.ts --app <APP_ID> [--iap <IAP_ID>] [--sub <SUBSCRIPTION_ID>]
//
// Checks, per product: the latest version resolves; its localizations list on
// the v2 path; each localization reads on /v2 by the SAME id the v1 list
// returned; the version-lock pre-check reads the version state; images list
// on the version. For the app: the draft-review-submission lookup the submit
// tools use before deciding to create or refuse.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  evaluateVersionLockGate,
  fetchLocalizationVersionState,
  resolveVersionForRead,
} from '../src/domains/product-version-resolve.js';
import type { ProductVersionKind } from '../src/domains/product-versions.js';
import { ascErrorText } from '../src/errors.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const client = createASCClient(loadConfig());
let failures = 0;

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const out = await fn();
    console.log(`  ok   ${label}`);
    return out;
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${label}\n       ${ascErrorText(err).slice(0, 400)}`);
    return undefined;
  }
}

interface Rows {
  data: Array<{ id: string; attributes?: Record<string, unknown> }>;
}

async function checkProduct(
  kind: ProductVersionKind,
  productId: string,
  v1LocalizationsPath: string,
  versionType: string,
  locType: string,
  hasImages: boolean,
): Promise<void> {
  console.log(`\n=== ${kind} ${productId}`);
  const vid = await step('latest version resolves', () =>
    resolveVersionForRead(client, kind, productId),
  );
  if (!vid) return;
  const v2 = await step('localizations list on the version (v2)', () =>
    client.request<Rows>(
      `/v1/${versionType}/${vid}/localizations?fields[${locType}]=locale,name&limit=50`,
    ),
  );
  const v1 = await step('v1 localization list (for the id comparison)', () =>
    client.request<Rows>(`${v1LocalizationsPath}?limit=50`),
  );
  if (v1 && v2) {
    const v1ids = new Set(v1.data.map((r) => r.id));
    const same = v2.data.filter((r) => v1ids.has(r.id)).length;
    console.log(
      `       v1 ${v1.data.length} / v2 ${v2.data.length} localizations, ${same} with the same id`,
    );
  }
  const first = v2?.data[0];
  if (first) {
    await step(`localization ${first.id} reads on /v2`, () =>
      client.request(`/v2/${locType}/${first.id}`),
    );
    const state = await fetchLocalizationVersionState(client, kind, locType, first.id);
    const gate = evaluateVersionLockGate(kind, state);
    console.log(
      `       version-lock pre-check: version state ${state ?? '(unread)'} → ${gate.allow ? 'edit allowed' : 'edit refused'}`,
    );
    if (!state) failures += 1;
  }
  if (hasImages) {
    await step('images list on the version', () =>
      client.request<Rows>(
        `/v1/${versionType}/${vid}/images?fields[${kind === 'iap' ? 'inAppPurchaseImages' : 'subscriptionImages'}]=fileName,fileSize,assetDeliveryState&limit=50`,
      ),
    );
  }
}

const appId = arg('app');
const iap = arg('iap');
const sub = arg('sub');
if (!appId) {
  console.error('Pass --app <APP_ID> (and optionally --iap / --sub).');
  process.exit(2);
}

if (iap) {
  await checkProduct(
    'iap',
    iap,
    `/v2/inAppPurchases/${iap}/inAppPurchaseLocalizations`,
    'inAppPurchaseVersions',
    'inAppPurchaseLocalizations',
    true,
  );
}
if (sub) {
  await checkProduct(
    'subscription',
    sub,
    `/v1/subscriptions/${sub}/subscriptionLocalizations`,
    'subscriptionVersions',
    'subscriptionLocalizations',
    true,
  );
  const withGroup = await client.request<{
    data: { relationships?: { group?: { data?: { id?: string } } } };
  }>(`/v1/subscriptions/${sub}?include=group`);
  const groupId = withGroup.data.relationships?.group?.data?.id;
  if (groupId) {
    await checkProduct(
      'subscriptionGroup',
      groupId,
      `/v1/subscriptionGroups/${groupId}/subscriptionGroupLocalizations`,
      'subscriptionGroupVersions',
      'subscriptionGroupLocalizations',
      false,
    );
  }
}

console.log(`\n=== app ${appId}`);
const drafts = await step('draft review submission lookup (filter[state]=READY_FOR_REVIEW)', () =>
  client.request<Rows>(
    `/v1/reviewSubmissions?filter[app]=${appId}&filter[state]=READY_FOR_REVIEW&fields[reviewSubmissions]=state&limit=200`,
  ),
);
if (drafts) {
  console.log(
    `       ${drafts.data.length} draft(s) → the submit tools would ${drafts.data.length ? 'REFUSE without reviewSubmissionId' : 'create a fresh submission'}`,
  );
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
