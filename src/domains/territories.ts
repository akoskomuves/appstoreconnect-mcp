import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ASCClient } from '../client.js';

export function registerTerritories(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_territories',
    {
      title: 'List territories',
      description: 'List all 175 App Store territories with their currency codes.',
      inputSchema: {},
    },
    async () => {
      const data = await client.request<unknown>('/v1/territories?limit=200');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
