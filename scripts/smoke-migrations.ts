#!/usr/bin/env tsx
// Live smoke for the deprecated-endpoint migrations and the /v2 content tools.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     SMOKE_APP_ID=<app id> npx tsx scripts/smoke-migrations.ts
//
// Without SMOKE_APP_ID it uses the first app on the account.
//
// What it does:
//   * Subscription availability → UPFRONT plan: reads both the deprecated
//     record and the plan record for every subscription and checks the
//     territory sets match (the assumption the migration rests on).
//   * Marketplace webhooks → /v1/webhooks: lists the app's webhooks with the
//     marketplace filter, tries the legacy team-level list (403 is expected on
//     accounts without the marketplace entitlement), and runs a create → patch
//     → delete drill of a DISABLED webhook subscribed to one marketplace event.
//     On a non-marketplace app Apple 409s the create ("… event types cannot be
//     added to the webhook") — that is the expected result there, and the
//     drill only completes against a real marketplace app.
//     Webhooks are developer-only config, invisible to customers; the drill
//     always cleans up in a finally.
//   * /v2 content: GETs existing IAP / subscription localizations and images
//     through /v2 and checks they are the same records as /v1.
//
// IAP create is NOT exercised: Apple reserves a productId forever. Set
// SMOKE_BURN_PRODUCT_ID to opt in (creates a draft IAP and deletes it).
//
// Every ID is discovered, never hardcoded.

import { execFileSync } from 'node:child_process';
import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestWebhooks } from '../src/digest.js';
import {
  buildMarketplaceWebhookV2CreateBody,
  isMarketplaceWebhook,
} from '../src/domains/alternative-distribution.js';
import {
  isPlanAvailabilityId,
  pickStandardPlanAvailability,
} from '../src/domains/availabilities.js';
import {
  buildIapCreateBody,
  buildIapPatchBody,
  evaluateIapDeleteGate,
} from '../src/domains/iap-products.js';
import { buildWebhookPatchBody } from '../src/domains/webhooks.js';
import { ascErrorText } from '../src/errors.js';
import { type JSONAPIResource, paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());

interface ListDoc {
  data?: JSONAPIResource[];
}
interface SingleDoc {
  data?: JSONAPIResource | null;
}

let failures = 0;
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  console.log(`\n=== ${label} ===`);
  try {
    return await fn();
  } catch (err) {
    failures += 1;
    console.log(`FAILED: ${ascErrorText(err)}`);
    return undefined;
  }
}

async function resolveAppId(): Promise<string> {
  if (process.env.SMOKE_APP_ID) return process.env.SMOKE_APP_ID;
  const any = await client.request<ListDoc>('/v1/apps?limit=1');
  const id = any.data?.[0]?.id;
  if (!id) throw new Error('no apps on this account — cannot smoke');
  return id;
}

async function territorySet(path: string): Promise<Set<string>> {
  const pages = await paginate(client, `${path}?limit=200`, 500);
  return new Set(pages.data.map((t) => t.id));
}

