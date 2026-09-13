---
'@akoskomuves/appstoreconnect-mcp': patch
---

Keep `server.json` in lockstep with `package.json` on release.

`server.json` is the manifest the official MCP Registry reads, and nothing in the release pipeline was updating it — it had sat at `1.0.1` since May while npm shipped through `1.9.0`, so every registry-driven discovery pointed at a four-month-old build.

`scripts/sync-server-json.mjs` now runs as part of the `version` script (the one `changesets/action` invokes to perform the bump), so the manifest version lands inside the release PR's own commit and can't drift again.
