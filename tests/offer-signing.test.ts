import { createPublicKey, verify as cryptoVerify, generateKeyPairSync } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { IapSigningConfig } from '../src/config.js';
import {
  signIntroductoryOfferEligibility,
  signPromotionalOfferLegacy,
  signPromotionalOfferV2,
} from '../src/domains/offer-signing.js';

// Apple's offer-signing wire shape is footgun-heavy: case-sensitive field
// names, three different formats, U+2063 separator on the legacy path,
// base64-vs-base64url, DER-encoded signature, etc. These tests pin the wire
// shape of all three formats by round-tripping through actual ES256
// verification — generated key, sign, then independently verify the output.

const INVISIBLE_SEPARATOR = '⁣';

function fixtureIapConfig(): IapSigningConfig & { publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
  return {
    issuerId: '11111111-2222-3333-4444-555555555555',
    keyId: 'ABC1234567',
    privateKey: privateKeyPem,
    publicKeyPem,
  };
}

describe('signPromotionalOfferLegacy', () => {
  const iap = fixtureIapConfig();
  // Deterministic nonce + timestamp so we can rebuild the exact message Apple
  // signed and verify the ECDSA signature against it.
  const nonce = '00000000-0000-4000-8000-000000000000';
  const timestampMs = 1_700_000_000_000;
  const result = signPromotionalOfferLegacy(iap, {
    appBundleId: 'com.example.app',
    productId: 'com.example.app.monthly',
    offerCode: 'WINTER2026',
    applicationUsername: 'user-abc',
    nonce,
    timestampMs,
  });

  it('echoes nonce, timestampMs, and keyId back to the caller for StoreKit use', () => {
    expect(result.nonce).toBe(nonce);
    expect(result.timestampMs).toBe(timestampMs);
    expect(result.keyId).toBe(iap.keyId);
  });

  it('produces a non-empty signature', () => {
    expect(result.signature.length).toBeGreaterThan(0);
  });

  it('signature is plain base64, not base64url (no - or _ characters)', () => {
    // base64url uses `-` and `_`; legacy spec mandates standard base64.
    expect(result.signature).not.toMatch(/[-_]/);
  });

  it('signature verifies against the expected concatenated message', () => {
    // Apple's legacy concat order, joined with U+2063 INVISIBLE SEPARATOR.
    // applicationUsername is lowercased before signing per Apple's spec.
    const message = [
      'com.example.app',
      iap.keyId,
      'com.example.app.monthly',
      'WINTER2026',
      'user-abc',
      nonce,
      String(timestampMs),
    ].join(INVISIBLE_SEPARATOR);
    const publicKey = createPublicKey(iap.publicKeyPem);
    const signatureBytes = Buffer.from(result.signature, 'base64');
    const ok = cryptoVerify(
      'SHA256',
      Buffer.from(message, 'utf-8'),
      { key: publicKey, dsaEncoding: 'der' },
      signatureBytes,
    );
    expect(ok).toBe(true);
  });

  it('auto-generates nonce and timestamp when omitted', () => {
    const r = signPromotionalOfferLegacy(iap, {
      appBundleId: 'com.example.app',
      productId: 'com.example.app.monthly',
      offerCode: 'WINTER2026',
      applicationUsername: '',
    });
    expect(r.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r.timestampMs).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('signPromotionalOfferV2', () => {
  const iap = fixtureIapConfig();
  const result = signPromotionalOfferV2(iap, {
    appBundleId: 'com.example.app',
    productId: 'com.example.app.monthly',
    offerIdentifier: 'WINTER2026',
    transactionId: 'TXN-12345',
  });

  it('returns a JWS compact serialization (three dot-separated base64url segments)', () => {
    const segments = result.jws.split('.');
    expect(segments).toHaveLength(3);
    // Each segment must be valid base64url (no padding, only -_A-Za-z0-9).
    for (const s of segments) {
      expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('header has alg=ES256 and kid set to the IAP key ID', async () => {
    const [headerB64] = result.jws.split('.');
    if (!headerB64) throw new Error('JWS missing header segment');
    const headerJson = Buffer.from(headerB64, 'base64url').toString('utf-8');
    const header = JSON.parse(headerJson);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe(iap.keyId);
    // Apple's reference library sets typ='JWT'. Pinning it so a future lib
    // version that drops it is a visible behavior change in our test output,
    // not a silent break.
    expect(header.typ).toBe('JWT');
  });

  it('payload uses Apple field names: bid, productId, offerIdentifier, transactionId, iss, iat, nonce, aud', async () => {
    const spki = await importSPKI(iap.publicKeyPem, 'ES256');
    const { payload } = await jwtVerify(result.jws, spki);
    expect(payload.bid).toBe('com.example.app');
    expect(payload.productId).toBe('com.example.app.monthly');
    expect(payload.offerIdentifier).toBe('WINTER2026');
    expect(payload.transactionId).toBe('TXN-12345');
    expect(payload.iss).toBe(iap.issuerId);
    expect(payload.aud).toBe('promotional-offer');
    // iat is seconds (JWT standard), not ms.
    expect(typeof payload.iat).toBe('number');
    expect(payload.iat).toBeGreaterThan(1_700_000_000);
    expect(payload.iat).toBeLessThan(2_000_000_000);
    expect(typeof payload.nonce).toBe('string');
    // None of the legacy fields should leak into the JWS payload.
    expect(payload.appBundleID).toBeUndefined();
    expect(payload.productIdentifier).toBeUndefined();
    expect(payload.subscriptionOfferID).toBeUndefined();
    expect(payload.applicationUsername).toBeUndefined();
    expect(payload.timestamp).toBeUndefined();
  });

  it('transactionId is omitted from payload when not passed (it is optional for V2 promo)', async () => {
    const noTxn = signPromotionalOfferV2(iap, {
      appBundleId: 'com.example.app',
      productId: 'com.example.app.monthly',
      offerIdentifier: 'SUMMER2026',
    });
    const spki = await importSPKI(iap.publicKeyPem, 'ES256');
    const { payload } = await jwtVerify(noTxn.jws, spki);
    expect(payload.transactionId).toBeUndefined();
  });
});

describe('signIntroductoryOfferEligibility', () => {
  const iap = fixtureIapConfig();
  const result = signIntroductoryOfferEligibility(iap, {
    appBundleId: 'com.example.app',
    productId: 'com.example.app.monthly',
    allowIntroductoryOffer: true,
    transactionId: 'TXN-12345',
  });

  it('audience is introductory-offer-eligibility', async () => {
    const spki = await importSPKI(iap.publicKeyPem, 'ES256');
    const { payload } = await jwtVerify(result.jws, spki);
    expect(payload.aud).toBe('introductory-offer-eligibility');
  });

  it('payload carries allowIntroductoryOffer as a boolean (not string)', async () => {
    const spki = await importSPKI(iap.publicKeyPem, 'ES256');
    const { payload } = await jwtVerify(result.jws, spki);
    expect(payload.allowIntroductoryOffer).toBe(true);
    expect(typeof payload.allowIntroductoryOffer).toBe('boolean');
  });

  it('transactionId is required (not optional like V2 promo)', async () => {
    const spki = await importSPKI(iap.publicKeyPem, 'ES256');
    const { payload } = await jwtVerify(result.jws, spki);
    expect(payload.transactionId).toBe('TXN-12345');
  });
});
