---
'@akoskomuves/appstoreconnect-mcp': minor
---

Ship-loop completeness — availabilities + App Review details/submissions (~25 new tools):

- **Availabilities**: subscription, IAP, and subscription-plan (MONTHLY/UPFRONT) per-territory availability — reads, availableTerritories listings, POST-only full-replace creates (plan availability also has PATCH). Territory linkage uses bare 3-letter ISO codes, unlike app availability's opaque composite ids.
- **App Review details**: create/read/update the per-version review card (contact, demo account, notes), plus App Review **attachments** (e.g. demo videos) as the review-assets upload factory's 5th resource (its `assetDeliveryState` struct handled in the shared digest).
- **Release requests**: `asc_post_app_store_version_release_request` releases an approved PENDING_DEVELOPER_RELEASE version to the store — the manual "Release this version" click, automated.
- **Standalone item submissions**: submit an IAP / subscription / subscription group's pending changes for review without a version release (IAP relates via `inAppPurchaseV2` — same wire-key gotcha family as review assets).
- **Grace periods**: read + patch the per-app billing grace period (optIn/sandboxOptIn, 3/16/28-day duration, renewal scope).

Also: the required-attributes audit now recognizes config-driven builders (computed relationship keys) via quoted-name evidence at call sites.
