# appstoreconnect-mcp

## 0.8.0

### Minor Changes

- f83d75a: v0.8.0 — subscription offer codes: campaigns, bulk codes, and CSV export.

  Opens the third subscription-discount surface alongside intro offers (new subscribers, free trial / pay-as-you-go / pay-up-front) and promotional offers (existing/lapsed subscribers, in-app SubscriptionOffer redemption). Offer codes are the customer-facing redeemable-string mechanism: the user enters a code in App Store → gets the campaign's terms applied to their subscription.

  **Apple's model has three layers.** The CAMPAIGN (`subscriptionOfferCodes`) carries name, customer-eligibility cohorts (NEW / EXISTING / EXPIRED), offer-eligibility (STACK_WITH_INTRO_OFFERS / REPLACE_INTRO_OFFERS), mode, duration, periods, and per-territory prices. ONE-TIME-USE BATCHES (`subscriptionOfferCodeOneTimeUseCodes`) are bulk-generated unique strings, one redemption each, with the actual code values exposed via a separate `/values` sub-resource that serves text/csv. CUSTOM (MULTI-USE) CODES — a single string redeemable by many people — are deferred to v0.8.1.

  **New tools (eight):**

  - `asc_list_subscription_offer_codes` — list campaigns on a subscription with cohort + offer-eligibility compact labels.
  - `asc_get_subscription_offer_code` — fetch one with prices, one-time-use batches, and custom codes inlined.
  - `asc_post_subscription_offer_code` — atomic create: campaign + all per-territory prices in one POST. Pre-flights the 10-campaign-per-subscription cap and refuses name collisions before the API call. Validates mode/price-point consistency: FREE_TRIAL refuses a stray `pricePointId`, non-FREE_TRIAL refuses a missing one.
  - `asc_patch_subscription_offer_code` — toggle `active`. The only mutable attribute on this resource.
  - `asc_list_subscription_offer_code_one_time_use_codes` — list bulk batches under a campaign, newest first, with a "total codes generated" footer.
  - `asc_post_subscription_offer_code_one_time_use_codes` — generate a batch of unique single-redemption strings (numberOfCodes + expirationDate as YYYY-MM-DD).
  - `asc_patch_subscription_offer_code_one_time_use_codes` — toggle `active` on a batch. Use to kill a leaked batch without nuking the parent campaign.
  - `asc_export_subscription_offer_code_one_time_use_values` — fetch the redeemable code strings as CSV (Apple serves text/csv on `/values` directly; tool passes through verbatim with a one-line summary header, skippable via `raw: true`). Treat as secrets.

  **PPP extended.**

  `ppp_compute_proposal` and `ppp_apply_proposal` accept `resourceType: "offerCode"` alongside the existing four. New required args when this type is chosen: `offerCodeName`, `customerEligibilities`, `offerEligibility`. Reuses the subscription PPP engine. Apply is **create-only and atomic** — per-territory prices are immutable post-create on this resource (unlike promo offers, which permit a price PATCH), so there's no rebalance path: to change prices, the only option is to retire the campaign and start a new one. FREE_TRIAL rejected for PPP (no price to compute).

  **No DELETE.** Apple's API does not expose DELETE on `subscriptionOfferCodes`. The only retirement path is `PATCH active=false`, which renders a campaign inert but leaves the row in App Store Connect — and deactivated campaigns still count against the 10-per-subscription cap. The 10-cap pre-flight refuse messages on both the create tool and the PPP apply path now document this and suggest the manual-ASC-UI cleanup escape hatch. v0.8.0 originally specced a delete tool; it was removed during the bugfix cycle.

  **Apple-contract landmines documented inline** (in case the OpenAPI silently shifts again):

  - The relationship URL on a subscription is `/offerCodes`, not `/subscriptionOfferCodes` — Apple drops the resource-type prefix on relationship paths.
  - `offerEligibility` (singular enum) and `customerEligibilities` (plural list) are two different attributes; both required at create.
  - `numberOfPeriods` is required on every `offerMode`, including FREE_TRIAL — set to 1 for one-shot modes.
  - FREE_TRIAL price rows must OMIT the `subscriptionPricePoint` relationship key entirely. Apple's validator allows `{ data: null }` syntactically but its persistence layer 500s on it; the spec-compliant form is to drop the key (Swift SDK's `encodeIfPresent` idiom).
  - Batch create accepts only `numberOfCodes` + `expirationDate` (+ optional `environment`, deferred). The `active` flag is PATCH-only.
  - `expirationDate` is an ISO 8601 calendar date (`YYYY-MM-DD`), not a date-time.
  - `/values` serves `text/csv`, not JSON. The ASCClient gained a `requestText` method that defaults `Accept: text/csv` (with override) and reuses the shared auth + 401-refresh + 429-retry envelope.

  All seven landmines were caught by a live-API smoke run against a real ASC account; `scripts/smoke-offer-codes.ts` is added so the next live-API surface can use the same fast-fail pattern.

  **Roadmap shuffle:** v0.8.1 = offer-codes follow-ons (custom multi-use codes + `environment: SANDBOX|PRODUCTION` on batch create + `autoRenewEnabled` on campaign create + tighter numberOfCodes-floor surfacing). v0.9 = TestFlight. v0.10 = localizations. v0.11 = customer reviews. v0.12 = sales/analytics.

