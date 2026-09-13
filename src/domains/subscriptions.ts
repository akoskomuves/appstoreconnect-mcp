import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestSubscriptionGroups,
  digestSubscriptionPricePoints,
  digestSubscriptionPrices,
  digestSubscriptions,
} from '../digest.js';
import {
  FULL_TERRITORY_SCAN,
  filterPagesByNearAmount,
  filterPagesByTerritory,
  paginate,
  territoryFilterNote,
} from '../jsonapi.js';
import {
  AppIdSchema,
  SubscriptionGroupIdSchema,
  SubscriptionIdSchema,
  TerritoryIdSchema,
} from '../schemas.js';

const GROUP_FIELDS = 'referenceName';
const SUB_FIELDS = 'name,productId,subscriptionPeriod,state,groupLevel';
// SubscriptionPrice has only `startDate` as an attribute; `preserveCurrentPrice`
// is a write-only field on the POST body, not a queryable resource attribute.
// We don't apply fields[subscriptionPrices] at all — Apple rejects unknown names.
const PRICE_POINT_FIELDS = 'customerPrice,proceeds,proceedsYear2';
const TERRITORY_FIELDS = 'currency';

export function registerSubscriptions(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_groups',
    {
      title: 'List subscription groups',
      description: 'List subscription groups for an app.',
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptionGroups]', GROUP_FIELDS);
      params.set('limit', '200');
      const pages = await paginate(
        client,
        `/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?${params.toString()}`,
        maxItems,
      );
      const text = raw ? JSON.stringify(pages, null, 2) : digestSubscriptionGroups(pages);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'asc_list_subscriptions',
    {
      title: 'List subscriptions',
      description: 'List auto-renewable subscriptions in a subscription group.',
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ groupId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptions]', SUB_FIELDS);
      params.set('limit', '200');
      const pages = await paginate(
        client,
        `/v1/subscriptionGroups/${encodeURIComponent(groupId)}/subscriptions?${params.toString()}`,
        maxItems,
      );
      const text = raw ? JSON.stringify(pages, null, 2) : digestSubscriptions(pages);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'asc_list_subscription_prices',
    {
      title: 'List subscription prices',
      description:
        'List the current price schedule for a subscription. Apple returns one row PER TERRITORY, so an unfiltered call on a worldwide subscription is ~175 rows — pass territoryId (e.g. "USA") whenever you care about a single market, or the response will be large enough to blow a tool-result token cap. Returns a compact table by default; pass raw:true for the full JSON:API payload (note: when territoryId is set the raw payload is narrowed too, though included[] still carries every territory).',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema.optional().describe(
          'Narrow the response to one territory (ISO-3 code, e.g. "USA"). Omit for every territory.',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, territoryId, maxItems, raw }) => {
      // Apple's /v1/subscriptions/{id}/prices is picky about extra query params:
      // adding fields[subscriptionPricePoints], fields[territories], or limit=200
      // produces a 400 with no detail. Stick to the include and let paginate()
      // walk links.next at the server's default page size.
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/prices?include=subscriptionPricePoint,territory`;
      // When narrowing to one territory, maxItems describes how much the
      // caller wants BACK, not how far to look. Apple returns territories in
      // its own order, so capping the fetch at a small maxItems can stop
      // before the requested territory is reached and report it as having no
      // price at all. Scan the whole schedule and let the filter narrow it.
      const fetchCeiling =
        territoryId === undefined ? maxItems : Math.max(maxItems, FULL_TERRITORY_SCAN);
      const fetched = await paginate(client, path, fetchCeiling);
      // Price rows always carry a concrete territory — no wildcard to preserve.
      const pages =
        territoryId === undefined ? fetched : filterPagesByTerritory(fetched, territoryId);
      const note =
        territoryId === undefined
          ? ''
          : territoryFilterNote(
              territoryId,
              pages.data.length,
              fetched.data.length,
              fetched.truncated,
            );
      // The note rides along in raw mode too: the payload IS narrowed there,
      // so dropping it would hand back a filtered document with no sign of it.
      const text = raw
        ? `${note}${JSON.stringify(pages, null, 2)}`
        : `${note}${digestSubscriptionPrices(pages)}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'asc_list_subscription_price_points',
    {
      title: 'List subscription price points',
      description:
        'List the valid price points a subscription can be set to in a given territory. Apple rotates these IDs; cache only within a single run. ' +
        'Pass nearAmount when you already know the target price — the response is narrowed to the nearest candidates client-side (Apple does not support a near-amount filter server-side, so the full list is still paginated but only the nearest tiers are surfaced).',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema,
        maxItems: z.number().int().positive().max(5000).default(1000),
        nearAmount: z
          .number()
          .positive()
          .optional()
          .describe(
            'Target customer price (in the territory currency). The response is filtered to the nearest tiers.',
          ),
        nearCount: z
          .number()
          .int()
          .positive()
          .max(100)
          .default(10)
          .describe('Max tiers to return when nearAmount is set.'),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, territoryId, maxItems, nearAmount, nearCount, raw }) => {
      const params = new URLSearchParams();
      params.set('filter[territory]', territoryId);
      params.set('include', 'territory');
      params.set('fields[subscriptionPricePoints]', PRICE_POINT_FIELDS);
      params.set('fields[territories]', TERRITORY_FIELDS);
      params.set('limit', '200');
      const fetched = await paginate(
        client,
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/pricePoints?${params.toString()}`,
        maxItems,
      );
      const pages =
        nearAmount !== undefined
          ? filterPagesByNearAmount(fetched, nearAmount, nearCount)
          : fetched;
      const text = raw ? JSON.stringify(pages, null, 2) : digestSubscriptionPricePoints(pages);
      return { content: [{ type: 'text', text }] };
    },
  );
}
