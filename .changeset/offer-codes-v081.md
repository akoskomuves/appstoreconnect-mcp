---
"@akoskomuves/appstoreconnect-mcp": patch
---

v0.8.1 — subscription offer codes follow-ons: custom (multi-use) codes, `environment` on batch create, `autoRenewEnabled` on campaign create, richer campaign digest.

Apple's offer-code domain has three child resource types — one-time-use batches (v0.8.0), and custom multi-use codes (this release). A custom code is one developer-chosen string redeemable up to `numberOfCodes` times across customers (e.g. `"LAUNCH2026"` usable by the first 500 people who type it). Unlike one-time-use batches — where Apple generates opaque strings and you fetch them as CSV via `/values` — the redeemable string IS the resource attribute on a custom code, so there's no separate export step.

**New tools (three):**

- `asc_list_subscription_offer_code_custom_codes` — list multi-use codes under a campaign, newest-first, with a "total redemption cap" footer. Indefinite-redemption codes (no expirationDate) render as `—`.
- `asc_post_subscription_offer_code_custom_code` — create a multi-use code. Caller picks `customCode` (the redeemable string) and `numberOfCodes` (the redemption cap); `expirationDate` (`YYYY-MM-DD`) is optional. Immutable post-create, same as one-time-use batches; only `active` is patchable. Apple has no DELETE on this resource either — `PATCH active=false` is the only retirement path.
- `asc_patch_subscription_offer_code_custom_code` — toggle `active` to kill a leaked or expired public code without nuking the parent campaign.

**Extended surfaces:**

- `asc_post_subscription_offer_code_one_time_use_codes` now accepts an optional `environment: SANDBOX | PRODUCTION` (per `OfferCodeEnvironment` enum). Omitted means Apple's default (PRODUCTION). Sandbox batches never bill real money and don't count against the live campaign's production allotment — useful for StoreKit redemption smoke testing without burning production codes.
- `asc_post_subscription_offer_code` and `ppp_apply_proposal` (`resourceType: "offerCode"`) now accept an optional `autoRenewEnabled` boolean. Omitted means Apple's default (auto-renew on). Pass `false` to make the campaign a one-shot non-renewing offer — pairs naturally with PAY_UP_FRONT for "redeem a code, get 3 months, then nothing auto-bills."
- `asc_list_subscription_offer_codes` digest gains an `AUTO_RNW` column (Y/N/— per `autoRenewEnabled`) and a `CODES` column rendering `productionCount/sandboxCount` when Apple exposes them (falls back to `totalNumberOfCodes` on sparse-fieldset responses).
- `asc_list_subscription_offer_code_one_time_use_codes` digest gains an `ENV` column (SBX / PROD / —) so the `environment` choice round-trips back into the operator's view. `ONE_TIME_USE_FIELDS` extended accordingly.
- The `OFFER_CODE_FIELDS` sparse-fieldset pin now includes `autoRenewEnabled,productionCodeCount,sandboxCodeCount` so the new columns aren't silently empty against the live API.

**Apple-contract notes** (verified against the AvdLee Swift SDK + live smoke against a real ASC account on 2026-05-31):

- Custom-code create body accepts `customCode` + `numberOfCodes` (+ optional `expirationDate`). The `active` flag is PATCH-only, same as one-time-use batches.
- `autoRenewEnabled` and `environment` both ride on encodeIfPresent — body builders OMIT the key entirely when undefined rather than sending `null`, mirroring the FREE_TRIAL `subscriptionPricePoint` fix from v0.8.0 (Apple's persistence layer 500s on explicit nulls in offer-code attribute slots).
- Custom-code `expirationDate` is optional (unlike one-time-use batches, where it's required); omitting it makes the code redeemable indefinitely until the campaign or the resource itself is deactivated.

**Live-smoke schema corrections (caught on 2026-05-31, fixed in this release):**

- **Custom-code `numberOfCodes` floor is 500**, not 1. Apple's create endpoint rejects 1, 5, 100, 250, 499 with `ENTITY_ERROR.ATTRIBUTE.INVALID — Invalid number of codes` and accepts 500/1000/25000. Custom codes now use a dedicated `CustomCodeNumberOfCodesSchema` (min 500, max 25000); one-time-use batches keep the old `TotalNumberOfCodesSchema` (min 1, max 25000) since the two surfaces have different floors despite sharing the wire field name.
- **PATCH `active=false` is one-way** on BOTH campaigns and custom codes. Apple rejects reactivation with `STATE_ERROR — Given Subscription OfferCode is inactivate, cannot be updated` (resp. `Given custom code is inactive`). The row persists as a permanent tombstone — campaigns still count against the 10-per-subscription cap. Side effect on custom codes: Apple silently stamps today's date into `expirationDate` on deactivation, so the row reads as an expired code from then on. Tool descriptions on both PATCH tools updated to surface this.
- **One-time-use `expirationDate` has an undocumented 6-month cap.** Apple rejects further-future dates with `Please select an expiration date no more than 6 months in the future`. `ExpirationDateSchema` description annotated; the cap is enforced server-side against Apple's clock so client-side `.refine()` would be brittle.
- **`autoRenewEnabled: false` is incompatible with `STACK_WITH_INTRO_OFFERS`.** Apple rejects the combination with `Offers without auto-renew behavior can not be stacked with Intro-Offers` (and mis-points `source.pointer` at `customerEligibilities`). Both `AutoRenewEnabledSchema` and `OfferEligibilitySchema` now document the cross-field rule. Non-renewing offer codes must pair with `REPLACE_INTRO_OFFERS`.

**Roadmap shuffle:** v0.8.1 row in `README.md` flipped to ✓. v0.9 (TestFlight) is the next major surface.
