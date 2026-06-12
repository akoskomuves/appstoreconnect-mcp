---
"@akoskomuves/appstoreconnect-mcp": patch
---

Fix: `asc_list_app_infos` (and `asc_get_app_info`'s digest) 400ed on every call — Apple REMOVED the `kidsAgeBand` attribute from the AppInfo contract after v0.12 shipped, and the hard-coded sparse fieldset still requested it ("'kidsAgeBand' is not a valid field name"). The field is dropped from the fieldset, digest column, and schema/tool descriptions. Live-verified: the old fieldset reproduces the 400, the fixed one returns data. Reported from real usage during a release workflow on 2026-06-12.
