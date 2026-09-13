---
'@akoskomuves/appstoreconnect-mcp': minor
---

Opt-in anonymous error reports, off by default.

So a bug like *"Apple started rejecting every `asc_patch_subscription_localization` with a 409"* surfaces as a signal instead of waiting for someone to notice and file an issue. That is a real example — it was found by hand; this is the automated version.

**Off unless you turn it on.** `appstoreconnect-mcp init` asks once and defaults to no. There is no enabled-by-default step and no opt-out-later. `appstoreconnect-mcp telemetry [status|on|off]` changes it; `doctor` reports it. `DO_NOT_TRACK=1` is honoured and beats an explicit opt-in, `ASC_MCP_TELEMETRY=0` hard-disables, and `ASC_MCP_TELEMETRY_HOST` / `_KEY` point a fork at its own collector.

**What goes out:** tool name, HTTP status, Apple's error `code` and generic `title`, the JSON pointer (`/data/attributes/state`), package/Node version, OS + arch, and a random install UUID. Plus one liveness ping per day, so an active install counts once whether it makes one call or a thousand.

**What never does:** Apple's error `detail` text, request URLs or paths, app IDs, bundle IDs, app names, prices, subscription names, any request or response body, the issuer ID, the key ID, any credential. This server holds App Store Connect credentials and Apple's error bodies carry the caller's commercially sensitive data, so the scrubber is an **allow-list** — a field Apple adds tomorrow is absent by construction rather than by review — and `tests/telemetry-scrubbing.test.ts` asserts on what is absent as hard as on what is present.

Two things this shook out that only showed up against the live collector:

- **Geolocation is disabled explicitly.** The collector derives city, postal code and lat/long from the request IP on its own, regardless of what the client sends. A verification event came back tagged with a postal code, which would have made "anonymous" a false claim in both the consent prompt and this changelog. `$geoip_disable` + a null `$ip` suppress it, confirmed by querying a post-fix event back.
- **The endpoint answers `200 {"status":"Ok"}` from either region**, then silently drops the event if the project lives in the other one. The default host is pinned to the verified region with a comment saying why, so nobody "fixes" it back.

Transport is fire-and-forget behind a 3s timeout: never blocks a tool call, never throws, and never writes to stdout — that stream is the MCP protocol channel. Tool attribution uses `AsyncLocalStorage` rather than a module-level variable, because MCP handlers run concurrently and a plain variable would misattribute one tool's failure to whichever call started last.

Tests +27 (698 total).
