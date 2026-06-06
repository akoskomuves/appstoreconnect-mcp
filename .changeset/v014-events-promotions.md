---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.14.0 — In-App Events + Promoted Purchases. The two remaining "live promotional surface" domains: time-bound App Store events with their own copy + assets, and the storefront IAP / subscription promotion layer.

**~28 new tools across 4 sub-domains.**

**App Events (10 tools)** — `src/domains/app-events.ts`. The customer-facing event surface attached to the App Store product page (live broadcasts, premieres, challenges, competitions, new seasons, major updates, special events).

- AppEvent CRUD: `asc_list_app_events` (per app) / `asc_get_app_event` / `asc_post_app_event` / `asc_patch_app_event` / `asc_delete_app_event`. Required at create: `appId` + `referenceName` (internal-only). Optional: `badge` (7-value enum), `deepLink`, `purchaseRequirement` (NO_COST_ASSOCIATED / IN_APP_PURCHASE), `primaryLocale`, `priority` (HIGH / NORMAL), `purpose` (4-value enum), `territorySchedules[]`.
- AppEventLocalization CRUD: same shape. Required at create: `appEventId` + `locale`. Optional copy attrs: `name` (30 chars), `shortDescription` (50), `longDescription` (120) — these are the tightest caps in the project so far.
- **State machine** (`eventState`): DRAFT / READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW / REJECTED / ACCEPTED / APPROVED / PUBLISHED / PAST / ARCHIVED (10 values). `evaluateAppEventStateGate` refuses WAITING_FOR_REVIEW / IN_REVIEW client-side (same conservatism as v0.12 AppInfo, v0.13 CPP); everything else passes through to Apple.
- **TerritorySchedule[]**: array of `{ territories: ISO3[], publishStart, eventStart, eventEnd }` (all ISO 8601 timestamps with timezone). Apple Date-typed — same shape as v0.11's `earliestReleaseDate`. `archivedTerritorySchedules` exists as a read-only field on the resource but is absent from CreateRequest / UpdateRequest.

**App Event Screenshots (6 tools)** — `src/domains/app-event-screenshots.ts`. Image assets per event localization × asset slot.

- `asc_list / get / post / patch / delete / upload_app_event_screenshot`. Same three-step reserve / chunk-PUT / commit protocol as v0.13 AppScreenshot — the v0.13 `asset-upload.ts` helpers are reused verbatim.
- Required at create: `fileSize` + `fileName` + `appEventAssetType` (EVENT_CARD = small tile / EVENT_DETAILS_PAGE = full-bleed view). One asset per (localization, slot).
- Unlike v0.13 AppScreenshot: the commit step does NOT take `sourceFileChecksum` — Apple's AppEventScreenshotUpdateRequest only has `isUploaded`. The composite still computes the MD5 and surfaces it for diagnostics.

**App Event Video Clips (6 tools)** — `src/domains/app-event-video-clips.ts`. Video assets per event localization × asset slot.

- Same shape as event screenshots, plus `previewFrameTimeCode` (poster frame) on both create and PATCH. PATCH lets the poster frame change without re-uploading.

**Promoted Purchases (6 tools)** — `src/domains/promoted-purchases.ts`. The storefront IAP / subscription promotion layer.

- `asc_list / get / post / patch / delete_promoted_purchase`. Each PromotedPurchase links an app to ONE IAP (`inAppPurchaseV2Id`) OR ONE subscription (`subscriptionId`) — tool layer enforces the one-of constraint.
- Required at create: `appId` + `visibleForAllUsers`. Optional: `enabled`.
- **State machine** (4 values): PREPARE_FOR_SUBMISSION / IN_REVIEW / APPROVED / REJECTED. Server-managed; not directly mutable.
- `asc_patch_promoted_purchases_order` — the per-app **ordering** linkage. PATCH `/v1/apps/{id}/relationships/promotedPurchases` with the full ordered ID list. Apple uses the **array order** as the storefront display order (position 0 = slot 1, etc.) — partial / delta updates are not supported.

**Apple-contract gotchas pinned by tests:**

1. **Boolean strip pattern** (same family as v0.9 / v0.12 / v0.13):
   - `AppEventScreenshotUpdateRequest.isUploaded` → wire `uploaded`
   - `AppEventVideoClipUpdateRequest.isUploaded` → wire `uploaded`
   - `PromotedPurchaseCreateRequest.isVisibleForAllUsers` → wire `visibleForAllUsers`
   - `PromotedPurchaseCreateRequest.isEnabled` → wire `enabled`
