---
'@akoskomuves/appstoreconnect-mcp': minor
---

Xcode Cloud (CI/CD) + SCM surface — 18 new tools:

- **CI reads**: products, workflows (flag digest + full-config get), build runs (by workflow or product, with issue-count summaries), build actions, issues, test results, artifacts (pre-signed time-limited downloadUrl fetched without the ASC bearer), the TestFlight builds a run produced, and the Xcode/macOS environment catalogs.
- **SCM reads**: providers, repositories, git references (branches/tags — the reference id is what build-start takes, not a bare branch name), pull requests.
- **CI triggers**: start a build run (workflow + optional branch/tag + clean) and PATCH a workflow's simple attributes (isEnabled pause/resume, clean, name, description — the deep start-condition/actions structures stay Xcode-owned by design).

Wire-key note pinned in tests: Xcode Cloud is the one domain family with NO is-prefix strip — `isEnabled`, `isPullRequestBuild`, `isClosed` are literal wire keys.
