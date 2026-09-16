#!/usr/bin/env tsx
// Live smoke for the v1.12.0 subscription-product-creation surfaces.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-subscription-products.ts
//
// WHAT THIS WRITES, AND WHY THAT IS SAFE
//
// A SubscriptionGroup and its localizations are developer-side config: they
// are invisible to customers until a subscription inside the group is
// submitted and approved, and they are freely deletable while the group holds
// no approved product. So the group + group-localization paths get a full
// create -> read -> patch -> delete drill, in a try/finally that always
// cleans up. This is the same exception the live-smoke protocol already makes
// for webhooks.
//
// The SUBSCRIPTION create is NOT run by default. Creating one burns its
// productId permanently — Apple never releases a product identifier for reuse
// on an account, even after the subscription is deleted. Opt in explicitly:
//
//   SMOKE_BURN_PRODUCT_ID=com.example.app.pppsmoke.donotuse.20260916 \
//     npx tsx scripts/smoke-subscription-products.ts
//
// Pick a junk identifier you are content to lose forever.
//
// Every ID is discovered, never hardcoded.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestSubscriptionGroupLocalizations, digestSubscriptionGroups } from '../src/digest.js';
import {
  buildSubscriptionGroupLocalizationCreateBody,
  buildSubscriptionGroupLocalizationPatchBody,
} from '../src/domains/subscription-group-localizations.js';
import {
  buildSubscriptionCreateBody,
  buildSubscriptionGroupCreateBody,
  buildSubscriptionGroupPatchBody,
  buildSubscriptionPatchBody,
  evaluateSubscriptionDeleteGate,
  evaluateSubscriptionGroupDeleteGate,
} from '../src/domains/subscriptions.js';
import { paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());
const STAMP = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
const BURN_PRODUCT_ID = process.env.SMOKE_BURN_PRODUCT_ID;

function section(label: string): void {
  console.log(`\n=== ${label} ===`);
}

interface ListDoc<T = { id?: string; attributes?: Record<string, unknown> }> {
  data?: T[];
}
interface SingleDoc {
  data?: { id?: string; attributes?: Record<string, unknown> };
}

async function resolveAppId(): Promise<string> {
  if (process.env.SMOKE_APP_ID) return process.env.SMOKE_APP_ID;
  const wanted = process.env.SMOKE_BUNDLE_ID ?? 'com.akoskomuves.WikiCatch';
  const byBundle = await client.request<ListDoc>(
    `/v1/apps?filter[bundleId]=${encodeURIComponent(wanted)}&limit=1`,
  );
  const hit = byBundle.data?.[0]?.id;
  if (hit) return hit;
  const any = await client.request<ListDoc>('/v1/apps?limit=1');
  const fallback = any.data?.[0]?.id;
  if (!fallback) throw new Error('no apps on this account — cannot smoke');
  return fallback;
}

