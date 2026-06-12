---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.18 — Sales/finance reports + Analytics Reports. The "look at what happened" slice: revenue TSVs straight from Apple and the four-level Analytics Reports chain, closing the roadmap's reporting gap ("Why did MRR drop in Brazil last week?").

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
