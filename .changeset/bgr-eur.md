---
'@akoskomuves/appstoreconnect-mcp': patch
---

Apple Music index: update BGR (Bulgaria) from BGN to EUR. Bulgaria adopted the euro and the App Store + Apple Music both bill in EUR there now. Previously BGR showed up as a `currency-mismatch` row in PPP proposals; with this fix it's part of the regular EUR cluster (factor 1.000 vs USA, target = anchor price).
