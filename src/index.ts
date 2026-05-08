#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createASCClient } from './client.js';
import { loadConfig } from './config.js';
import { registerApps } from './domains/apps.js';
import { registerPricing } from './domains/pricing.js';
import { registerSubscriptions } from './domains/subscriptions.js';
import { registerTerritories } from './domains/territories.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createASCClient(config);

  const server = new McpServer({
    name: 'appstoreconnect-mcp',
    version: '0.0.0',
  });

  registerApps(server, client);
  registerSubscriptions(server, client);
  registerPricing(server, client);
  registerTerritories(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[appstoreconnect-mcp] fatal: ${message}\n`);
  process.exit(1);
});
