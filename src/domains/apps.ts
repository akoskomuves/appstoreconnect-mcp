import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestApps, digestSingle } from '../digest.js';
import type { JSONAPIResource, JSONAPIResponse } from '../jsonapi.js';
import { paginate } from '../jsonapi.js';
import { AppIdSchema, BundleIdSchema } from '../schemas.js';

const APP_FIELDS = 'name,bundleId,sku,primaryLocale,contentRightsDeclaration';

export function registerApps(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_apps',
    {
      title: 'List apps',
      description:
        'List apps on the App Store Connect account. Returns a compact table by default; pass raw:true to get the full JSON:API response.',
      inputSchema: z.object({
        bundleId: BundleIdSchema.optional(),
        maxItems: z.number().int().positive().max(2000).default(1000),
        raw: z.boolean().default(false),
      }),
    },
    async ({ bundleId, maxItems, raw }) => {
      const params = new URLSearchParams();
      if (bundleId) params.set('filter[bundleId]', bundleId);
      params.set('fields[apps]', APP_FIELDS);
      params.set('limit', '200');
      const pages = await paginate(client, `/v1/apps?${params.toString()}`, maxItems);
      const text = raw ? JSON.stringify(pages, null, 2) : digestApps(pages);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'asc_get_app',
    {
      title: 'Get app',
      description: 'Fetch a single app by its App Store Connect ID.',
      inputSchema: z.object({
        appId: AppIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[apps]', APP_FIELDS);
      const data = await client.request<JSONAPIResponse<JSONAPIResource>>(
        `/v1/apps/${encodeURIComponent(appId)}?${params.toString()}`,
      );
      const text = raw ? JSON.stringify(data, null, 2) : digestSingle(data.data, 'App');
      return { content: [{ type: 'text', text }] };
    },
  );
}
