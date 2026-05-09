---
'appstoreconnect-mcp': patch
---

`init`: scan `~/.appstore`, `~/Downloads`, and `~/Desktop` for `.p8` files and present them as a select list (sorted most-recent-first, with auto-detected Key IDs). Falls back to manual path entry. Avoids the chore of typing a 60-character path.
