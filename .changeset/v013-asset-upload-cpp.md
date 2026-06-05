---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.13.0 — Asset upload + Custom Product Pages. Screenshots + App Previews (the three-step reserve/PUT/commit Apple upload protocol, exposed as both composite shortcuts and raw escape hatches) + the full Custom Product Pages surface (page + version + localization CRUD).

**~25 new tools across 4 sub-domains.**

**Screenshots (8 tools)** — `src/domains/screenshots.ts`. Full CRUD on `AppScreenshotSet` + `AppScreenshot`, plus a composite upload shortcut.

- `asc_list_app_screenshot_sets` / `asc_get_app_screenshot_set` / `asc_post_app_screenshot_set` / `asc_delete_app_screenshot_set` — set CRUD per (parent localization, `screenshotDisplayType`). Parent is one of `appStoreVersionLocalizations` / `appCustomProductPageLocalizations` / `appStoreVersionExperimentTreatmentLocalizations` — Apple requires exactly one even though the Swift contract marks the relationships block optional.
- `asc_list_app_screenshots` / `asc_get_app_screenshot` / `asc_delete_app_screenshot` — read/delete individual screenshot records.
- `asc_post_app_screenshot` — RAW step 1: reserves a screenshot with `fileSize` + `fileName`, returns `uploadOperations[]` (one per chunk).
- `asc_patch_app_screenshot` — RAW step 3: commits with `sourceFileChecksum` + `uploaded: true`. Empty PATCHes refused.
- `asc_upload_screenshot` — **composite shortcut**: takes a local file path, reserves, PUTs every chunk, commits — one tool call. Tilde paths expanded.

**App Previews (8 tools)** — `src/domains/previews.ts`. Same shape as screenshots, plus poster-frame handling.

- Set CRUD per (parent localization, `previewType`) — same three-way parent. Note: `previewType` uses **no `APP_` prefix** (`IPHONE_67`, not `APP_IPHONE_67`) — distinct enum from `ScreenshotDisplayType`.
- `asc_post_app_preview` / `asc_patch_app_preview` / `asc_delete_app_preview` — raw three-step variants; reserve takes optional `previewFrameTimeCode` + `mimeType`. PATCH lets you change `previewFrameTimeCode` (poster frame) without re-uploading the video.
- `asc_upload_app_preview` — composite shortcut for the full reserve/PUT/commit flow.

**Asset upload helper (1 tool)** — `src/domains/asset-upload.ts`. Shared chunk-PUT primitive used by the composites and exposed as an escape hatch.

- `asc_upload_asset_chunk` — RAW step 2: executes ONE `UploadOperation` (PUT a slice of a local file to Apple's pre-signed storage URL with the operation's `requestHeaders`). Apple's storage URLs are pre-signed — no ASC bearer auth applied. Useful when driving the three-step flow manually (e.g. parallel uploads across many sets).
- Internal helpers: `executeUploadOperation`, `executeAllUploadOperations`, `computeFileMd5Hex`, `readFileSizeBytes`, `expandHomePath`. Used by `asc_upload_screenshot` + `asc_upload_app_preview` composites.

**Custom Product Pages (~10 tools)** — `src/domains/custom-product-pages.ts`. Full CRUD on `AppCustomProductPage` + `AppCustomProductPageVersion` + `AppCustomProductPageLocalization`.

- `asc_list/get/post/patch/delete_app_custom_product_page` — page CRUD per app. Apple creates the initial version automatically.
- `asc_list/get/post/delete_app_custom_product_page_version` — version CRUD with optional `deepLink`. State machine: PREPARE_FOR_SUBMISSION / READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW / ACCEPTED / APPROVED / REPLACED_WITH_NEW_VERSION / REJECTED.
- `asc_list/get/post/patch/delete_app_custom_product_page_localization` — localization CRUD per (version, locale). Only writable attr is `promotionalText` (170 chars) — overrides the parent AppStoreVersionLocalization's promotional text for customers landing via the CPP URL. State gate refuses WAITING_FOR_REVIEW / IN_REVIEW.

**Apple-contract gotchas pinned by tests:**

1. **Boolean strip pattern** (`isFoo` → wire `foo`) — same family as v0.9's `isHotrunning` and v0.12's `isVisibleInAppStore`:
   - `AppScreenshotUpdateRequest.isUploaded` → wire `uploaded`
   - `AppPreviewUpdateRequest.isUploaded` → wire `uploaded`
   - `AppCustomProductPageUpdateRequest.isVisible` → wire `visible`
