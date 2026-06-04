---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.12.0 — App Info + structured-ASO catalog. The per-app metadata layer (subtitle, name, categories, privacy URLs) + Apple's structured-ASO surfaces (category catalog, AppTags, SearchKeywords).

**12 new tools across 5 sub-domains.**

**AppInfo (3 tools)** — `src/domains/app-info.ts`. The per-app metadata layer above the version, carrying primary/secondary category relationships + age ratings. Apple manages create/delete automatically; only PATCH is exposed and it's **relationships-only** (no mutable attributes on AppInfoUpdateRequest).

- `asc_list_app_infos` — per-app list (typically one record; macOS notarization can introduce a second on the NOTARIZATION track)
- `asc_get_app_info` — fetch with all 6 category relationships + localizations expanded
- `asc_patch_app_info` — set/clear/swap any of the 6 category slots (`primaryCategory`, `primarySubcategoryOne`, `primarySubcategoryTwo`, `secondaryCategory`, `secondarySubcategoryOne`, `secondarySubcategoryTwo`). Each slot accepts a category ID (set), `null` (clear), or absence (leave alone). State-gated: refuses `WAITING_FOR_REVIEW` / `IN_REVIEW` client-side.

**AppInfoLocalization (5 tools)** — full CRUD for per-app, per-locale name + subtitle + privacy URLs/text. Distinct from AppStoreVersionLocalization — this is the persistent app-level copy that survives across versions.

- `asc_list/get/post/patch/delete_app_info_localization`. Required at create: `appInfoId` + `locale` + `name` (30 chars). Optional: `subtitle` (30 chars), `privacyPolicyUrl`, `privacyChoicesUrl` (CCPA/CPRA), `privacyPolicyText` (inline text for territories that require it).
- **Wire-key gotcha** (same pattern as v0.10's marketingUrl/supportUrl, v0.9's BetaAppLocalization URLs): Swift `privacyPolicyURL` → wire `privacyPolicyUrl`, Swift `privacyChoicesURL` → wire `privacyChoicesUrl`. CamelCase, NOT all-caps. Tests assert the all-caps form is absent.

**AppCategory (1 tool)** — `src/domains/aso-catalog.ts`. Apple's read-only category catalog.

- `asc_list_app_categories` — fetches the catalog with `subcategories` included via the parent → subcategories relationship. Optional `filter[platforms]` to narrow. Use to resolve human-readable category names → category IDs before `asc_patch_app_info`.

**AppTag (2 tools)** — Apple's structured-ASO tag surface.

- `asc_list_app_tags` — per-app tag membership with name + `visibleInAppStore` flag
- `asc_patch_app_tag` — toggle `visibleInAppStore` (the ONLY mutable attribute on AppTag). Wire-key gotcha: Swift `isVisibleInAppStore` → wire `visibleInAppStore` (is-prefix stripped). Tag membership management (adding/removing tags from an app via the `App.appTags` linkage) is **deferred to v0.12.1** — needs the linkage POST/DELETE surface.

**SearchKeywords (1 tool)** — Apple's aggregated keyword surface.

- `asc_list_search_keywords` — read-only at `/v1/apps/{id}/searchKeywords`, with optional `filter[platform]` + `filter[locale]`. Surfaces AppKeyword records — every keyword Apple has indexed across the app's localizations. **Keyword writes still live on AppStoreVersionLocalization.keywords** (v0.10's per-version comma-separated field). Use this read surface to inspect what Apple is actually indexing — useful for diagnosing ASO underperformance.

**State gating:** `evaluateAppInfoPatchGate` — conservative single-set refusal: `WAITING_FOR_REVIEW`, `IN_REVIEW`. Other states pass through (Apple's PATCH rules vary subtly with state and the field-by-state matrix is undocumented for AppInfo).

**Schemas (10 new):** `AppInfoIdSchema`, `AppInfoLocalizationIdSchema`, `AppCategoryIdSchema`, `AppTagIdSchema`, `AppKeywordIdSchema`, `AppInfoLocalizationNameSchema` (30 chars), `SubtitleSchema` (30 chars), `PrivacyPolicyTextSchema` (no client cap; Apple is authoritative), `PrivacyChoicesUrlSchema`, `VisibleInAppStoreSchema`.

**Digests (5 new):** `digestAppInfos` (state + appStoreState + age rating + kidsBand), `digestAppInfoLocalizations` (LOCALE + NAME + SUBTITLE + PRIV_URL host-only + PRIV_CHOICES host-only + PRIV_TEXT_LEN), `digestAppCategories` (CATEGORY_ID + PLATFORMS + SUBCATEGORIES), `digestAppTags` (NAME + VISIBLE Y/N/—), `digestSearchKeywords` (KEYWORD + KEYWORD_ID).

**Tests (+21):** `tests/app-info-body.test.ts` — relationships-only AppInfo PATCH (set/clear/leave-alone semantics, six-slot variations), AppInfoLocalization create/patch including camelCase URL wire-key assertions, full `evaluateAppInfoPatchGate` truth table. `tests/aso-catalog-body.test.ts` — AppTag PATCH wire-key correctness (stripped `visibleInAppStore`, single-field attributes block, boolean false handling).

**Roadmap shuffle:** v0.12 row in `README.md` flipped to ✓ with the actually-shipped surface (12 tools). v0.13 (Screenshots + App Previews + Custom Product Pages) next.

**Out of scope for v0.12.0 (deferred to v0.12.1):**
- AppTag membership management (add/remove tags from an app via `App.appTags` linkage POST/DELETE)
- AppTag territories management (similar linkage POST/DELETE on `AppTag.territories`)
- SearchKeyword writes (Apple's keyword catalog is curated; writes happen via `AppStoreVersionLocalization.keywords` which is already v0.10's surface)
- AppInfo age-rating PATCH (heavy — Apple requires the full age-rating questionnaire flow which is its own multi-step surface; not currently in any release plan)

**Coming next (v0.13):** Screenshots + App Previews (asset upload per locale × device-class) + Custom Product Pages (channel-specific copy variants).
