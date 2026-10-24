---
"@akoskomuves/appstoreconnect-mcp": minor
---

Add in-app purchase create, update and delete (`asc_post_iap`, `asc_patch_iap`, `asc_delete_iap`), using `POST /v2/inAppPurchases` and `PATCH` / `DELETE /v2/inAppPurchases/{id}`. Delete checks the state first and refuses for IAPs under review or already approved; `force: true` skips the check.

Add the `/v2` version-scoped content endpoints: localizations for IAPs, subscriptions and subscription groups, and promotional images for IAPs and subscriptions (22 tools, `asc_*_version_localization` and `asc_*_version_image`). They add to the `/v1` endpoints rather than replace them. They use the same resources but attach to a product version instead of the product, and `/v1` is not deprecated, so the existing tools are unchanged. Live-checked on 2026-10-24: `/v2` GETs return the same records as `/v1`.