2. **URL camelCase strip** — `AppPreview.videoURL` → wire `videoUrl` (read-only response field; never written).
3. **No-attrs-block omission** on `AppCustomProductPageVersionCreateRequest` — `attributes` is OPTIONAL in the Swift contract; when no `deepLink` is provided the body builder **omits the entire `attributes` key** (Apple rejects bare `attrs:{}` on this endpoint, same pattern as v0.9 AppInfo PATCH).
4. **State gate** on `AppCustomProductPageVersion` — same lifecycle as AppInfo. `evaluateCustomProductPageVersionGate` refuses `WAITING_FOR_REVIEW` / `IN_REVIEW`; other states pass through.
5. **Three-way parent** on screenshot + preview sets — Apple's Swift marks all three relationship slots optional, but a POST that picks none is rejected. Tool description spells out the one-of constraint.
6. **PreviewType vs ScreenshotDisplayType** — same device classes, different enums. `IPHONE_67` (preview) vs `APP_IPHONE_67` (screenshot). Values NOT interchangeable.

**Upload-flow UX shape (composite + raw escape hatches):**

- Composite: `asc_upload_screenshot` / `asc_upload_app_preview` — one tool call per asset, takes a local file path, returns the committed resource. Best LLM ergonomics, hides the three-step protocol.
- Raw: `asc_post_app_screenshot` / `asc_post_app_preview` (reserve) → `asc_upload_asset_chunk` (one chunk PUT) → `asc_patch_app_screenshot` / `asc_patch_app_preview` (commit). For callers that want manual control (e.g. parallel uploads, custom retry semantics).

**Schemas (16 new):** `AppScreenshotSetIdSchema`, `AppScreenshotIdSchema`, `AppPreviewSetIdSchema`, `AppPreviewIdSchema`, `AppCustomProductPageIdSchema`, `AppCustomProductPageVersionIdSchema`, `AppCustomProductPageLocalizationIdSchema`, `ScreenshotDisplayTypeSchema` (33 values incl. IMESSAGE variants), `PreviewTypeSchema` (16 values, no IMESSAGE), `ScreenshotSetParentTypeSchema` (3-way parent enum), `FileNameSchema`, `FileSizeSchema`, `SourceFileChecksumSchema`, `LocalFilePathSchema`, `PreviewFrameTimeCodeSchema`, `PreviewMimeTypeSchema`, `CustomProductPageNameSchema`, `CustomProductPageVisibleSchema`, `CustomProductPageDeepLinkSchema`, `CustomProductPagePromotionalTextSchema` (170 chars).

**Digests (7 new):** `digestAppScreenshotSets`, `digestAppScreenshots` (FILE_NAME + SIZE + STATE + CHECKSUM committed/pending + SCREENSHOT_ID), `digestAppPreviewSets`, `digestAppPreviews` (+ FRAME + dual ASSET/VIDEO state), `digestAppCustomProductPages` (NAME + VISIBLE + URL), `digestAppCustomProductPageVersions` (VERSION + STATE + DEEP_LINK), `digestAppCustomProductPageLocalizations` (LOCALE + PROMO_LEN + preview).

**Tests (+34):** `tests/screenshots-body.test.ts` (set parent routing, fileSize-is-number assertion, `uploaded` wire-key regression guards on commit), `tests/previews-body.test.ts` (PreviewType no-APP-prefix assertion, optional `previewFrameTimeCode` + `mimeType` round-trip, poster-frame patch isolation), `tests/custom-product-pages-body.test.ts` (page `visible` strip, no-attrs-block omission on version create, locale-immutable on localization patch, full state-gate truth table).

**Roadmap shuffle:** v0.13 row in `README.md` flipped to ✓ with the actually-shipped surface (~25 tools). v0.14 (In-App Events + Promoted Purchases) next.

**Out of scope for v0.13.0 (deferred):**
- `AppCustomProductPageCreateRequest.included[]` inline nested creates — page + version + localization land via separate POSTs.
- `appStoreVersionTemplate` / `customProductPageTemplate` relationships on CPP create (clone-from semantics).
- Screenshot / preview asset reordering (Apple's app-screenshot-set ordering surface).
- `AppStoreVersionExperimentTreatment` writes (the third parent option for sets — readable through `parentType` filter but treatment CRUD itself is deferred).

**Coming next (v0.14):** In-App Events (live promotional events visible on the App Store product page) + Promoted Purchases (in-store IAP promotion surface).

**Live-smoke spec corrections (caught on 2026-06-05, fixed in this release):**

- **`digestAppScreenshots` / `digestAppPreviews` STATE columns**: Apple's `AppMediaAssetState` and `AppMediaVideoState` are **structs**, not enum strings — the wire shape is `{ errors: [], warnings: null, state: "COMPLETE" }`. The digests previously stringified the entire wrapper object into the STATE / ASSET_STATE / VIDEO_STATE cell, producing `{"errors":[],"warnings":null,"state":"COMPLETE"}` instead of `COMPLETE`. Added `deliveryStateLabel()` helper that pulls `.state` out of the wrapper for display; `raw:true` output is unchanged (errors + warnings still surface for callers that need them). Verified live on a shipped app's APP_IPHONE_67 set (7 screenshots, all `COMPLETE`).
