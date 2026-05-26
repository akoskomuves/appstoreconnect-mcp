---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.8.0 — subscription offer codes: campaigns, bulk codes, and CSV export.

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
