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
        'Apple requires startDate ≥ today + 24h; this server defaults to ≥7 days for safety.',
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
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
