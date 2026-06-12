# appstoreconnect-mcp

## 0.21.0

### Minor Changes

- 379eb20: v0.22 — Per-territory pre-orders + real-FX PPP. Two of the three remaining v1.0+ items.

  **Pre-orders (1 new tool)** — `asc_patch_territory_availability`: PATCH `/v1/territoryAvailabilities/{id}` with available / releaseDate / preOrderEnabled, completing the v0.15 availability surface (list → patch → end-pre-order). The ID is the Apple-opaque base64 composite from `asc_list_territory_availabilities` (the v0.15 discovery) — bare ISO codes rejected. ⚠️ `available=false` pulls the app from sale in that territory; the description requires confirmed intent.

  **Real-FX (PPP engine upgrade, no new tool)** — `fxRates` on `ppp_compute_proposal` AND `ppp_apply_proposal` (and threaded through every offer-apply path):

  - Semantics: USD value of ONE unit of each currency (e.g. `{"BHD": 2.65, "KWD": 3.25}`); USD implied 1.
  - Rescues the currency-mismatch territories the engine previously skipped (USD-billed Gulf storefronts where Apple Music prices in BHD/KWD/OMR) with a dimension-correct conversion: `factor = (indexLocal × usd(idx)) / (anchorLocal × usd(anchor))`, target converted into the billing currency. Implemented as the pure, unit-tested `fxAdjustedTarget` in the PPP engine.
  - fx-adjusted rows are flagged (`*` on FACTOR + summary count); `reason` stays exactly `change`/`unchanged` so apply filters are unaffected.
  - The skip message now says how to rescue ("pass fxRates") or what's missing ("fxRates missing a needed currency").
  - **Security stance:** rates are USER-SUPPLIED only. This server's egress remains Apple-API-only — no third-party FX feed is ever fetched.

  **Tests:** FX math (mismatch rescue, all-same-currency reduction, non-USD billing conversion, missing/invalid-rate refusals) + territory-availability patch body.

  **Live smoke (2026-06-12, WikiCatch):** territory-availability read verified (175 territories, opaque composite IDs feeding the new PATCH tool); real-FX rescue verified against the real bundled index (BHR: 1.49 BHD × 2.65 USD/BHD vs the USD anchor → factor 0.359, dimension-correct target). The PATCH write itself was NOT drilled — it is store-affecting on a shipped app; its body shape is pinned by unit tests.

## 0.20.0

### Minor Changes

- 251cc79: v0.21 — Runtime health + accessibility: diagnostic signatures, perf/power metrics, accessibility declarations. Two of the three remaining v1.0+ "niche read surfaces" turn out richer than planned — accessibility declarations are full CRUD with a customer-facing publish gate.

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

  **Live smoke (2026-06-12, WikiCatch):** CLEAN — zero corrections (second clean round in a row). Both non-JSON:API content types verified live (real xcode-metrics documents returned through the Accept overrides; empty `productData` is the small-app expected shape), diagnostic-signatures empty-list read clean, and the accessibility drill (DRAFT create with two flags → third-flag patch → delete, publish never sent) confirmed all ten strip-family wire keys against the live API with the flag-matrix digest rendering correctly.

  **Schemas (5 new):** `DiagnosticSignatureIdSchema`, `DiagnosticTypeSchema`, `PerfMetricTypeSchema`, `AccessibilityDeclarationIdSchema`, `AccessibilityDeclarationStateSchema`.

  **Digests (2 new):** `digestDiagnosticSignatures` (heaviest-first), `digestAccessibilityDeclarations` (flag matrix).

## 0.19.0

### Minor Changes

- 396ca2d: v0.20 — App Store Version Experiments V2 (product-page A/B tests). The highest-leverage ASO item from the v1.0+ bucket, pulled forward: test alternate screenshots, previews, and app icons against the live product page with a controlled traffic split.

  **12 new tools in 1 sub-domain** — `src/domains/version-experiments.ts`. V2 surface only (app-attached, rolls across versions); the deprecated version-attached v1 experiments are not exposed.

  **Experiment lifecycle (5 tools)**

  - `asc_list_version_experiments` — GET `/v1/apps/{id}/appStoreVersionExperimentsV2` (the URL-version QUIRK: a /v1 path listing V2 resources; CRUD lives at `/v2/appStoreVersionExperiments`). Digest shows the 9-state lifecycle, traffic %, review-required flag, start/end dates.
  - `asc_get_version_experiment` — with treatments + latestControlVersion included.
  - `asc_post_version_experiment` — ALL THREE attrs required (name, platform, trafficProportion 1–99). Created in PREPARE_FOR_SUBMISSION; publicly invisible until submitted AND started.
  - `asc_patch_version_experiment` — name / trafficProportion / **started=true** (⚠️ customer-facing: begins serving treatments to real traffic; requires APPROVED; the description instructs explicit human approval first). Wire-key gotcha pinned: Swift `isStarted` → wire `started`.
  - `asc_delete_version_experiment`.

  **Treatments + localizations (7 tools)**

  - Treatment CRUD-minus-get (`asc_list/post/patch/delete_experiment_treatment[s]`) — name + optional `appIconName` (alternate-icon testing; the icon must ship in the binary). Create emits the `appStoreVersionExperimentV2` relationship, never the deprecated v1 sibling (pinned by test).
  - Treatment localization list/create/delete — per-locale containers for variant assets. **Variant screenshots/previews reuse the existing v0.13 asset tools** (`asc_post_app_screenshot_set` etc. already accept parentType `appStoreVersionExperimentTreatmentLocalizations`) — no new upload machinery.
  - Submission rides the existing v0.11 V2 review-submission flow.

  **Apple-contract gotchas pinned by tests:** the `isStarted`→`started` strip, all-required experiment create attrs, V2-only treatment relationship, /v1-list-vs-/v2-CRUD path split.

  **Live smoke (2026-06-12, WikiCatch):** CLEAN — full create → get → patch → treatment → localization → lists → delete drill verified every tool path with zero spec corrections (first fully-clean round since v0.14). `started=true` and review submission deliberately NOT exercised (customer-facing). The read list also rendered a real historical experiment correctly (a STOPPED screenshots test from April), confirming digest output against genuine data.

  **Schemas (5 new):** `VersionExperimentIdSchema`, `ExperimentTreatmentIdSchema`, `TreatmentLocalizationIdSchema`, `TrafficProportionSchema`, `ExperimentStateSchema` (9-value enum).

  **Digests (3 new):** `digestVersionExperiments`, `digestExperimentTreatments` (PROMOTED column = winner pushed live), `digestTreatmentLocalizations`.

## 0.18.1

### Patch Changes

