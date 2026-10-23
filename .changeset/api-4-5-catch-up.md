---
'@akoskomuves/appstoreconnect-mcp': minor
---

Catch up with App Store Connect API 4.5: Korean age ratings and organization subscriptions.

- `asc_patch_age_rating_declaration`: `koreaAgeRatingOverride` now accepts `ALL` and `TWELVE_PLUS`, alongside `NONE`, `FIFTEEN_PLUS` and `NINETEEN_PLUS`.
- `asc_patch_subscription` accepts `multiSeatStatus` (`ENABLED` / `DISABLED`) and `marketSettings`, the markets a subscription is sold in: `APP_STORE`, `APPLE_SCHOOL`, `APPLE_BUSINESS`. `marketSettings` replaces the whole list, so pass every market you want to keep. Apple accepts both fields on update only, not on create.
- `asc_list_subscriptions` requests both fields and shows them as `MULTI_SEAT` and `MARKETS` columns.
