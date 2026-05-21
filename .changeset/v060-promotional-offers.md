---
'@akoskomuves/appstoreconnect-mcp': minor
---

v0.6.0 — subscription promotional offers, with PPP awareness.

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
