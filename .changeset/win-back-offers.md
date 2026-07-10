---
"@akoskomuves/appstoreconnect-mcp": minor
---

Add subscription **win-back offers** — the third subscription offer type alongside introductory and promotional offers.

Win-back offers target lapsed subscribers and are surfaced automatically by Apple to eligible churned customers. Six new tools in a new `win-back-offers` domain:

- `asc_list_subscription_win_back_offers` / `asc_get_subscription_win_back_offer` / `asc_list_subscription_win_back_offer_prices` (reads)
- `asc_post_subscription_win_back_offer` — create with eligibility rules, schedule, priority, and per-territory prices in one atomic POST (pre-flights `offerId` uniqueness)
- `asc_patch_subscription_win_back_offer` — update the mutable attributes (eligibility, `startDate`/`endDate`, `priority`, `promotionIntent`)
- `asc_delete_subscription_win_back_offer`

Immutability mirrors Apple's contract: `referenceName`, `offerId`, `duration`, `offerMode`, `periodCount`, `targetSubscriptionPlanType`, and the prices are fixed after creation (delete + re-create to change them). Wire shapes for create/patch are pinned by unit tests.
