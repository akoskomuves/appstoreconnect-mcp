---
name: ppp-rebalance
description: Rebalance per-territory App Store subscription prices using a Purchasing Power Parity (PPP) index. Drives the `appstoreconnect-mcp` server through a dry-run → schedule → rollback flow with the standard gotchas baked in. Use when the user says "rebalance prices", "PPP pricing", "fix overpriced emerging-market prices", or asks to schedule subscription price changes per territory.
---

# PPP rebalance

You are helping the user rebalance their iOS app's subscription prices across App Store territories using a Purchasing Power Parity index. The `appstoreconnect-mcp` server is connected and provides the necessary tools.

## Workflow

Run these phases **in order**. Never skip the dry-run.

### 1. Discover the subscription

If the user hasn't named the app + subscription:

1. `asc_list_apps` — find the app (filter by bundle ID if known).
2. `asc_list_subscription_groups` for that app.
3. `asc_list_subscriptions` for the relevant group.
4. Confirm with the user which subscription is being repriced.

### 2. Read the current state

1. `asc_list_subscription_prices` for the chosen subscription. Show the current per-territory price schedule as a table.
2. `asc_list_territories` to map territory IDs to currencies.

### 3. Compute the proposal

For each territory:

- **PPP factor** = `apple_music_individual_price[territory] / apple_music_individual_price[USA]`, normalized to USD via the territory's FX rate.
- **target_price_usd** = `base_price_usd × ppp_factor`
- **target_price_local** = `target_price_usd × local_fx_rate`
- Snap `target_price_local` to the nearest valid Apple price point via `asc_list_subscription_price_points` for that (subscription, territory).
- Apply a sanity floor: `target_price_local ≥ 0.15 × current_price_local` to guard against bad index data.

If you don't have an Apple Music price table available, ask the user to provide one or fall back to a public source (Big Mac index, World Bank PPP) and flag the substitution.

### 4. Dry-run output

Print a table:

```
  Territory  Current        Proposed       Δ      PPP factor
  USA        $29.99 USD     $29.99 USD     —      1.00
  BRA        R$149  BRL     R$39.90 BRL    -73%   0.27
  ...
```

End with: total territories changed, average drop, and the start date you'll propose. **Stop and wait for the user to approve** before any writes.

### 5. Apply

After explicit user approval:

- Default `startDate` to today + 7 days (Apple requires ≥24h; 7 is safety buffer).
- For each territory in the proposal, call `asc_post_subscription_price` with `preserveCurrentPrice: true`.
- Skip writes for territories with no change.
- Report each result; on the first failure, **stop and ask** rather than continuing through the list.

### 6. Verify

After the apply, call `asc_list_subscription_prices` again and confirm the pending schedule matches the proposal. Tell the user where to view it in App Store Connect web UI.

## Gotchas

These are the things that have bitten people doing this before; cite them out loud when relevant:

- **Always pass `preserveCurrentPrice: true`** on `asc_post_subscription_price`. Otherwise existing subscribers re-price at next renewal — Apple sends them a notification and may even block the schedule.
- **Russia (`RUS`)**: App Store closed. Skip the territory entirely.
- **USD-only territories**: Some markets (Vietnam, Pakistan, Egypt at times) bill in USD only. The `pricePoints` list per territory is the source of truth — if the only currency offered is USD, treat the territory as fixed-price.
- **Snap direction**: Rounding to the nearest price point can land *above* your target. If PPP says ARS 1,150 and the available points are ARS 990 / ARS 1,290, you'll snap up to 1,290. Ask the user whether to prefer rounding down for emerging markets.
- **Start date min lead time**: Apple requires ≥24h. Default to 7 days.
- **`automaticPrices` flag**: If the subscription currently has automatic FX-based pricing enabled, posting per-territory prices switches it to manual. Surface this explicitly.
- **JWT expiry**: ES256 tokens last ≤20 min. The MCP refreshes them transparently; if you see a 401, just retry once.
- **Apple gives no batch endpoint**: each territory is one POST. ~15 territories = ~15 sequential calls.

## Rollback

If the proposal turns out wrong before activation:

1. `asc_list_subscription_prices` — find the pending entries (the `startDate` will be in the future).
2. For each unwanted entry, `asc_delete_subscription_price` with the price ID.
3. Confirm with `asc_list_subscription_prices` that the schedule is clean.

## Configuration the user should pin once

Ask once and remember in their project memory:

- **Base territory**: usually `USA`.
- **Base price**: e.g., `29.99 USD/year`.
- **PPP index source**: Apple Music (default), Big Mac, World Bank, or a custom JSON file.
- **Round strategy**: nearest (default), down (more conservative), up (more revenue-protective).
- **Run cadence**: ad-hoc / quarterly.

## When NOT to use this skill

- Cracking the price for a *new* subscription before launch — use `asc_post_subscription_price` directly without PPP factors; the initial schedule is a one-shot decision.
- Reshaping introductory offers, free trials, or promo codes — those are different ASC resources and not covered here.
- Currency-specific tax adjustments — Apple handles tax automatically per region.
