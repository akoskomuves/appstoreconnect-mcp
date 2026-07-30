import { randomUUID } from 'node:crypto';
import {
  IntroductoryOfferEligibilitySignatureCreator,
  PromotionalOfferSignatureCreator,
  PromotionalOfferV2SignatureCreator,
} from '@apple/app-store-server-library';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type IapSigningConfig, loadIapSigningConfig } from '../config.js';
import {
  ApplicationUsernameSchema,
  BundleIdSchema,
  NonceSchema,
  OfferCodeSchema,
  ProductIdSchema,
  TimestampMillisSchema,
  TransactionIdSchema,
} from '../schemas.js';

// Subscription-offer signing produces the cryptographic payload StoreKit
// requires to redeem a promotional or introductory offer in-app. Three
// formats coexist (per Apple's docs as of 2026):
//
//   1. LEGACY (PromotionalOfferSignatureCreator) — ECDSA P-256 / SHA-256
//      signature over a U+2063-delimited concatenation of seven fields,
//      base64-encoded (NOT base64url). Used by StoreKit 1's SKPaymentDiscount
//      and the older StoreKit 2 Product.PurchaseOption.promotionalOffer(
//      offerID:keyID:nonce:signature:timestamp:) API. Still fully supported.
//   2. JWS V2 PROMOTIONAL OFFER (PromotionalOfferV2SignatureCreator) — a
//      proper JWS with aud="promotional-offer". Introduced WWDC 2025.
//      Recommended for new code; back-deployed to iOS 15.
//   3. JWS V2 INTRO ELIGIBILITY (IntroductoryOfferEligibilitySignatureCreator)
//      — same key, aud="introductory-offer-eligibility", carries an
//      allowIntroductoryOffer boolean that lets you override StoreKit's
//      default eligibility check (e.g. grant a returning user another trial).
//
// All three use the SAME signing key — the per-team In-App Purchase key
// from App Store Connect → Users and Access → Integrations → In-App Purchase
// (NOT the ASC API key). This module wraps Apple's official
// `@apple/app-store-server-library` so we don't hand-roll the byte layout —
// the U+2063 invisible-separator landmine and the case-sensitive JWS payload
// field names are exactly the kind of detail you only get right by using the
// reference implementation.

export interface LegacyPromoOfferInput {
  appBundleId: string;
  productId: string;
  offerCode: string;
  applicationUsername: string;
  nonce?: string | undefined;
  timestampMs?: number | undefined;
}

export interface LegacyPromoOfferResult {
  signature: string;
  nonce: string;
  timestampMs: number;
  keyId: string;
}

export interface PromoOfferV2Input {
  appBundleId: string;
  productId: string;
  offerIdentifier: string;
  transactionId?: string | undefined;
}

export interface IntroOfferEligibilityInput {
  appBundleId: string;
  productId: string;
  allowIntroductoryOffer: boolean;
  transactionId: string;
}

export interface JWSResult {
  jws: string;
}

export function signPromotionalOfferLegacy(
  iap: IapSigningConfig,
  input: LegacyPromoOfferInput,
): LegacyPromoOfferResult {
  const nonce = input.nonce ?? randomUUID();
  const timestampMs = input.timestampMs ?? Date.now();
  const creator = new PromotionalOfferSignatureCreator(
    iap.privateKey,
    iap.keyId,
    input.appBundleId,
  );
  const signature = creator.createSignature(
    input.productId,
    input.offerCode,
    input.applicationUsername,
    nonce,
    timestampMs,
  );
  return { signature, nonce, timestampMs, keyId: iap.keyId };
}

export function signPromotionalOfferV2(iap: IapSigningConfig, input: PromoOfferV2Input): JWSResult {
  const creator = new PromotionalOfferV2SignatureCreator(
    iap.privateKey,
    iap.keyId,
    iap.issuerId,
    input.appBundleId,
  );
  const jws = creator.createSignature(input.productId, input.offerIdentifier, input.transactionId);
  return { jws };
}

export function signIntroductoryOfferEligibility(
  iap: IapSigningConfig,
  input: IntroOfferEligibilityInput,
): JWSResult {
  const creator = new IntroductoryOfferEligibilitySignatureCreator(
    iap.privateKey,
    iap.keyId,
    iap.issuerId,
    input.appBundleId,
  );
  const jws = creator.createSignature(
    input.productId,
    input.allowIntroductoryOffer,
    input.transactionId,
  );
  return { jws };
}

const SETUP_INSTRUCTIONS =
  'Offer signing requires the In-App Purchase signing key from App Store Connect → Users and Access → Integrations → In-App Purchase (NOT the same .p8 as the ASC API key). Set ASC_IAP_ISSUER_ID, ASC_IAP_KEY_ID, and ASC_IAP_PRIVATE_KEY_PATH. Run `appstoreconnect-mcp doctor` to verify the configuration.';

