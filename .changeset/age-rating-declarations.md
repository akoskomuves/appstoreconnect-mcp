---
'@akoskomuves/appstoreconnect-mcp': minor
---

Add **age rating declarations** — two tools closing a submission gap. The age-rating questionnaire gates App Review, and while ppp could already *read* the computed `appStoreAgeRating` via AppInfo, there was no way to answer the questionnaire that produces it.

- `asc_get_age_rating_declaration` — read the answers. A declaration carries 29 attributes and on a typical app nearly all sit at `NONE`/`false`, so the digest leads with the non-default answers and then always shows the overrides and Kids band (an unset override is a real answer, so absence stays visible).
- `asc_patch_age_rating_declaration` — answer the questionnaire: 13 content-frequency questions, 11 booleans, the two rating overrides, the Korea override, the Kids age band, and the reviewer info URL.

Contract details verified against the live API rather than inferred, because two of them are easy to get wrong:

- **It hangs off AppInfo, not the version.** `/v1/appInfos/{id}/ageRatingDeclaration` returns 200; `/v1/appStoreVersions/{id}/ageRatingDeclaration` returns 404. Age rating is per-app metadata like categories, not per-release.
- **The declaration ID equals the AppInfo ID** — another entry in the "Apple resource IDs are not always opaque" family. So passing `appId` resolves the target for you. If an app has several AppInfos (Apple keeps separate ones across notarization tracks), the tool reports the candidates rather than guessing and silently rating the wrong track.
- **Writes go to the flat resource** `PATCH /v1/ageRatingDeclarations/{id}`, with the ID repeated in the body.
- **Apple merges on PATCH** — omitted keys keep their value. The body builder emits only what the caller supplied, so an `undefined` can never land on the wire as an accidental clear. The flip side, documented in the tool: you cannot clear an answer by omitting it, you must send the explicit `NONE`/`false`.
- **`ageRatingOverride` (v1) is deprecated and not interchangeable with `ageRatingOverrideV2`** — v1's vocabulary has `SEVENTEEN_PLUS` where v2 has `EIGHTEEN_PLUS`. Only v2 is accepted for writes; reads flag a lingering v1 value if one is set.
- **`kidsAgeBand` lives here**, not on AppInfo. Its removal from AppInfo is a separate, earlier change — a stale note in `schemas.ts` implied it had been dropped from Apple's contract entirely, now corrected.

Also: **`asc_get_app_availability_v2` and `asc_list_territory_availabilities` now explain a 404 instead of surfacing it bare.** Apple creates the availability record at an app's *first submission*, not at creation, so a brand-new app 404s with nothing wrong — which reads convincingly as "no territories are selected" and sends you to configure them by hand. Measured across 11 real apps: every app that had ever left `PREPARE_FOR_SUBMISSION` returned 200 (including one never released), every app still in it returned 404. The tools now say this, and note that a 404 on an already-submitted app *is* worth investigating.

Read paths live-smoked. The PATCH is covered by unit tests pinning the wire shape and the enum vocabularies; it was not drilled against a live app, since age rating is customer-facing on a shipped product.
