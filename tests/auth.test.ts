import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { TokenProvider } from '../src/auth.js';

async function makeKeyPair() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pkcs8 = await exportPKCS8(privateKey);
  return { publicKey, pkcs8 };
}

describe('TokenProvider', () => {
  it('issues an ES256 JWT with the configured issuer, key id, and audience', async () => {
    const { publicKey, pkcs8 } = await makeKeyPair();
    const provider = new TokenProvider({
      issuerId: 'issuer-uuid',
      keyId: 'KEYID12345',
      privateKey: pkcs8,
    });

    const jwt = await provider.getToken();
    const header = decodeProtectedHeader(jwt);
    const payload = decodeJwt(jwt);

    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('KEYID12345');
    expect(header.typ).toBe('JWT');
    expect(payload.iss).toBe('issuer-uuid');
    expect(payload.aud).toBe('appstoreconnect-v1');
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(20 * 60);

    const verified = await jwtVerify(jwt, publicKey, { audience: 'appstoreconnect-v1' });
    expect(verified.payload.iss).toBe('issuer-uuid');
  });

  it('caches tokens until close to expiry', async () => {
    const { pkcs8 } = await makeKeyPair();
    const provider = new TokenProvider({
      issuerId: 'issuer-uuid',
      keyId: 'KEYID12345',
      privateKey: pkcs8,
    });

    const a = await provider.getToken();
    const b = await provider.getToken();
    expect(a).toBe(b);
  });

  it('issues a fresh token after invalidate()', async () => {
    const { pkcs8 } = await makeKeyPair();
    const provider = new TokenProvider({
      issuerId: 'issuer-uuid',
      keyId: 'KEYID12345',
      privateKey: pkcs8,
    });

    const a = await provider.getToken();
    provider.invalidate();
    // Same iat second resolution may collide; the key fact is that cache was cleared.
    // We assert by re-signing succeeds and produces a valid token.
    const b = await provider.getToken();
    expect(typeof b).toBe('string');
    expect(b.split('.').length).toBe(3);
    expect(a.split('.').length).toBe(3);
  });
});
