---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.20 — App Store Version Experiments V2 (product-page A/B tests). The highest-leverage ASO item from the v1.0+ bucket, pulled forward: test alternate screenshots, previews, and app icons against the live product page with a controlled traffic split.

**12 new tools in 1 sub-domain** — `src/domains/version-experiments.ts`. V2 surface only (app-attached, rolls across versions); the deprecated version-attached v1 experiments are not exposed.

**Experiment lifecycle (5 tools)**

- `asc_list_version_experiments` — GET `/v1/apps/{id}/appStoreVersionExperimentsV2` (the URL-version QUIRK: a /v1 path listing V2 resources; CRUD lives at `/v2/appStoreVersionExperiments`). Digest shows the 9-state lifecycle, traffic %, review-required flag, start/end dates.
- `asc_get_version_experiment` — with treatments + latestControlVersion included.
- `asc_post_version_experiment` — ALL THREE attrs required (name, platform, trafficProportion 1–99). Created in PREPARE_FOR_SUBMISSION; publicly invisible until submitted AND started.
- `asc_patch_version_experiment` — name / trafficProportion / **started=true** (⚠️ customer-facing: begins serving treatments to real traffic; requires APPROVED; the description instructs explicit human approval first). Wire-key gotcha pinned: Swift `isStarted` → wire `started`.
- `asc_delete_version_experiment`.

**Treatments + localizations (7 tools)**

- Treatment CRUD-minus-get (`asc_list/post/patch/delete_experiment_treatment[s]`) — name + optional `appIconName` (alternate-icon testing; the icon must ship in the binary). Create emits the `appStoreVersionExperimentV2` relationship, never the deprecated v1 sibling (pinned by test).
- Treatment localization list/create/delete — per-locale containers for variant assets. **Variant screenshots/previews reuse the existing v0.13 asset tools** (`asc_post_app_screenshot_set` etc. already accept parentType `appStoreVersionExperimentTreatmentLocalizations`) — no new upload machinery.
- Submission rides the existing v0.11 V2 review-submission flow.

**Apple-contract gotchas pinned by tests:** the `isStarted`→`started` strip, all-required experiment create attrs, V2-only treatment relationship, /v1-list-vs-/v2-CRUD path split.

**Schemas (5 new):** `VersionExperimentIdSchema`, `ExperimentTreatmentIdSchema`, `TreatmentLocalizationIdSchema`, `TrafficProportionSchema`, `ExperimentStateSchema` (9-value enum).

**Digests (3 new):** `digestVersionExperiments`, `digestExperimentTreatments` (PROMOTED column = winner pushed live), `digestTreatmentLocalizations`.