- 3683434: Fix: `asc_list_app_infos` (and `asc_get_app_info`'s digest) 400ed on every call — Apple REMOVED the `kidsAgeBand` attribute from the AppInfo contract after v0.12 shipped, and the hard-coded sparse fieldset still requested it ("'kidsAgeBand' is not a valid field name"). The field is dropped from the fieldset, digest column, and schema/tool descriptions. Live-verified: the old fieldset reproduces the 400, the fixed one returns data. Reported from real usage during a release workflow on 2026-06-12.

## 0.18.0

### Minor Changes

- b959be2: v0.19 — Customer reviews + review summarizations. The last planned roadmap row before v1.0+: read what customers say, reply publicly (with guardrails), and pull Apple's AI-aggregated review summary.

  **6 new tools in 1 sub-domain** — `src/domains/customer-reviews.ts`.

  - `asc_list_customer_reviews` — app-wide (`/v1/apps/{id}/customerReviews`) or version-scoped (`/v1/appStoreVersions/{id}/customerReviews`); pass exactly one of appId / appStoreVersionId. Filters: rating (STRINGS "1".."5" per the wire contract), territory, and `hasPublishedResponse` (wire `exists[publishedResponse]`) — `false` is the unanswered queue. Sorts: ±createdDate, ±rating. Digest shows star bars, title/body previews, and the developer-response state via `include=response`.
  - `asc_get_customer_review` — full review body + response included.
  - `asc_get_customer_review_response` — the review's single developer reply (state PUBLISHED / PENDING_PUBLISH).
  - `asc_post_customer_review_response` — ⚠️ **PUBLIC-FACING WRITE**: publishes the reply on the App Store under the review; one response per review (re-posting REPLACES). The tool description instructs models to draft → show the human → post only on explicit approval. responseBody capped at 5,970 chars per Apple's UI limit.
  - `asc_delete_customer_review_response` — removes the public reply; the review itself is untouched.
  - `asc_list_customer_review_summarizations` — Apple's AI-aggregated summary per (platform, territory, locale), the same text shown on the product page. `filter[platform]` REQUIRED by Apple; empty lists are common (feature rollout + review-volume gated).

  **Apple-contract gotchas pinned by tests:**

  1. **Exists-param strip variant**: Swift `isExistsPublishedResponse` → wire `exists[publishedResponse]` — a new member of the is-prefix strip family, on a query param rather than an attribute.
  2. **`filter[rating]` values are strings**, not numbers.
  3. **CustomerReviewResponseV1CreateRequest**: responseBody attribute REQUIRED + review relationship.
  4. **`include=response`** baked into the list (v0.16 lesson — relationship objects don't materialize without include).
  5. No sentiment filter exists on Apple's side — rating is the documented proxy.

  **Live-smoke spec corrections caught on 2026-06-12** (real WikiCatch reviews via `scripts/smoke-reviews.ts`, strictly read-only — the respond tool is public-facing and was NOT drilled):

  1. **A review with no developer response returns 200 + `data: null`** on `/v1/customerReviews/{id}/response` — not a 404. The tool detects it and reports "no response yet" instead of dumping `{"data": null}`.
  2. Verified live: app-wide list (2 real reviews with star bars + previews), the `exists[publishedResponse]=false` unanswered queue, rating filters, single-review get with include, version-scoped list, and a clean empty-list summarizations read (Apple hasn't generated one for this app). Respond/delete paths covered by body-builder tests only — intentionally not exercised against the live store.

  **Schemas (5 new):** `CustomerReviewIdSchema`, `CustomerReviewResponseIdSchema`, `ReviewRatingFilterSchema`, `ReviewSortSchema`, `SummarizationPlatformSchema`.

  **Digests (2 new):** `digestCustomerReviews` (star bars + response state), `digestCustomerReviewSummarizations` (full summary text blocks).

### Patch Changes

- ebf09b0: Document the `ASC_VENDOR_NUMBER` env var (introduced in v0.18 as the vendor-number fallback for `asc_get_sales_report` / `asc_get_finance_report`): README gets an "Optional: vendor number" config section (where to find it in App Store Connect, role requirements for the report endpoints), and `appstoreconnect-mcp --help` lists it alongside the other optional env vars.

## 0.17.0

### Minor Changes

- 4669857: v0.18 — Sales/finance reports + Analytics Reports. The "look at what happened" slice: revenue TSVs straight from Apple and the four-level Analytics Reports chain, closing the roadmap's reporting gap ("Why did MRR drop in Brazil last week?").

  **9 new tools across 2 sub-domains + a client extension.**

  **Client** — `requestBinary()` joins `request()`/`requestText()`: same auth + 401-refresh + 429-backoff envelope, Accept `application/a-gzip`, returns a Buffer. Sales/finance endpoints are NOT JSON:API — they serve gzipped TSV selected purely by filter params.

  **Sales + finance reports (2 tools)** — `src/domains/sales-reports.ts`.

  - `asc_get_sales_report` — GET `/v1/salesReports`. Four required filters: vendorNumber + reportType (10 values: SALES, SUBSCRIPTION, SUBSCRIPTION_EVENT, SUBSCRIBER, SUBSCRIPTION_OFFER_CODE_REDEMPTION, INSTALLS, FIRST_ANNUAL, PRE_ORDER, NEWSSTAND, WIN_BACK_ELIGIBILITY) + reportSubType (5) + frequency (DAILY/WEEKLY/MONTHLY/YEARLY); optional reportDate (granularity follows frequency) + version. Apple 404s with "there were no sales" on dates with no data — absence, not a malformed request.
  - `asc_get_finance_report` — GET `/v1/financeReports`. ALL four params required: vendorNumber + regionCode ("ZZ" = consolidated; FINANCE_DETAIL only with "Z1") + reportDate (Apple FISCAL months, YYYY-MM) + reportType.
  - Both: gunzip → TSV preview digest (row/column counts + first maxRows rows), `raw` for the full text, `saveTo` to write the decoded file to disk. Vendor number is account-level — param with `ASC_VENDOR_NUMBER` env fallback.

  **Analytics Reports (7 tools)** — `src/domains/analytics-reports.ts`. The four-level chain: request → reports → instances → segments.

  - `asc_post_analytics_report_request` / `asc_list_analytics_report_requests` / `asc_delete_analytics_report_request` — accessType ONGOING (continuous generation; auto-pauses on inactivity → `stoppedDueToInactivity=true`, delete + recreate to resume) or ONE_TIME_SNAPSHOT (historical backfill). One per (app, accessType). Instances appear up to ~48h after creation.
  - `asc_list_analytics_reports` — the catalog under a request, filterable by category (APP_USAGE / APP_STORE_ENGAGEMENT / COMMERCE / FRAMEWORK_USAGE / PERFORMANCE) or exact name.
  - `asc_list_analytics_report_instances` — dated materializations, filter granularity + processingDate.
  - `asc_list_analytics_report_segments` — checksum + sizeInBytes + PRE-SIGNED TIME-LIMITED url per chunk. The digest prints URLs verbatim below the table (never truncated — the download tool needs them exact).
  - `asc_download_analytics_report_segment` — plain fetch of the pre-signed URL **without the ASC bearer** (the signature lives in the URL; sending the token to a non-Apple-API host would leak it), gunzip, CSV preview / `raw` / `saveTo`.

  **Apple-contract gotchas pinned by tests:**

  1. **is-prefix strip**: `isStoppedDueToInactivity` → wire `stoppedDueToInactivity` (AnalyticsReportRequest, read-only; pinned via the fields constant).
  2. **Non-JSON:API endpoints**: salesReports/financeReports take required filter SETS (no id, no pagination) and return `application/a-gzip` bodies — query builders pin the exact required-filter combinations.
  3. **Gzip magic-byte detection** (1f 8b): JSON error bodies arrive un-gzipped on the same endpoints and must pass through undamaged.
  4. **Nested limit param** `limit[reports]` exists on the request list (noted, unused — reports are listed per-request instead).
  5. **Pre-signed segment URLs**: fetched with NO Authorization header.

  **Live-smoke spec corrections caught on 2026-06-12** (real WikiCatch/notehunter sales data + analytics chain drill via `scripts/smoke-reports.ts`):

  1. **Subscription-family reportTypes REQUIRE `filter[version]`** — Apple's 400 names the latest ("The latest version for this report is 1_4"). The tool self-heals: parses the version from the error and retries once, noting it in the output.
  2. **Subscription-family reportTypes have NO "latest report" default** — omitting reportDate 404s ("There were no sales for the date specified") even when data exists, unlike SALES which defaults to the latest. The tool defaults their DAILY reportDate to yesterday.
  3. **`AnalyticsReport.id` is a composite** (`r3-<requestUUID>` — slot prefix + parent request id), not an opaque UUID. Pass verbatim, never parse (pinned in the schema description).
  4. Verified live: SALES daily TSV with real proceeds/intro-offer rows, SUBSCRIPTION 1_4 (38 rows) + SUBSCRIPTION_EVENT 1_4 (4 events), analytics request create + immediate COMMERCE catalog population (10 reports). Instances/segments not yet exercisable (<48h after request creation); the ONGOING request on the smoke app is intentionally kept so they accrue.

  **Schemas (12 new):** `VendorNumberSchema`, `SalesReportTypeSchema`, `SalesReportSubTypeSchema`, `ReportFrequencySchema`, `FinanceRegionCodeSchema`, `AnalyticsReportRequestIdSchema`, `AnalyticsReportIdSchema`, `AnalyticsReportInstanceIdSchema`, `AnalyticsReportSegmentIdSchema`, `AnalyticsAccessTypeSchema`, `AnalyticsReportCategorySchema`, `AnalyticsGranularitySchema`.

  **Digests (4 new + 2 inline previews):** `digestAnalyticsReportRequests`, `digestAnalyticsReports`, `digestAnalyticsReportInstances`, `digestAnalyticsReportSegments` (verbatim URLs), plus TSV/CSV preview renderers.

## 0.16.0

### Minor Changes

- d3f355e: v0.17 — Webhooks. Per-app event push from App Store Connect: register an HTTPS endpoint for a set of event types, audit per-attempt delivery history, retry failures, and verify the pipe with test pings. Closes the loop with v0.16: `BETA_FEEDBACK_CRASH_SUBMISSION_CREATED` / `BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED` events push what the feedback read tools pull.

  **8 new tools in 1 sub-domain** — `src/domains/webhooks.ts`.

  **CRUD (5 tools)**

  - `asc_list_webhooks` — GET `/v1/apps/{id}/webhooks`. Name, enabled state, endpoint URL, subscribed event types per row. The secret never appears (write-only).
  - `asc_get_webhook` — single webhook with app relationship.
  - `asc_post_webhook` — POST `/v1/webhooks`. ALL FIVE attributes required: name, url (HTTPS), secret (HMAC-SHA256 signing key for the `X-Apple-Signature` header), eventTypes (≥1 of 12), enabled.
  - `asc_patch_webhook` — mutate name / url / secret (rotation) / eventTypes (whole-array replace) / enabled (pause–resume). Refuses empty PATCH client-side.
  - `asc_delete_webhook` — permanent; delivery history goes with it. Pause via `enabled=false` instead when in doubt.

  **Deliveries + redelivery + ping (3 tools)**

  - `asc_list_webhook_deliveries` — GET `/v1/webhooks/{id}/deliveries` with `filter[deliveryState]` (SUCCEEDED / FAILED / PENDING) and createdDate-window filters. Digest resolves each delivery's event type via `include=event` (the v0.16 live-smoke lesson applied at design time) and shows response HTTP status + error message per attempt.
  - `asc_post_webhook_redelivery` — POST `/v1/webhookDeliveries`, relationships-only body whose `template` relationship is SELF-REFERENTIAL (type `webhookDeliveries`, pointing at the existing delivery to retry). New attempt arrives with `redelivery=true`.
  - `asc_post_webhook_ping` — POST `/v1/webhookPings`, relationships-only. Response resource is id-only; the ping lands at the endpoint with `ping=true` and shows up in the deliveries list.

  **Apple-contract gotchas pinned by tests:**

  1. **is-prefix strips**, three new instances: `isEnabled`→`enabled` (Webhook create/patch — asserted on writes), `isRedelivery`→`redelivery` (WebhookDelivery, read-only), `isPing`→`ping` (WebhookEvent, read-only) — the read-only pair pinned via the sparse-fieldset constants.
  2. **WebhookCreateRequest attributes are ALL REQUIRED** — no partial create; the body builder takes all five non-optionally.
  3. **`secret` is WRITE-ONLY** — absent from the readable fields enum, never echoed by GET; rotatable via PATCH.
  4. **Relationships-only creates** on redelivery + ping (no attributes block at all, same family as v0.16 BuildBetaNotification); redelivery's `template` is self-referential.
  5. **Verbose date-filter keys**: `filter[createdDateGreaterThanOrEqualTo]` / `filter[createdDateLessThan]` — not a bare `filter[createdDate]` range.
  6. **`include=event` on the deliveries list** baked in at design time (v0.16 lesson: relationship objects don't materialize without include).

  **Live-smoke spec corrections caught on 2026-06-11** (full create → get → ping → deliveries → redeliver → patch → delete drill against WikiCatch via `scripts/smoke-webhooks.ts` — every tool path live-verified, drill cleans up after itself):

  1. **The deliveries list REQUIRES `filter[createdDateGreaterThanOrEqualTo]`** — Apple 400s without it ("Filter is required and only one must be provided", a misleading message: `filter[deliveryState]` alone does NOT satisfy it). The value must be a full ISO 8601 date-time (bare dates rejected), at most 10 days in the past, not in the future. The tool now defaults the filter to the widest window Apple accepts (~10 days back) so a bare "list deliveries" call works.
  2. **Ping events arrive with `eventType=null` + `ping=true`** — the digest renders them as `PING (ping)`.
  3. Verified clean live: secret never echoed on GET, redelivery creates a new attempt with `redelivery=true` (PENDING → FAILED against the dummy endpoint), patch rename + `enabled=false` pause, delete, and the included-event digest resolution.

  **Out of scope:** MarketplaceWebhook (EU DMA alternative distribution) stays in the v1.0+ bucket.

  **Schemas (5 new):** `WebhookIdSchema`, `WebhookDeliveryIdSchema`, `WebhookEventTypeSchema` (12-value enum), `WebhookSecretSchema`, `WebhookDeliveryStateSchema`.

  **Digests (2 new):** `digestWebhooks`, `digestWebhookDeliveries` (FAILED rows reference the redelivery tool in the legend).

## 0.15.0

### Minor Changes

- c8ff9e2: v0.16 — TestFlight follow-ons: Beta Feedback Submissions + Build Beta Notifications + Beta Recruitment Criteria. The feedback half of the TestFlight loop: v0.9 distributed builds to testers; this release reads back what testers say (screenshots, crashes, crash logs), pings them about new builds, and gates who can auto-join through public links.

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

  **Live-smoke spec corrections caught on 2026-06-10** (WikiCatch, 3 real crash submissions):

  1. **Feedback lists now send `include=build,tester`** — without include, Apple omits the build/tester relationship objects entirely (sparse fieldsets alone don't materialize them) and the digest's BUILD_ID / TESTER_ID columns rendered empty. Pinned by a query-builder test.
  2. **Crash logs expire server-side**: all three ~4-month-old submissions 404 on the crashLog related link even though the URL matches Apple's own `links.related` — the tool now explains the absence instead of dumping a bare NOT_FOUND.
  3. **No-criterion beta group: GET criterion → 409 ENTITY_ERROR** (not an empty 200 / clean 404), with a detail that resolves the criterion BY THE GROUP'S OWN ID — strong evidence `BetaRecruitmentCriterion.id == betaGroup.id` (4th shared-ID quirk, after AppKeyword / AppAvailabilityV2 / TerritoryAvailability). Tool translates the 409 to "no criterion yet".
  4. **Compatible-build check on a criterion-less group 404s** ("id 'Not Defined'") — the check only exists once a criterion does; tool says so.

  **Schemas (6 new):** `BetaFeedbackScreenshotSubmissionIdSchema`, `BetaFeedbackCrashSubmissionIdSchema`, `BetaRecruitmentCriterionIdSchema`, `DeviceFamilySchema` (6-value enum incl. VISION), `DeviceFamilyOsVersionFilterSchema`, `FeedbackPlatformFilterSchema` (platform enum ≠ device-family enum).

  **Digests (3 new):** `digestBetaFeedbackScreenshotSubmissions`, `digestBetaFeedbackCrashSubmissions`, `digestBetaRecruitmentCriterionOptions`.

## 0.14.0

### Minor Changes

- 5ce2de3: v0.15.0 — App Availability + Phased Release + Encryption Declarations. The territory / rollout / export-compliance triad: where the app is sold, how it rolls out to users, and the US export-compliance documentation Apple requires.

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

## 0.13.0

### Minor Changes

- c1202e7: v0.13.0 — Asset upload + Custom Product Pages. Screenshots + App Previews (the three-step reserve/PUT/commit Apple upload protocol, exposed as both composite shortcuts and raw escape hatches) + the full Custom Product Pages surface (page + version + localization CRUD).

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

- ca169b6: v0.14.0 — In-App Events + Promoted Purchases. The two remaining "live promotional surface" domains: time-bound App Store events with their own copy + assets, and the storefront IAP / subscription promotion layer.

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

## 0.12.0

### Minor Changes

- b839cb6: v0.12.0 — App Info + structured-ASO catalog. The per-app metadata layer (subtitle, name, categories, privacy URLs) + Apple's structured-ASO surfaces (category catalog, AppTags, SearchKeywords).

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

  **Live-smoke spec corrections (caught on 2026-06-04, fixed in this release):**

  - **`asc_list_search_keywords`**: `fields[appKeywords]=keyword` returns 400 `PARAMETER_ERROR.INVALID "'keyword' is not a valid field name"`. `AppKeyword` has NO attributes per Apple's contract — only `id` + `links`. The sparse-fieldset call dropped entirely.
  - **Important discovery**: the `AppKeyword.id` IS the human-readable keyword string (Apple uses the keyword as the primary key — e.g. `bluegill`, `solunar`, `walleye` — not opaque UUIDs). The `digestSearchKeywords` table now reads `KEYWORD` column rendered from the bare id. Apple's surface is **broader than the version-level `keywords` field** — it includes terms Apple discovered from app content, useful for diagnosing ASO impression drivers.

## 0.11.0

### Minor Changes

- 29f1131: v0.11.0 — App Store Version write surface + V2 Review Submission flow. Closes the release lifecycle: ship a new version end-to-end through the MCP (build → version → localize → submit) without opening App Store Connect.

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

## 0.10.1

### Patch Changes

- 15b53fb: Fix: state-aware pre-check on `asc_patch_app_store_version_localization` + schema clarification.

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

## 0.10.0

### Minor Changes

- df81e43: v0.10.0 — App Store product page localizations: app versions, subscriptions, IAPs.

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

## 0.9.0

### Minor Changes

- 62fa1a6: v0.9.0 — TestFlight: builds, beta groups, beta testers, beta localizations, beta review.

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

## 0.8.1

### Patch Changes

- 19c9f4d: v0.8.1 — subscription offer codes follow-ons: custom (multi-use) codes, `environment` on batch create, `autoRenewEnabled` on campaign create, richer campaign digest.

  Apple's offer-code domain has three child resource types — one-time-use batches (v0.8.0), and custom multi-use codes (this release). A custom code is one developer-chosen string redeemable up to `numberOfCodes` times across customers (e.g. `"LAUNCH2026"` usable by the first 500 people who type it). Unlike one-time-use batches — where Apple generates opaque strings and you fetch them as CSV via `/values` — the redeemable string IS the resource attribute on a custom code, so there's no separate export step.

  **New tools (three):**

  - `asc_list_subscription_offer_code_custom_codes` — list multi-use codes under a campaign, newest-first, with a "total redemption cap" footer. Indefinite-redemption codes (no expirationDate) render as `—`.
  - `asc_post_subscription_offer_code_custom_code` — create a multi-use code. Caller picks `customCode` (the redeemable string) and `numberOfCodes` (the redemption cap); `expirationDate` (`YYYY-MM-DD`) is optional. Immutable post-create, same as one-time-use batches; only `active` is patchable. Apple has no DELETE on this resource either — `PATCH active=false` is the only retirement path.
  - `asc_patch_subscription_offer_code_custom_code` — toggle `active` to kill a leaked or expired public code without nuking the parent campaign.

  **Extended surfaces:**

  - `asc_post_subscription_offer_code_one_time_use_codes` now accepts an optional `environment: SANDBOX | PRODUCTION` (per `OfferCodeEnvironment` enum). Omitted means Apple's default (PRODUCTION). Sandbox batches never bill real money and don't count against the live campaign's production allotment — useful for StoreKit redemption smoke testing without burning production codes.
  - `asc_post_subscription_offer_code` and `ppp_apply_proposal` (`resourceType: "offerCode"`) now accept an optional `autoRenewEnabled` boolean. Omitted means Apple's default (auto-renew on). Pass `false` to make the campaign a one-shot non-renewing offer — pairs naturally with PAY_UP_FRONT for "redeem a code, get 3 months, then nothing auto-bills."
  - `asc_list_subscription_offer_codes` digest gains an `AUTO_RNW` column (Y/N/— per `autoRenewEnabled`) and a `CODES` column rendering `productionCount/sandboxCount` when Apple exposes them (falls back to `totalNumberOfCodes` on sparse-fieldset responses).
  - `asc_list_subscription_offer_code_one_time_use_codes` digest gains an `ENV` column (SBX / PROD / —) so the `environment` choice round-trips back into the operator's view. `ONE_TIME_USE_FIELDS` extended accordingly.
  - The `OFFER_CODE_FIELDS` sparse-fieldset pin now includes `autoRenewEnabled,productionCodeCount,sandboxCodeCount` so the new columns aren't silently empty against the live API.

  **Apple-contract notes** (verified against the AvdLee Swift SDK + live smoke against a real ASC account on 2026-05-31):

  - Custom-code create body accepts `customCode` + `numberOfCodes` (+ optional `expirationDate`). The `active` flag is PATCH-only, same as one-time-use batches.
  - `autoRenewEnabled` and `environment` both ride on encodeIfPresent — body builders OMIT the key entirely when undefined rather than sending `null`, mirroring the FREE_TRIAL `subscriptionPricePoint` fix from v0.8.0 (Apple's persistence layer 500s on explicit nulls in offer-code attribute slots).
  - Custom-code `expirationDate` is optional (unlike one-time-use batches, where it's required); omitting it makes the code redeemable indefinitely until the campaign or the resource itself is deactivated.

  **Live-smoke schema corrections (caught on 2026-05-31, fixed in this release):**

  - **Custom-code `numberOfCodes` floor is 500**, not 1. Apple's create endpoint rejects 1, 5, 100, 250, 499 with `ENTITY_ERROR.ATTRIBUTE.INVALID — Invalid number of codes` and accepts 500/1000/25000. Custom codes now use a dedicated `CustomCodeNumberOfCodesSchema` (min 500, max 25000); one-time-use batches keep the old `TotalNumberOfCodesSchema` (min 1, max 25000) since the two surfaces have different floors despite sharing the wire field name.
  - **PATCH `active=false` is one-way** on BOTH campaigns and custom codes. Apple rejects reactivation with `STATE_ERROR — Given Subscription OfferCode is inactivate, cannot be updated` (resp. `Given custom code is inactive`). The row persists as a permanent tombstone — campaigns still count against the 10-per-subscription cap. Side effect on custom codes: Apple silently stamps today's date into `expirationDate` on deactivation, so the row reads as an expired code from then on. Tool descriptions on both PATCH tools updated to surface this.
  - **One-time-use `expirationDate` has an undocumented 6-month cap.** Apple rejects further-future dates with `Please select an expiration date no more than 6 months in the future`. `ExpirationDateSchema` description annotated; the cap is enforced server-side against Apple's clock so client-side `.refine()` would be brittle.
  - **`autoRenewEnabled: false` is incompatible with `STACK_WITH_INTRO_OFFERS`.** Apple rejects the combination with `Offers without auto-renew behavior can not be stacked with Intro-Offers` (and mis-points `source.pointer` at `customerEligibilities`). Both `AutoRenewEnabledSchema` and `OfferEligibilitySchema` now document the cross-field rule. Non-renewing offer codes must pair with `REPLACE_INTRO_OFFERS`.

  **Roadmap shuffle:** v0.8.1 row in `README.md` flipped to ✓. v0.9 (TestFlight) is the next major surface.

## 0.8.0

### Minor Changes

- f83d75a: v0.8.0 — subscription offer codes: campaigns, bulk codes, and CSV export.

  Opens the third subscription-discount surface alongside intro offers (new subscribers, free trial / pay-as-you-go / pay-up-front) and promotional offers (existing/lapsed subscribers, in-app SubscriptionOffer redemption). Offer codes are the customer-facing redeemable-string mechanism: the user enters a code in App Store → gets the campaign's terms applied to their subscription.

  **Apple's model has three layers.** The CAMPAIGN (`subscriptionOfferCodes`) carries name, customer-eligibility cohorts (NEW / EXISTING / EXPIRED), offer-eligibility (STACK_WITH_INTRO_OFFERS / REPLACE_INTRO_OFFERS), mode, duration, periods, and per-territory prices. ONE-TIME-USE BATCHES (`subscriptionOfferCodeOneTimeUseCodes`) are bulk-generated unique strings, one redemption each, with the actual code values exposed via a separate `/values` sub-resource that serves text/csv. CUSTOM (MULTI-USE) CODES — a single string redeemable by many people — are deferred to v0.8.1.

  **New tools (eight):**

  - `asc_list_subscription_offer_codes` — list campaigns on a subscription with cohort + offer-eligibility compact labels.
  - `asc_get_subscription_offer_code` — fetch one with prices, one-time-use batches, and custom codes inlined.
  - `asc_post_subscription_offer_code` — atomic create: campaign + all per-territory prices in one POST. Pre-flights the 10-campaign-per-subscription cap and refuses name collisions before the API call. Validates mode/price-point consistency: FREE_TRIAL refuses a stray `pricePointId`, non-FREE_TRIAL refuses a missing one.
  - `asc_patch_subscription_offer_code` — toggle `active`. The only mutable attribute on this resource.
  - `asc_list_subscription_offer_code_one_time_use_codes` — list bulk batches under a campaign, newest first, with a "total codes generated" footer.
  - `asc_post_subscription_offer_code_one_time_use_codes` — generate a batch of unique single-redemption strings (numberOfCodes + expirationDate as YYYY-MM-DD).
  - `asc_patch_subscription_offer_code_one_time_use_codes` — toggle `active` on a batch. Use to kill a leaked batch without nuking the parent campaign.
  - `asc_export_subscription_offer_code_one_time_use_values` — fetch the redeemable code strings as CSV (Apple serves text/csv on `/values` directly; tool passes through verbatim with a one-line summary header, skippable via `raw: true`). Treat as secrets.

  **PPP extended.**

  `ppp_compute_proposal` and `ppp_apply_proposal` accept `resourceType: "offerCode"` alongside the existing four. New required args when this type is chosen: `offerCodeName`, `customerEligibilities`, `offerEligibility`. Reuses the subscription PPP engine. Apply is **create-only and atomic** — per-territory prices are immutable post-create on this resource (unlike promo offers, which permit a price PATCH), so there's no rebalance path: to change prices, the only option is to retire the campaign and start a new one. FREE_TRIAL rejected for PPP (no price to compute).

  **No DELETE.** Apple's API does not expose DELETE on `subscriptionOfferCodes`. The only retirement path is `PATCH active=false`, which renders a campaign inert but leaves the row in App Store Connect — and deactivated campaigns still count against the 10-per-subscription cap. The 10-cap pre-flight refuse messages on both the create tool and the PPP apply path now document this and suggest the manual-ASC-UI cleanup escape hatch. v0.8.0 originally specced a delete tool; it was removed during the bugfix cycle.

  **Apple-contract landmines documented inline** (in case the OpenAPI silently shifts again):

  - The relationship URL on a subscription is `/offerCodes`, not `/subscriptionOfferCodes` — Apple drops the resource-type prefix on relationship paths.
  - `offerEligibility` (singular enum) and `customerEligibilities` (plural list) are two different attributes; both required at create.
  - `numberOfPeriods` is required on every `offerMode`, including FREE_TRIAL — set to 1 for one-shot modes.
  - FREE_TRIAL price rows must OMIT the `subscriptionPricePoint` relationship key entirely. Apple's validator allows `{ data: null }` syntactically but its persistence layer 500s on it; the spec-compliant form is to drop the key (Swift SDK's `encodeIfPresent` idiom).
  - Batch create accepts only `numberOfCodes` + `expirationDate` (+ optional `environment`, deferred). The `active` flag is PATCH-only.
  - `expirationDate` is an ISO 8601 calendar date (`YYYY-MM-DD`), not a date-time.
  - `/values` serves `text/csv`, not JSON. The ASCClient gained a `requestText` method that defaults `Accept: text/csv` (with override) and reuses the shared auth + 401-refresh + 429-retry envelope.

  All seven landmines were caught by a live-API smoke run against a real ASC account; `scripts/smoke-offer-codes.ts` is added so the next live-API surface can use the same fast-fail pattern.

  **Roadmap shuffle:** v0.8.1 = offer-codes follow-ons (custom multi-use codes + `environment: SANDBOX|PRODUCTION` on batch create + `autoRenewEnabled` on campaign create + tighter numberOfCodes-floor surfacing). v0.9 = TestFlight. v0.10 = localizations. v0.11 = customer reviews. v0.12 = sales/analytics.

## 0.7.0

### Minor Changes

- fff9ea2: v0.7.0 — subscription offer signing for in-app redemption.

  Closes the v0.6 loop: v0.6.0 added the ASC config surface for promotional offers; v0.7.0 adds the cryptographic signer the consuming iOS app needs to redeem those offers via StoreKit. Three formats — Apple supports all three concurrently, and which you need depends on which StoreKit API your app uses.

  **New tools (three):**

  - `asc_sign_promotional_offer_legacy` — legacy ECDSA-concatenated format used by StoreKit 1's `SKPaymentDiscount` and the original StoreKit 2 `Product.PurchaseOption.promotionalOffer(offerID:keyID:nonce:signature:timestamp:)` API. Returns the base64 signature plus the nonce, timestamp, and keyId to pass back to StoreKit. Auto-generates a UUID nonce and current timestamp by default; both can be overridden for testing.
  - `asc_sign_promotional_offer` — JWS v2 format introduced at WWDC 2025, recommended for new code on iOS 15+. Use with StoreKit 2's newer promotional-offer purchase options. Returns the JWS compact serialization directly.
  - `asc_sign_introductory_offer_eligibility` — JWS v2 with `aud="introductory-offer-eligibility"`. Lets you override StoreKit's default introductory-offer eligibility check (e.g. grant a returning customer another trial). New in WWDC 2025.

  All three sign with the same key — the per-team **In-App Purchase signing key** from App Store Connect → Users and Access → Integrations → In-App Purchase. This is distinct from the ASC API key used by every other tool in this MCP.

  **Built on Apple's official library.** Uses `@apple/app-store-server-library`'s `PromotionalOfferSignatureCreator`, `PromotionalOfferV2SignatureCreator`, and `IntroductoryOfferEligibilitySignatureCreator` rather than hand-rolling crypto. The legacy format alone has at least four landmines (U+2063 INVISIBLE SEPARATOR as delimiter, base64 vs base64url, DER-encoded signature, lowercased applicationUsername) — Apple's reference library handles all of them.

  **New env vars (optional):**

  - `ASC_IAP_ISSUER_ID` — the issuer UUID shown on the In-App Purchase keys page (different from `ASC_ISSUER_ID`).
  - `ASC_IAP_KEY_ID` — 10-character key ID.
  - `ASC_IAP_PRIVATE_KEY_PATH` — path to the IAP signing `.p8` (`~` is expanded).

  Server still starts without these — only the `asc_sign_*` tools refuse with a setup message if they're missing. The other tools are unaffected. Setting one or two but not all three is rejected with a clear error.

  **`appstoreconnect-mcp doctor` extended** with an "IAP signing" section that reports whether the IAP env vars are configured, whether the `.p8` loads, and whether it parses as a valid ES256 key. Skipped (not failed) when no IAP env vars are set.

  **Roadmap shuffle:** v0.7.0 = subscription offer codes (one-time-use bulk + custom codes); v0.8 = TestFlight; v0.9 = localizations; v1.0 = customer reviews; v1.1 = sales/analytics.

## 0.6.0

### Minor Changes

- dac2b05: v0.6.0 — subscription promotional offers, with PPP awareness.

  Promotional offers are discounts targeted at **existing or lapsed** subscribers (intro offers target new subscribers — opposite eligibility, set by the resource type itself; there is no per-offer eligibility flag in Apple's API). v0.6.0 adds the full ASC config surface — six tools — plus PPP extended to a fifth resource type.

  JWT signing for in-app redemption (a separate `.p8` from the ASC API key) is intentionally out of scope here and will land as v0.6.1.

  **New tools:**

  - `asc_list_subscription_promotional_offers` — list promo offers configured for a subscription.
  - `asc_get_subscription_promotional_offer` — fetch a single offer, including its per-territory prices.
  - `asc_list_subscription_promotional_offer_prices` — list per-territory price rows attached to an offer.
  - `asc_post_subscription_promotional_offer` — create an offer with `name` + `offerCode` + mode + duration + all per-territory prices in one atomic POST. Pre-flights both Apple's 10-offer-per-subscription cap and `offerCode` collisions; refuses with a clear remedy message instead of letting Apple 409.
  - `asc_patch_subscription_promotional_offer_prices` — replace the per-territory prices on an existing offer. Apple's wire semantic is replace (the new prices array becomes the post-state, dropping any territory not listed); this tool's `mode: 'replace' | 'add' | 'remove'` parameter hides the footgun. `'add'` reads current prices and merges; `'remove'` reads and filters. `name`, `offerCode`, `mode`, `duration`, and `numberOfPeriods` are immutable after creation — to change any of them, delete and re-create.
  - `asc_delete_subscription_promotional_offer` — DELETE → 204.

  **PPP extended to promotional offers.**

  `ppp_compute_proposal` and `ppp_apply_proposal` now accept `resourceType: "promotionalOffer"` alongside the existing `"subscription" | "app" | "iap" | "introductoryOffer"`. Required args: `subscriptionId`, `offerMode`, `duration`, `promoOfferName`, `promoOfferCode`, plus `numberOfPeriods` when `offerMode=PAY_AS_YOU_GO`.

  - The compute path reuses the subscription PPP engine, with the same currency-mismatch skip and Δ-vs-current-sub-price reporting introduced in v0.5.0 for intro offers.
  - The apply path is **create-only**: refuses if `offerCode` collides with an existing offer on the sub, or if the sub is at Apple's 10-offer cap. To rebalance an existing campaign, delete it and re-run.
  - Apply is **one atomic POST** to `/v1/subscriptionPromotionalOffers` — the offer + all its per-territory prices either all land or none do. No per-row retry needed (closer to app/IAP whole-schedule semantics than intro-offers' per-row pacing).
  - `FREE_TRIAL` rejected by compute and apply (no price to compute). Create a free-trial promo with `asc_post_subscription_promotional_offer` directly.

  **Roadmap shuffle (continuing the "label = actual semver" discipline from v0.4/v0.5):** v0.6.1 = JWT signing for promotional-offer redemption; v0.7.0 = subscription offer codes (one-time-use bulk + custom codes); v0.8 = TestFlight; v0.9 = localizations; v1.0 = customer reviews; v1.1 = sales/analytics.

## 0.5.0

### Minor Changes

- a357457: v0.5.0 — subscription introductory offers, with PPP awareness.

  Introductory offers are the discounted "first window" on top of an auto-renewable subscription: free trials, pay-as-you-go promos, and pay-up-front promos. v0.5.0 adds the full surface — list / get / create / patch / delete — plus PPP-aware per-territory pricing.

  **New tools:**

  - `asc_list_subscription_introductory_offers` — list intro offers configured for a subscription, across territories. Wildcard offers (Apple's "all territories" with `territory: null`) surface as `TERR=(all)` in the table.
  - `asc_get_subscription_introductory_offer` — fetch a single offer by ID.
  - `asc_post_subscription_introductory_offer` — create an offer. Three modes:

    - `FREE_TRIAL` — no price; redeem and get the sub for `duration` free. Omit `pricePointId`.
    - `PAY_AS_YOU_GO` — discounted price each period for `numberOfPeriods` periods. Requires `pricePointId` and `numberOfPeriods`.
    - `PAY_UP_FRONT` — single charge for the whole `duration` window. Requires `pricePointId`.

    Server-side checks: `pricePointId` required unless `FREE_TRIAL`; `numberOfPeriods` required when `PAY_AS_YOU_GO`; `endDate > startDate`. Pass `territoryId` to target one market, or omit it for Apple's "all territories" wildcard (which uses the literal price point in every market with no auto-FX — for PPP-aware multi-territory offers, create one per territory).

  - `asc_patch_subscription_introductory_offer` — narrow update path. Apple only lets you change `startDate`, `endDate`, and `pricePointId` after creation. To change `offerMode` / `duration` / `numberOfPeriods`, delete and re-create. The most common use is extending `endDate` to keep a campaign running.
  - `asc_delete_subscription_introductory_offer` — delete a pending or active offer. Apple refuses to delete an offer that is currently redeemable; to stop an active offer, PATCH `endDate` to today instead.

  **PPP extended to introductory offers.**

  `ppp_compute_proposal` and `ppp_apply_proposal` now accept `resourceType: "introductoryOffer"` alongside the existing `"subscription" | "app" | "iap"`. Required args: `subscriptionId`, `offerMode`, `duration`, plus `numberOfPeriods` when `offerMode=PAY_AS_YOU_GO`.

  - The compute path snaps `basePriceAnchor` to valid subscription price points per territory using the Apple Music PPP signal — same engine as subscription PPP, same currency-mismatch skip for USD-billed Gulf markets.
  - The Δ column compares the snapped offer price against the **current regular subscription price** in that territory, so a `-50%` Δ reads as "the offer is half off the sub."
  - The apply path POSTs one offer per change row to `/v1/subscriptionIntroductoryOffers`, paced at `maxConcurrency` (default 2), with the same 429-retry behaviour as base subscription pricing.
  - `FREE_TRIAL` is rejected by both compute and apply — there is no price to compute. Use `asc_post_subscription_introductory_offer` with `territoryId` omitted for a single global free trial.
  - Intro offers are additions, not replacements: Apple returns 409 if an active offer already exists for a `(sub, territory)` cell. Those rows show as `failed` in the result table; pre-existing offers are not modified.

  **Roadmap shuffle.** v0.5 in the original roadmap covered intro + promotional + offer codes; per the Changesets convention (each domain is a minor bump) those slip down: v0.6.0 = promotional offers, v0.7.0 = offer codes, TestFlight moves to v0.8, localizations v0.9, reviews v1.0, analytics v1.1.

## 0.4.0

### Minor Changes

- d702a70: v0.4.0 — close the monetization loop. PPP auto-apply now works for every paid surface (subscriptions, apps, IAPs), and price-point listings can be narrowed to a target band.

  **ppp_apply_proposal now auto-applies for apps and IAPs.**

  Previously, `ppp_apply_proposal({resourceType: "app", ...})` returned a JSON payload that the caller had to feed back into `asc_post_app_price_schedule` by hand, and IAPs weren't on the PPP path at all. Both now POST the new schedule directly:

  - Single whole-schedule-replace POST (one HTTP call, fail/succeed atomically — no partial writes to clean up).
  - Base-territory ack guardrail: if `baseTerritory` differs from the resource's current base territory, the tool refuses until you pass `acknowledgeDeletesScheduledIfBaseChanges: true` (Apple wipes pending scheduled changes on base-change).
  - Same `maxDropPct` sanity guard as the subscription path (default 90%).
  - Same MCP elicitation confirmation flow — clients without elicitation can re-run with `confirm: true`.
  - Active-now base-territory entry is inserted automatically; if the base isn't in the proposal (anchor price unchanged), the current price-point ID is reused.

  **ppp_compute_proposal: resourceType: "iap"** with `iapId`. Same shape and output as `resourceType: "app"`, fetches via `/v2/inAppPurchases/{id}/iapPriceSchedule` and price points from `/v2/inAppPurchases/{id}/pricePoints`.

  **nearAmount filter on price-point listings.** `asc_list_subscription_price_points`, `asc_list_app_price_points`, and `asc_list_iap_price_points` now accept:

  - `nearAmount` (positive number, optional) — target customer price in the territory currency.
  - `nearCount` (default 10) — max tiers to return when `nearAmount` is set.

  Apple doesn't support a near-amount filter server-side, so the full list is still paginated, but the response is narrowed to the N closest tiers client-side. Cuts the typical 600-tier table down to ~10 candidates the model can actually reason over.

  **Notes:**

  - Apps and IAPs share a single `applyWholeSchedule` code path internally — the only differences are the JSON:API type/relationship names, which live in two small config objects (`APP_SCHEDULE_CONFIG`, `IAP_SCHEDULE_CONFIG`). IAPs use `inAppPurchaseV2` as the inline-row owning relationship even though the schedule's top-level rel is `inAppPurchase` — Apple's own spec inconsistency, baked into the code and pinned by tests.
  - `preserveCurrentPrice` and `maxConcurrency` continue to apply to subscriptions only — apps and IAPs have no grandfather mechanism and always issue a single POST.

## 0.3.0

### Minor Changes

- 698e500: v0.2.1 — in-app purchases (v2 surface).

  **New tools:**

  - `asc_list_iaps` — list IAPs for an app (consumables, non-consumables, non-renewing subscriptions). Auto-renewable subs are unchanged on the existing Subscriptions tools.
  - `asc_get_iap` — fetch one IAP by ID.
  - `asc_list_iap_prices` — current price schedule for an IAP (same shape as app prices: manual overrides + auto-derived + base territory).
  - `asc_list_iap_price_points` — valid Apple price tiers for an IAP in a given territory.
  - `asc_post_iap_price_schedule` — replace the entire IAP price schedule. Whole-schedule replace (matches Apple's API). Pre-flight checks: `acknowledgeReplacesAll: true` required, at least one entry for `baseTerritory` with no `startDate`, and `acknowledgeDeletesScheduledIfBaseChanges` when the base territory changes.

  **Notes:**

  - v1 IAP endpoints (`/v1/inAppPurchases/*`) are deprecated and not exposed. If an app's `asc_list_iaps` returns zero rows but you know it has IAPs, they're legacy-v1 and need migration via the App Store Connect web UI.
  - The IAP detail endpoint and price schedule endpoint use the `/v2/` URL prefix (Apple's API split — list is on `/v1/` but the IAP-scoped reads are on `/v2/`).
  - Inline-create payloads use the relationship name `inAppPurchaseV2` (not `inAppPurchase`) — easy to typo, baked into the write tool.
  - No `preserveCurrentPrice` analog for IAPs (same as apps) — new prices activate atomically at each entry's `startDate`.

## 0.2.0

### Minor Changes

- b96eb5a: v0.2.0 — app pricing surface, with PPP support for the compute side.

  **New tools:**

  - `asc_list_app_prices` — list the current price schedule for an app (manual overrides + auto-derived + base territory).
  - `asc_list_app_price_points` — list valid Apple price tiers for an app in a given territory.
  - `asc_post_app_price_schedule` — replace the entire price schedule. Whole-schedule replace (matches Apple's API semantics, NOT a merge). Pre-flight checks: at least one entry for the base territory with `startDate: null`, `acknowledgeReplacesAll: true` required, and a separate `acknowledgeDeletesScheduledIfBaseChanges` ack when the base territory changes (Apple wipes pending scheduled changes on base-change).

  **PPP generalized:**

  - `ppp_compute_proposal` now accepts `resourceType: "subscription" | "app"` (defaults to `"subscription"` for back-compat). For apps, pass `appId` instead of `subscriptionId`. Computes the same proposal table — the underlying fetch path is heavier for apps (one HTTP call per unique territory to resolve current amounts, since Apple's appPriceSchedule endpoint rejects chained includes).
  - `ppp_apply_proposal` accepts `resourceType` too, but auto-apply is **subscription-only** for now. For apps, the tool returns the proposal table plus a JSON payload pre-formatted for `asc_post_app_price_schedule` (whole-schedule replace path is wired separately).

  **Notes:**

  - Apps have no grandfather mechanism (no `preserveCurrentPrice` analog) — new schedules activate atomically at each entry's `startDate`.
  - Apple's `appPriceSchedule` GET rejects chained includes (`manualPrices.appPricePoint`) and `fields[appPricePoints]` selectors; the read digest shows territory + manual/auto flag + start date + IDs only. Amounts resolved via `asc_list_app_price_points`.
  - Read/write handlers in the app-pricing domain surface Apple's full error body (`errors[].detail`) on non-2xx so the model can self-correct invalid include/fields params without a roundtrip.

## 0.1.2

### Patch Changes

- abee8e4: Apple Music index: update BGR (Bulgaria) from BGN to EUR. Bulgaria adopted the euro and the App Store + Apple Music both bill in EUR there now. Previously BGR showed up as a `currency-mismatch` row in PPP proposals; with this fix it's part of the regular EUR cluster (factor 1.000 vs USA, target = anchor price).

## 0.1.1

### Patch Changes

- 0b98884: `ppp_compute_proposal` and `ppp_apply_proposal`: skip territories where the App Store Connect billing currency differs from the bundled Apple Music index currency. Marked as `currency-mismatch (asc=X, am=Y)` in the proposal table and excluded from the apply set.

  This guards against a dimensional bug: the Apple Music price ratio is only a valid PPP-FX signal when both numerator (local Apple Music price) and the ASC billing currency match. For USD-billed Gulf markets (BHR, KWT, OMN) where Apple Music is sold in BHD/KWD/OMR, the formula would have produced artificially low prices (~$0.69 instead of ~$1.80 for a $4.99 anchor). Now those markets are explicitly skipped — set them manually via `asc_post_subscription_price` if needed.

- eb65a2b: Compact PPP proposal output so the diff table fits in a normal terminal.

  Apple's `subscriptionPricePoint` IDs are ~50-char base64 strings that blew the proposal table past 80 columns and forced wrap. `ppp_compute_proposal` now shows `POINT_ID` as the last 8 characters of the ID (e.g. `…NjEifQ`) by default; pass `raw: true` to see full IDs. `ppp_apply_proposal`'s elicitation confirmation message drops the `POINT_ID` column entirely — the user is reviewing prices, not relationship IDs, and the server uses the IDs internally regardless.

- 175e96d: Handle Apple's 429 rate limits transparently in the HTTP client.

  `client.request` now retries on 429 up to 6 times, honouring the `Retry-After` header when present and falling back to exponential backoff (2s → 4s → 8s … capped at 60s). Without this, applying many subscription prices in parallel would cause Apple to start rejecting writes after ~50 requests/minute and the per-row catch in `ppp_apply_proposal` was reporting them as failed without retry — leaving partial pending schedules. Discovered when a 60-territory apply only landed 10 of the writes before Apple started throwing 429s.

  Also lowered the default `maxConcurrency` for `ppp_apply_proposal` from 5 to 2. With the new retry behaviour the higher concurrency mostly produced backoff stalls; 2 keeps writes well under Apple's threshold without sacrificing meaningful wall time on a typical 60-row run.

## 0.1.0

### Minor Changes

- a2108dd: Compact responses + auto-pagination across all read tools.

  Each list/get tool now returns a clean text table by default (`asc_list_apps`, `asc_list_subscription_groups`, `asc_list_subscriptions`, `asc_list_subscription_prices`, `asc_list_subscription_price_points`, `asc_list_territories`, `asc_get_app`). Every tool accepts `raw: true` to get the original JSON:API payload, and paginated tools accept `maxItems` (default 500–1000).

  Internal changes:

  - New `paginate()` helper follows `links.next`, merges and dedupes `included` resources across pages.
  - Sparse fieldsets (`fields[type]=…`) applied per tool to avoid pulling unused attributes.
  - `&limit=200` set on all list endpoints (was missing on `subscriptionPrices`, capping responses at 50/175 territories).
  - New `digest.ts` module with one digester per resource type, joining `data` ↔ `included` to surface the actually useful columns (territory + currency + amount instead of relationship URIs).

  Net effect: a full 175-territory subscription price schedule fits in ~5 KB of text instead of ~90 KB of nested JSON.

- cf4afca: Add `init` and `doctor` subcommands.

  `appstoreconnect-mcp init` is an interactive wizard that opens App Store Connect, copies the `.p8` to `~/.appstore/` with `chmod 600`, prompts for issuer/key IDs (Key ID auto-detected from the filename), verifies auth with a real ASC call, and registers the MCP in any installed clients (Claude Code, Claude Desktop, Cursor, Windsurf — auto-detected).

  `appstoreconnect-mcp doctor` is a read-only diagnostic — checks key directory permissions, parses each `.p8`, lists registered clients, and optionally hits the live API if env vars are set.

  The default no-arg invocation continues to start the MCP server over stdio (unchanged behavior for clients).

- b0794b6: Add `ppp_apply_proposal` — the single-tool entry point for a PPP rebalance.

  Computes the same proposal as `ppp_compute_proposal`, then asks the user to confirm via MCP elicitation (Claude Code, Claude Desktop, etc.), and on confirm POSTs all eligible price changes against App Store Connect in parallel. The user-facing flow collapses from "propose → review → manually trigger 14 writes → verify" into a single tool call with one in-client confirmation prompt.

  Built-in guardrails:

  - `maxDropPct` (default 90%) — refuses to apply if any single row drops more than this; guards against a bad Apple Music index entry crashing a price.
  - `maxConcurrency` (default 5) — parallel POSTs well under Apple's 50/min rate limit.
  - `preserveCurrentPrice: true` by default — existing subscribers are grandfathered.
  - `startDate` defaults to today + 7 days (Apple requires ≥24h; 7 is a safety buffer).
  - `confirm: true` arg as a fallback for clients that don't support elicitation, or for automation.

  Refactored `src/domains/ppp.ts` to share the proposal-computation logic between `ppp_compute_proposal` and `ppp_apply_proposal`. Added an in-domain `concurrentMap` helper covered by 5 new tests (37 total now passing).

- 3f0f600: Add `ppp_load_index` and `ppp_compute_proposal` tools.

  `ppp_compute_proposal` is the single entry point for a Purchasing Power Parity rebalance: it fetches the current price schedule for the target subscription, loads the bundled Apple Music Individual-plan price snapshot (`data/apple-music-prices.json`), computes a per-territory factor using Apple Music ratios as the implied PPP-FX rate, fetches valid price points in parallel for territories where the target differs from current, snaps to the nearest valid Apple price point (configurable `roundStrategy`: `nearest` / `down` / `up`), and returns a compact dry-run table with `POINT_ID`s ready to feed back into `asc_post_subscription_price`. Apply a configurable sanity floor (`floorFactor`, default 0.15) so bad index data can't crash the price.

  `ppp_load_index` returns the bundled snapshot as a sorted table (or raw JSON) so users can see what reference data is in play.

  The bundled snapshot covers ~70 territories with high-confidence Apple Music prices as of 2026-05-09; refresh upstream by editing `data/apple-music-prices.json` and resubmitting.

  Updated `examples/ppp-rebalance/SKILL.md` to drive the new tool. The skill now does discover → propose → review → apply → verify → rollback, with the gotchas (preserveCurrentPrice, Russia, USD-only territories, snap direction) called out.

### Patch Changes

- d4326ce: `init`: scan `~/.appstore`, `~/Downloads`, and `~/Desktop` for `.p8` files and present them as a select list (sorted most-recent-first, with auto-detected Key IDs). Falls back to manual path entry. Avoids the chore of typing a 60-character path.

This changelog is generated from [changesets](.changeset/). See [CONTRIBUTING.md](CONTRIBUTING.md#working-on-a-change).
