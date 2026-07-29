---
'@akoskomuves/appstoreconnect-mcp': minor
---

Adopt the **MCP 2026-07-28 protocol revision**, migrating from `@modelcontextprotocol/sdk` v1 to the split v2 packages (`@modelcontextprotocol/server` 2.0.0).

The server now speaks **both eras from one codebase** — 2026-07-28 clients get the stateless path (no `initialize` handshake, `server/discover`, per-request `_meta` envelope), while 2025-era clients keep the handshake they have today via the SDK's legacy shim. All 306 tools, their names, schemas, and behavior are unchanged.

What changed under the hood:

- **Entry point** — `serveStdio(factory)` replaces the hand-wired `StdioServerTransport` + `server.connect()`. Credentials are still resolved once up front, so a bad key fails fast on stderr rather than once per tool call.
- **Destructive-write confirmation → multi-round-trip requests (MRTR).** Under 2026-07-28 a server may no longer push an `elicitation/create` mid-handler. The five `ppp_apply_proposal` confirmation flows (whole schedule, subscription prices, intro offers, promo offers, offer codes) now **return** `input_required` and are re-entered with the acknowledgement. No `requestState` is minted: re-entry recomputes the proposal from the same tool arguments, which also re-checks live App Store Connect prices immediately before writing. The prompts, the decline/cancel handling, and the `confirm: true` bypass are all unchanged, and a client that can't elicit still gets the "re-run with `confirm: true`" message instead of a hard error.
- **Cache hints** — `tools/list` advertises `ttlMs: 3600000` / `cacheScope: "public"`. The tool list is registered once at startup, never mutates, and contains no account-derived data, so it is safely cacheable for the process lifetime.
- **Deterministic `tools/list` order** (a new SHOULD in this revision) — already satisfied by fixed registration order; verified identical across independent processes.
- **Deprecation audit** — the server uses none of Roots, Sampling, or Logging, all deprecated in this revision.
- `zod` floor raised to `^4.2.0` (required by SDK v2).
