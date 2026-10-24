---
"@akoskomuves/appstoreconnect-mcp": minor
---

Add in-app product versions, in-app purchase offer codes and build uploads. 43 new tools.

- **Versions** (API 4.4.1): list / get / create versions of in-app purchases, subscriptions and subscription groups, plus each version's localizations and images. A version holds the metadata App Review approves; the product keeps identity and prices. The tool descriptions explain how the two layers relate. Version creation refuses while a `PREPARE_FOR_SUBMISSION` draft exists, since versions cannot be deleted.
- **IAP offer codes** (API 4.2): campaigns, prices, one-time-use batches (with CSV export) and custom codes for consumables, non-consumables and non-renewing subscriptions. Mirrors the subscription offer-code tools, including the campaign cap and name-collision pre-flight.
- **Build uploads** (API 4.1): `asc_upload_build` uploads an `.ipa` / `.pkg` from a local file (create → reserve → PUT chunks → commit with MD5), plus the raw steps, upload listing with state and errors, and build-bundle reads (per-device file sizes, App Clip domain status, TestFlight App Clip invocations).

Live-checked on 2026-10-24: version-scoped localizations have no `state` field and version images report `assetDeliveryState` (the v1 field names return 400); the build-upload list needs `include=build` to return the build; a COMPLETE upload's build id equals its upload id.