async function main(): Promise<void> {
  try {
    execFileSync('node', ['scripts/check-dist-fresh.mjs'], { stdio: 'pipe' });
  } catch (err) {
    const e = err as { stderr?: Buffer };
    console.log(`\n!! ${e.stderr?.toString().trim() ?? 'dist/ is stale'}`);
    console.log('!! This smoke tests src/ and will pass regardless. Build before trusting it.\n');
  }

  const appId = await resolveAppId();
  console.log(`smoke target app: ${appId}`);

  // ---- Subscription availability → UPFRONT plan ----
  const groups = await client.request<ListDoc>(`/v1/apps/${appId}/subscriptionGroups?limit=10`);
  const subs: JSONAPIResource[] = [];
  for (const g of groups.data ?? []) {
    const doc = await client.request<ListDoc>(
      `/v1/subscriptionGroups/${g.id}/subscriptions?limit=20`,
    );
    subs.push(...(doc.data ?? []));
  }
  console.log(`\n${subs.length} subscription(s) on the app`);
  for (const sub of subs) {
    await step(`availability migration: subscription ${sub.id}`, async () => {
      const plans = await client.request<{
        data?: Array<{ id: string; attributes?: { planType?: string } }>;
      }>(`/v1/subscriptions/${sub.id}/planAvailabilities?limit=200`);
      const standard = pickStandardPlanAvailability(plans.data ?? []);
      console.log(
        `plans: ${(plans.data ?? []).map((p) => p.attributes?.planType).join(', ') || '(none)'}`,
      );
      if (!standard) {
        console.log('no UPFRONT plan — the tools report "0 territories" for this subscription');
        return;
      }
      if (!isPlanAvailabilityId(standard.id))
        throw new Error(`unexpected plan id shape ${standard.id}`);
      if (isPlanAvailabilityId(sub.id)) throw new Error('subscription id misread as a plan id');
      const plan = await territorySet(
        `/v1/subscriptionPlanAvailabilities/${encodeURIComponent(standard.id)}/availableTerritories`,
      );
      // Deprecated read, used here ONLY to check the migration's assumption.
      let legacy: Set<string> | undefined;
      try {
        legacy = await territorySet(
          `/v1/subscriptionAvailabilities/${sub.id}/availableTerritories`,
        );
      } catch (err) {
        console.log(
          `legacy read failed (fine if Apple has retired it): ${ascErrorText(err).slice(0, 200)}`,
        );
      }
      if (legacy) {
        const same = legacy.size === plan.size && [...legacy].every((t) => plan.has(t));
        console.log(
          `UPFRONT plan ${plan.size} territories, legacy ${legacy.size} — ${same ? 'IDENTICAL' : 'DIFFER'}`,
        );
        if (!same)
          throw new Error('legacy availability and UPFRONT plan differ — migration unsafe');
      } else {
        console.log(`UPFRONT plan ${plan.size} territories`);
      }
    });
  }

  // ---- Marketplace webhooks ----
  await step('asc_list_marketplace_webhooks (app webhooks, marketplace filter)', async () => {
    const all = await paginate(client, `/v1/apps/${appId}/webhooks?limit=200`, 200);
    const mk = all.data.filter(isMarketplaceWebhook);
    console.log(`${all.data.length} webhook(s), ${mk.length} with marketplace events`);
    if (mk.length) console.log(digestWebhooks({ ...all, data: mk }));
  });

  await step(
    'asc_list_marketplace_webhooks legacy:true (empty or 403 without the entitlement)',
    async () => {
      try {
        const pages = await paginate(client, '/v1/marketplaceWebhooks?limit=200', 200);
        console.log(`[ok] ${pages.data.length} legacy record(s)`);
      } catch (err) {
        console.log(`[ok] legacy list refused: ${ascErrorText(err).slice(0, 300)}`);
      }
    },
  );

  await step('marketplace webhook drill: create (disabled) → patch → delete', async () => {
    const body = buildMarketplaceWebhookV2CreateBody({
      marketplaceAppId: appId,
      endpointUrl: 'https://example.com/ppp-smoke-marketplace',
      secret: `ppp-smoke-${Date.now()}`,
      name: 'ppp-smoke-marketplace (safe to delete)',
      eventTypes: ['ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED'],
      enabled: false,
    });
    let createdId: string | undefined;
    try {
      try {
        const res = await client.request<SingleDoc>('/v1/webhooks', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        createdId = res.data?.id;
      } catch (err) {
        // A non-marketplace app may not accept marketplace events. Report it.
        console.log(`create refused: ${ascErrorText(err).slice(0, 400)}`);
        const list = await paginate(client, `/v1/apps/${appId}/webhooks?limit=200`, 200);
        createdId = list.data.find((w) =>
          String(w.attributes?.name).startsWith('ppp-smoke-marketplace'),
        )?.id;
        if (createdId) console.log(`…but the record exists (${createdId}) — cleaning up`);
        return;
      }
      console.log(`[ok] created ${createdId}`);
      const patched = await client.request<SingleDoc>(`/v1/webhooks/${createdId}`, {
        method: 'PATCH',
        body: JSON.stringify(
          buildWebhookPatchBody({
            webhookId: String(createdId),
            eventTypes: [
              'ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED',
              'ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED',
            ],
          }),
        ),
      });
      console.log(
        `[ok] patched eventTypes → ${JSON.stringify(patched.data?.attributes?.eventTypes)}`,
      );
      if (patched.data && !isMarketplaceWebhook(patched.data)) {
        throw new Error('patched webhook not recognised as a marketplace webhook');
      }
    } finally {
      if (createdId) {
        await client.request(`/v1/webhooks/${createdId}`, { method: 'DELETE' });
        console.log(`[ok] deleted ${createdId}`);
      }
    }
  });

  // ---- /v2 content GETs ----
  const iaps = await client.request<ListDoc>(`/v1/apps/${appId}/inAppPurchasesV2?limit=5`);
  const iap = iaps.data?.[0];
  if (iap) {
    await step(`/v2 IAP localization + image GET (iap ${iap.id})`, async () => {
      const locs = await client.request<ListDoc>(
        `/v2/inAppPurchases/${iap.id}/inAppPurchaseLocalizations?limit=1`,
      );
      const loc = locs.data?.[0];
      if (loc) {
        const v2 = await client.request<SingleDoc>(`/v2/inAppPurchaseLocalizations/${loc.id}`);
        console.log(
          `[ok] /v2 localization ${v2.data?.id} type ${v2.data?.type} (same id as /v1: ${v2.data?.id === loc.id})`,
        );
      } else console.log('no IAP localizations');
      const imgs = await client.request<ListDoc>(`/v2/inAppPurchases/${iap.id}/images?limit=1`);
      const img = imgs.data?.[0];
      if (img) {
        const v2 = await client.request<SingleDoc>(`/v2/inAppPurchaseImages/${img.id}`);
        console.log(`[ok] /v2 image ${v2.data?.id}`);
      } else console.log('no IAP images — /v2 image GET not exercised');
    });
    await step(`IAP delete gate on a live IAP (${iap.id}) — read only`, async () => {
      const doc = await client.request<SingleDoc>(
        `/v2/inAppPurchases/${iap.id}?fields[inAppPurchases]=state`,
      );
      const state = doc.data?.attributes?.state as string | undefined;
      const gate = evaluateIapDeleteGate(state);
      console.log(`state ${state} → ${gate.allow ? 'allow' : `refuse (${gate.reason})`}`);
    });
  } else {
    console.log('\nno IAPs on the app — /v2 IAP content GETs not exercised');
  }

  const sub = subs[0];
  if (sub) {
    await step(`/v2 subscription localization GET (sub ${sub.id})`, async () => {
      const locs = await client.request<ListDoc>(
        `/v1/subscriptions/${sub.id}/subscriptionLocalizations?limit=1`,
      );
      const loc = locs.data?.[0];
      if (!loc) return console.log('no subscription localizations');
      const v2 = await client.request<SingleDoc>(`/v2/subscriptionLocalizations/${loc.id}`);
      console.log(
        `[ok] /v2 subscription localization ${v2.data?.id} (same id: ${v2.data?.id === loc.id})`,
      );
    });
    const group = groups.data?.[0];
    if (group) {
      await step(`/v2 subscription group localization GET (group ${group.id})`, async () => {
        const locs = await client.request<ListDoc>(
          `/v1/subscriptionGroups/${group.id}/subscriptionGroupLocalizations?limit=1`,
        );
        const loc = locs.data?.[0];
        if (!loc) return console.log('no group localizations');
        const v2 = await client.request<SingleDoc>(`/v2/subscriptionGroupLocalizations/${loc.id}`);
        console.log(`[ok] /v2 group localization ${v2.data?.id}`);
      });
    }
  }

  // ---- Opt-in: IAP create → patch → delete (burns a productId) ----
  const burn = process.env.SMOKE_BURN_PRODUCT_ID;
  if (burn) {
    await step(`IAP create drill (burns ${burn})`, async () => {
      let id: string | undefined;
      try {
        const res = await client.request<SingleDoc>('/v2/inAppPurchases', {
          method: 'POST',
          body: JSON.stringify(
            buildIapCreateBody({
              appId,
              productId: burn,
              name: 'ppp smoke (delete me)',
              inAppPurchaseType: 'CONSUMABLE',
            }),
          ),
        });
        id = res.data?.id;
        console.log(`[ok] created ${id} state ${res.data?.attributes?.state}`);
        await client.request(`/v2/inAppPurchases/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(buildIapPatchBody({ iapId: String(id), reviewNote: 'smoke' })),
        });
        console.log('[ok] patched reviewNote');
      } finally {
        if (id) {
          await client.request(`/v2/inAppPurchases/${id}`, { method: 'DELETE' });
          console.log(`[ok] deleted ${id}`);
        }
      }
    });
  } else {
    console.log(
      '\nIAP create drill skipped (set SMOKE_BURN_PRODUCT_ID to opt in — the productId is reserved forever)',
    );
  }

  console.log(`\n${failures === 0 ? 'SMOKE CLEAN' : `${failures} step(s) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
