import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import open from 'open';
import { TokenProvider } from './auth.js';
import {
  type ClientDescriptor,
  type ClientId,
  detectClients,
  listClients,
  readServer,
  resolveServerInvocation,
  upsertServer,
} from './clients.js';

const HOME = homedir();
const KEY_DIR = join(HOME, '.appstore');
const ASC_KEYS_URL = 'https://appstoreconnect.apple.com/access/integrations/api';
const SERVER_NAME = 'appstoreconnect';
const KEY_FILENAME_RE = /^AuthKey_([A-Z0-9]{10})\.p8$/i;

function expandPath(p: string): string {
  if (p.startsWith('~/')) return p.replace('~', HOME);
  if (p === '~') return HOME;
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function looksLikePKCS8(text: string): boolean {
  return text.includes('-----BEGIN PRIVATE KEY-----');
}

function maybeAutoDetectKeyId(p8Path: string): string | undefined {
  const match = KEY_FILENAME_RE.exec(basename(p8Path));
  return match?.[1]?.toUpperCase();
}

interface FoundKey {
  path: string;
  mtime: Date;
  keyId?: string;
}

const SCAN_DIRS = [KEY_DIR, join(HOME, 'Downloads'), join(HOME, 'Desktop')];

function findP8Files(): FoundKey[] {
  const results: FoundKey[] = [];
  const seen = new Set<string>();
  for (const dir of SCAN_DIRS) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.p8')) continue;
      const path = join(dir, name);
      if (seen.has(path)) continue;
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        const keyId = maybeAutoDetectKeyId(path);
        results.push(keyId ? { path, mtime: stat.mtime, keyId } : { path, mtime: stat.mtime });
        seen.add(path);
      } catch {
        // ignore unreadable
      }
    }
  }
  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results;
}

function formatTimeAgo(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

function tildify(p: string): string {
  return p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p;
}

async function promptManualPath(): Promise<string> {
  while (true) {
    const raw = await input({
      message: 'Path to your .p8 file:',
      default: '~/Downloads/AuthKey_XXXXXXXXXX.p8',
      validate: (v) => v.trim().length > 0 || 'A path is required',
    });
    const expanded = expandPath(raw.trim());
    if (!existsSync(expanded)) {
      console.log(`  ✗ File not found: ${expanded}\n`);
      continue;
    }
    if (!looksLikePKCS8(readFileSync(expanded, 'utf-8'))) {
      console.log(`  ✗ Doesn't look like a PKCS8 .p8 (no BEGIN PRIVATE KEY header)\n`);
      continue;
    }
    return expanded;
  }
}

async function pickFromFound(found: FoundKey[]): Promise<string | 'manual'> {
  const choices = [
    ...found.map((f) => {
      const tag = f.keyId ? `Key ID ${f.keyId}` : 'unknown key id';
      return {
        name: `${tildify(f.path)}  (${tag}, ${formatTimeAgo(f.mtime)})`,
        value: f.path,
      };
    }),
    { name: 'Enter a different path…', value: '__manual__' as const },
  ];
  const choice = await select({
    message: `Found ${found.length} .p8 ${found.length === 1 ? 'file' : 'files'} — pick one:`,
    choices,
  });
  return choice === '__manual__' ? 'manual' : choice;
}

async function locateP8(): Promise<string> {
  let found = findP8Files();

  if (found.length === 0) {
    console.log(`No .p8 files found in ~/.appstore, ~/Downloads, or ~/Desktop.`);
    const wantsBrowser = await confirm({
      message: 'Open App Store Connect now to create a key?',
      default: true,
    });
    if (wantsBrowser) {
      try {
        await open(ASC_KEYS_URL);
      } catch {
        console.log(`Browser open failed — visit this manually: ${ASC_KEYS_URL}\n`);
      }
      console.log(`Create a key with role 'Admin' (pricing writes) or 'App Manager' (read-only).`);
      console.log(`You can only download the .p8 once — save it somewhere safe.\n`);
      await confirm({
        message: 'Press Enter when you have downloaded the .p8 file.',
        default: true,
      });
      found = findP8Files();
    }
  }

  while (true) {
    if (found.length > 0) {
      const picked = await pickFromFound(found);
      if (picked !== 'manual') {
        if (looksLikePKCS8(readFileSync(picked, 'utf-8'))) return picked;
        console.log(`  ✗ ${picked} doesn't look like a PKCS8 .p8 — try another.\n`);
        found = found.filter((f) => f.path !== picked);
        continue;
      }
    }
    return await promptManualPath();
  }
}

async function ensureP8(): Promise<{ path: string; keyId: string }> {
  let p8Path = await locateP8();

  // Copy into ~/.appstore/ unless it's already there.
  if (!p8Path.startsWith(KEY_DIR)) {
    mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
    chmodSync(KEY_DIR, 0o700);
    const dest = join(KEY_DIR, basename(p8Path));
    if (existsSync(dest)) {
      const overwrite = await confirm({
        message: `${dest} already exists. Overwrite?`,
        default: false,
      });
      if (!overwrite) {
        console.log(`  → Keeping existing ${dest}, ignoring source ${p8Path}.`);
      } else {
        copyFileSync(p8Path, dest);
        chmodSync(dest, 0o600);
        console.log(`  ✓ Copied to ${dest} (chmod 600)`);
      }
    } else {
      copyFileSync(p8Path, dest);
      chmodSync(dest, 0o600);
      console.log(`  ✓ Copied to ${dest} (chmod 600)`);
    }
    p8Path = dest;
  } else {
    try {
      chmodSync(p8Path, 0o600);
    } catch {
      // Best-effort.
    }
  }

  const detectedKeyId = maybeAutoDetectKeyId(p8Path);
  const keyId = await input({
    message: 'Key ID (10 chars, A-Z 0-9):',
    ...(detectedKeyId ? { default: detectedKeyId } : {}),
    validate: (v) => /^[A-Z0-9]{10}$/i.test(v.trim()) || 'Must be 10 alphanumeric characters',
  });

  return { path: p8Path, keyId: keyId.trim().toUpperCase() };
}

async function verifyAuth(args: {
  issuerId: string;
  keyId: string;
  privateKey: string;
}): Promise<{ ok: true; appCount: number } | { ok: false; error: string }> {
  const tokens = new TokenProvider({
    issuerId: args.issuerId,
    keyId: args.keyId,
    privateKey: args.privateKey,
  });
  let token: string;
  try {
    token = await tokens.getToken();
  } catch (err) {
    return { ok: false, error: `JWT signing failed: ${(err as Error).message}` };
  }
  const res = await fetch('https://api.appstoreconnect.apple.com/v1/apps?limit=200', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { errors?: Array<{ detail?: string }> };
      detail = body.errors?.[0]?.detail ?? '';
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: `App Store Connect returned ${res.status}${detail ? `: ${detail}` : ''}`,
    };
  }
  const json = (await res.json()) as { data?: unknown[] };
  return { ok: true, appCount: json.data?.length ?? 0 };
}

