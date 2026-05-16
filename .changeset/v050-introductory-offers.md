---
'@akoskomuves/appstoreconnect-mcp': minor
---

v0.5.0 — subscription introductory offers, with PPP awareness.

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
