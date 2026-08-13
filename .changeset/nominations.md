---
'@akoskomuves/appstoreconnect-mcp': minor
---

Featuring nominations (5 tools) — pitch releases to Apple's editorial team for App Store featuring (WWDC24 surface): list (app/state/type filters), get, create, update, delete. Creates default to `submitted:false` (a reviewable DRAFT); `asc_patch_nomination submitted:true` is the one-way send — no un-submit, only archive.

Live-smoke spec corrections caught 2026-08-13 (full draft create→patch→delete cycle drilled):

- `filter[state]` is REQUIRED on the list endpoint (spec says optional) AND single-valued — the tool fans out one request per state and merges when no state filter is given.
- `publishStartDate`/`publishEndDate` must be full ISO 8601 date-TIMES — a bare `YYYY-MM-DD` 409s.
- Every PATCH must re-state `submitted` (or pass `archived`) — an attributes-only edit 400s; the tool refuses client-side with the rule spelled out.
- A 500 UNEXPECTED_ERROR on create does NOT mean the write failed — one such create persisted server-side; list drafts before retrying.
- Wire key is `launchInSelectMarketsFirst` ("Markets", not the UI's "storefronts" wording).
