---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.10.0 — App Store product page localizations: app versions, subscriptions, IAPs.

A minor bump because the entire localization domain is new — four sub-domains (one read-only, three full CRUD), 17 new tools, no breaking changes. This is the surface the roadmap called "the biggest LLM win": translate release notes (and product page copy + subscription/IAP marketing copy) into N locales using existing locale copy as voice reference, present a diff, push on approval.

**App Store versions (2 tools, read-only)** — `src/domains/appstore-versions.ts`. `asc_list_app_store_versions` (per-app — Apple's `/v1/appStoreVersions` collection is write-only on GET, returning `FORBIDDEN_ERROR`, so the only way to enumerate versions is via the per-app relationship path; appId is required) with optional `platform` filter; and `asc_get_app_store_version` (expands app + appStoreVersionLocalizations + build). Lookup-only surface so callers can find a version ID before localizing it; version creation, submission, and lifecycle management are deferred (Apple's flows are heavy enough to deserve their own domain). Note: Apple rejects a `sort` parameter on the per-app path (PARAMETER_ERROR.ILLEGAL); the digest client-side-sorts by createdDate descending.

**App Store version localizations (5 tools, CRUD)** — `src/domains/appstore-version-localizations.ts`. This is the LLM-leverage core. Per (version, locale): `whatsNew` (release notes, 4000 chars), `description` (4000), `keywords` (100 chars TOTAL across all keywords — count carefully), `promotionalText` (170), `marketingUrl`, `supportUrl`. Locale is immutable post-create (lookup key). The `promotionalText` field is the only one mutable after a version has been released without triggering a new app-review cycle — useful for ongoing campaigns within a released version.

**Subscription localizations (5 tools, CRUD)** — `src/domains/subscription-localizations.ts`. Per (subscription, locale): `name` (30 chars) + `description` (45 chars). A server-side `state` attribute (PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED) reflects review status — read-only, set by Apple as the localization moves through review with the parent subscription.

**IAP localizations (5 tools, CRUD)** — `src/domains/iap-localizations.ts`. Same structural shape as subscription localizations — same 3 attrs (name + locale + description), same state enum. v2 IAP surface only (Apple's `/v2/inAppPurchases` — matches the rest of the project's IAP surface from v0.3.0). Parent relationship is named `inAppPurchaseV2` on the wire even though the resource type it points at is plain `inAppPurchases`.

**Apple wire-key gotchas, documented inline + asserted in body-builder tests.**

- **App Store version localization URL attrs**: Swift `marketingURL` → wire `marketingUrl`; Swift `supportURL` → wire `supportUrl`. CamelCase, NOT all-caps despite Swift's URL suffix convention. Same pattern as v0.9.0's BetaAppLocalization URLs — Apple is consistent on stripping the all-caps URL suffix.
- **IAP localization parent rel**: relationship key is `inAppPurchaseV2` (with V2 suffix) but the resource type it references is `inAppPurchases` (no V2). Easy to conflate; test asserts both.
- **App Store version**: Swift `isDownloadable` → wire `downloadable` (is-prefix stripped). Used in the sparse-fieldset pin so the column doesn't silently empty.
- **Locale is immutable** on all 3 localization resources — PATCH bodies must not carry it. Builders have no codepath for locale on PATCH; tests assert it's never emitted.
- **Subscription + IAP `state` is server-managed** — rejected from PATCH bodies. Builders have no codepath; tests assert.

**Schemas (12 new in `src/schemas.ts`).** 4 ID schemas (AppStoreVersionIdSchema, AppStoreVersionLocalizationIdSchema, SubscriptionLocalizationIdSchema, InAppPurchaseLocalizationIdSchema). 6 product-page value schemas with Apple's explicit caps (ReleaseNotesSchema 4000, ProductDescriptionSchema 4000, KeywordsSchema 100, PromotionalTextSchema 170, SupportUrlSchema URL, SubscriptionLocalizationNameSchema 30, SubscriptionLocalizationDescriptionSchema 45, IapLocalizationNameSchema 30, IapLocalizationDescriptionSchema 45). Plus PlatformSchema (IOS/MAC_OS/TV_OS/WATCH_OS/VISION_OS enum) used by the appStoreVersions filter and shared with the existing builds surface.

