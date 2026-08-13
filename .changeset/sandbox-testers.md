---
'@akoskomuves/appstoreconnect-mcp': minor
---

Sandbox testers (3 tools, /v2 surface): list the team's StoreKit sandbox accounts, PATCH a tester's settings (territory, interruptPurchases, accelerated subscriptionRenewalRate — a month renewing every 3–60 minutes for renewal/billing-retry/grace testing), and clear purchase history (relationships-only POST; note Apple names the request resource in the SINGULAR — `sandboxTestersClearPurchaseHistoryRequest`). Pairs with the monetization surface: set a fast renewal clock, buy in sandbox, clear, repeat.
