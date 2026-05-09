# appstoreconnect-mcp

[![npm](https://img.shields.io/npm/v/appstoreconnect-mcp.svg)](https://www.npmjs.com/package/appstoreconnect-mcp)
[![CI](https://github.com/akoskomuves/appstoreconnect-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/akoskomuves/appstoreconnect-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Apple App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi). Drives apps, subscriptions, pricing, and more from any MCP-compatible client (Claude Code, Claude Desktop, etc.).

> Status: early — `v0.1.0` covers the subscription-pricing surface (the PPP rebalancing use case). New domains are added one file at a time; see [Roadmap](#roadmap).

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

## PPP rebalancing skill

The `examples/ppp-rebalance/` directory contains a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that wraps these tools into a Purchasing Power Parity workflow (dry-run → schedule → rollback) with the gotchas baked in.

```sh
mkdir -p ~/.claude/skills && \
  ln -s "$PWD/examples/ppp-rebalance" ~/.claude/skills/ppp-rebalance
```

Then ask Claude: *"Rebalance my subscription prices using the ppp-rebalance skill."*

## Roadmap

- [x] Apps + subscription pricing (v0.1)
- [ ] TestFlight (beta groups, testers, builds)
- [ ] App metadata (screenshots, descriptions, localizations)
- [ ] Sales reports / analytics
- [ ] In-app purchases (non-subscription)
- [ ] Customer reviews

Each is one new file under `src/domains/` — contributions welcome.

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
