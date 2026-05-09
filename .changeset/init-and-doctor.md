---
'appstoreconnect-mcp': minor
---

Add `init` and `doctor` subcommands.

`appstoreconnect-mcp init` is an interactive wizard that opens App Store Connect, copies the `.p8` to `~/.appstore/` with `chmod 600`, prompts for issuer/key IDs (Key ID auto-detected from the filename), verifies auth with a real ASC call, and registers the MCP in any installed clients (Claude Code, Claude Desktop, Cursor, Windsurf — auto-detected).

`appstoreconnect-mcp doctor` is a read-only diagnostic — checks key directory permissions, parses each `.p8`, lists registered clients, and optionally hits the live API if env vars are set.

The default no-arg invocation continues to start the MCP server over stdio (unchanged behavior for clients).
