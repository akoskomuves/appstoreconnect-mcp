import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ASCClient } from '../client.js';
import {
  AppIdSchema,
  SubscriptionGroupIdSchema,
  SubscriptionIdSchema,
  TerritoryIdSchema,
} from '../schemas.js';

export function registerSubscriptions(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_groups',
    {
      title: 'List subscription groups',
      description: 'List subscription groups for an app.',
      inputSchema: { appId: AppIdSchema },
    },
    async ({ appId }) => {
      const data = await client.request<unknown>(
        `/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.registerTool(
    'asc_list_subscriptions',
    {
      title: 'List subscriptions',
      description: 'List auto-renewable subscriptions in a subscription group.',
      inputSchema: { groupId: SubscriptionGroupIdSchema },
    },
    async ({ groupId }) => {
      const data = await client.request<unknown>(
        `/v1/subscriptionGroups/${encodeURIComponent(groupId)}/subscriptions`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.registerTool(
    'asc_list_subscription_prices',
    {
      title: 'List subscription prices',
      description:
        'List the current price schedule for a subscription, including any pending scheduled changes.',
      inputSchema: { subscriptionId: SubscriptionIdSchema },
    },
    async ({ subscriptionId }) => {
      const data = await client.request<unknown>(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/prices?include=subscriptionPricePoint,territory`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.registerTool(
    'asc_list_subscription_price_points',
    {
      title: 'List subscription price points',
      description:
        'List the valid price points a subscription can be set to in a given territory. Apple rotates these IDs; cache only within a single run.',
      inputSchema: {
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema,
      },
    },
    async ({ subscriptionId, territoryId }) => {
      const data = await client.request<unknown>(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/pricePoints?filter[territory]=${encodeURIComponent(territoryId)}&limit=200`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
