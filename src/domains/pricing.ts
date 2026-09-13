import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  PricePointIdSchema,
  StartDateSchema,
  SubscriptionIdSchema,
  SubscriptionPriceIdSchema,
  TerritoryIdSchema,
} from '../schemas.js';

export function registerPricing(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_post_subscription_price',
    {
      title: 'Schedule a subscription price change',
      description:
        'Schedule a price change for a single (subscription, territory) on a future date. ' +
        'Always pass preserveCurrentPrice=true unless you intend to re-price existing subscribers. ' +
        'Apple requires startDate ≥ today + 24h; this server defaults to ≥7 days for safety. ' +
        'READING THE RESULT: the created row comes back with `preserved: false`, and keeps reading false in the price schedule for as long as it is the newest row. That is correct and expected — it does NOT mean preserveCurrentPrice was ignored. `preserved` means "this row is held for the cohort that subscribed under it", so it only flips true once a NEWER price supersedes it.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema,
        pricePointId: PricePointIdSchema,
        startDate: StartDateSchema,
        preserveCurrentPrice: z
          .boolean()
          .default(true)
          .describe(
            'Grandfather existing subscribers at their current price. Strongly recommended.',
          ),
      }),
    },
    async ({ subscriptionId, territoryId, pricePointId, startDate, preserveCurrentPrice }) => {
      const body = {
        data: {
          type: 'subscriptionPrices',
          attributes: {
            startDate,
            preserveCurrentPrice,
          },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: subscriptionId } },
            subscriptionPricePoint: {
              data: { type: 'subscriptionPricePoints', id: pricePointId },
            },
            territory: { data: { type: 'territories', id: territoryId } },
          },
        },
      };
      const data = await client.request<unknown>('/v1/subscriptionPrices', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Apple echoes `preserved: false` on every freshly-created row (it is the
      // newest one, so nothing supersedes it yet). Without this note the
      // response reads as a silent grandfathering failure — a caller has
      // already deleted and re-created a row through the raw API chasing it.
      const note = preserveCurrentPrice
        ? 'Scheduled with preserveCurrentPrice=true — existing subscribers are grandfathered.\n\n' +
          'NOTE: the row below reads `preserved: false`, and will keep reading false for as long as it is the newest price. That is expected, not a failure — `preserved` flips true only once a NEWER price supersedes this row.\n\n'
        : 'Scheduled with preserveCurrentPrice=false — EXISTING SUBSCRIBERS WILL BE RE-PRICED at the next renewal on or after the start date.\n\n';
      return { content: [{ type: 'text', text: `${note}${JSON.stringify(data, null, 2)}` }] };
    },
  );

  server.registerTool(
    'asc_delete_subscription_price',
    {
      title: 'Cancel a pending subscription price change',
      description:
        'Delete a pending scheduled subscription price by ID. Use this to roll back a change that has not yet activated.',
      inputSchema: z.object({
        subscriptionPriceId: SubscriptionPriceIdSchema,
      }),
    },
    async ({ subscriptionPriceId }) => {
      await client.request<void>(
        `/v1/subscriptionPrices/${encodeURIComponent(subscriptionPriceId)}`,
        { method: 'DELETE' },
      );
      return {
        content: [{ type: 'text', text: `Deleted scheduled price ${subscriptionPriceId}.` }],
      };
    },
  );
}
