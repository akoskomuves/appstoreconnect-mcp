---
name: ppp-rebalance
description: Rebalance per-territory App Store subscription prices using a Purchasing Power Parity (PPP) index. Drives the `appstoreconnect-mcp` server through a dry-run → schedule → rollback flow with the standard gotchas baked in. Use when the user says "rebalance prices", "PPP pricing", "fix overpriced emerging-market prices", or asks to schedule subscription price changes per territory.
---

# PPP rebalance

You are helping the user rebalance their iOS app's subscription prices across App Store territories using a Purchasing Power Parity index. The `appstoreconnect-mcp` server is connected and provides the necessary tools.

The MCP does the math for you — `ppp_compute_proposal` is the single tool that produces the dry-run table. Your job is to drive the conversation, validate the proposal with the user, and apply it via the write tools.

## Workflow

Run these phases **in order**. Never skip the dry-run.

### 1. Discover the subscription

If the user hasn't named the app + subscription:

1. `asc_list_apps` — find the app (filter by bundle ID if known).
2. `asc_list_subscription_groups` for that app.
3. `asc_list_subscriptions` for the relevant group.
4. Confirm with the user which subscription is being repriced and the **anchor base price** (e.g. `$29.99 USD`).

### 2. Compute the proposal (dry-run)

```
ppp_compute_proposal(
  subscriptionId: "...",
  basePriceAnchor: 29.99,
  anchorTerritory: "USA",
  roundStrategy: "nearest"   // or "down" / "up"
)
```

The tool:

- Fetches the current price schedule for every territory.
- Loads the bundled Apple Music index (`ppp_load_index` shows the snapshot).
- Computes a PPP factor per territory using Apple Music ratios as implied PPP-FX.
- Fetches the valid price points for every territory whose target differs from current, in parallel.
- Snaps each target to the nearest valid Apple price point.
- Applies a 15% floor (`floorFactor`) so a bad index entry can't crash the price.
- Returns a compact table with current, target, snapped, Δ%, factor, and a NOTE column for skipped/no-data rows.

Show the table to the user. **Stop and wait for explicit approval before any writes.**

### 3. Iterate the proposal if needed

If the user wants to tweak:

- **Different round strategy**: re-run with `roundStrategy: "down"` (more conservative for emerging markets) or `"up"` (more revenue-protective).
- **Subset of territories**: pass `territories: ["BRA", "MEX", "ARG", "TUR", "IND", "IDN"]` to scope the proposal.
- **Different base price**: change `basePriceAnchor`.
- **Show all rows** including unchanged: pass `skipUnchanged: false`.
- **Surface no-index rows**: pass `skipMissingIndex: false` so the user can see which territories Apple Music data is missing for.

### 4. Apply

Once the user approves:

- Default `startDate` to **today + 7 days** (Apple requires ≥24h; 7 is a safety buffer).
- For each row in the proposal with a `POINT_ID`, call:

  ```
  asc_post_subscription_price(
    subscriptionId: "...",
    territoryId: "<3-letter code>",
    pricePointId: "<POINT_ID from proposal>",
    startDate: "<YYYY-MM-DD>",
    preserveCurrentPrice: true
  )
  ```

- **Always** pass `preserveCurrentPrice: true` unless the user explicitly says otherwise. This grandfathers existing subscribers — Apple may otherwise reject the schedule or send mass-renewal notifications.
- Skip writes for rows with a `NOTE` (no-index, no-current-price, no-price-points, snap-failed, unchanged).
- Report each result. **On the first failure, stop and ask** — don't continue through the list and end up with a half-applied schedule.

### 5. Verify

After the apply, re-run `asc_list_subscription_prices` and confirm the pending schedule matches the proposal. The new entries will have a non-null `START_DATE`.

### 6. Rollback (if needed)

If the proposal turns out wrong before activation:

1. `asc_list_subscription_prices` — find the pending entries (future `startDate`).
2. For each unwanted entry, `asc_delete_subscription_price` with the `PRICE_ID`.
3. Re-run `asc_list_subscription_prices` to confirm the schedule is clean.

## Gotchas

These have bitten people doing this before; cite them when relevant:

- **Always `preserveCurrentPrice: true`** on writes. Otherwise existing subscribers re-price at next renewal — notifications + possible Apple rejection.
- **Russia (`RUS`)**: App Store closed. The proposal will likely include it; skip the apply step for `RUS`.
- **USD-only territories** (e.g. some MENA + Pacific markets): the bundled index shows them with `currency: "USD"`. The proposal will compute correctly but you can't change currency on a USD-billed territory.
- **Snap direction surprises**: nearest can land *above* target. If the user wants emerging-market prices to drop, recommend `roundStrategy: "down"`.
- **Start date min lead time**: Apple requires ≥24h. The skill defaults to 7 days.
- **Apple gives no batch endpoint**: each territory is one POST. ~14 emerging markets = ~14 sequential calls.
- **Apple Music index is a snapshot** — the bundled `data/apple-music-prices.json` is refreshed manually upstream. Show the snapshot date when presenting the proposal so the user can decide whether to refresh it first.

## When NOT to use this skill

- Cracking the price for a *new* subscription before launch — call `asc_post_subscription_price` directly without PPP factors; the initial schedule is a one-shot decision.
- Reshaping introductory offers, free trials, or promo codes — those are different ASC resources and not covered here.
- Currency-specific tax adjustments — Apple handles tax automatically per region.