2. **URL camelCase strip** — `AppEventVideoClip.videoURL` → wire `videoUrl` (read-only response field, same shape as v0.13 AppPreview).
3. **PromotedPurchase relationship type IS `inAppPurchases`** even though the field is named `inAppPurchaseV2` — Apple keeps the relationship key versioned while the resource type stays unversioned. Tests assert this verbatim.
4. **AppPromotedPurchasesLinkagesRequest bare-array shape** — no `type` / `attributes` / `relationships` envelope; just `{ data: [{ type, id }, ...] }`. The array IS the ordering. Tests assert preserved input order.
5. **No state gate on PromotedPurchase** — Apple's IN_REVIEW state may reject writes, but the project pattern is to surface Apple's verbatim error rather than pre-gate (4 states is short and Apple's rejection messages are clear).

**Asset upload reuse**: `app-event-screenshots.ts` and `app-event-video-clips.ts` reuse `src/domains/asset-upload.ts` verbatim — `executeAllUploadOperations`, `computeFileMd5Hex`, `expandHomePath`, `summarizeUpload`. The composite shortcut + raw three-step pattern from v0.13 carries through. The `asc_upload_asset_chunk` raw escape hatch handles event assets too (it is generic over Apple's UploadOperation shape).

**Schemas (~20 new):** `AppEventIdSchema`, `AppEventLocalizationIdSchema`, `AppEventScreenshotIdSchema`, `AppEventVideoClipIdSchema`, `PromotedPurchaseIdSchema`, `AppEventBadgeSchema`, `AppEventPurchaseRequirementSchema`, `AppEventPrioritySchema`, `AppEventPurposeSchema`, `AppEventAssetTypeSchema`, `AppEventReferenceNameSchema`, `AppEventDeepLinkSchema`, `AppEventPrimaryLocaleSchema`, `AppEventTerritorySchedulesSchema` (array-of-struct with regex-validated ISO 8601 timestamps), `AppEventNameSchema` (30), `AppEventShortDescriptionSchema` (50), `AppEventLongDescriptionSchema` (120), `PromotedPurchaseVisibleForAllUsersSchema`, `PromotedPurchaseEnabledSchema`.

**Digests (5 new):** `digestAppEvents` (REFERENCE_NAME + STATE + BADGE + PRIORITY + PURPOSE + TERR_COUNT + EVENT_ID), `digestAppEventLocalizations` (LOCALE + NAME + SHORT_LEN + LONG_LEN + LOC_ID with the 30 / 50 / 120 caps legend), `digestAppEventScreenshots` (FILE_NAME + SIZE + SLOT + STATE), `digestAppEventVideoClips` (+ FRAME + dual ASSET / VIDEO state), `digestPromotedPurchases` (PRODUCT_ID + KIND + VISIBLE_ALL + ENABLED + STATE).

**Tests (+33):** `tests/app-events-body.test.ts` (territorySchedule passthrough, locale-immutable on localization patch, full state-gate truth table), `tests/app-event-assets-body.test.ts` (appEventAssetType-required + `uploaded` wire-key regression guards across both screenshot + clip + poster-frame-only PATCH), `tests/promoted-purchases-body.test.ts` (`visibleForAllUsers` / `enabled` wire-key regression guards, `inAppPurchases`-typed relationship even though field is named `inAppPurchaseV2`, bare-array shape on linkages PATCH).

**Roadmap shuffle:** v0.14 row in `README.md` flipped to ✓ with the actually-shipped surface (~28 tools). v0.15 (App Availability v2 + Phased Release + App Encryption Declarations) next.

**Out of scope for v0.14.0 (deferred):**
- Customer reviews (read · respond · filter by sentiment/version) — still parked at v0.19.
- AppEvent `archivedTerritorySchedules` writes (Apple read-only).
- `AppStoreVersionPromotion` (different from PromotedPurchase — version-level promotion surface; niche).
- AppEventCreateRequest with included[] nested inline localization / screenshot create — event + localization + assets land via separate POSTs (same as v0.13 CPP).

**Coming next (v0.15):** App Availability v2 (territory enable/disable, soft-launch flows) + Phased Release (staged rollout 1%→100%) + App Encryption Declarations (export compliance per build).
