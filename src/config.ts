import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export interface Config {
  issuerId: string;
  keyId: string;
  privateKey: string;
  // Optional second key pair for subscription-offer signing (asc_sign_* tools).
  // Issued at App Store Connect → Users and Access → Integrations → In-App
  // Purchase — distinct from the ASC API key. When unset, the server still
  // starts; offer-signing tools report a clear setup error at call time.
  iap?: IapSigningConfig;
}

export interface IapSigningConfig {
  issuerId: string;
  keyId: string;
  privateKey: string;
}

function expandHome(path: string): string {
  if (path.startsWith('~/')) return path.replace('~', homedir());
  if (path === '~') return homedir();
  return path;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Lazy IAP key reader — separated from loadConfig so a missing or unreadable
// IAP key doesn't crash server startup for users who only need ASC reads/writes.
export function loadIapSigningConfig(): IapSigningConfig | undefined {
  const issuerId = process.env.ASC_IAP_ISSUER_ID;
  const keyId = process.env.ASC_IAP_KEY_ID;
  const keyPath = process.env.ASC_IAP_PRIVATE_KEY_PATH;
  if (!issuerId && !keyId && !keyPath) return undefined;
  if (!issuerId || !keyId || !keyPath) {
    throw new Error(
      'IAP signing requires all three of ASC_IAP_ISSUER_ID, ASC_IAP_KEY_ID, ASC_IAP_PRIVATE_KEY_PATH — at least one is set but not all. Configure all three or unset all three.',
    );
  }
  const expandedPath = expandHome(keyPath);
  let privateKey: string;
  try {
    privateKey = readFileSync(expandedPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read ASC_IAP_PRIVATE_KEY_PATH at ${expandedPath}: ${(err as Error).message}`,
    );
  }
  return { issuerId, keyId, privateKey };
}

export function loadConfig(): Config {
  const issuerId = requireEnv('ASC_ISSUER_ID');
  const keyId = requireEnv('ASC_KEY_ID');
  const privateKeyPath = expandHome(requireEnv('ASC_PRIVATE_KEY_PATH'));
  let privateKey: string;
  try {
    privateKey = readFileSync(privateKeyPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read ASC_PRIVATE_KEY_PATH at ${privateKeyPath}: ${(err as Error).message}`,
    );
  }
  // IAP signing is loaded eagerly here so server startup catches misconfigured
  // env (e.g. wrong path) early. The "unset all three" case still returns
  // undefined gracefully — the server starts; signing tools fail at call time.
  const iap = loadIapSigningConfig();
  return iap ? { issuerId, keyId, privateKey, iap } : { issuerId, keyId, privateKey };
}
