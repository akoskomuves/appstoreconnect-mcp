#!/usr/bin/env tsx
// Live READ-ONLY smoke for the API 4.6 retention messages + retention offers
// reads. Never writes: retention messages and offers are customer-facing.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-retention-messages.ts
//
// For every app: list its retention messages with the exact query the tool
// sends, and drill into each message (get, versions, each version + its
// localizations + placement, assigned subscriptions). For every subscription
// of every app: its assigned retention message, all retention offers, the
// presented ones, and for each offer the get + prices. Any Apple error is
// printed with ascErrorText and counted; the script exits 1 if any read failed.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  buildRetentionMessageListQuery,
  buildRetentionOfferListQuery,
  digestRetentionMessageLocalizations,
  digestRetentionMessages,
  digestRetentionMessageVersions,
  digestRetentionOfferPrices,
  digestRetentionOffers,
} from '../src/domains/retention-messages.js';
import { ascErrorText } from '../src/errors.js';
import { type CollectedPages, paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());
let failures = 0;
const counts = { apps: 0, messages: 0, versions: 0, subscriptions: 0, offers: 0, presented: 0 };

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const out = await fn();
    console.log(`  ok   ${label}`);
    return out;
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${label}\n       ${ascErrorText(err).slice(0, 600)}`);
    return undefined;
  }
}

const enc = encodeURIComponent;

async function drillMessage(messageId: string): Promise<void> {
  await step(`GET retentionMessages/${messageId}`, () =>
    client.request(`/v1/retentionMessages/${enc(messageId)}?include=versions,subscriptions`),
  );
  const versions = await step(`GET retentionMessages/${messageId}/versions`, () =>
    paginate(
      client,
      `/v1/retentionMessages/${enc(messageId)}/versions?fields[retentionMessageVersions]=state,retentionMessage,localizations,placement&include=localizations&fields[retentionMessageLocalizations]=locale&limit[localizations]=50&limit=200`,
      200,
    ),
  );
  if (versions) {
    console.log(indent(digestRetentionMessageVersions(versions)));
    for (const v of versions.data) {
      counts.versions += 1;
      await step(`GET retentionMessageVersions/${v.id}`, () =>
        client.request(
          `/v1/retentionMessageVersions/${enc(v.id)}?include=retentionMessage,localizations,placement&limit[localizations]=50`,
        ),
      );
      const locs = await step(`GET retentionMessageVersions/${v.id}/localizations`, () =>
        paginate(
          client,
          `/v1/retentionMessageVersions/${enc(v.id)}/localizations?fields[retentionMessageLocalizations]=locale,header,body,retentionMessageVersion&limit=200`,
          200,
        ),
      );
      if (locs) {
        console.log(indent(digestRetentionMessageLocalizations(locs)));
        const first = locs.data[0];
        if (first) {
          await step(`GET retentionMessageLocalizations/${first.id}`, () =>
            client.request(
              `/v1/retentionMessageLocalizations/${enc(first.id)}?include=retentionMessageVersion`,
            ),
          );
        }
      }
      const placement = await step(`GET retentionMessageVersions/${v.id}/placement`, () =>
        client.request<{ data: unknown }>(
          `/v1/retentionMessageVersions/${enc(v.id)}/placement?include=image,video`,
        ),
      );
      if (placement) console.log(`       placement: ${placement.data === null ? 'none' : 'set'}`);
    }
  }
  const subs = await step(`GET retentionMessages/${messageId}/subscriptions`, () =>
    paginate(client, `/v1/retentionMessages/${enc(messageId)}/subscriptions?limit=200`, 200),
  );
  if (subs) console.log(`       assigned to ${subs.data.length} subscription(s)`);
}

async function drillSubscription(subId: string, label: string): Promise<void> {
  counts.subscriptions += 1;
  console.log(`\n  -- subscription ${subId} (${label}) --`);
  const msg = await step(`GET subscriptions/${subId}/retentionMessage`, () =>
    client.request<{ data: { id: string } | null }>(
      `/v1/subscriptions/${enc(subId)}/retentionMessage?include=versions&fields[retentionMessageVersions]=state`,
    ),
  );
  if (msg) console.log(`       retention message: ${msg.data ? msg.data.id : 'none'}`);
  const offers = await step(`GET subscriptions/${subId}/retentionOffers`, () =>
    paginate(
      client,
      `/v1/subscriptions/${enc(subId)}/retentionOffers?${buildRetentionOfferListQuery()}`,
      200,
    ),
  );
  const presented = await step(`GET subscriptions/${subId}/retentionMessageOffers`, () =>
    paginate(
      client,
      `/v1/subscriptions/${enc(subId)}/retentionMessageOffers?${buildRetentionOfferListQuery()}`,
      200,
    ),
  );
  if (presented) counts.presented += presented.data.length;
  if (offers) {
    if (offers.data.length) console.log(indent(digestRetentionOffers(offers)));
    for (const o of offers.data) {
      counts.offers += 1;
      await step(`GET retentionOffers/${o.id}`, () =>
        client.request(`/v1/retentionOffers/${enc(o.id)}?include=subscription,prices`),
      );
      const prices = await step(`GET retentionOffers/${o.id}/prices`, () =>
        paginate(
          client,
          `/v1/retentionOffers/${enc(o.id)}/prices?include=territory,subscriptionPricePoint&limit=200`,
          500,
        ),
      );
      if (prices) console.log(indent(digestRetentionOfferPrices(prices)));
    }
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `       ${l}`)
    .join('\n');
}

async function main(): Promise<void> {
  const apps = await paginate(client, '/v1/apps?fields[apps]=name,bundleId&limit=200', 200);
  for (const app of apps.data) {
    counts.apps += 1;
    console.log(`\n=== App ${app.id} (${app.attributes?.['name'] ?? ''}) ===`);
    const messages: CollectedPages | undefined = await step(
      `GET apps/${app.id}/retentionMessages`,
      () =>
        paginate(
          client,
          `/v1/apps/${enc(app.id)}/retentionMessages?${buildRetentionMessageListQuery()}`,
          200,
        ),
    );
    if (messages) {
      console.log(indent(digestRetentionMessages(messages)));
      for (const m of messages.data) {
        counts.messages += 1;
        await drillMessage(m.id);
      }
    }
    const groups = await step(`GET apps/${app.id}/subscriptionGroups`, () =>
      paginate(client, `/v1/apps/${enc(app.id)}/subscriptionGroups?limit=200`, 200),
    );
    for (const g of groups?.data ?? []) {
      const subs = await step(`GET subscriptionGroups/${g.id}/subscriptions`, () =>
        paginate(
          client,
          `/v1/subscriptionGroups/${enc(g.id)}/subscriptions?fields[subscriptions]=productId&limit=200`,
          200,
        ),
      );
      for (const s of subs?.data ?? []) {
        await drillSubscription(s.id, String(s.attributes?.['productId'] ?? ''));
      }
    }
  }
  console.log(`\nSummary: ${JSON.stringify(counts)}; failed reads: ${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(ascErrorText(err));
  process.exit(1);
});
