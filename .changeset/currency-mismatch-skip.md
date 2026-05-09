---
'appstoreconnect-mcp': patch
---

`ppp_compute_proposal` and `ppp_apply_proposal`: skip territories where the App Store Connect billing currency differs from the bundled Apple Music index currency. Marked as `currency-mismatch (asc=X, am=Y)` in the proposal table and excluded from the apply set.

This guards against a dimensional bug: the Apple Music price ratio is only a valid PPP-FX signal when both numerator (local Apple Music price) and the ASC billing currency match. For USD-billed Gulf markets (BHR, KWT, OMN) where Apple Music is sold in BHD/KWD/OMR, the formula would have produced artificially low prices (~$0.69 instead of ~$1.80 for a $4.99 anchor). Now those markets are explicitly skipped — set them manually via `asc_post_subscription_price` if needed.
