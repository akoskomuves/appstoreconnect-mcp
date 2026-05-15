---
'@akoskomuves/appstoreconnect-mcp': minor
---

v0.4.0 — close the monetization loop. PPP auto-apply now works for every paid surface (subscriptions, apps, IAPs), and price-point listings can be narrowed to a target band.

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
