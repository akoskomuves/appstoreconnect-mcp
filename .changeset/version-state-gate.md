---
"@akoskomuves/appstoreconnect-mcp": patch
---

Fix: state-aware pre-check on `asc_patch_app_store_version_localization` + schema clarification.

A live-PATCH bug report against v0.10.0 surfaced two issues with the App Store version localization patch surface. Both are wire-layer / docstring corrections — no new tools.

**`asc_patch_app_store_version_localization` now pre-checks the parent version's state.** Apple's `AppStoreVersion` lives in a state machine that gates which `AppStoreVersionLocalization` fields are mutable, and the constraint is enforced server-side via a bare 409 `STATE_ERROR — "Attribute X cannot be edited at this time"` that doesn't say WHY, WHAT IS ALLOWED, or HOW TO RECOVER. Worse, Apple's PATCH is atomic — batching a `promotionalText` change with a `marketingUrl` change against a `READY_FOR_SALE` version rejects the entire batch.

The tool now fetches the parent version's `appStoreState` in one round-trip (with `?include=appStoreVersion&fields[appStoreVersions]=appStoreState,appVersionState`) before sending the PATCH, and refuses incompatible batches client-side with a structured message:

```
Refused: AppStoreVersionLocalization PATCH blocked by parent App Store Version state.

State:    READY_FOR_SALE
Allowed:  promotionalText
Blocked:  marketingUrl, whatsNew
Reason:   parent version is in READY_FOR_SALE — Apple only permits promotionalText edits
          without a new app-review cycle in this state
Next:     To edit other fields, create a new App Store version
          (asc_post_app_store_version — coming in v0.10.x) and patch its localizations.
          To keep your current promo edit, retry this call with promotionalText alone.
```

The state machine the tool now models (extracted from Apple docs + live observation):

- **Editable states** — all six fields mutable: `PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `METADATA_REJECTED`, `REJECTED`, `INVALID_BINARY`, `DEVELOPER_REMOVED_FROM_SALE`
- **Promo-only states** — ONLY `promotionalText` mutable (Apple's documented escape hatch — promo edits don't require a new review cycle): `READY_FOR_SALE`, `PENDING_DEVELOPER_RELEASE`, `REPLACED_WITH_NEW_VERSION`, `REMOVED_FROM_SALE`
- **Frozen states** — NOTHING mutable until Apple finishes the cycle: `WAITING_FOR_REVIEW`, `IN_REVIEW`, `PROCESSING_FOR_APP_STORE`
- **Unknown / undefined state** — pass through; Apple's server-side error stays the authoritative gate

Pre-check failure (unable to fetch the parent state) is non-fatal — the PATCH still goes through and Apple's error is surfaced verbatim. A fallback post-flight enrichment catches the rare race window where the parent state transitions between pre-check and PATCH and surfaces a hint to refetch.

The patch tool's title-line description is rewritten to lead with the state-machine constraint (instead of burying it as a "Special case"), so an LLM reading the tool schema sees the gate as a top-of-mind constraint rather than a footnote.

**`MarketingUrlSchema` description rewritten.** The schema is shared between `AppStoreVersionLocalization` (App Store product page Developer Website link) and `BetaAppLocalization` (TestFlight beta description URL). The previous description only mentioned the TestFlight surface, leading the LLM to misunderstand `marketingUrl` on v0.10's AppStoreVersionLocalization tools. The new description explicitly differentiates the two surfaces.

**Doc-only warnings on `asc_patch_subscription_localization` + `asc_patch_iap_localization`.** Both resources have a server-side `state` attribute walking `PREPARE_FOR_SUBMISSION` → `WAITING_FOR_REVIEW` → `APPROVED` and likely lock `name`/`description` once `APPROVED`. The constraint is undocumented in Apple's public docs and not yet verified live. The patch-tool descriptions now note this pattern and that Apple's `STATE_ERROR` is the source of truth. Client-side pre-check deferred until verified live (probably v0.10.2 or a future patch).

**Tests (+38)** in `tests/appstore-version-state-gate.test.ts` cover every state × field combination — refusal for blocked fields per state, allow-through for editable states, pass-through for unknown states.

277/277 tests pass · typecheck clean · lint clean · build green.
