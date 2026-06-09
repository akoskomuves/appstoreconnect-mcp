---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.15.0 — App Availability + Phased Release + Encryption Declarations. The territory / rollout / export-compliance triad: where the app is sold, how it rolls out to users, and the US export-compliance documentation Apple requires.

**~19 new tools across 4 sub-domains.**

**App Availability v2 (4 tools)** — `src/domains/app-availability.ts`. Per-app territory availability + pre-order management.

- `asc_get_app_availability_v2` — current per-app availability + the `availableInNewTerritories` flag.
- `asc_list_territory_availabilities` — list which territories the app is sold in + their soft-launch dates + pre-order state.
- `asc_post_app_availability_v2` — **POST-only REPLACE** (no PATCH on this surface). Sends the FULL territory list + the `availableInNewTerritories` flag; Apple atomically swaps over.
- `asc_end_app_availability_pre_order` — POST an EndAppAvailabilityPreOrder to end pre-order in selected territories. Relationships-only body.

**Phased Release (4 tools)** — `src/domains/phased-release.ts`. The 7-day staged rollout state machine attached to an App Store version.

- `asc_get / post / patch / delete_app_store_version_phased_release`. State machine (4 values): INACTIVE / ACTIVE / PAUSED / COMPLETE. Apple's rollout: 1% / 2% / 5% / 10% / 20% / 50% / 100% across 7 days. Valid transitions: INACTIVE → ACTIVE, ACTIVE ↔ PAUSED, ACTIVE → COMPLETE. The PATCH carries only `phasedReleaseState` — the only mutable attribute.

**Encryption Declarations (5 tools)** — `src/domains/encryption-declarations.ts`. US export-compliance declarations + per-build linkage.

- `asc_list_app_encryption_declarations` (per app, filtered) / `asc_get_app_encryption_declaration` — read surface.
- `asc_post_app_encryption_declaration` — create. Required: appDescription + containsProprietaryCryptography + containsThirdPartyCryptography + availableOnFrenchStore. There is NO PATCH for declarations — Apple treats them as append-only; create a new one to refresh.
- `asc_get / patch_build_app_encryption_declaration` — read / set the linkage between ONE build and ONE declaration (or null to unlink). Apple's inverse (declaration → builds[]) is deprecated and skipped.

**Encryption Declaration Documents (6 tools)** — supporting document (typically a PDF questionnaire) per declaration, using the v0.13 asset-upload protocol.

- `asc_get / post / patch / delete_app_encryption_declaration_document` (raw three-step variants) + `asc_upload_app_encryption_declaration_document` (composite shortcut). Same shape as v0.13 `asc_upload_screenshot`. Helpers reused verbatim from `src/domains/asset-upload.ts`.

**Apple-contract gotchas pinned by tests:**

