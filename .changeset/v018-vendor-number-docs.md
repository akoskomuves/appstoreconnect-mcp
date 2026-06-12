---
"@akoskomuves/appstoreconnect-mcp": patch
---

Document the `ASC_VENDOR_NUMBER` env var (introduced in v0.18 as the vendor-number fallback for `asc_get_sales_report` / `asc_get_finance_report`): README gets an "Optional: vendor number" config section (where to find it in App Store Connect, role requirements for the report endpoints), and `appstoreconnect-mcp --help` lists it alongside the other optional env vars.