export interface InitDeps {
  execScriptPath: string;
  pkgName: string;
}

async function runInit(deps: InitDeps): Promise<void> {
  console.log('\nappstoreconnect-mcp — setup wizard\n');

  const { path: p8Path, keyId } = await ensureP8();

  const issuerId = await input({
    message: 'Issuer ID (UUID at the top of the Keys page):',
    validate: (v) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim()) ||
      'Must be a UUID',
  });

  console.log('\nVerifying credentials against App Store Connect...');
  const privateKey = readFileSync(p8Path, 'utf-8');
  const verify = await verifyAuth({ issuerId: issuerId.trim(), keyId, privateKey });
  if (!verify.ok) {
    console.error(`  ✗ ${verify.error}`);
    console.error(`\nFix the credentials and try again — nothing was written.`);
    process.exit(1);
  }
  console.log(`  ✓ ok (${verify.appCount} ${verify.appCount === 1 ? 'app' : 'apps'} visible)\n`);

  const detected = detectClients();
  const allClients = listClients();
  if (detected.length === 0) {
    console.log('No MCP clients detected (Claude Code, Claude Desktop, Cursor, Windsurf).');
    console.log('You can still add this MCP manually using the snippet in the README.\n');
  }
  const choices = allClients.map((c) => ({
    name: `${c.label}  (${c.configPath})${detected.includes(c) ? '' : '  — not detected'}`,
    value: c.id,
    checked: detected.includes(c),
    disabled: !detected.includes(c) && 'config not found — install the client first',
  }));

  const selected = (await checkbox({
    message: 'Register the MCP in:',
    choices,
    required: true,
  })) as ClientId[];

  const invocation = resolveServerInvocation({
    execScriptPath: deps.execScriptPath,
    pkgName: deps.pkgName,
  });
  const env = {
    ASC_ISSUER_ID: issuerId.trim(),
    ASC_KEY_ID: keyId,
    ASC_PRIVATE_KEY_PATH: p8Path,
  };

  for (const id of selected) {
    const client: ClientDescriptor = allClients.find((c) => c.id === id) as ClientDescriptor;
    const existing = readServer(client, SERVER_NAME);
    if (existing) {
      const overwrite = await confirm({
        message: `${client.label} already has a "${SERVER_NAME}" server. Overwrite?`,
        default: true,
      });
      if (!overwrite) {
        console.log(`  → Skipped ${client.label}.`);
        continue;
      }
    }
    upsertServer(client, SERVER_NAME, { ...invocation, env });
    console.log(`  ✓ Registered "${SERVER_NAME}" in ${client.label} (${client.configPath})`);
  }

  console.log('\nDone.');
  console.log('Restart your MCP client(s) to pick up the new server:');
  for (const id of selected) {
    const client = allClients.find((c) => c.id === id);
    if (client) console.log(`  - ${client.label}`);
  }
  console.log('\nIn your client, ask: "use appstoreconnect to list my apps".');
}

export async function main(deps: InitDeps): Promise<void> {
  try {
    await runInit(deps);
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'ExitPromptError') {
      console.log('\nCancelled.');
      process.exit(130);
    }
    console.error(`\n[init] error: ${(err as Error).message ?? err}`);
    process.exit(1);
  }
}
