---
'@akoskomuves/appstoreconnect-mcp': patch
---

Fix two endpoint bugs that made real workflows fall back to manual work. Both reproduced against the live API and re-verified after the fix.

**`asc_post_app_availability_v2` POSTed to the wrong API version.** It used `/v1/appAvailabilities`, which Apple 404s — `PATH_ERROR`, "The resource 'v1/appAvailabilities' does not exist". AppAvailabilityV2 is served only on `/v2`, which the sibling read path already used correctly; the create path had drifted. Every attempt to set territory availability failed, forcing territories to be set by hand.

Both paths now derive from one exported `APP_AVAILABILITIES_V2_ENDPOINT` constant so they cannot diverge again. Confirmed live: `/v1` → 404 `PATH_ERROR`, `/v2` → reaches body validation.

**`asc_list_builds` sent `filter[processingState]` on a path that rejects it.** Scoping to an app used Apple's relationship path `/v1/apps/{id}/builds`, which refuses all filters with 400 `PARAMETER_ERROR.ILLEGAL` — "The parameter 'filter[processingState]' can not be used with this request". So `asc_list_builds` with both `appId` and `processingState` — the natural "show me this app's testable builds" call — always failed.

Requests needing a filter now route through the team-wide collection `/v1/builds` with `filter[app]` for scoping, which accepts filters *and* `sort`. The plain per-app listing keeps the relationship path. Endpoint selection moved into an exported, unit-tested `buildBuildsListQuery()` so a filter can never be appended to the relationship path again.

Also in this release, from verifying the above against real IDs:

- **`TerritoryAvailabilityIdSchema` now pre-flights the bare-code mistake.** Passing `"USA"` where the Apple-opaque composite belongs previously went to Apple and came back as an unexplained rejection. It is now refused up front with a message naming the tool to call instead. A real ID is base64 of a JSON object (~38 chars), so a 3-letter code can never be a false positive.
- **Corrected the documented ID shape.** It is `base64({"s":"<appId>","t":"<CODE>"})` with padding **stripped** — the previous example showed a trailing `=` that real IDs don't carry. A test comment also still claimed these IDs *were* the 3-letter codes, a stale error the v0.15 smoke had already disproved.