1. **Boolean strip pattern** (same family as v0.9 / v0.12 / v0.13 / v0.14):
   - `AppAvailabilityV2.isAvailableInNewTerritories` → wire `availableInNewTerritories`
   - `AppEncryptionDeclaration.isAvailableOnFrenchStore` → wire `availableOnFrenchStore`
   - `AppEncryptionDeclaration.isExempt` → wire `exempt` (read-only)
   - `AppEncryptionDeclarationDocumentUpdateRequest.isUploaded` → wire `uploaded` (4th time we've seen this exact one — same as v0.13 / v0.14 asset uploads)
2. **URL camelCase strip**:
   - `AppEncryptionDeclarationDocument.downloadURL` → wire `downloadUrl` (read-only)
   - `AppEncryptionDeclaration.documentURL` → wire `documentUrl` (read-only, deprecated)
3. **POST-only replacement** on AppAvailabilityV2 — no PATCH / DELETE. Send the FULL territory list every time; Apple swaps atomically.
4. **TerritoryAvailability IDs ARE the 3-letter ISO codes themselves** — `territoryAvailabilities/USA`, `territoryAvailabilities/BRA`, etc. Same discovery pattern as v0.12 AppKeyword.id (= the keyword string itself). Tests verify the array passes territory codes through verbatim.
5. **No-attrs-block omission** on AppStoreVersionPhasedReleaseCreateRequest — the `attributes` block is OPTIONAL in the Swift contract (the only attr inside, `phasedReleaseState`, is also optional). When state is omitted, the body builder OMITS the entire `attributes` key. Third domain we've seen this pattern in (after v0.9 AppInfo PATCH and v0.13 CPP Version Create).
6. **Deprecated-attr exclusion on AppEncryptionDeclaration writes** — the legacy `usesEncryption` field is NOT in the modern CreateRequest. Body builder must NOT emit it (Apple's modern path uses the server-set `exempt` flag). Tests verify the exact set of emitted attrs.
7. **Build → Declaration linkage uses bare-data shape** (no `relationships` envelope, no `attributes`): `{ data: { type, id } }` to link, `{ data: null }` to unlink. Each build has at most ONE declaration. The inverse linkage (declaration → builds[]) is deprecated and skipped.
8. **EndAppAvailabilityPreOrder is relationships-only** — no `attributes` block (same pattern as v0.9 AppInfo PATCH).

**Asset upload reuse**: encryption declaration documents reuse `src/domains/asset-upload.ts` verbatim — same three-step `reserve` → `chunk-PUT` → `commit` protocol as v0.13 / v0.14.

**Schemas (13 new):** `AppAvailabilityIdSchema`, `PhasedReleaseIdSchema`, `AppEncryptionDeclarationIdSchema`, `AppEncryptionDeclarationDocumentIdSchema`, `PhasedReleaseStateSchema` (4-value enum), `EncryptionDeclarationStateSchema` (6-value enum), `AvailableInNewTerritoriesSchema`, `TerritoryAvailabilityIdSchema`, `AppEncryptionDeclarationDescriptionSchema`, `ContainsProprietaryCryptographySchema`, `ContainsThirdPartyCryptographySchema`, `AvailableOnFrenchStoreSchema`, `ExemptSchema`.

**Digests (2 new):** `digestTerritoryAvailabilities` (TERR / AVAILABLE / RELEASE_DATE / PRE_ORDER / PRE_ORDER_DATE — with the "id IS the ISO 3-letter code" legend), `digestAppEncryptionDeclarations` (STATE / CODE / EXEMPT / PROPRIETARY / THIRD_PARTY / FRANCE / CREATED / DECL_ID — with the state-enum legend).

**Tests (+19):** `tests/app-availability-body.test.ts` (availability `availableInNewTerritories` wire-key regression guard, full-list pass-through, EndAppAvailabilityPreOrder relationships-only shape), `tests/phased-release-body.test.ts` (no-attrs-block omission when state is omitted, state-only patch shape), `tests/encryption-declarations-body.test.ts` (`availableOnFrenchStore` wire-key strip, deprecated `usesEncryption` exclusion on create, bare-data linkage shape with null-unlink, `uploaded` wire-key strip on document commit).

**Roadmap shuffle:** v0.15 row in `README.md` flipped to ✓ with the actually-shipped surface (~19 tools). v0.16 (TestFlight follow-ons: Beta Feedback Submissions + Build Beta Notifications + Beta Recruitment Criteria) next.

**Out of scope for v0.15.0 (deferred):**
- `TerritoryAvailabilityInlineCreate` via `included[]` on AppAvailabilityV2CreateRequest (per-territory release-date scheduling — soft-launch dates). Currently v0.15 uses existing territory IDs only; scheduling lands in a future cut.
- `AppEncryptionDeclarationBuildsLinkagesRequest` (the inverse declaration → builds[] linkage) — marked deprecated in the Swift SDK, replaced by the per-build linkage which IS wrapped here.
- AppEncryptionDeclaration deprecated read attrs (`usesEncryption`, `uploadedDate`, `documentURL`, `documentName`, `documentType`) are surfaced via `raw:true` for legacy declarations but excluded from writes.

**Coming next (v0.16):** TestFlight follow-ons — Beta Feedback Submissions (tester screenshots + crashes), Build Beta Notifications, and Beta Recruitment Criteria (auto-recruit via public link).

**Live-smoke spec corrections (caught on 2026-06-08, fixed in this release):**

- **`asc_list_territory_availabilities` was hitting the wrong URL** (`/v1/apps/{appId}/appAvailabilityV2/territoryAvailabilities` — Apple returns PATH_ERROR). The actual endpoint surfaced in the `asc_get_app_availability_v2` response's `related` link lives at `/v2/appAvailabilities/{id}/territoryAvailabilities`. Two things going on: it's `/v2` (not `/v1`) and the base path is the standalone AppAvailabilities resource (not the per-app accessor). Discovery: Apple shares the numeric identifier between AppAvailability and App — `appAvailability.id == appId` on the wire (added to `AppAvailabilityIdSchema` describe). Tool description updated to mention this.
- **`asc_get_app_store_version_phased_release` description claimed 404 on no-attachment** but Apple actually returns `{ data: null }`. Description corrected.

**Live-smoke spec corrections (caught on 2026-06-09, fixed in this release):**

- **TerritoryAvailability `.id` is NOT the 3-letter ISO code.** I claimed it was (mirroring v0.12 AppKeyword). The live endpoint returned IDs like `eyJzIjoiNjc1ODU0ODA0NiIsInQiOiJBVVQifQ` — base64 of `{"s":<appId>,"t":<3-letter-code>}`. It's an Apple-opaque per-(app, territory) composite. **Opposite** of v0.12 AppKeyword (where the id IS the human-readable string). Updated: `TerritoryAvailabilityIdSchema` describe, the `asc_list_territory_availabilities` description, the `asc_post_app_availability_v2` and `asc_end_app_availability_pre_order` descriptions to make clear callers must pass the opaque IDs through verbatim from the LIST endpoint (NOT bare ISO codes). The digest now decodes the `t` field for the human-readable TERR column and surfaces the full opaque ID in a separate TERR_ID column.
