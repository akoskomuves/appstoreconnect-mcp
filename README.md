# appstoreconnect-mcp

[![npm](https://img.shields.io/npm/v/@akoskomuves/appstoreconnect-mcp.svg)](https://www.npmjs.com/package/@akoskomuves/appstoreconnect-mcp)
[![CI](https://github.com/akoskomuves/appstoreconnect-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/akoskomuves/appstoreconnect-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Apple App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi). Drives apps, subscriptions, pricing, and more from any MCP-compatible client (Claude Code, Claude Desktop, Cursor, Windsurf).

The first published surface is **subscription pricing** — including a Purchasing Power Parity rebalance flow that's already been used to schedule 120 production price changes across 65 territories on a real iOS app. New ASC domains (TestFlight, sales, screenshots, IAPs) are designed to plug in one file at a time; see [Roadmap](#roadmap).

## Install (zero-config)

```sh
npx @akoskomuves/appstoreconnect-mcp init
```

The wizard:

1. Opens [App Store Connect → Keys](https://appstoreconnect.apple.com/access/integrations/api) so you can download a `.p8` (skipped if you already have one).
2. Copies the key to `~/.appstore/` with `chmod 600`.
3. Asks for your Issuer ID and (auto-detected) Key ID.
4. Verifies auth with a real API call before writing anything.
5. Detects which MCP clients you have installed — Claude Code, Claude Desktop, Cursor, Windsurf — and registers itself in the ones you pick.

When something looks off later, run a read-only diagnostic:

```sh
npx @akoskomuves/appstoreconnect-mcp doctor
```

### Manual install

If you'd rather wire it up by hand, add to `~/.claude.json` (Claude Code), `claude_desktop_config.json` (Claude Desktop), or your client's equivalent:

```json
{
  "mcpServers": {
    "appstoreconnect": {
      "command": "npx",
      "args": ["-y", "@akoskomuves/appstoreconnect-mcp"],
      "env": {
        "ASC_ISSUER_ID": "...",
        "ASC_KEY_ID": "...",
        "ASC_PRIVATE_KEY_PATH": "~/.appstore/AuthKey_XXXXXXXXXX.p8"
      }
    }
  }
}
```

Or via Claude Code's CLI:

```sh
claude mcp add appstoreconnect \
  -e ASC_ISSUER_ID=... \
  -e ASC_KEY_ID=... \
  -e ASC_PRIVATE_KEY_PATH=~/.appstore/AuthKey_XXXXXXXXXX.p8 \
  -- npx -y @akoskomuves/appstoreconnect-mcp
```

## Configure

Generate an App Store Connect API key at [App Store Connect → Users and Access → Integrations → Keys](https://appstoreconnect.apple.com/access/integrations/api). Pricing writes need the **Admin** role; read-only operations work with **App Manager**.

| Variable | What |
| --- | --- |
| `ASC_ISSUER_ID` | Issuer UUID from the Keys page |
| `ASC_KEY_ID` | 10-character Key ID |
| `ASC_PRIVATE_KEY_PATH` | Path to your downloaded `AuthKey_XXXXXXXXXX.p8` file (`~` is expanded) |

The `.p8` file is a private key — never commit it. Recommended: `~/.appstore/AuthKey_XXXXXXXXXX.p8` outside any repo.

## Tools

### Apps
- `asc_list_apps` — list apps (filter by `bundleId`)
- `asc_get_app` — fetch one app by ID

### Subscriptions
- `asc_list_subscription_groups` — groups for an app
- `asc_list_subscriptions` — auto-renewable subscriptions in a group
- `asc_list_subscription_prices` — current price schedule per subscription
- `asc_list_subscription_price_points` — valid price points for a subscription in a territory

### Subscription pricing (writes)
- `asc_post_subscription_price` — schedule a price change for one territory
- `asc_delete_subscription_price` — cancel a pending scheduled change

### App pricing (paid non-subscription apps)
- `asc_list_app_prices` — current price schedule for an app, splitting manual overrides from auto-derived prices and surfacing the base territory
- `asc_list_app_price_points` — valid Apple price tiers for an app in a given territory (~600+ tiers per territory; pair with a `nearAmount` filter when supported)
- `asc_post_app_price_schedule` — replace the entire price schedule (whole-schedule replace, NOT a merge — matches Apple's API). Pre-flight refuses unless at least one entry targets the base territory with no `startDate`, and requires explicit `acknowledgeReplacesAll: true`. A separate `acknowledgeDeletesScheduledIfBaseChanges` ack is required when changing the base territory (Apple wipes pending scheduled changes on base-change). Apps have no grandfather mechanism — new schedules activate atomically at each entry's `startDate`.

### In-app purchases (consumables, non-consumables, non-renewing subs)
- `asc_list_iaps` — list IAPs for an app (v2 surface only — auto-renewable subscriptions are covered by the Subscriptions tools above). Filterable by `inAppPurchaseType` and `state`. If this returns zero rows for an app you know has IAPs, the IAPs may be legacy-only and need to be migrated in the App Store Connect web UI before they appear here.
- `asc_get_iap` — fetch a single IAP by ID.
- `asc_list_iap_prices` — current price schedule for an IAP (same shape as app prices: manual overrides + auto-derived + base territory).
- `asc_list_iap_price_points` — valid Apple price tiers for an IAP in a given territory.
- `asc_post_iap_price_schedule` — replace the entire IAP price schedule (same whole-schedule replace semantics as `asc_post_app_price_schedule`: `acknowledgeReplacesAll: true`, base-territory entry with no `startDate`, base-change ack required). No grandfather mechanism — same as apps.

### Territories
- `asc_list_territories` — all 175 App Store territories

### PPP rebalancing
- `ppp_load_index` — return the bundled Apple Music Individual-plan price snapshot used as the PPP signal
- `ppp_compute_proposal` — compute a proposed per-territory price schedule (read-only dry-run; uses Apple Music ratios as implied PPP-FX, snaps to valid Apple price points, applies a configurable round strategy and floor). Pass `resourceType: "subscription"` (default) with `subscriptionId`, or `resourceType: "app"` with `appId` for paid apps.
- `ppp_apply_proposal` — for `resourceType: "subscription"`: recomputes and schedules the changes against ASC after confirming via MCP elicitation (or `confirm: true` for unattended use). Refuses to apply if any row drops by more than `maxDropPct` (default 90%); paces writes at `maxConcurrency` (default 2) and retries 429s automatically; skips territories where ASC billing currency ≠ Apple Music currency. For `resourceType: "app"`: returns the proposal table plus a JSON payload pre-formatted for `asc_post_app_price_schedule` (auto-apply for apps is on the v0.2 follow-up list — Apple's whole-schedule-replace semantics need a different code path).

### Response shape

Every list/get tool returns a compact text table by default — designed for an LLM to read without burning context. Every tool also accepts:

- `raw: true` — return the full JSON:API payload (`data`, `included`, `links`, `meta`) for debugging or advanced use.
- `maxItems: number` — cap auto-pagination (default 500–1000 depending on the tool). The MCP follows `links.next` and merges + dedupes `included` resources across pages.

Sparse fieldsets (`fields[type]=...`) are applied per tool to avoid pulling unused attributes. The whole 175-territory price schedule comes back in one paginated call (200/page) at roughly 1/10th the size of the unfiltered payload.

## Production behavior

A few details worth knowing before running `ppp_apply_proposal` against a live App Store Connect account:

- **Rate limit handling.** Apple throttles POST endpoints around 50/min. `client.request` honours `Retry-After` headers and falls back to exponential backoff (2s → 60s, capped, up to 6 retries). A 60-territory rebalance pacing through retries finishes in about 2 minutes wall time with zero manual intervention.
- **Currency-mismatch skip.** If the bundled Apple Music index lists a territory in one currency (say BHD) but ASC bills your subscription in another (USD), the PPP-FX ratio breaks dimensionally. The proposal marks those rows `currency-mismatch (asc=USD, am=BHD)` and excludes them from the apply set. Common in Gulf USD-billed markets (BHR, KWT, OMN). Set those manually if you want to.
- **Sanity floor.** `floorFactor` (default 0.15) is a hard lower bound on per-territory drops as a fraction of the current price — guards against a stale index entry collapsing a price to near-zero. For a more conservative rebalance, pass 0.30 or 0.50.
- **Sanity ceiling on drops.** `maxDropPct` (default 90%) refuses to apply *any* run where a single row drops more than this. If you've ever seen Apple Music tank a market price aggressively, this catches the resulting outlier before you write it to ASC.
- **Refresh the snapshot when you care.** `data/apple-music-prices.json` is a hand-curated snapshot. Each entry is dated; the snapshot date is shown in proposal output. Pull request a refresh when Apple Music prices move and the project will fold it in.

## PPP rebalancing skill

The `examples/ppp-rebalance/` directory contains a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that wraps these tools into a Purchasing Power Parity workflow (dry-run → schedule → rollback) with the gotchas baked in.

```sh
mkdir -p ~/.claude/skills && \
  ln -s "$PWD/examples/ppp-rebalance" ~/.claude/skills/ppp-rebalance
```

Then ask Claude: *"Rebalance my subscription prices using the ppp-rebalance skill."*

## Roadmap

v0.1 and the v0.2.0 slice cover roughly all of monetization pricing reads + subscription writes + paid-app whole-schedule writes. The rest is fertile ground for LLM-driven ops because so much App Store work is judgment-heavy text — translations, review responses, pricing positioning — that a model can draft and a human approves.

| Phase | Domain | What it unlocks |
| --- | --- | --- |
| **v0.1** ✓ | Apps · subscriptions · subscription pricing · PPP rebalance | Schedule per-territory price changes by purchasing power. |
| **v0.2.0** ✓ | App pricing (non-subscription): list / list price points / replace schedule · PPP compute extended to apps | PPP dry-run against paid apps; manual apply via `asc_post_app_price_schedule`. |
| **v0.2.1** ✓ | In-app purchases (v2): list / get / price schedule reads + writes | Same monetization surface for IAPs (consumables, non-consumables, non-renewing subs). Auto-renewables stay on the Subscriptions tools. |
| **v0.2.x** | App-side `ppp_apply_proposal` auto-apply · PPP for IAPs · introductory offers · promotional offers · `nearAmount` filter on price-point listing | One-shot PPP rebalance for *every* paid surface, not just subs. |
| **v0.3** | TestFlight: builds · beta groups · beta testers · build localizations · beta app review | "Invite these 30 testers to the new build with this test note in EN/ES/JA." |
| **v0.4** | App version localizations · subscription localizations · IAP localizations | The biggest LLM win. Translate release notes into 35 locales using existing localizations as voice reference, present diff, push on approval. |
| **v0.5** | Customer reviews (read · respond · filter by sentiment/version) | "Draft a response to every 1-star review on the latest version that mentions the export bug. Show me before posting." |
| **v0.6** | Sales/trends · finance reports · app analytics | "Why did MRR drop in Brazil last week? Compare to the rebalance activation date." |
| **v0.7** | EU DMA: external purchase links · alternative payment systems · compliance reports | Niche but valuable for any app opting out of Apple's commerce in the EU. |
| **v0.8+** | Real-FX for currency-mismatch territories · screenshot uploads · ASO keyword analysis · custom product pages · A/B tests | Polish + advanced surfaces. |

**Out of scope** (Fastlane / Xcode already do these well): provisioning profiles, certificates, devices, capabilities, Game Center config.

Think of this as the LLM companion for App Store Connect ops. Fastlane is for the build/release pipeline; this is for the post-release knowledge work — translation, pricing, customer feedback, analytics.

Each new domain is one file under `src/domains/<name>.ts` plus a `register*` call in `src/index.ts`. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Develop

```sh
git clone https://github.com/akoskomuves/appstoreconnect-mcp.git
cd appstoreconnect-mcp
npm install
npm run dev   # tsx watch mode
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor flow (changesets, PR template, branch naming).

## License

[MIT](LICENSE) © 2026 Akos Komuves
