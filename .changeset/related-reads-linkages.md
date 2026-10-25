---
"@akoskomuves/appstoreconnect-mcp": minor
---

Cover the rest of API 4.5.1's related-resource reads, relationship linkages and single PATCH/DELETEs (59 new tools, 779 in total).

- **`asc_get_related`** — one tool for 48 `GET /v1/{parent}/{id}/{relationship}` reads, keyed `"<parent>.<relationship>"` (a build's app / pre-release version / icons / individual testers, a tester's apps / groups / builds, a profile's devices, a CI product's repositories, a review submission's items, …). To-one reads report "none linked" when Apple answers `data: null`.
- **By-id reads** for analytics reports / instances / segments, alternative-distribution package deltas / variants / versions, CI products / build actions / issues / test results, SCM providers / pull requests, IAP hosted content and v3 app price points.
- **App info** category slots and territory age ratings; **price schedule** manual / automatic prices for apps and IAPs; **price-point equalizations** for apps, IAPs and subscriptions.
- **TestFlight usage metrics** (tester, beta group public link, build) and the API 4.5 **performance overview** (`application/vnd.apple.xcode-overview+json`).
- **Linkages**: build ↔ beta groups and individual testers, beta tester ↔ groups / builds / apps, app-wide tester removal, search keywords on version and custom-product-page localizations, screenshot / preview set ordering, bulk removal of subscription prices and introductory offers, and `POST /v1/appStoreVersionPromotions`.
- **Android → iOS app mapping** CRUD and **routing app coverage** upload (to-one per version, same three-step upload as review screenshots).
- **`asc_patch_app`** (server notification URLs, content rights, primary locale, …), custom product page version deep link, certificate `activated`, review submission item `resolved` / `removed`, and deletes for Xcode Cloud workflows and products.

Live-checked 2026-10-24 (read-only): Apple refuses `limit` on `bundleIds/{id}/bundleIdCapabilities`; app and beta-group `betaTesterUsages` require `groupBy` or a filter; `adjustedEqualizations` requires `filter[planType]` and accepts only `MONTHLY`.
