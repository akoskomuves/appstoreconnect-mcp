---
'appstoreconnect-mcp': patch
---

Compact PPP proposal output so the diff table fits in a normal terminal.

Apple's `subscriptionPricePoint` IDs are ~50-char base64 strings that blew the proposal table past 80 columns and forced wrap. `ppp_compute_proposal` now shows `POINT_ID` as the last 8 characters of the ID (e.g. `…NjEifQ`) by default; pass `raw: true` to see full IDs. `ppp_apply_proposal`'s elicitation confirmation message drops the `POINT_ID` column entirely — the user is reviewing prices, not relationship IDs, and the server uses the IDs internally regardless.
