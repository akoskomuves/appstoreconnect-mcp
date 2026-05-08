import { importPKCS8, SignJWT } from 'jose';
import type { Config } from './config.js';

const ASC_AUDIENCE = 'appstoreconnect-v1';
// Apple caps token lifetime at 20 min; use 19 to leave buffer for clock skew.
const TOKEN_TTL_SECONDS = 60 * 19;
const REFRESH_AHEAD_SECONDS = 30;

interface CachedToken {
  jwt: string;
  expiresAt: number;
}

export class TokenProvider {
  private cache: CachedToken | null = null;

  constructor(private readonly config: Config) {}

  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cache && this.cache.expiresAt > now + REFRESH_AHEAD_SECONDS) {
      return this.cache.jwt;
    }
    const key = await importPKCS8(this.config.privateKey, 'ES256');
    const expiresAt = now + TOKEN_TTL_SECONDS;
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.keyId, typ: 'JWT' })
      .setIssuer(this.config.issuerId)
      .setAudience(ASC_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(key);
    this.cache = { jwt, expiresAt };
    return jwt;
  }

  invalidate(): void {
    this.cache = null;
  }
}
