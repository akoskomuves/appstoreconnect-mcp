---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.16 — TestFlight follow-ons: Beta Feedback Submissions + Build Beta Notifications + Beta Recruitment Criteria. The feedback half of the TestFlight loop: v0.9 distributed builds to testers; this release reads back what testers say (screenshots, crashes, crash logs), pings them about new builds, and gates who can auto-join through public links.

**14 new tools across 3 sub-domains.**

**Beta Feedback Submissions (7 tools)** — `src/domains/beta-feedback.ts`. Tester-created, read-only records (list / get / delete only — there is no create or patch on this surface).

- `asc_list_beta_feedback_screenshot_submissions` / `asc_list_beta_feedback_crash_submissions` — per-app lists with filters: deviceModel, osVersion, appPlatform, devicePlatform, build, build.preReleaseVersion (dotted wire key), tester; newest-first sort by default. Digest shows date / device / OS / comment preview / build + tester linkage.
- `asc_get_beta_feedback_screenshot_submission` — full device context (connection, battery, disk, uptime, screen) + the `screenshots` array: `{url, width, height, expirationDate}` — Apple-signed TIME-LIMITED download URLs; re-fetch when expired.
- `asc_get_beta_feedback_crash_submission` — crash feedback metadata; the log itself is a separate resource.
- `asc_get_beta_feedback_crash_log` — GET `/v1/betaFeedbackCrashSubmissions/{id}/crashLog` → `betaCrashLogs.logText`, capped at `maxChars` (default 200k) with a truncation note.
- `asc_delete_beta_feedback_screenshot_submission` / `asc_delete_beta_feedback_crash_submission` — permanent dismissal.

**Build Beta Notifications (1 tool)** — `src/domains/build-beta-notifications.ts`.

- `asc_post_build_beta_notification` — fire-and-forget "new build available" ping to every tester with access to the build. The manual trigger for builds with `autoNotifyEnabled` off (the auto path lives on buildBetaDetail, v0.9).

**Beta Recruitment Criteria (6 tools)** — `src/domains/beta-recruitment.ts`. Device-family + OS-version windows gating public-link auto-recruitment.

- `asc_get_beta_group_recruitment_criterion` — GET `/v1/betaGroups/{id}/betaRecruitmentCriteria`. TO-ONE: a group has at most one criterion; the plural path segment returns a SINGLE resource.
- `asc_post_beta_recruitment_criterion` / `asc_patch_beta_recruitment_criterion` / `asc_delete_beta_recruitment_criterion` — lifecycle on `/v1/betaRecruitmentCriteria`. PATCH replaces the WHOLE `deviceFamilyOsVersionFilters` array (no per-entry add/remove).
- `asc_list_beta_recruitment_criterion_options` — the OS versions Apple accepts per device family (digest flattens to one row per family).
- `asc_get_beta_recruitment_compatible_build_check` — `hasCompatibleBuild`: whether matching devices could actually install one of the group's builds; false means public-link joiners passing the criteria would find nothing.

**Apple-contract gotchas pinned by tests:**

1. **Trailing-ID strip** (new instance of the URL-strip family): Swift `buildBundleID` → wire `buildBundleId` on both feedback resources. Matters for `fields[…]` sparse fieldsets — pinned by the query-builder test.
2. **Dotted relation filter**: the build-version filter is `filter[build.preReleaseVersion]` (filters on the RELATED build's pre-release version), not a flat key.
3. **BuildBetaNotificationCreateRequest has NO attributes block at all** — `data` carries type + relationships only. Stricter than the v0.15 no-attrs-OMISSION cases (where attrs were optional): this shape never had attributes. Test asserts `'attributes' in body.data === false`.
4. **BetaRecruitmentCriterionCreateRequest attributes are REQUIRED** (`deviceFamilyOsVersionFilters` non-optional in the Swift contract) — the opposite of gotcha 3; test asserts the attrs block is always present.
5. **Recruitment filter wire keys are verbatim camelCase** (`deviceFamily` / `minimumOsInclusive` / `maximumOsInclusive`) — no strips; absent min/max are OMITTED, not null.
6. **SDK lag on DELETEs**: DELETE on `/v1/betaFeedbackScreenshotSubmissions/{id}`, `/v1/betaFeedbackCrashSubmissions/{id}`, and `/v1/betaRecruitmentCriteria/{id}` is documented by Apple (verified against Apple doc JSON 2026-06-10) but MISSING from the AvdLee Swift SDK — implemented per Apple docs, flagged for live-smoke attention.
7. **To-one with plural path**: `/v1/betaGroups/{id}/betaRecruitmentCriteria` returns a single resource despite the plural segment.

**Schemas (6 new):** `BetaFeedbackScreenshotSubmissionIdSchema`, `BetaFeedbackCrashSubmissionIdSchema`, `BetaRecruitmentCriterionIdSchema`, `DeviceFamilySchema` (6-value enum incl. VISION), `DeviceFamilyOsVersionFilterSchema`, `FeedbackPlatformFilterSchema` (platform enum ≠ device-family enum).

**Digests (3 new):** `digestBetaFeedbackScreenshotSubmissions`, `digestBetaFeedbackCrashSubmissions`, `digestBetaRecruitmentCriterionOptions`.
