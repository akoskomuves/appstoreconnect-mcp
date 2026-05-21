import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { importPKCS8 } from 'jose';
import { TokenProvider } from './auth.js';
import { detectClients, listClients, readServer } from './clients.js';

const HOME = homedir();
const KEY_DIR = join(HOME, '.appstore');
const SERVER_NAME = 'appstoreconnect';

interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}

function fmt(r: CheckResult): string {
  const mark = r.ok ? '✓' : '✗';
  return `  ${mark} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`;
}

function info(label: string, detail?: string): string {
  return `  · ${label}${detail ? ` — ${detail}` : ''}`;
}

async function checkKeyDir(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  if (!existsSync(KEY_DIR)) {
    out.push({
      ok: false,
      label: `${KEY_DIR} not found`,
      detail: 'run `appstoreconnect-mcp init` to set it up',
    });
    return out;
  }
  const stat = statSync(KEY_DIR);
  const mode = stat.mode & 0o777;
  out.push({
    ok: mode === 0o700,
    label: `${KEY_DIR} permissions`,
    detail: `mode ${mode.toString(8)}${mode === 0o700 ? '' : ' (recommend chmod 700)'}`,
  });

  const files = readdirSync(KEY_DIR).filter((f) => f.endsWith('.p8'));
  if (files.length === 0) {
    out.push({ ok: false, label: 'No .p8 keys found in ~/.appstore' });
    return out;
  }
  for (const f of files) {
    const path = join(KEY_DIR, f);
    const fileMode = statSync(path).mode & 0o777;
    let parsed = false;
    try {
      const text = readFileSync(path, 'utf-8');
      await importPKCS8(text, 'ES256');
      parsed = true;
    } catch {
      parsed = false;
    }
    out.push({
      ok: parsed && fileMode === 0o600,
      label: f,
      detail: `mode ${fileMode.toString(8)}, ${parsed ? 'parses as ES256 PKCS8' : 'failed to parse'}`,
    });
  }
  return out;
}

function checkClients(): CheckResult[] {
  const detected = detectClients();
  const all = listClients();
  const out: CheckResult[] = [];
  out.push({
    ok: detected.length > 0,
    label: 'MCP clients detected',
    detail:
      detected.length === 0 ? 'no client configs found' : detected.map((c) => c.label).join(', '),
  });
  for (const client of all) {
    const entry = readServer(client, SERVER_NAME);
    if (!entry) continue;
    const env = entry.env ?? {};
    const cmd = `${entry.command}${entry.args ? ` ${entry.args.join(' ')}` : ''}`;
    const envParts = (['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY_PATH'] as const).map(
      (k) => `${k}=${env[k] ? 'set' : 'MISSING'}`,
    );
    const ok = envParts.every((p) => p.endsWith('=set'));
    out.push({
      ok,
      label: `${client.label} → ${SERVER_NAME}`,
      detail: `${cmd} (${envParts.join(', ')})`,
    });
  }
  return out;
}

async function checkAuth(): Promise<CheckResult | null> {
  const issuerId = process.env['ASC_ISSUER_ID'];
  const keyId = process.env['ASC_KEY_ID'];
  const keyPath = process.env['ASC_PRIVATE_KEY_PATH'];
  if (!issuerId || !keyId || !keyPath) {
    return null;
  }
  const expanded = keyPath.startsWith('~/') ? keyPath.replace('~', HOME) : keyPath;
  if (!existsSync(expanded)) {
    return { ok: false, label: 'Live auth check', detail: `key not found at ${expanded}` };
  }
  try {
    const tokens = new TokenProvider({
      issuerId,
      keyId,
      privateKey: readFileSync(expanded, 'utf-8'),
    });
    const token = await tokens.getToken();
    const res = await fetch('https://api.appstoreconnect.apple.com/v1/apps?limit=1', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return {
        ok: false,
        label: 'Live auth check',
        detail: `App Store Connect returned ${res.status}`,
      };
    }
    return { ok: true, label: 'Live auth check', detail: 'JWT signed and accepted' };
  } catch (err) {
    return { ok: false, label: 'Live auth check', detail: (err as Error).message };
  }
}

async function checkIapSigning(): Promise<CheckResult | null> {
  const issuerId = process.env.ASC_IAP_ISSUER_ID;
  const keyId = process.env.ASC_IAP_KEY_ID;
  const keyPath = process.env.ASC_IAP_PRIVATE_KEY_PATH;
  if (!issuerId && !keyId && !keyPath) return null;
  if (!issuerId || !keyId || !keyPath) {
    return {
      ok: false,
      label: 'IAP signing config',
      detail:
        'partial — need all three of ASC_IAP_ISSUER_ID, ASC_IAP_KEY_ID, ASC_IAP_PRIVATE_KEY_PATH',
    };
  }
  const expanded = keyPath.startsWith('~/') ? keyPath.replace('~', HOME) : keyPath;
  if (!existsSync(expanded)) {
    return {
      ok: false,
      label: 'IAP signing config',
      detail: `key not found at ${expanded}`,
    };
  }
  try {
    const text = readFileSync(expanded, 'utf-8');
    await importPKCS8(text, 'ES256');
    return {
      ok: true,
      label: 'IAP signing config',
      detail: `key loads as ES256, keyId=${keyId}`,
    };
  } catch (err) {
    return {
      ok: false,
      label: 'IAP signing config',
      detail: `key failed to parse as ES256: ${(err as Error).message}`,
    };
  }
}

export async function main(): Promise<void> {
  console.log('\nappstoreconnect-mcp — doctor\n');

  console.log('Key directory:');
  for (const r of await checkKeyDir()) console.log(fmt(r));

  console.log('\nMCP client integrations:');
  for (const r of checkClients()) console.log(fmt(r));

  const liveAuth = await checkAuth();
  console.log('\nLive auth:');
  if (liveAuth) {
    console.log(fmt(liveAuth));
  } else {
    console.log(
      info(
        'skipped',
        'set ASC_ISSUER_ID/ASC_KEY_ID/ASC_PRIVATE_KEY_PATH env vars to verify against the live API',
      ),
    );
  }

  const iapSigning = await checkIapSigning();
  console.log('\nIAP signing (subscription offer redemption):');
  if (iapSigning) {
    console.log(fmt(iapSigning));
  } else {
    console.log(
      info(
        'not configured',
        'set ASC_IAP_ISSUER_ID/ASC_IAP_KEY_ID/ASC_IAP_PRIVATE_KEY_PATH to enable the asc_sign_* tools. Key issued at ASC → Users and Access → Integrations → In-App Purchase (different from the ASC API key).',
      ),
    );
  }

  console.log('\nNext steps:');
  console.log('  - First-time setup:  appstoreconnect-mcp init');
  console.log('  - Use it from a client: ask "use appstoreconnect to list my apps"');
  console.log('  - Issues:           https://github.com/akoskomuves/appstoreconnect-mcp/issues\n');
}
