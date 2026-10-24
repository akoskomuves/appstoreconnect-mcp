#!/usr/bin/env tsx
// Live smoke for API-gap section D: IAP / subscription / subscription-group
// versions, IAP offer codes, build uploads and build bundles.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     SMOKE_APP_ID=<app id> npx tsx scripts/smoke-product-versions.ts
//
// Without SMOKE_APP_ID it walks every app on the account until it finds one
// with IAPs / subscriptions / build uploads.
//
// READS AND DRY RUNS ONLY. It drives the real tool handlers (registered onto a
// capturing stub server) so the exact query strings the tools send are what
// Apple sees. Version creation and offer codes on a real product are
// customer-facing or permanent (no DELETE on either), so the post tools run
// with dryRun only, and offer-code / build-upload writes are not called at
// all. Every ID is discovered, never hardcoded.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { registerBuildUploads } from '../src/domains/build-uploads.js';
import { registerIapOfferCodes } from '../src/domains/iap-offer-codes.js';
import { registerProductVersions } from '../src/domains/product-versions.js';
import { ascErrorText } from '../src/errors.js';
import { type JSONAPIResource, paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
const tools = new Map<string, { schema: { parse: (v: unknown) => unknown }; handler: Handler }>();
const stub = {
  registerTool(
    name: string,
    def: { inputSchema: { parse: (v: unknown) => unknown } },
    handler: Handler,
  ) {
    tools.set(name, { schema: def.inputSchema, handler });
  },
} as never;
registerProductVersions(stub, client);
registerIapOfferCodes(stub, client);
registerBuildUploads(stub, client);

let failures = 0;
let calls = 0;

function clip(text: string, lines = 18): string {
  const all = text.split('\n');
  return all.length <= lines
    ? text
    : `${all.slice(0, lines).join('\n')}\n… (${all.length - lines} more lines)`;
}

/** Run a tool through its zod schema + handler, as the MCP server would. */
async function tool(
  name: string,
  args: Record<string, unknown>,
  expectError = false,
): Promise<string> {
  const t = tools.get(name);
  if (!t) throw new Error(`unknown tool ${name}`);
  calls += 1;
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  try {
    const res = await t.handler(t.schema.parse(args) as Record<string, unknown>);
    const text = res.content.map((c) => c.text).join('\n');
    if (res.isError && !expectError) {
      failures += 1;
      console.log(`FAILED:\n${clip(text, 40)}`);
    } else {
      console.log(clip(text));
    }
    return text;
  } catch (err) {
    failures += 1;
    console.log(`THREW: ${ascErrorText(err)}`);
    return '';
  }
}

function firstId(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1];
}

async function appIds(): Promise<string[]> {
  if (process.env.SMOKE_APP_ID) return [process.env.SMOKE_APP_ID];
  const apps = await paginate(client, '/v1/apps?fields[apps]=name&limit=200', 200);
  return apps.data.map((a) => a.id);
}

async function list(path: string, max = 50): Promise<JSONAPIResource[]> {
  try {
    return (await paginate(client, path, max)).data;
  } catch (err) {
    console.log(`(discovery ${path} failed: ${ascErrorText(err)})`);
    return [];
  }
}

async function smokeVersions(
  kind: 'iap' | 'subscription' | 'subscription_group',
  parentId: string,
): Promise<void> {
  const text = await tool(`asc_list_${kind}_versions`, { parentId, raw: true });
  let versions: JSONAPIResource[] = [];
  try {
    versions = (JSON.parse(text) as { data: JSONAPIResource[] }).data;
  } catch {
    return;
  }
  await tool(`asc_list_${kind}_versions`, { parentId });
  await tool(`asc_list_${kind}_versions`, { parentId, state: ['APPROVED'] });
  await tool(`asc_post_${kind}_version`, { parentId, dryRun: true });
  const v = versions[0];
  if (!v) {
    console.log(`(no ${kind} versions on ${parentId})`);
    return;
  }
  console.log(`relationships on a list row: ${JSON.stringify(v.relationships ?? {})}`);
  await tool(`asc_get_${kind}_version`, { versionId: v.id });
  await tool(`asc_list_${kind}_version_localizations`, { versionId: v.id });
  if (kind !== 'subscription_group') {
    await tool(`asc_list_${kind}_version_images`, { versionId: v.id });
    await tool(`asc_get_${kind}_version_primary_image`, { versionId: v.id });
  }
}

async function smokeIapOfferCodes(iapId: string): Promise<boolean> {
  const raw = await tool('asc_list_iap_offer_codes', { inAppPurchaseId: iapId, raw: true });
  await tool('asc_list_iap_offer_codes', { inAppPurchaseId: iapId });
  await tool('asc_list_iap_offer_codes', { inAppPurchaseId: iapId, territoryId: 'USA' });
  let codes: JSONAPIResource[] = [];
  try {
    codes = (JSON.parse(raw) as { data: JSONAPIResource[] }).data;
  } catch {
    return false;
  }
  const oc = codes[0];
  if (!oc) return false;
  await tool('asc_get_iap_offer_code', { offerCodeId: oc.id });
  await tool('asc_list_iap_offer_code_prices', { offerCodeId: oc.id });
  const batches = await tool('asc_list_iap_offer_code_one_time_use_codes', {
    offerCodeId: oc.id,
    raw: true,
  });
  const batchId = firstId(
    batches,
    /"type": "inAppPurchaseOfferCodeOneTimeUseCodes",\s*"id": "([^"]+)"/,
  );
  if (batchId) await tool('asc_get_iap_offer_code_one_time_use_codes', { oneTimeUseId: batchId });
  const customs = await tool('asc_list_iap_offer_code_custom_codes', {
    offerCodeId: oc.id,
    raw: true,
  });
  const customId = firstId(
    customs,
    /"type": "inAppPurchaseOfferCodeCustomCodes",\s*"id": "([^"]+)"/,
  );
  if (customId) await tool('asc_get_iap_offer_code_custom_code', { customCodeId: customId });
  return true;
}

