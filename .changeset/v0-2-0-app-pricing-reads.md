---
'@akoskomuves/appstoreconnect-mcp': minor
---

v0.2.0 — app pricing surface, with PPP support for the compute side.

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
