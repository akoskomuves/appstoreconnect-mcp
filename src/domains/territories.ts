import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestTerritories } from '../digest.js';
import { paginate } from '../jsonapi.js';

export function registerTerritories(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_territories',
    {
      title: 'List territories',
      description: 'List App Store territories with their currency codes.',
      inputSchema: {
        maxItems: z.number().int().positive().max(500).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[territories]', 'currency');
      params.set('limit', '200');
      const pages = await paginate(client, `/v1/territories?${params.toString()}`, maxItems);
      const text = raw ? JSON.stringify(pages, null, 2) : digestTerritories(pages);
      return { content: [{ type: 'text', text }] };
    },
  );
}
