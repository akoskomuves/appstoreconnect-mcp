---
'@akoskomuves/appstoreconnect-mcp': minor
---

Move in-app purchase and subscription metadata onto Apple's version model before Apple removes the old endpoints.

Apple emailed developers that the product-scoped v1 endpoints for IAP and subscription localizations, images, subscription group localizations, and the standalone IAP / subscription / subscription group submissions will be removed beginning in early 2027. Spec 4.6 does not flag them as deprecated, so a spec audit can't see this. The tools that used them now work on the replacement endpoints and keep their names:

- **Localizations** (`asc_*_iap_localization`, `asc_*_subscription_localization`, `asc_*_subscription_group_localization`): get, patch and delete use the `/v2` resources with the same localization ids (checked live: an id is identical in v1 and v2). Create and list act on the product's latest version, or on `versionId`. Writes land on the latest editable version; they refuse while a version is in review, and on an approved version unless you pass `createVersionIfNeeded: true`. Patch checks the version first and explains Apple's lock on approved copy, with a `force` escape. The v2 records have no `state`; review status lives on the version.
- **Images** (`asc_*_iap_image`, `asc_*_subscription_image`): reserve, list, commit and delete use the `/v2` image resources on the product's version. v2 images take no checksum.
- **Submissions** (`asc_post_iap_submission`, `asc_post_subscription_submission`, `asc_post_subscription_group_submission`): these now create a review submission, add the product's latest editable version as an item, and submit it. **Breaking:** they now require `appId`, because Apple has no link from an IAP or subscription back to its app. If the app already has a draft review submission they refuse rather than submit whatever else it holds; pass `reviewSubmissionId` to add the item to that draft instead.
- **`asc_post_review_submission_item`** takes `itemType` + `itemId` for all 17 item kinds in spec 4.6, including IAP, subscription and subscription group versions, Game Center versions, in-app events, custom product pages and Asset Library media. `appStoreVersionId` on its own still works.
