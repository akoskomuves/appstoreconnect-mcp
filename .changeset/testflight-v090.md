---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.9.0 — TestFlight: builds, beta groups, beta testers, beta localizations, beta review.

A minor bump because the entire TestFlight domain is new — five sub-domains, 32 new tools, no breaking changes to the v0.1–v0.8 surface. This is the second-largest single release after v0.1.

**Builds (5 tools).** `asc_list_builds` (per-app or team-wide, with `processingState` filter — VALID/PROCESSING/FAILED/INVALID — and a default `sort=-uploadedDate`), `asc_get_build` (expands app + preReleaseVersion + buildBetaDetail + betaBuildLocalizations + betaGroups + betaAppReviewSubmission inline), `asc_patch_build` (only mutable attrs are `expired` and `usesNonExemptEncryption` — tool refuses no-op PATCHes at the tool layer), `asc_get_build_beta_detail`, and `asc_patch_build_beta_detail` (only `autoNotifyEnabled` is mutable on this resource — `internalBuildState` + `externalBuildState` are Apple-managed reflections of review status, not settable).

**Beta groups (9 tools).** Full CRUD (`asc_list/get/post/patch/delete_beta_group`) plus 4 linkage tools (`asc_add/remove_beta_group_testers`, `asc_add/remove_beta_group_builds`). The POST supports atomic pre-seeding of `initialBetaGroupIds` + `initialBuildIds` so a group can land already populated. Pre-flight `publicLinkSanityCheck` catches the two common state errors client-side: public links on internal groups (Apple rejects) and `publicLinkLimitEnabled=true` without a `publicLinkLimit` value.

**Beta testers (5 tools).** `asc_list_beta_testers` (with mutually-exclusive `appId` / `betaGroupId` scoping), `asc_get_beta_tester` (expands apps + betaGroups + builds), `asc_post_beta_tester` (creates the record only — does NOT send the invite email), `asc_delete_beta_tester` (team-wide nuclear — use `asc_remove_beta_group_testers` to remove from just one group), and `asc_post_beta_tester_invitation` (this is what sends the email; supports both the modern app-only flow and the legacy per-tester shape Apple has marked deprecated in their contract).

**Beta localizations (10 tools).** Per-build "What to Test" (`betaBuildLocalizations`, 5 tools: list/get/post/patch/delete) and per-app standing description + feedback email + marketing/privacy URLs (`betaAppLocalizations`, 5 tools: list/get/post/patch/delete). Both surface `locale` as immutable post-create — to change locale, delete and re-create. `whatsNew` capped at 4000 chars; `description` capped at 4000 chars.

