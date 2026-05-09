# appstoreconnect-mcp

[![npm](https://img.shields.io/npm/v/appstoreconnect-mcp.svg)](https://www.npmjs.com/package/appstoreconnect-mcp)
[![CI](https://github.com/akoskomuves/appstoreconnect-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/akoskomuves/appstoreconnect-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Apple App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi). Drives apps, subscriptions, pricing, and more from any MCP-compatible client (Claude Code, Claude Desktop, Cursor, Windsurf).

The first published surface is **subscription pricing** — including a Purchasing Power Parity rebalance flow that's already been used to schedule 120 production price changes across 65 territories on a real iOS app. New ASC domains (TestFlight, sales, screenshots, IAPs) are designed to plug in one file at a time; see [Roadmap](#roadmap).

## Install (zero-config)

```sh
npx appstoreconnect-mcp init
```

The wizard:

1. Opens [App Store Connect → Keys](https://appstoreconnect.apple.com/access/integrations/api) so you can download a `.p8` (skipped if you already have one).
2. Copies the key to `~/.appstore/` with `chmod 600`.
3. Asks for your Issuer ID and (auto-detected) Key ID.
4. Verifies auth with a real API call before writing anything.
5. Detects which MCP clients you have installed — Claude Code, Claude Desktop, Cursor, Windsurf — and registers itself in the ones you pick.

When something looks off later, run a read-only diagnostic:

```sh
npx appstoreconnect-mcp doctor
```

### Manual install

If you'd rather wire it up by hand, add to `~/.claude.json` (Claude Code), `claude_desktop_config.json` (Claude Desktop), or your client's equivalent:

```json
{
  "mcpServers": {
    "appstoreconnect": {
      "command": "npx",
      "args": ["-y", "appstoreconnect-mcp"],
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
  -- npx -y appstoreconnect-mcp
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

### Pricing (writes)
- `asc_post_subscription_price` — schedule a price change for one territory
- `asc_delete_subscription_price` — cancel a pending scheduled change

### Territories
- `asc_list_territories` — all 175 App Store territories

### PPP rebalancing
- `ppp_load_index` — return the bundled Apple Music Individual-plan price snapshot used as the PPP signal
- `ppp_compute_proposal` — compute a proposed per-territory price schedule for a subscription (read-only dry-run; uses Apple Music ratios as implied PPP-FX, snaps to valid Apple price points, applies a configurable round strategy and floor)
- `ppp_apply_proposal` — same computation, then schedule the changes against ASC after confirming via MCP elicitation (or `confirm: true` for unattended use). Refuses to apply if any row drops by more than `maxDropPct` (default 90%); paces writes at `maxConcurrency` (default 2) and retries 429s automatically; skips territories where ASC billing currency ≠ Apple Music currency.

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

- [x] **v0.1** — Apps · subscriptions · subscription pricing · PPP rebalance (with elicitation, 429 retry, currency-mismatch skip, sanity floor/ceiling)
- [ ] TestFlight (beta groups, testers, builds)
- [ ] App metadata (screenshots, descriptions, localizations)
- [ ] Sales reports / analytics
- [ ] In-app purchases (non-subscription)
- [ ] Customer reviews
- [ ] Real-FX support for currency-mismatched territories (today they're skipped; with an FX feed we could compute a correct target)

Each new domain is one file under `src/domains/` plus a `register*` call in `src/index.ts`. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

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

## Security

Never commit `.p8` keys. Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Akos Komuves
