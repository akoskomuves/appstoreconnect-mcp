---
'@akoskomuves/appstoreconnect-mcp': minor
---

Add App Clips and Background Assets (52 new tools).

App Clips: list an app's clips; default experiences (create, copy from a template, link to a version from either side), their localizations, header image upload, and the App Review detail; advanced experiences with inline localizations, Maps place cards and their image upload; TestFlight invocations and their localized titles.

Background Assets: Apple-hosted asset packs per app, their versions, the release state on each track (internal beta, external beta, App Store), and file upload (asset archive or manifest) with a composite reserve → upload → commit tool. The commit uses `sourceFileChecksums.file`, because the singular `sourceFileChecksum` is deprecated on this resource.

Both image uploads and the asset-pack file upload reuse the existing chunked-upload helper.
