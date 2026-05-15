# appstoreconnect-mcp

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