**Beta review (8 tools).** Submissions: `asc_list/get/post_beta_app_review_submission` (POST takes only `buildId` — Apple's `BetaAppReviewSubmissionCreateRequest` has no attributes block at all; tool refuses to emit one). Per-app standing detail: `asc_list/get/patch_beta_app_review_detail` (contact info + demo account + sign-in-required flag + reviewer notes). PreReleaseVersions: `asc_list/get_pre_release_version` (read-only, useful for grouping builds by version train).

**Apple wire-key gotchas documented inline and asserted in body-builder tests.** Apple's Swift SDK strips the `is` prefix from most boolean attributes when encoding to JSON, but with frustrating inconsistency:

- BetaGroup attrs: `isInternalGroup` and `hasAccessToAllBuilds` KEEP the prefix on the wire; `isPublicLinkEnabled` / `isPublicLinkLimitEnabled` / `isFeedbackEnabled` STRIP it. Mixing them up silently lands the wrong shape and Apple either no-ops or 422s.
- BetaAppLocalization URL attrs: Swift `marketingURL` → wire `marketingUrl`; Swift `privacyPolicyURL` → wire `privacyPolicyUrl` (camelCase, NOT all-caps). Easy to get wrong from intuition.
- BetaAppReviewDetail: Swift `isDemoAccountRequired` → wire `demoAccountRequired`.
- BetaTesterInvitationCreateRequest + BetaAppReviewSubmissionCreateRequest both have NO attributes block at all — only relationships. Body builders must NOT emit an `attributes: {}` placeholder; tests assert the key is absent.
- BetaBuildLocalization PATCH accepts only `whatsNew` (locale is the lookup key, immutable). BetaAppLocalization PATCH accepts everything except locale. BetaGroup PATCH excludes `isInternalGroup` + `hasAccessToAllBuilds` (immutable post-create).

**Immutability tables.** Each domain header in source documents which attributes are mutable, which are PATCH-only, and which are set-at-create-only. The patterns are stable across the domain so future TestFlight additions can mirror them.

**Schemas.** 24 new schemas added to `src/schemas.ts` upfront in the foundation commit: 9 ID schemas (Build, BuildBetaDetail, BetaGroup, BetaTester, BetaBuildLocalization, BetaAppLocalization, BetaAppReviewSubmission, BetaAppReviewDetail, PreReleaseVersion), 2 enums (BuildAudienceType — INTERNAL_ONLY/APP_STORE_ELIGIBLE — and ProcessingState — PROCESSING/FAILED/INVALID/VALID), and 13 value schemas covering locale (BCP-47 regex), whatsNew + description caps, feedback email + marketing/privacy URLs, beta-group name, tester email (uniqueness key), tester first/last name, beta-review contact info (first/last/phone/email), demo account name/password (with note about plaintext-in-ASC; rotate after each review cycle), and reviewer notes.

**Digests.** Six new digest helpers: `digestBuilds` (compact STATE: OK/PROC/FAIL/INV + AUDIENCE: INT/STORE + Y/N/— expired flag; trims ISO datetimes to date portion), `digestBetaGroups` (KIND: INT/EXT + ALL_BUILDS + PUB_LINK + LIMIT + FEEDBACK columns with em-dash for sparse fieldsets), `digestBetaTesters` (EMAIL + FIRST + LAST + INVITE EMAIL/LINK + STATE NOT_INVITED/INVITED/ACCEPTED/INSTALLED), `digestBetaBuildLocalizations` (LOCALE + WHATS_NEW_LEN + 60-char preview), `digestBetaAppLocalizations` (LOCALE + DESC_LEN + FEEDBACK_EMAIL + MARKETING_URL host-only + PRIVACY_URL host-only), `digestBetaAppReviewSubmissions` (STATE: WAIT/REVIEW/OK/NO + SUBMITTED date), `digestBetaAppReviewDetails` (CONTACT + EMAIL + DEMO_REQ Y/N/— + NOTES_LEN), and `digestPreReleaseVersions` (VERSION + PLATFORM).

**Smoke script.** `scripts/smoke-testflight.ts` walks the TestFlight surface read-only against a live ASC account, with `--app <id>` to walk a single app's full surface (builds → preReleaseVersions → betaGroups → betaTesters → betaAppLocalizations → betaAppReviewDetails → per-group expand + per-build localizations + submissions) and `--build <id>` to fetch a single build with all relationships. Verifies wire-key correctness inline (asserts `marketingUrl` is present and `marketingURL` is not, asserts `demoAccountRequired` is present and `isDemoAccountRequired` is not). The script is READ-ONLY; writes are exercised via the MCP tools through a Claude session, mirroring the v0.8.0 / v0.8.1 cycles.

**Tests (+52).** Four new test files (`tests/build-body.test.ts`, `tests/beta-group-body.test.ts`, `tests/beta-tester-body.test.ts`, `tests/beta-localization-body.test.ts`, `tests/beta-review-body.test.ts`) plus extensions to `tests/digest.test.ts` for the six new digest helpers. 209/209 tests pass. Wire-key correctness is the consistent assertion theme: "this wire key must appear, this Swift property name must not."

**Roadmap shuffle.** v0.9 row in `README.md` flipped to ✓ and reworded to reflect the actually-shipped surface. v0.10 (localizations for the App Store product page itself — release notes, descriptions, keywords) is the next major surface; v0.11 is customer reviews; v0.12 is sales/analytics.

**Out of scope for v0.9.0 (deferred):** beta recruitment criteria (auto-recruit testers), individual-tester-to-build linkage (`/v1/builds/{id}/individualTesters`), build bundles (entitlements + capabilities — niche), AppClip invocations, beta tester usage metrics, public-link redemption metrics. These will likely land as a v0.9.1 patch if/when a real workflow needs them.
