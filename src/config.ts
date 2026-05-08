import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export interface Config {
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
  return { issuerId, keyId, privateKey };
}
