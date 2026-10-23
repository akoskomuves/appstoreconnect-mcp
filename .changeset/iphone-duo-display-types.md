---
'@akoskomuves/appstoreconnect-mcp': minor
---

Add iPhone Duo screenshot and preview display types.

`asc_post_app_screenshot_set` now accepts `APP_IPHONE_DUO` and `IMESSAGE_APP_IPHONE_DUO`, and `asc_post_app_preview_set` accepts `IPHONE_DUO`. Before this, a Duo set could only be created in the App Store Connect web UI. Uploading into an existing Duo set already worked, because `asc_upload_screenshot` takes a set ID.

Apple's published OpenAPI spec (4.5.1) and docs don't list these values yet. The live API does: a create with an unknown display type is rejected with a 409 whose `detail` lists every accepted value, and the Duo values are in that list. The API has one Duo type, with no separate value for the inner and outer displays.