## 0.7.0

### Minor Changes

- fff9ea2: v0.7.0 — subscription offer signing for in-app redemption.

  Closes the v0.6 loop: v0.6.0 added the ASC config surface for promotional offers; v0.7.0 adds the cryptographic signer the consuming iOS app needs to redeem those offers via StoreKit. Three formats — Apple supports all three concurrently, and which you need depends on which StoreKit API your app uses.

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

## 0.6.0

### Minor Changes

- dac2b05: v0.6.0 — subscription promotional offers, with PPP awareness.

  Promotional offers are discounts targeted at **existing or lapsed** subscribers (intro offers target new subscribers — opposite eligibility, set by the resource type itself; there is no per-offer eligibility flag in Apple's API). v0.6.0 adds the full ASC config surface — six tools — plus PPP extended to a fifth resource type.

  JWT signing for in-app redemption (a separate `.p8` from the ASC API key) is intentionally out of scope here and will land as v0.6.1.

  **New tools:**

  - `asc_list_subscription_promotional_offers` — list promo offers configured for a subscription.
  - `asc_get_subscription_promotional_offer` — fetch a single offer, including its per-territory prices.
  - `asc_list_subscription_promotional_offer_prices` — list per-territory price rows attached to an offer.
  - `asc_post_subscription_promotional_offer` — create an offer with `name` + `offerCode` + mode + duration + all per-territory prices in one atomic POST. Pre-flights both Apple's 10-offer-per-subscription cap and `offerCode` collisions; refuses with a clear remedy message instead of letting Apple 409.
  - `asc_patch_subscription_promotional_offer_prices` — replace the per-territory prices on an existing offer. Apple's wire semantic is replace (the new prices array becomes the post-state, dropping any territory not listed); this tool's `mode: 'replace' | 'add' | 'remove'` parameter hides the footgun. `'add'` reads current prices and merges; `'remove'` reads and filters. `name`, `offerCode`, `mode`, `duration`, and `numberOfPeriods` are immutable after creation — to change any of them, delete and re-create.
  - `asc_delete_subscription_promotional_offer` — DELETE → 204.

  **PPP extended to promotional offers.**

  `ppp_compute_proposal` and `ppp_apply_proposal` now accept `resourceType: "promotionalOffer"` alongside the existing `"subscription" | "app" | "iap" | "introductoryOffer"`. Required args: `subscriptionId`, `offerMode`, `duration`, `promoOfferName`, `promoOfferCode`, plus `numberOfPeriods` when `offerMode=PAY_AS_YOU_GO`.

  - The compute path reuses the subscription PPP engine, with the same currency-mismatch skip and Δ-vs-current-sub-price reporting introduced in v0.5.0 for intro offers.
  - The apply path is **create-only**: refuses if `offerCode` collides with an existing offer on the sub, or if the sub is at Apple's 10-offer cap. To rebalance an existing campaign, delete it and re-run.
  - Apply is **one atomic POST** to `/v1/subscriptionPromotionalOffers` — the offer + all its per-territory prices either all land or none do. No per-row retry needed (closer to app/IAP whole-schedule semantics than intro-offers' per-row pacing).
  - `FREE_TRIAL` rejected by compute and apply (no price to compute). Create a free-trial promo with `asc_post_subscription_promotional_offer` directly.

  **Roadmap shuffle (continuing the "label = actual semver" discipline from v0.4/v0.5):** v0.6.1 = JWT signing for promotional-offer redemption; v0.7.0 = subscription offer codes (one-time-use bulk + custom codes); v0.8 = TestFlight; v0.9 = localizations; v1.0 = customer reviews; v1.1 = sales/analytics.

## 0.5.0

### Minor Changes

- a357457: v0.5.0 — subscription introductory offers, with PPP awareness.

  Introductory offers are the discounted "first window" on top of an auto-renewable subscription: free trials, pay-as-you-go promos, and pay-up-front promos. v0.5.0 adds the full surface — list / get / create / patch / delete — plus PPP-aware per-territory pricing.

  **New tools:**

  - `asc_list_subscription_introductory_offers` — list intro offers configured for a subscription, across territories. Wildcard offers (Apple's "all territories" with `territory: null`) surface as `TERR=(all)` in the table.
  - `asc_get_subscription_introductory_offer` — fetch a single offer by ID.
  - `asc_post_subscription_introductory_offer` — create an offer. Three modes:

    - `FREE_TRIAL` — no price; redeem and get the sub for `duration` free. Omit `pricePointId`.
    - `PAY_AS_YOU_GO` — discounted price each period for `numberOfPeriods` periods. Requires `pricePointId` and `numberOfPeriods`.
    - `PAY_UP_FRONT` — single charge for the whole `duration` window. Requires `pricePointId`.

    Server-side checks: `pricePointId` required unless `FREE_TRIAL`; `numberOfPeriods` required when `PAY_AS_YOU_GO`; `endDate > startDate`. Pass `territoryId` to target one market, or omit it for Apple's "all territories" wildcard (which uses the literal price point in every market with no auto-FX — for PPP-aware multi-territory offers, create one per territory).

  - `asc_patch_subscription_introductory_offer` — narrow update path. Apple only lets you change `startDate`, `endDate`, and `pricePointId` after creation. To change `offerMode` / `duration` / `numberOfPeriods`, delete and re-create. The most common use is extending `endDate` to keep a campaign running.
  - `asc_delete_subscription_introductory_offer` — delete a pending or active offer. Apple refuses to delete an offer that is currently redeemable; to stop an active offer, PATCH `endDate` to today instead.

  **PPP extended to introductory offers.**

  `ppp_compute_proposal` and `ppp_apply_proposal` now accept `resourceType: "introductoryOffer"` alongside the existing `"subscription" | "app" | "iap"`. Required args: `subscriptionId`, `offerMode`, `duration`, plus `numberOfPeriods` when `offerMode=PAY_AS_YOU_GO`.

  - The compute path snaps `basePriceAnchor` to valid subscription price points per territory using the Apple Music PPP signal — same engine as subscription PPP, same currency-mismatch skip for USD-billed Gulf markets.
  - The Δ column compares the snapped offer price against the **current regular subscription price** in that territory, so a `-50%` Δ reads as "the offer is half off the sub."
  - The apply path POSTs one offer per change row to `/v1/subscriptionIntroductoryOffers`, paced at `maxConcurrency` (default 2), with the same 429-retry behaviour as base subscription pricing.
  - `FREE_TRIAL` is rejected by both compute and apply — there is no price to compute. Use `asc_post_subscription_introductory_offer` with `territoryId` omitted for a single global free trial.
  - Intro offers are additions, not replacements: Apple returns 409 if an active offer already exists for a `(sub, territory)` cell. Those rows show as `failed` in the result table; pre-existing offers are not modified.

  **Roadmap shuffle.** v0.5 in the original roadmap covered intro + promotional + offer codes; per the Changesets convention (each domain is a minor bump) those slip down: v0.6.0 = promotional offers, v0.7.0 = offer codes, TestFlight moves to v0.8, localizations v0.9, reviews v1.0, analytics v1.1.

## 0.4.0

### Minor Changes

- d702a70: v0.4.0 — close the monetization loop. PPP auto-apply now works for every paid surface (subscriptions, apps, IAPs), and price-point listings can be narrowed to a target band.

  **ppp_apply_proposal now auto-applies for apps and IAPs.**

  Previously, `ppp_apply_proposal({resourceType: "app", ...})` returned a JSON payload that the caller had to feed back into `asc_post_app_price_schedule` by hand, and IAPs weren't on the PPP path at all. Both now POST the new schedule directly:

  - Single whole-schedule-replace POST (one HTTP call, fail/succeed atomically — no partial writes to clean up).
  - Base-territory ack guardrail: if `baseTerritory` differs from the resource's current base territory, the tool refuses until you pass `acknowledgeDeletesScheduledIfBaseChanges: true` (Apple wipes pending scheduled changes on base-change).
  - Same `maxDropPct` sanity guard as the subscription path (default 90%).
  - Same MCP elicitation confirmation flow — clients without elicitation can re-run with `confirm: true`.
  - Active-now base-territory entry is inserted automatically; if the base isn't in the proposal (anchor price unchanged), the current price-point ID is reused.

  **ppp_compute_proposal: resourceType: "iap"** with `iapId`. Same shape and output as `resourceType: "app"`, fetches via `/v2/inAppPurchases/{id}/iapPriceSchedule` and price points from `/v2/inAppPurchases/{id}/pricePoints`.

  **nearAmount filter on price-point listings.** `asc_list_subscription_price_points`, `asc_list_app_price_points`, and `asc_list_iap_price_points` now accept:

  - `nearAmount` (positive number, optional) — target customer price in the territory currency.
  - `nearCount` (default 10) — max tiers to return when `nearAmount` is set.

  Apple doesn't support a near-amount filter server-side, so the full list is still paginated, but the response is narrowed to the N closest tiers client-side. Cuts the typical 600-tier table down to ~10 candidates the model can actually reason over.

  **Notes:**

  - Apps and IAPs share a single `applyWholeSchedule` code path internally — the only differences are the JSON:API type/relationship names, which live in two small config objects (`APP_SCHEDULE_CONFIG`, `IAP_SCHEDULE_CONFIG`). IAPs use `inAppPurchaseV2` as the inline-row owning relationship even though the schedule's top-level rel is `inAppPurchase` — Apple's own spec inconsistency, baked into the code and pinned by tests.
  - `preserveCurrentPrice` and `maxConcurrency` continue to apply to subscriptions only — apps and IAPs have no grandfather mechanism and always issue a single POST.

## 0.3.0

### Minor Changes

- 698e500: v0.2.1 — in-app purchases (v2 surface).

  **New tools:**

  - `asc_list_iaps` — list IAPs for an app (consumables, non-consumables, non-renewing subscriptions). Auto-renewable subs are unchanged on the existing Subscriptions tools.
  - `asc_get_iap` — fetch one IAP by ID.
  - `asc_list_iap_prices` — current price schedule for an IAP (same shape as app prices: manual overrides + auto-derived + base territory).
  - `asc_list_iap_price_points` — valid Apple price tiers for an IAP in a given territory.
  - `asc_post_iap_price_schedule` — replace the entire IAP price schedule. Whole-schedule replace (matches Apple's API). Pre-flight checks: `acknowledgeReplacesAll: true` required, at least one entry for `baseTerritory` with no `startDate`, and `acknowledgeDeletesScheduledIfBaseChanges` when the base territory changes.

  **Notes:**

  - v1 IAP endpoints (`/v1/inAppPurchases/*`) are deprecated and not exposed. If an app's `asc_list_iaps` returns zero rows but you know it has IAPs, they're legacy-v1 and need migration via the App Store Connect web UI.
  - The IAP detail endpoint and price schedule endpoint use the `/v2/` URL prefix (Apple's API split — list is on `/v1/` but the IAP-scoped reads are on `/v2/`).
  - Inline-create payloads use the relationship name `inAppPurchaseV2` (not `inAppPurchase`) — easy to typo, baked into the write tool.
  - No `preserveCurrentPrice` analog for IAPs (same as apps) — new prices activate atomically at each entry's `startDate`.

## 0.2.0

### Minor Changes

- b96eb5a: v0.2.0 — app pricing surface, with PPP support for the compute side.

  **New tools:**

  - `asc_list_app_prices` — list the current price schedule for an app (manual overrides + auto-derived + base territory).
  - `asc_list_app_price_points` — list valid Apple price tiers for an app in a given territory.
  - `asc_post_app_price_schedule` — replace the entire price schedule. Whole-schedule replace (matches Apple's API semantics, NOT a merge). Pre-flight checks: at least one entry for the base territory with `startDate: null`, `acknowledgeReplacesAll: true` required, and a separate `acknowledgeDeletesScheduledIfBaseChanges` ack when the base territory changes (Apple wipes pending scheduled changes on base-change).

  **PPP generalized:**

  - `ppp_compute_proposal` now accepts `resourceType: "subscription" | "app"` (defaults to `"subscription"` for back-compat). For apps, pass `appId` instead of `subscriptionId`. Computes the same proposal table — the underlying fetch path is heavier for apps (one HTTP call per unique territory to resolve current amounts, since Apple's appPriceSchedule endpoint rejects chained includes).
  - `ppp_apply_proposal` accepts `resourceType` too, but auto-apply is **subscription-only** for now. For apps, the tool returns the proposal table plus a JSON payload pre-formatted for `asc_post_app_price_schedule` (whole-schedule replace path is wired separately).

  **Notes:**

  - Apps have no grandfather mechanism (no `preserveCurrentPrice` analog) — new schedules activate atomically at each entry's `startDate`.
  - Apple's `appPriceSchedule` GET rejects chained includes (`manualPrices.appPricePoint`) and `fields[appPricePoints]` selectors; the read digest shows territory + manual/auto flag + start date + IDs only. Amounts resolved via `asc_list_app_price_points`.
  - Read/write handlers in the app-pricing domain surface Apple's full error body (`errors[].detail`) on non-2xx so the model can self-correct invalid include/fields params without a roundtrip.

## 0.1.2

### Patch Changes

- abee8e4: Apple Music index: update BGR (Bulgaria) from BGN to EUR. Bulgaria adopted the euro and the App Store + Apple Music both bill in EUR there now. Previously BGR showed up as a `currency-mismatch` row in PPP proposals; with this fix it's part of the regular EUR cluster (factor 1.000 vs USA, target = anchor price).

## 0.1.1

### Patch Changes

- 0b98884: `ppp_compute_proposal` and `ppp_apply_proposal`: skip territories where the App Store Connect billing currency differs from the bundled Apple Music index currency. Marked as `currency-mismatch (asc=X, am=Y)` in the proposal table and excluded from the apply set.

  This guards against a dimensional bug: the Apple Music price ratio is only a valid PPP-FX signal when both numerator (local Apple Music price) and the ASC billing currency match. For USD-billed Gulf markets (BHR, KWT, OMN) where Apple Music is sold in BHD/KWD/OMR, the formula would have produced artificially low prices (~$0.69 instead of ~$1.80 for a $4.99 anchor). Now those markets are explicitly skipped — set them manually via `asc_post_subscription_price` if needed.

- eb65a2b: Compact PPP proposal output so the diff table fits in a normal terminal.

  Apple's `subscriptionPricePoint` IDs are ~50-char base64 strings that blew the proposal table past 80 columns and forced wrap. `ppp_compute_proposal` now shows `POINT_ID` as the last 8 characters of the ID (e.g. `…NjEifQ`) by default; pass `raw: true` to see full IDs. `ppp_apply_proposal`'s elicitation confirmation message drops the `POINT_ID` column entirely — the user is reviewing prices, not relationship IDs, and the server uses the IDs internally regardless.

- 175e96d: Handle Apple's 429 rate limits transparently in the HTTP client.

  `client.request` now retries on 429 up to 6 times, honouring the `Retry-After` header when present and falling back to exponential backoff (2s → 4s → 8s … capped at 60s). Without this, applying many subscription prices in parallel would cause Apple to start rejecting writes after ~50 requests/minute and the per-row catch in `ppp_apply_proposal` was reporting them as failed without retry — leaving partial pending schedules. Discovered when a 60-territory apply only landed 10 of the writes before Apple started throwing 429s.

  Also lowered the default `maxConcurrency` for `ppp_apply_proposal` from 5 to 2. With the new retry behaviour the higher concurrency mostly produced backoff stalls; 2 keeps writes well under Apple's threshold without sacrificing meaningful wall time on a typical 60-row run.

## 0.1.0

### Minor Changes

- a2108dd: Compact responses + auto-pagination across all read tools.

  Each list/get tool now returns a clean text table by default (`asc_list_apps`, `asc_list_subscription_groups`, `asc_list_subscriptions`, `asc_list_subscription_prices`, `asc_list_subscription_price_points`, `asc_list_territories`, `asc_get_app`). Every tool accepts `raw: true` to get the original JSON:API payload, and paginated tools accept `maxItems` (default 500–1000).

  Internal changes:

  - New `paginate()` helper follows `links.next`, merges and dedupes `included` resources across pages.
  - Sparse fieldsets (`fields[type]=…`) applied per tool to avoid pulling unused attributes.
  - `&limit=200` set on all list endpoints (was missing on `subscriptionPrices`, capping responses at 50/175 territories).
  - New `digest.ts` module with one digester per resource type, joining `data` ↔ `included` to surface the actually useful columns (territory + currency + amount instead of relationship URIs).

  Net effect: a full 175-territory subscription price schedule fits in ~5 KB of text instead of ~90 KB of nested JSON.

- cf4afca: Add `init` and `doctor` subcommands.

  `appstoreconnect-mcp init` is an interactive wizard that opens App Store Connect, copies the `.p8` to `~/.appstore/` with `chmod 600`, prompts for issuer/key IDs (Key ID auto-detected from the filename), verifies auth with a real ASC call, and registers the MCP in any installed clients (Claude Code, Claude Desktop, Cursor, Windsurf — auto-detected).

  `appstoreconnect-mcp doctor` is a read-only diagnostic — checks key directory permissions, parses each `.p8`, lists registered clients, and optionally hits the live API if env vars are set.

  The default no-arg invocation continues to start the MCP server over stdio (unchanged behavior for clients).

- b0794b6: Add `ppp_apply_proposal` — the single-tool entry point for a PPP rebalance.

  Computes the same proposal as `ppp_compute_proposal`, then asks the user to confirm via MCP elicitation (Claude Code, Claude Desktop, etc.), and on confirm POSTs all eligible price changes against App Store Connect in parallel. The user-facing flow collapses from "propose → review → manually trigger 14 writes → verify" into a single tool call with one in-client confirmation prompt.

  Built-in guardrails:

  - `maxDropPct` (default 90%) — refuses to apply if any single row drops more than this; guards against a bad Apple Music index entry crashing a price.
  - `maxConcurrency` (default 5) — parallel POSTs well under Apple's 50/min rate limit.
  - `preserveCurrentPrice: true` by default — existing subscribers are grandfathered.
  - `startDate` defaults to today + 7 days (Apple requires ≥24h; 7 is a safety buffer).
  - `confirm: true` arg as a fallback for clients that don't support elicitation, or for automation.

  Refactored `src/domains/ppp.ts` to share the proposal-computation logic between `ppp_compute_proposal` and `ppp_apply_proposal`. Added an in-domain `concurrentMap` helper covered by 5 new tests (37 total now passing).

- 3f0f600: Add `ppp_load_index` and `ppp_compute_proposal` tools.

  `ppp_compute_proposal` is the single entry point for a Purchasing Power Parity rebalance: it fetches the current price schedule for the target subscription, loads the bundled Apple Music Individual-plan price snapshot (`data/apple-music-prices.json`), computes a per-territory factor using Apple Music ratios as the implied PPP-FX rate, fetches valid price points in parallel for territories where the target differs from current, snaps to the nearest valid Apple price point (configurable `roundStrategy`: `nearest` / `down` / `up`), and returns a compact dry-run table with `POINT_ID`s ready to feed back into `asc_post_subscription_price`. Apply a configurable sanity floor (`floorFactor`, default 0.15) so bad index data can't crash the price.

  `ppp_load_index` returns the bundled snapshot as a sorted table (or raw JSON) so users can see what reference data is in play.

  The bundled snapshot covers ~70 territories with high-confidence Apple Music prices as of 2026-05-09; refresh upstream by editing `data/apple-music-prices.json` and resubmitting.

  Updated `examples/ppp-rebalance/SKILL.md` to drive the new tool. The skill now does discover → propose → review → apply → verify → rollback, with the gotchas (preserveCurrentPrice, Russia, USD-only territories, snap direction) called out.

### Patch Changes

- d4326ce: `init`: scan `~/.appstore`, `~/Downloads`, and `~/Desktop` for `.p8` files and present them as a select list (sorted most-recent-first, with auto-detected Key IDs). Falls back to manual path entry. Avoids the chore of typing a 60-character path.

This changelog is generated from [changesets](.changeset/). See [CONTRIBUTING.md](CONTRIBUTING.md#working-on-a-change).
