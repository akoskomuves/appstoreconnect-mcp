---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.11.0 — App Store Version write surface + V2 Review Submission flow. Closes the release lifecycle: ship a new version end-to-end through the MCP (build → version → localize → submit) without opening App Store Connect.

**9 new tools across 2 sub-domains.**

**App Store Version writes (3 tools)** — `src/domains/appstore-versions.ts` extends the v0.10 read-only surface:

- `asc_post_app_store_version` — Create a version. Required: appId + platform + versionString. Optional: copyright, reviewType (`APP_STORE` / `NOTARIZATION`), releaseType (`MANUAL` / `AFTER_APPROVAL` / `SCHEDULED`), earliestReleaseDate, buildId (attach a TestFlight build at create time). Cross-field check refuses `releaseType: SCHEDULED` without `earliestReleaseDate` client-side rather than letting Apple reject.
- `asc_patch_app_store_version` — Mutate versionString / copyright / reviewType / releaseType / earliestReleaseDate / downloadable. Plus build relationship — `buildId` to attach/swap, `clearBuild: true` to clear (sends `data: null`). All attrs encodeIfPresent. Wire-key gotcha: Swift `isDownloadable` → wire `downloadable`. State gating deferred — Apple's field-by-state matrix is undocumented and varies per attr.
- `asc_delete_app_store_version` — DELETE with client-side state gate. Refuses frozen states (`WAITING_FOR_REVIEW`, `IN_REVIEW`, `PROCESSING_FOR_APP_STORE` — "cancel review first") and live states (`READY_FOR_SALE`, `PENDING_DEVELOPER_RELEASE`, `REPLACED_WITH_NEW_VERSION`, `REMOVED_FROM_SALE` — "deleting a live version would orphan customers, create a new version instead"). Refusal carries a structured `{state, reason, nextEditablePath}` payload.

**V2 Review Submission (6 tools)** — `src/domains/review-submissions.ts` wraps Apple's modern multi-item submission flow:

- `asc_post_review_submission` — Create a DRAFT submission on an app. Required: appId. Optional: platform (recommended — without it, Apple submits all platforms the app supports). Submission lands in `READY_FOR_REVIEW`.
- `asc_list_review_submissions` — List submissions filtered by app (Apple requires `filter[app]`).
- `asc_get_review_submission` — Fetch one with `items` + `app` + `appStoreVersionForReview` includes. Surfaces ReviewSubmissionItem state per item (`READY_FOR_REVIEW` / `ACCEPTED` / `APPROVED` / `REJECTED` / `REMOVED`) for partial-approval diagnosis.
- `asc_patch_review_submission` — `action: "submit"` flips Apple's `submitted: true` (state walks `READY_FOR_REVIEW` → `WAITING_FOR_REVIEW`). `action: "cancel"` flips `canceled: true` (valid in `WAITING_FOR_REVIEW` / `IN_REVIEW`). The two are mutually exclusive per Apple's contract — the friendly action enum prevents emitting both.
- `asc_post_review_submission_item` — Add an App Store version as an item under a draft submission. v0.11 only wraps the `appStoreVersion` slot; ReviewSubmissionItem also accepts IAPs / experiments / in-app events / custom product page versions — those slots will be wrapped when v0.12 / v0.13 / v0.14 ship those domains.
- `asc_delete_review_submission_item` — Remove an item from a draft. Only valid in `READY_FOR_REVIEW`.

**Apple wire-key gotchas, asserted in tests:**

- `AppStoreVersionUpdateRequest`: Swift `isDownloadable` → wire `downloadable`.
- `ReviewSubmissionUpdateRequest`: Swift `isSubmitted` → wire `submitted`; Swift `isCanceled` → wire `canceled`. The friendly `action: "submit" | "cancel"` schema enforces mutual exclusivity at the tool layer.
- `ReviewSubmissionCreateRequest`: when no platform is passed, the `attributes` block is OMITTED entirely (Apple rejects bare `attributes: {}` on some submission endpoints — same pattern as `BetaTesterInvitationCreateRequest` in v0.9).
- `ReviewSubmissionItemCreateRequest`: relationship-polymorphic, but exactly ONE item-type rel is permitted per item. Body builder hard-codes the `appStoreVersion` slot; tests assert no other slot leaks.

**State machine modeled for DELETE (`evaluateVersionDeleteGate`)** — pure, offline-testable function that classifies Apple's `appStoreState` into:

- Editable (`PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `METADATA_REJECTED`, `REJECTED`, `INVALID_BINARY`, `DEVELOPER_REMOVED_FROM_SALE`) → allow
- Frozen (`WAITING_FOR_REVIEW`, `IN_REVIEW`, `PROCESSING_FOR_APP_STORE`) → refuse with cancel-first recovery path
- Live / promo-only (`READY_FOR_SALE`, `PENDING_DEVELOPER_RELEASE`, `REPLACED_WITH_NEW_VERSION`, `REMOVED_FROM_SALE`) → refuse with create-new-version recovery path
- Unknown → pass through; Apple's API stays the authoritative gate

**Schemas (8 new):** `ReviewSubmissionIdSchema`, `ReviewSubmissionItemIdSchema`, `ReviewSubmissionActionSchema` (`submit` | `cancel`), `CopyrightSchema`, `ReleaseTypeSchema` (`MANUAL` / `AFTER_APPROVAL` / `SCHEDULED`), `EarliestReleaseDateSchema` (ISO 8601 timestamp with timezone, distinct from the date-only `StartDateSchema` on the pricing surface), `ReviewTypeSchema` (`APP_STORE` / `NOTARIZATION`), `VersionStringSchema` (1-3 numeric segments).

**Digest:** `digestReviewSubmissions` renders STATE + PLATFORM + SUBMITTED + SUBMISSION_ID, newest-first by submittedDate.

**Tests (+37):** `tests/appstore-version-body.test.ts` covers create/patch wire shape including the `downloadable` wire-key strip and build relationship attach/clear; the full `evaluateVersionDeleteGate` truth table across editable / frozen / live states + unknown pass-through. `tests/review-submission-body.test.ts` covers the no-attributes-when-no-platform shape, the mutually-exclusive submit/cancel patch attrs (one OR the other, never both), and the single-item-type rel constraint on ReviewSubmissionItem create.

**Roadmap shuffle:** v0.10.1 row in `README.md` updated to reflect the state-gate fix that actually shipped at that version (not the originally-planned "version write surface" — that's now v0.11.0). v0.12 (App Info + Tags + Search Keywords) is next on the planned sequence.

**Out of scope for v0.11.0 (deferred):**
- State-aware pre-check on `asc_patch_app_store_version` (field-by-state matrix is undocumented — defer until verified live)
- The legacy V1 `/v1/appStoreVersionSubmissions` single-version surface (v0.11 uses V2 only)
- Other ReviewSubmissionItem slots (IAP / experiment / in-app event / custom product page version) — will land when those domains ship
- Manual release control after Apple approves a `MANUAL` releaseType — this is achieved by PATCH'ing the version to `releaseType: AFTER_APPROVAL` once you're ready, or by the App Availability surface (v0.15)
