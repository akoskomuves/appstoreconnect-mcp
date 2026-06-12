---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.21 — Runtime health + accessibility: diagnostic signatures, perf/power metrics, accessibility declarations. Two of the three remaining v1.0+ "niche read surfaces" turn out richer than planned — accessibility declarations are full CRUD with a customer-facing publish gate.

**8 new tools across 2 sub-domains.**

**Diagnostics + perf/power (4 tools, all read-only)** — `src/domains/diagnostics.ts`.

- `asc_list_diagnostic_signatures` — per-build problem hotspots (DISK_WRITES / HANGS / LAUNCHES), impact-weighted, heaviest-first digest.
- `asc_get_diagnostic_logs` — the anonymized call stacks behind one signature. NOT JSON:API: `application/vnd.apple.diagnostic-logs+json` via an Accept override on `requestText`.
- `asc_get_app_perf_power_metrics` / `asc_get_build_perf_power_metrics` — Xcode-metrics percentile curves (8 metric types × device classes), app-rolling or single-build. NOT JSON:API: `application/vnd.apple.xcode-metrics+json`. maxChars-capped raw JSON.
- All three populate only with enough opted-in usage — empty/404 on small apps is the documented normal case.

**Accessibility declarations (4 tools)** — `src/domains/accessibility-declarations.ts`. The "Accessibility Nutrition Label" on the product page, per (app, deviceFamily).

- `asc_list_accessibility_declarations` — deviceFamily/state filters; digest renders the nine support flags as a Y/N/— matrix (— = not declared ≠ declared-unsupported).
- `asc_post_accessibility_declaration` — DRAFT create (deviceFamily required + any subset of nine flags; omitted flags OMITTED on the wire, not false).
- `asc_patch_accessibility_declaration` — flag edits + ⚠️ **publish=true is CUSTOMER-FACING** (label goes live; previous PUBLISHED becomes REPLACED). Description instructs explicit human approval.
- `asc_delete_accessibility_declaration` — DRAFTs only.

**Apple-contract gotchas pinned by tests:**

1. **The largest is-prefix strip family yet (10 members)**: nine `isSupports*` → `supports*` + `isPublish` → `publish`.
2. **Omitted ≠ false** on support flags — undeclared flags are dropped from the body.
3. **Two non-JSON:API content types** requiring Accept overrides (`vnd.apple.diagnostic-logs+json`, `vnd.apple.xcode-metrics+json`).
4. Static fieldset literal kept audit-compatible with `scripts/audit-fieldsets.py` (validated against Apple's official OpenAPI spec — 71 fieldset usages clean).

**Schemas (5 new):** `DiagnosticSignatureIdSchema`, `DiagnosticTypeSchema`, `PerfMetricTypeSchema`, `AccessibilityDeclarationIdSchema`, `AccessibilityDeclarationStateSchema`.

**Digests (2 new):** `digestDiagnosticSignatures` (heaviest-first), `digestAccessibilityDeclarations` (flag matrix).
