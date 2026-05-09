---
'appstoreconnect-mcp': minor
---

Add `ppp_load_index` and `ppp_compute_proposal` tools.

`ppp_compute_proposal` is the single entry point for a Purchasing Power Parity rebalance: it fetches the current price schedule for the target subscription, loads the bundled Apple Music Individual-plan price snapshot (`data/apple-music-prices.json`), computes a per-territory factor using Apple Music ratios as the implied PPP-FX rate, fetches valid price points in parallel for territories where the target differs from current, snaps to the nearest valid Apple price point (configurable `roundStrategy`: `nearest` / `down` / `up`), and returns a compact dry-run table with `POINT_ID`s ready to feed back into `asc_post_subscription_price`. Apply a configurable sanity floor (`floorFactor`, default 0.15) so bad index data can't crash the price.

`ppp_load_index` returns the bundled snapshot as a sorted table (or raw JSON) so users can see what reference data is in play.

The bundled snapshot covers ~70 territories with high-confidence Apple Music prices as of 2026-05-09; refresh upstream by editing `data/apple-music-prices.json` and resubmitting.

Updated `examples/ppp-rebalance/SKILL.md` to drive the new tool. The skill now does discover → propose → review → apply → verify → rollback, with the gotchas (preserveCurrentPrice, Russia, USD-only territories, snap direction) called out.
