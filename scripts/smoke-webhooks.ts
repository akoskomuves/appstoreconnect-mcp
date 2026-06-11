#!/usr/bin/env tsx
// Live smoke test for the v0.17 webhooks surface. Not wired into the test
// suite — run by a human with real ASC creds in env.
//
// Usage:
//   npx tsx scripts/smoke-webhooks.ts <APP_ID>            # read-only: list webhooks
//   npx tsx scripts/smoke-webhooks.ts <APP_ID> --drill    # full cycle: create → get →
//                                                         # ping → deliveries → redeliver →
//                                                         # patch → DELETE (cleans up)
//
// The drill is safe for a live app: webhooks are developer-side config,
// invisible to customers, and the script deletes everything it creates.
// The endpoint URL is a dummy (https://example.com/...) so ping deliveries
// exercise the FAILED/SUCCEEDED path without a real receiver.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestWebhookDeliveries, digestWebhooks } from '../src/digest.js';
import {
  buildWebhookCreateBody,
  buildWebhookDeliveryListQuery,
  buildWebhookPatchBody,
  buildWebhookPingBody,
  buildWebhookRedeliveryBody,
} from '../src/domains/webhooks.js';
import { paginate } from '../src/jsonapi.js';

type Client = ReturnType<typeof createASCClient>;

async function listWebhooks(client: Client, appId: string): Promise<void> {
  console.log(`=== Webhooks on app ${appId} ===\n`);
  const params = new URLSearchParams();
  params.set('fields[webhooks]', 'enabled,eventTypes,name,url,app');
  params.set('limit', '200');
  const pages = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/webhooks?${params.toString()}`,
    200,
  );
  console.log(digestWebhooks(pages));
}

async function drill(client: Client, appId: string): Promise<void> {
  console.log('\n=== DRILL: create → get → ping → deliveries → redeliver → patch → delete ===\n');

  // 1. Create
  const createBody = buildWebhookCreateBody({
    appId,
    name: 'v017-smoke-DELETE-ME',
    url: 'https://example.com/asc-webhook-smoke',
    secret: 'v017-smoke-secret-not-real',
    eventTypes: ['BUILD_UPLOAD_STATE_UPDATED'],
    enabled: true,
  });
  const created = await client.request<{ data: { id: string } }>('/v1/webhooks', {
    method: 'POST',
    body: JSON.stringify(createBody),
  });
  const webhookId = created.data.id;
  console.log(`1. CREATE ok — webhook ${webhookId}`);

  try {
    // 2. Get (secret must NOT be echoed)
    const got = await client.request<{ data: { attributes?: Record<string, unknown> } }>(
      `/v1/webhooks/${encodeURIComponent(webhookId)}?include=app`,
      { method: 'GET' },
    );
    const attrs = got.data.attributes ?? {};
    console.log(
      `2. GET ok — enabled=${String(attrs.enabled)} eventTypes=${JSON.stringify(attrs.eventTypes)} secretEchoed=${'secret' in attrs}`,
    );

    // 3. Ping
    const ping = await client.request<{ data: { id: string } }>('/v1/webhookPings', {
      method: 'POST',
      body: JSON.stringify(buildWebhookPingBody(webhookId)),
    });
    console.log(`3. PING ok — ping resource ${ping.data.id}`);

    // 4. Deliveries (poll a few times — delivery may take a moment to appear)
    let deliveryId: string | undefined;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      // Apple REQUIRES the gte date filter on this endpoint (live finding).
      const params = buildWebhookDeliveryListQuery({
        createdAfterOrAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      });
      const deliveries = await paginate(
        client,
        `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries?${params.toString()}`,
        200,
      );
      if (deliveries.data.length > 0) {
        console.log(`4. DELIVERIES ok after ${attempt * 5}s:\n`);
        console.log(digestWebhookDeliveries(deliveries));
        deliveryId = deliveries.data[0]?.id;
        break;
      }
      console.log(`   (poll ${attempt}: no deliveries yet)`);
    }
    if (!deliveryId) console.log('4. DELIVERIES — none appeared within 30s (ping may be slow)');

    // 5. Redelivery from the ping delivery
    if (deliveryId) {
      try {
        const redelivered = await client.request<{ data: { id: string } }>(
          '/v1/webhookDeliveries',
          { method: 'POST', body: JSON.stringify(buildWebhookRedeliveryBody(deliveryId)) },
        );
        console.log(`5. REDELIVERY ok — new delivery ${redelivered.data.id}`);
      } catch (err) {
        console.log(`5. REDELIVERY failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 6. Patch (rename + pause)
    const patchBody = buildWebhookPatchBody({
      webhookId,
      name: 'v017-smoke-patched-DELETE-ME',
      enabled: false,
    });
    await client.request(`/v1/webhooks/${encodeURIComponent(webhookId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    });
    console.log('6. PATCH ok — renamed + enabled=false');
  } finally {
    // 7. Delete — always clean up, even if a middle step threw
    await client.request(`/v1/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
    console.log(`7. DELETE ok — webhook ${webhookId} removed`);
  }

  // 8. Confirm gone
  await listWebhooks(client, appId);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const appId = args.find((a) => !a.startsWith('--'));
  if (!appId) {
    console.error('Usage: npx tsx scripts/smoke-webhooks.ts <APP_ID> [--drill]');
    process.exit(1);
  }
  const config = loadConfig();
  const client = createASCClient(config);
  await listWebhooks(client, appId);
  if (args.includes('--drill')) await drill(client, appId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