async function smokeBuilds(appId: string): Promise<boolean> {
  const raw = await tool('asc_list_build_uploads', { appId, maxItems: 5, raw: true });
  await tool('asc_list_build_uploads', { appId, maxItems: 5 });
  await tool('asc_list_build_uploads', {
    appId,
    maxItems: 5,
    state: ['COMPLETE'],
    platform: ['IOS'],
  });
  let uploads: JSONAPIResource[] = [];
  try {
    uploads = (JSON.parse(raw) as { data: JSONAPIResource[] }).data;
  } catch {
    // fall through
  }
  const u = uploads[0];
  if (u) {
    await tool('asc_get_build_upload', { buildUploadId: u.id });
    const files = await tool('asc_list_build_upload_files', { buildUploadId: u.id, raw: true });
    await tool('asc_list_build_upload_files', { buildUploadId: u.id });
    const fileId = firstId(files, /"type": "buildUploadFiles",\s*"id": "([^"]+)"/);
    if (fileId) await tool('asc_get_build_upload_file', { buildUploadFileId: fileId });
  }

  const builds = await list(`/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=3`, 3);
  const build = builds[0];
  if (build) {
    await tool('asc_list_build_bundles', { buildId: build.id });
    const res = await client.request<{ included?: JSONAPIResource[] }>(
      `/v1/builds/${build.id}?include=buildBundles&fields[buildBundles]=bundleType&limit[buildBundles]=50`,
    );
    const bundles = (res.included ?? []).filter((r) => r.type === 'buildBundles');
    console.log(
      `bundle ids: ${bundles.map((b) => `${b.id} (${b.attributes?.['bundleType']})`).join(', ')}`,
    );
    for (const bundle of bundles.slice(0, 3)) {
      const bundleId = bundle.id;
      await tool('asc_list_build_bundle_file_sizes', { buildBundleId: bundleId, maxItems: 20 });
      if (bundle.attributes?.['bundleType'] === 'APP_CLIP') {
        await tool(
          'asc_get_build_bundle_app_clip_domain_status',
          { buildBundleId: bundleId },
          true,
        );
        await tool(
          'asc_get_build_bundle_app_clip_domain_status',
          { buildBundleId: bundleId, kind: 'debug' },
          true,
        );
        await tool(
          'asc_list_build_bundle_beta_app_clip_invocations',
          { buildBundleId: bundleId },
          true,
        );
      }
    }
  }

  // asc_upload_build dry run against a throwaway local file: exercises UTI
  // inference + fs.stat + both bodies, sends nothing.
  const dir = mkdtempSync(join(tmpdir(), 'ppp-smoke-'));
  try {
    const file = join(dir, 'Smoke.ipa');
    writeFileSync(file, 'not a real ipa');
    await tool('asc_upload_build', {
      appId,
      localFilePath: file,
      cfBundleShortVersionString: '0.0.1',
      cfBundleVersion: '1',
      platform: 'IOS',
      dryRun: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return uploads.length > 0;
}

async function main(): Promise<void> {
  let doneIap = false;
  let doneOfferCodes = false;
  let doneSub = false;
  let doneGroup = false;
  let doneBuilds = false;
  for (const appId of await appIds()) {
    if (doneIap && doneSub && doneGroup && doneBuilds && doneOfferCodes) break;
    console.log(`\n##### app ${appId}`);
    const iaps = await list(`/v1/apps/${appId}/inAppPurchasesV2?limit=50`);
    for (const iap of iaps) {
      if (!doneIap) {
        await smokeVersions('iap', iap.id);
        doneIap = true;
      }
      if (!doneOfferCodes) doneOfferCodes = await smokeIapOfferCodes(iap.id);
      if (doneOfferCodes) break;
    }
    const groups = await list(`/v1/apps/${appId}/subscriptionGroups?limit=10`);
    const group = groups[0];
    if (group && !doneGroup) {
      await smokeVersions('subscription_group', group.id);
      doneGroup = true;
    }
    if (group && !doneSub) {
      const subs = await list(`/v1/subscriptionGroups/${group.id}/subscriptions?limit=5`);
      const sub = subs[0];
      if (sub) {
        await smokeVersions('subscription', sub.id);
        doneSub = true;
      }
    }
    if (!doneBuilds) doneBuilds = await smokeBuilds(appId);
  }
  console.log(
    `\n${calls} tool calls, ${failures} failures. Covered: iap versions=${doneIap} iap offer codes=${doneOfferCodes} subscription versions=${doneSub} group versions=${doneGroup} build uploads=${doneBuilds}`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(ascErrorText(err));
  process.exitCode = 1;
});
