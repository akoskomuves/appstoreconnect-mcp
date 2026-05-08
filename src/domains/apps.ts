import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ASCClient } from '../client.js';
import { AppIdSchema, BundleIdSchema } from '../schemas.js';

export function registerApps(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_apps',
    {
      title: 'List apps',
      description:
        'List apps on the App Store Connect account. Optionally filter by bundle identifier.',
      inputSchema: {
        bundleId: BundleIdSchema.optional(),
      },
    },
    async ({ bundleId }) => {
      const query = bundleId ? `?filter[bundleId]=${encodeURIComponent(bundleId)}` : '';
      const data = await client.request<unknown>(`/v1/apps${query}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    'asc_get_app',
    {
      title: 'Get app',
      description: 'Fetch a single app by its App Store Connect ID.',
      inputSchema: {
        appId: AppIdSchema,
      },
    },
    async ({ appId }) => {
      const data = await client.request<unknown>(`/v1/apps/${encodeURIComponent(appId)}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