// Resolve IAP signing config at call time so that:
//   1. A server started without IAP env vars still works for all the
//      non-signing tools.
//   2. Signing tools fail with a clear setup message if the env is missing,
//      instead of a generic null-deref.
// Reads env each call — cheap, and lets the user fix env without restarting.
function resolveIapConfig(
  fallback: IapSigningConfig | undefined,
): { ok: true; iap: IapSigningConfig } | { ok: false; message: string } {
  if (fallback) return { ok: true, iap: fallback };
  try {
    const iap = loadIapSigningConfig();
    if (iap) return { ok: true, iap };
    return { ok: false, message: SETUP_INSTRUCTIONS };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `${detail}\n\n${SETUP_INSTRUCTIONS}` };
  }
}

export function registerOfferSigning(
  server: McpServer,
  iapConfig: IapSigningConfig | undefined,
): void {
  server.registerTool(
    'asc_sign_promotional_offer_legacy',
    {
      title: 'Sign a promotional offer (legacy format)',
      description:
        "Sign a promotional-offer redemption payload using the legacy ECDSA-concatenated format. Use this when your iOS app uses StoreKit 1 (SKPaymentDiscount) or StoreKit 2's Product.PurchaseOption.promotionalOffer(offerID:keyID:nonce:signature:timestamp:). For new code on iOS 15+, prefer asc_sign_promotional_offer (JWS v2). " +
        'Returns the base64 signature plus the nonce, timestamp, and keyId — pass all four back to StoreKit alongside the offerID. The signature is valid for 24 hours from timestampMs; re-sign per redemption attempt, do not pre-sign and cache.',
      inputSchema: z.object({
        appBundleId: BundleIdSchema,
        productId: ProductIdSchema,
        offerCode: OfferCodeSchema,
        applicationUsername: ApplicationUsernameSchema,
        nonce: NonceSchema.optional(),
        timestampMs: TimestampMillisSchema.optional(),
      }),
    },
    async (input) => {
      const resolved = resolveIapConfig(iapConfig);
      if (!resolved.ok) {
        return { content: [{ type: 'text', text: resolved.message }], isError: true };
      }
      try {
        const result = signPromotionalOfferLegacy(resolved.iap, input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Signing failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'asc_sign_promotional_offer',
    {
      title: 'Sign a promotional offer (JWS v2)',
      description:
        "Sign a promotional-offer redemption payload using the JWS v2 format (recommended for new code; introduced WWDC 2025, back-deployed to iOS 15). Use this when your iOS app uses StoreKit 2's newer Product.PurchaseOption.promotionalOffer / subscriptionPromotionalOffer APIs. " +
        "Returns the JWS compact serialization (header.payload.signature, base64url-encoded). Pass it directly to the StoreKit API expecting a JWS string. transactionId is optional but strongly recommended — use the customer's appTransactionId. The signature is valid for 24 hours from the iat claim; re-sign per redemption attempt.",
      inputSchema: z.object({
        appBundleId: BundleIdSchema,
        productId: ProductIdSchema,
        offerIdentifier: OfferCodeSchema,
        transactionId: TransactionIdSchema.optional(),
      }),
    },
    async (input) => {
      const resolved = resolveIapConfig(iapConfig);
      if (!resolved.ok) {
        return { content: [{ type: 'text', text: resolved.message }], isError: true };
      }
      try {
        const result = signPromotionalOfferV2(resolved.iap, input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Signing failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'asc_sign_introductory_offer_eligibility',
    {
      title: 'Sign an introductory-offer eligibility override',
      description:
        'Sign a JWS that overrides StoreKit\'s default introductory-offer eligibility check. Use this when you want to grant a returning customer a fresh introductory offer (which StoreKit normally only allows once per subscription group per Apple ID), or deny an offer the customer would otherwise be eligible for. Same signing key as promo offers; aud="introductory-offer-eligibility". ' +
        "Pair with StoreKit 2's Product.PurchaseOption.introductoryOfferEligibility(...). Signature valid for 24 hours from iat.",
      inputSchema: z.object({
        appBundleId: BundleIdSchema,
        productId: ProductIdSchema,
        allowIntroductoryOffer: z
          .boolean()
          .describe(
            'true = allow the customer to redeem an introductory offer (override StoreKit eligibility). false = deny.',
          ),
        transactionId: TransactionIdSchema,
      }),
    },
    async (input) => {
      const resolved = resolveIapConfig(iapConfig);
      if (!resolved.ok) {
        return { content: [{ type: 'text', text: resolved.message }], isError: true };
      }
      try {
        const result = signIntroductoryOfferEligibility(resolved.iap, input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Signing failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
