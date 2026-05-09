import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'windsurf';

export interface ClientDescriptor {
  id: ClientId;
  label: string;
  configPath: string;
}

export interface MCPServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPConfigShape {
  mcpServers?: Record<string, MCPServerEntry>;
  [k: string]: unknown;
}

const HOME = homedir();
const PLATFORM = platform();

const CLIENTS: Record<ClientId, ClientDescriptor> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    configPath: join(HOME, '.claude.json'),
  },
  'claude-desktop': {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    configPath:
      PLATFORM === 'darwin'
        ? join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : PLATFORM === 'win32'
          ? join(
              process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'),
              'Claude',
              'claude_desktop_config.json',
            )
          : join(HOME, '.config', 'Claude', 'claude_desktop_config.json'),
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    configPath: join(HOME, '.cursor', 'mcp.json'),
  },
  windsurf: {
    id: 'windsurf',
    label: 'Windsurf',
    configPath: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
  },
};

export function listClients(): ClientDescriptor[] {
  return Object.values(CLIENTS);
}

export function detectClients(): ClientDescriptor[] {
  return listClients().filter((c) => existsSync(c.configPath));
}

export function clientById(id: ClientId): ClientDescriptor {
  return CLIENTS[id];
}

function readConfig(path: string): MCPConfigShape {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as MCPConfigShape;
  } catch (err) {
    throw new Error(`Cannot parse ${path} as JSON: ${(err as Error).message}`);
  }
}

function writeConfig(path: string, config: MCPConfigShape): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export function readServer(client: ClientDescriptor, name: string): MCPServerEntry | undefined {
  const config = readConfig(client.configPath);
  return config.mcpServers?.[name];
}

export function upsertServer(client: ClientDescriptor, name: string, entry: MCPServerEntry): void {
  const config = readConfig(client.configPath);
  config.mcpServers = { ...config.mcpServers, [name]: entry };
  writeConfig(client.configPath, config);
}

export function removeServer(client: ClientDescriptor, name: string): boolean {
  const config = readConfig(client.configPath);
  if (!config.mcpServers || !(name in config.mcpServers)) return false;
  delete config.mcpServers[name];
  writeConfig(client.configPath, config);
  return true;
}

/**
 * Decide what command + args to write into a client config given how this CLI
 * was invoked. If we're running from inside a published `node_modules`, prefer
 * `npx -y appstoreconnect-mcp`. Otherwise (local dev checkout) point at the
 * absolute path of the built `dist/index.js`.
 */
export function resolveServerInvocation(meta: { execScriptPath: string; pkgName: string }): {
  command: string;
  args: string[];
} {
  const fromNodeModules = meta.execScriptPath.includes(`/node_modules/${meta.pkgName}/`);
  if (fromNodeModules) {
    return { command: 'npx', args: ['-y', meta.pkgName] };
  }
  return { command: 'node', args: [meta.execScriptPath] };
}
