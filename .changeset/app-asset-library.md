---
"@akoskomuves/appstoreconnect-mcp": minor
---

Add the App Asset Library (App Store Connect API 4.5.1), which replaces screenshot sets, preview sets and in-app event screenshots / video clips. 21 new tools: reference data (device groups, per-group limits, image and video specs), library image and video reads, composite and raw uploads, archive / rename / delete, placements on version, Custom Product Page, experiment-treatment and in-app event localizations, and placement reordering. The old set-based screenshot, preview, event-screenshot and event-video tools are marked deprecated in their descriptions and point to the new ones.

Live-checked on 2026-10-23: the library id equals the app id; `appAssetLibraryRefData` rejects `limit`, so the tool never sends it; live placements report `ACTIVE` / `INACTIVE` states that the spec does not list, so the placement state filter takes free strings.
