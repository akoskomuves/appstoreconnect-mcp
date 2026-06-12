---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.22 — Per-territory pre-orders + real-FX PPP. Two of the three remaining v1.0+ items.

**Pre-orders (1 new tool)** — `asc_patch_territory_availability`: PATCH `/v1/territoryAvailabilities/{id}` with available / releaseDate / preOrderEnabled, completing the v0.15 availability surface (list → patch → end-pre-order). The ID is the Apple-opaque base64 composite from `asc_list_territory_availabilities` (the v0.15 discovery) — bare ISO codes rejected. ⚠️ `available=false` pulls the app from sale in that territory; the description requires confirmed intent.

**Real-FX (PPP engine upgrade, no new tool)** — `fxRates` on `ppp_compute_proposal` AND `ppp_apply_proposal` (and threaded through every offer-apply path):

- Semantics: USD value of ONE unit of each currency (e.g. `{"BHD": 2.65, "KWD": 3.25}`); USD implied 1.
- Rescues the currency-mismatch territories the engine previously skipped (USD-billed Gulf storefronts where Apple Music prices in BHD/KWD/OMR) with a dimension-correct conversion: `factor = (indexLocal × usd(idx)) / (anchorLocal × usd(anchor))`, target converted into the billing currency. Implemented as the pure, unit-tested `fxAdjustedTarget` in the PPP engine.
- fx-adjusted rows are flagged (`*` on FACTOR + summary count); `reason` stays exactly `change`/`unchanged` so apply filters are unaffected.
- The skip message now says how to rescue ("pass fxRates") or what's missing ("fxRates missing a needed currency").
- **Security stance:** rates are USER-SUPPLIED only. This server's egress remains Apple-API-only — no third-party FX feed is ever fetched.

**Tests:** FX math (mismatch rescue, all-same-currency reduction, non-USD billing conversion, missing/invalid-rate refusals) + territory-availability patch body.

**Live smoke (2026-06-12, WikiCatch):** territory-availability read verified (175 territories, opaque composite IDs feeding the new PATCH tool); real-FX rescue verified against the real bundled index (BHR: 1.49 BHD × 2.65 USD/BHD vs the USD anchor → factor 0.359, dimension-correct target). The PATCH write itself was NOT drilled — it is store-affecting on a shipped app; its body shape is pinned by unit tests.