**Digests (4 new).** `digestAppStoreVersions` (VERSION + PLATFORM + STATE + REL_TYPE + CREATED, newest first). `digestAppStoreVersionLocalizations` (LOCALE + length columns for whatsNew/description/keywords/promotionalText + a 50-char whatsNew preview with newline stripping). `digestSubscriptionLocalizations` (LOCALE + NAME + DESC_LEN + 45-char description preview + STATE enum). `digestIapLocalizations` (same shape as subscription localizations; legends include Apple's caps). All four sort by locale alphabetically for stable cross-run display.

**Smoke script.** `scripts/smoke-localizations.ts` walks the localization surface read-only against a live ASC account: app → newest version → version localizations → first subscription's localizations → first IAP's localizations. Inline wire-key sanity check asserts `marketingUrl`/`supportUrl` are present and `marketingURL`/`supportURL` are not. READ-ONLY; writes are exercised via the MCP tools through Claude, same pattern as v0.8.x / v0.9 cycles.

**Tests (+26).** Three new test files (`tests/appstore-version-localization-body.test.ts`, `tests/subscription-localization-body.test.ts`, `tests/iap-localization-body.test.ts`). 235/235 cumulative pass. Wire-key correctness is the consistent assertion theme: "this wire key must appear, this Swift property name must not." The IAP localization tests also explicitly guard the `inAppPurchaseV2` (relationship key) vs `inAppPurchases` (resource type) split with a regression test for the common wrong shapes `inAppPurchase` / `iap`.

**Roadmap shuffle.** v0.10 row in `README.md` flipped to ✓ and reworded to enumerate the four shipped sub-domains. Roadmap intro extended to "v0.1–v0.10". Next: v0.11 (customer reviews — read, respond, filter by sentiment/version) and v0.12 (sales/analytics — finance reports, app metrics, MRR tracking).

**Out of scope for v0.10.0 (deferred):** App Store version create/update/delete + submission flows (heavy enough to deserve their own domain). Screenshot sets + preview sets (asset upload is its own beast — likely a v0.11 or v0.12 split). Custom product pages + their version localizations (niche, fewer users). App-clip invocations. tvOsPrivacyPolicy on app-store-version localizations (Apple exposes it on `BetaAppLocalization` only per the Swift SDK — not on this resource). These will likely land as a v0.10.1 patch or its own v0.10.2 if/when a real workflow needs them.

**Folded in: v0.9 spec-compliance fixes from the v0.10 smoke pass.**

The v0.10 live smoke surfaced two latent bugs in v0.9.0 (already published) — folded into this release rather than shipped as v0.10.1:

- **`asc_list_builds`**: `sort=-uploadedDate` is rejected on the per-app relationship path `/v1/apps/{id}/builds` (PARAMETER_ERROR.ILLEGAL — same constraint as `/v1/apps/{id}/appStoreVersions`). `sort` is now emitted only when listing team-wide via `/v1/builds`. `digestBuilds` already client-side-sorts newest-first, so the operator view is unchanged.
- **`asc_list_beta_testers`**: the `appId` parameter is removed — Apple's `/v1/apps/{id}/betaTesters` relationship is DELETE-only (returns 403 FORBIDDEN_ERROR "does not allow GET_RELATED. Allowed operation is: DELETE"). The team-wide path and the group-scoped path remain. Callers wanting "every tester on app X" must orchestrate: list groups → list testers per group → dedupe by tester ID. Tool description now spells this out so the next LLM caller doesn't try to pass appId again.

Both fixes are wire-layer corrections, not feature changes. The schema-level removal of `appId` from `asc_list_beta_testers` would technically be a breaking change if anyone were using it, but the path never worked end-to-end on the live API, so no functional caller could have depended on it.
