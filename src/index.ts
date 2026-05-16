#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createASCClient } from './client.js';
import { loadConfig } from './config.js';
import { registerAppPricing } from './domains/app-pricing.js';
import { registerApps } from './domains/apps.js';
import { registerIaps } from './domains/iap.js';
import { registerIntroOffers } from './domains/intro-offers.js';
import { registerPpp } from './domains/ppp.js';
import { registerPricing } from './domains/pricing.js';
import { registerSubscriptions } from './domains/subscriptions.js';
import { registerTerritories } from './domains/territories.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

interface PackageMeta {
  name: string;
  version: string;
}

function readPackageMeta(): PackageMeta {
  const pkgUrl = new URL('../package.json', import.meta.url);
  try {
    const raw = readFileSync(fileURLToPath(pkgUrl), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: parsed.name ?? 'appstoreconnect-mcp',
      version: parsed.version ?? '0.0.0',
    };
  } catch {
    return { name: 'appstoreconnect-mcp', version: '0.0.0' };
  }
}

const HELP = `appstoreconnect-mcp — Model Context Protocol server for the App Store Connect API.

Usage:
  appstoreconnect-mcp                Run the MCP server over stdio (default; this is what your MCP client invokes).
  appstoreconnect-mcp init           Interactive setup wizard: place .p8, verify auth, register with installed clients.
  appstoreconnect-mcp doctor         Read-only diagnostic of keys, client integrations, and live auth.
  appstoreconnect-mcp --version      Print the package version.
  appstoreconnect-mcp --help         Show this help.

Environment variables (read when running as a server):
  ASC_ISSUER_ID         App Store Connect issuer UUID.
  ASC_KEY_ID            10-character key ID.
  ASC_PRIVATE_KEY_PATH  Path to the .p8 private key file (~ is expanded).

Documentation: https://github.com/akoskomuves/appstoreconnect-mcp
`;

async function runServer(): Promise<void> {
  const meta = readPackageMeta();
  const config = loadConfig();
  const client = createASCClient(config);

  const server = new McpServer({ name: meta.name, version: meta.version });

  registerApps(server, client);
  registerSubscriptions(server, client);
  registerPricing(server, client);
  registerAppPricing(server, client);
  registerIaps(server, client);
  registerIntroOffers(server, client);
  registerTerritories(server, client);
  registerPpp(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  switch (subcommand) {
    case undefined: {
      await runServer();
      return;
    }
    case 'init': {
      const { main: runInit } = await import('./init.js');
      const meta = readPackageMeta();
      await runInit({ execScriptPath: SCRIPT_PATH, pkgName: meta.name });
      return;
    }
    case 'doctor': {
      const { main: runDoctor } = await import('./doctor.js');
      await runDoctor();
      return;
    }
    case '-v':
    case '--version': {
      const meta = readPackageMeta();
      process.stdout.write(`${meta.version}\n`);
      return;
    }
    case '-h':
    case '--help':
    case 'help': {
      process.stdout.write(HELP);
      return;
    }
    default: {
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${HELP}`);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[appstoreconnect-mcp] fatal: ${message}\n`);
  process.exit(1);
});