async function main(): Promise<void> {
  const appId = await resolveAppId();
  console.log(`smoke target app: ${appId}`);

  // ---- 1. Read path: existing groups (works even on an app with none) ----
  section('asc_list_subscription_groups');
  const existing = await paginate(
    client,
    `/v1/apps/${appId}/subscriptionGroups?fields[subscriptionGroups]=referenceName&limit=200`,
    500,
  );
  console.log(digestSubscriptionGroups(existing));

  let groupId: string | undefined;
  let localizationId: string | undefined;
  let subscriptionId: string | undefined;

  try {
    // ---- 2. Create a group ----
    section('asc_post_subscription_group');
    const refName = `ppp smoke ${STAMP} (delete me)`;
    const created = await client.request<SingleDoc>('/v1/subscriptionGroups', {
      method: 'POST',
      body: JSON.stringify(buildSubscriptionGroupCreateBody({ appId, referenceName: refName })),
    });
    groupId = created.data?.id;
    console.log(
      `created group ${groupId} referenceName="${created.data?.attributes?.referenceName}"`,
    );
    if (!groupId) throw new Error('create returned no id');

    // ---- 3. GET it back ----
    section('asc_get_subscription_group');
    const fetched = await client.request<SingleDoc>(`/v1/subscriptionGroups/${groupId}`);
    console.log(JSON.stringify(fetched.data?.attributes, null, 2));

    // ---- 4. Rename it ----
    section('asc_patch_subscription_group');
    const renamed = await client.request<SingleDoc>(`/v1/subscriptionGroups/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify(
        buildSubscriptionGroupPatchBody({ groupId, referenceName: `${refName} renamed` }),
      ),
    });
    console.log(`referenceName now "${renamed.data?.attributes?.referenceName}"`);

    // ---- 5. Group localization: create / list / patch ----
    section('asc_post_subscription_group_localization');
    const loc = await client.request<SingleDoc>('/v1/subscriptionGroupLocalizations', {
      method: 'POST',
      body: JSON.stringify(
        buildSubscriptionGroupLocalizationCreateBody({
          groupId,
          name: `PPP Smoke ${STAMP.slice(-6)}`,
          locale: 'en-US',
        }),
      ),
    });
    localizationId = loc.data?.id;
    console.log(`created group localization ${localizationId}`);
    console.log(`state on create: ${loc.data?.attributes?.state}`);

    section('asc_list_subscription_group_localizations');
    const locList = await paginate(
      client,
      `/v1/subscriptionGroups/${groupId}/subscriptionGroupLocalizations` +
        '?fields[subscriptionGroupLocalizations]=name,customAppName,locale,state&limit=200',
      500,
    );
    console.log(digestSubscriptionGroupLocalizations(locList));

    if (localizationId) {
      section('asc_patch_subscription_group_localization');
      const patched = await client.request<SingleDoc>(
        `/v1/subscriptionGroupLocalizations/${localizationId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(
            buildSubscriptionGroupLocalizationPatchBody({
              subscriptionGroupLocalizationId: localizationId,
              name: `PPP Smoke ${STAMP.slice(-6)} v2`,
            }),
          ),
        },
      );
      console.log(`name now "${patched.data?.attributes?.name}"`);
    }

    // ---- 6. Subscription create — opt-in only (burns a productId) ----
    if (BURN_PRODUCT_ID) {
      section('asc_post_subscription (BURNING a productId)');
      const sub = await client.request<SingleDoc>('/v1/subscriptions', {
        method: 'POST',
        body: JSON.stringify(
          buildSubscriptionCreateBody({
            groupId,
            name: `ppp smoke sub ${STAMP}`,
            productId: BURN_PRODUCT_ID,
            subscriptionPeriod: 'ONE_MONTH',
          }),
        ),
      });
      subscriptionId = sub.data?.id;
      console.log(`created subscription ${subscriptionId}`);
      console.log(`state on create: ${sub.data?.attributes?.state} (expect MISSING_METADATA)`);
      console.log(`period: ${sub.data?.attributes?.subscriptionPeriod}`);

      if (subscriptionId) {
        section('asc_patch_subscription');
        const patchedSub = await client.request<SingleDoc>(`/v1/subscriptions/${subscriptionId}`, {
          method: 'PATCH',
          body: JSON.stringify(
            buildSubscriptionPatchBody({ subscriptionId, groupLevel: 1, familySharable: false }),
          ),
        });
        console.log(
          `groupLevel=${patchedSub.data?.attributes?.groupLevel} familySharable=${patchedSub.data?.attributes?.familySharable}`,
        );

        section('delete gate against the real state');
        const state = patchedSub.data?.attributes?.state as string | undefined;
        const gate = evaluateSubscriptionDeleteGate(state);
        console.log(`state=${state} -> allow=${gate.allow} ${gate.reason ?? ''}`);
      }
    } else {
      section('asc_post_subscription — SKIPPED');
      console.log('set SMOKE_BURN_PRODUCT_ID to drill the subscription create path.');
      console.log('Apple reserves the productId permanently, so this is opt-in on purpose.');
    }

    // ---- 7. Group delete gate against real children ----
    section('group delete gate against real children');
    const children = await client.request<
      ListDoc<{ id: string; attributes?: { name?: string; state?: string } }>
    >(`/v1/subscriptionGroups/${groupId}/subscriptions?fields[subscriptions]=name,state&limit=200`);
    const mapped = (children.data ?? []).map((c) => ({
      id: c.id,
      name: c.attributes?.name,
      state: c.attributes?.state,
    }));
    const groupGate = evaluateSubscriptionGroupDeleteGate(mapped);
    console.log(
      `${mapped.length} child subscription(s) -> allow=${groupGate.allow} ${groupGate.reason ?? ''}`,
    );
  } finally {
    // ---- Cleanup: always, in reverse order of creation ----
    section('cleanup');
    if (subscriptionId) {
      try {
        await client.request(`/v1/subscriptions/${subscriptionId}`, { method: 'DELETE' });
        console.log(`deleted subscription ${subscriptionId}`);
      } catch (err) {
        console.log(`!! could not delete subscription ${subscriptionId}: ${String(err)}`);
      }
    }
    if (localizationId) {
      try {
        await client.request(`/v1/subscriptionGroupLocalizations/${localizationId}`, {
          method: 'DELETE',
        });
        console.log(`deleted group localization ${localizationId}`);
      } catch (err) {
        console.log(`!! could not delete group localization ${localizationId}: ${String(err)}`);
      }
    }
    if (groupId) {
      try {
        await client.request(`/v1/subscriptionGroups/${groupId}`, { method: 'DELETE' });
        console.log(`deleted group ${groupId}`);
      } catch (err) {
        console.log(`!! could not delete group ${groupId}: ${String(err)}`);
        console.log('   ^ clean this up by hand in App Store Connect.');
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
