---
'@akoskomuves/appstoreconnect-mcp': minor
---

v0.2.1 — in-app purchases (v2 surface).

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
