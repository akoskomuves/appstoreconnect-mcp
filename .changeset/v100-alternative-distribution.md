---
"@akoskomuves/appstoreconnect-mcp": major
---

v1.0 — EU DMA / alternative distribution, completing the roadmap. Every planned surface from v0.1 to v1.0 has now shipped: ~230 tools across 40 domains covering monetization, TestFlight, the full product page, release lifecycle, territory/rollout/export compliance, webhooks, revenue + analytics reporting, customer feedback, A/B testing, runtime health, accessibility, pre-orders, real-FX PPP, and alternative distribution.

**19 new tools in 1 sub-domain** — `src/domains/alternative-distribution.ts`. Entitlement-gated: every endpoint 403s unless the account holds Apple's EU alternative-distribution / marketplace entitlement; the error formatter explains this rather than presenting it as a bug.

- **Web-distribution domains (3):** list / register / delete (⚠️ delete stops installs from that domain). No PATCH exists — delete + re-create.
- **Signing keys (4):** list, per-app to-one get, register (takes the PUBLIC PEM only — the tool description forbids pasting private keys), delete (⚠️ artifacts stop validating).
- **Packages (5):** relationships-only create per App Store Version, to-one get, versions list (state COMPLETED/REPLACED with pre-signed time-limited download URLs printed verbatim — same hygiene as analytics segments: download promptly, never with the ASC bearer), variants + deltas lists.
- **Marketplace search details (4):** to-one get, create / patch / delete of the catalogUrl MarketplaceKit queries.
- **Marketplace webhooks (4):** list / create / patch / delete with a write-only HMAC secret (v0.17 semantics).

**Apple-contract gotchas pinned by tests:** `catalogURL`→`catalogUrl` + `endpointURL`→`endpointUrl` (URL-strip family), relationships-only package create, optional-app-relationship omission on key create, write-only marketplace secret.

**1.0 stability statement:** 486 unit tests; every release v0.12–v1.0 live-smoked against a real App Store Connect account; all 73 sparse fieldsets validated against Apple's official OpenAPI spec (`scripts/audit-fieldsets.py`); security posture — Apple-only egress (pre-signed URLs fetched bearer-free), write-only secrets, public-key-only intake, customer-facing writes (review responses, experiment starts, accessibility publishes, territory pulls, pricing) explicitly flagged for human approval in their descriptions.

**Live smoke (2026-06-12, unentitled account — the expected boundary):** team-level lists (domains, keys, marketplace webhooks) return clean empty 200s; the per-app key to-one returns 200 + `data:null` when absent (the v0.19 pattern — tool now reports it plainly); calling marketplaceSearchDetail on a NON-marketplace app surfaces an Apple-side 500 UNEXPECTED_ERROR (documented in the tool description: it means "not a marketplace app", not an outage). Writes not exercisable without the entitlement — body shapes pinned by unit tests.
