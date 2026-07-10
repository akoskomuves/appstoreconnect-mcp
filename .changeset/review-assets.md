---
"@akoskomuves/appstoreconnect-mcp": minor
---

Add **IAP + subscription review assets** — 22 tools across a new `review-assets` domain, closing a real correctness gap: Apple requires an App Store review screenshot on an in-app purchase / subscription before it can be submitted, and there was no tool to attach one.

Four resources, each with the v0.13 three-step asset-upload flow (composite `asc_upload_*` + raw reserve/commit/delete + reads):

- **IAP promotional images** (`inAppPurchaseImages`, to-many) — list / get / upload / post / patch / delete
- **IAP review screenshot** (`inAppPurchaseAppStoreReviewScreenshots`, to-one) — get / upload / post / patch / delete
- **Subscription promotional images** (`subscriptionImages`, to-many) — full set
- **Subscription review screenshot** (`subscriptionAppStoreReviewScreenshots`, to-one) — full set

Apple-contract details captured: the reserve relationship key differs per resource (IAP image uses `inAppPurchase`, IAP review screenshot uses `inAppPurchaseV2` — same `inAppPurchases` target), the `uploaded` wire key (Swift `isUploaded`), and the to-one review-screenshot cardinality (the upload/reserve tools pre-flight and refuse a second one with a delete-first remedy). Reserve/commit wire shapes pinned by unit tests; read paths live-smoked against the real API.
