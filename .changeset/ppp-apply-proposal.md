---
'appstoreconnect-mcp': minor
---

Add `ppp_apply_proposal` — the single-tool entry point for a PPP rebalance.

Computes the same proposal as `ppp_compute_proposal`, then asks the user to confirm via MCP elicitation (Claude Code, Claude Desktop, etc.), and on confirm POSTs all eligible price changes against App Store Connect in parallel. The user-facing flow collapses from "propose → review → manually trigger 14 writes → verify" into a single tool call with one in-client confirmation prompt.

Built-in guardrails:

- `maxDropPct` (default 90%) — refuses to apply if any single row drops more than this; guards against a bad Apple Music index entry crashing a price.
- `maxConcurrency` (default 5) — parallel POSTs well under Apple's 50/min rate limit.
- `preserveCurrentPrice: true` by default — existing subscribers are grandfathered.
- `startDate` defaults to today + 7 days (Apple requires ≥24h; 7 is a safety buffer).
- `confirm: true` arg as a fallback for clients that don't support elicitation, or for automation.

Refactored `src/domains/ppp.ts` to share the proposal-computation logic between `ppp_compute_proposal` and `ppp_apply_proposal`. Added an in-domain `concurrentMap` helper covered by 5 new tests (37 total now passing).
