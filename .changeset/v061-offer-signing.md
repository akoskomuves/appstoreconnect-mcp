---
'@akoskomuves/appstoreconnect-mcp': minor
---

v0.6.1 — subscription offer signing for in-app redemption.

Closes the v0.6 loop: v0.6.0 added the ASC config surface for promotional offers; v0.6.1 adds the cryptographic signer the consuming iOS app needs to redeem those offers via StoreKit. Three formats — Apple supports all three concurrently, and which you need depends on which StoreKit API your app uses.

**New tools (three):**

- `asc_sign_promotional_offer_legacy` — legacy ECDSA-concatenated format used by StoreKit 1's `SKPaymentDiscount` and the original StoreKit 2 `Product.PurchaseOption.promotionalOffer(offerID:keyID:nonce:signature:timestamp:)` API. Returns the base64 signature plus the nonce, timestamp, and keyId to pass back to StoreKit. Auto-generates a UUID nonce and current timestamp by default; both can be overridden for testing.
- `asc_sign_promotional_offer` — JWS v2 format introduced at WWDC 2025, recommended for new code on iOS 15+. Use with StoreKit 2's newer promotional-offer purchase options. Returns the JWS compact serialization directly.
- `asc_sign_introductory_offer_eligibility` — JWS v2 with `aud="introductory-offer-eligibility"`. Lets you override StoreKit's default introductory-offer eligibility check (e.g. grant a returning customer another trial). New in WWDC 2025.

All three sign with the same key — the per-team **In-App Purchase signing key** from App Store Connect → Users and Access → Integrations → In-App Purchase. This is distinct from the ASC API key used by every other tool in this MCP.

**Built on Apple's official library.** Uses `@apple/app-store-server-library`'s `PromotionalOfferSignatureCreator`, `PromotionalOfferV2SignatureCreator`, and `IntroductoryOfferEligibilitySignatureCreator` rather than hand-rolling crypto. The legacy format alone has at least four landmines (U+2063 INVISIBLE SEPARATOR as delimiter, base64 vs base64url, DER-encoded signature, lowercased applicationUsername) — Apple's reference library handles all of them.

**New env vars (optional):**

- `ASC_IAP_ISSUER_ID` — the issuer UUID shown on the In-App Purchase keys page (different from `ASC_ISSUER_ID`).
- `ASC_IAP_KEY_ID` — 10-character key ID.
- `ASC_IAP_PRIVATE_KEY_PATH` — path to the IAP signing `.p8` (`~` is expanded).

Server still starts without these — only the `asc_sign_*` tools refuse with a setup message if they're missing. The other tools are unaffected. Setting one or two but not all three is rejected with a clear error.

**`appstoreconnect-mcp doctor` extended** with an "IAP signing" section that reports whether the IAP env vars are configured, whether the `.p8` loads, and whether it parses as a valid ES256 key. Skipped (not failed) when no IAP env vars are set.

**Roadmap shuffle:** v0.7.0 = subscription offer codes (one-time-use bulk + custom codes); v0.8 = TestFlight; v0.9 = localizations; v1.0 = customer reviews; v1.1 = sales/analytics.
