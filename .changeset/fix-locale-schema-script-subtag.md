---
"@akoskomuves/appstoreconnect-mcp": patch
---

Fix `LocaleSchema` regex to accept BCP-47 script subtags like `zh-Hans` and `zh-Hant`.

The previous regex `/^[a-z]{2,3}(-[A-Z]{2})?$/` only allowed a 2-letter region
suffix (e.g. `en-US`), which incorrectly rejected 4-letter script subtags
(`Hans`, `Hant`). This caused input validation errors for Traditional and
Simplified Chinese locales (`zh-Hant`, `zh-Hans`) even though the tool's own
error message listed them as valid examples.

The new regex `/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/` covers all three
forms Apple uses: language-only (`ja`), language + script (`zh-Hant`), and
language + region (`en-US`).
