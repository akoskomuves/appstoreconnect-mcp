---
'@akoskomuves/appstoreconnect-mcp': minor
---

Fix: `asc_post_subscription_price` could not open a price schedule.

The tool marked `startDate` required and serialized it unconditionally, so there was no way to express a subscription's **first** price in a territory — and Apple rejects a dated first price. The tool worked for later changes and could not create the one that has to come first, which meant every subscription's opening price still had to be set in the App Store Connect web UI.

Reported with a repro that isolated the variable: 409 at 1, 8 and 29 days out, with `preserveCurrentPrice` both true and false. Apple confirms it in the error text once you read `details` rather than the message envelope:

> `409 ENTITY_ERROR.ATTRIBUTE.INVALID` → `/data/attributes/startDate`
> *"Invalid startDate. Create a starting price before creating future prices."*

`startDate` is now optional. Omit it for the opening price; pass it only once a price exists in that territory. When omitted the attributes block is dropped from the request entirely rather than sent empty.

**A second precondition surfaced while verifying the fix, and it is the more confusing one.** Territory availability must exist *before* any price. Without it, even a correctly shaped undated POST fails — and Apple blames the wrong field:

> `409 ENTITY_ERROR.RELATIONSHIP.INVALID` → `/data/relationships/subscriptionPricePoint/id`
> *"An error occurred while processing the pricing information."*

Nothing is wrong with the price point. Apple simply cannot price a territory the subscription is not sold in, and reports that by pointing at the ID. The tool now translates both 409s into the actual remedy instead of passing them through: the first says "re-run without startDate", the second says "add the territory with `asc_post_subscription_availability` first" (with the full-replace warning attached, since that endpoint takes the complete territory list and omitted territories go off sale).

The working order is **availability → undated baseline → dated changes**, and it is documented on the tool, in the builder, and in the README.

Other changes:

- **`preserveCurrentPrice` is no longer forced onto a baseline.** It means "grandfather the existing cohort at the price they subscribed under" — on an opening price there is no cohort and no previous price. It still defaults to `true` for dated changes, and an explicit value is always honoured.
- **The result note distinguishes a baseline from a scheduled change** instead of describing every write as the latter.
- **`ppp_apply_proposal` now shares the same builder**, so the two request shapes cannot drift. It always supplies a `startDate` by construction, so its behaviour is unchanged — a test pins its wire output byte-for-byte, since that path has driven real production price changes.
- Corrected a false claim in the tool description: it advertised that "this server defaults to ≥7 days for safety", which nothing enforced. Apple validates the 24h minimum; ≥7 days is now described as a recommendation rather than a guarantee the server does not make.

Verified live on 2026-09-16 against a throwaway subscription: undated + availability **succeeds**; undated without availability fails with the relationship error; dated without a baseline fails with the startDate error. `scripts/smoke-subscription-products.ts` runs that matrix behind `SMOKE_BURN_PRODUCT_ID`, and now prints `ascErrorText(err)` — an earlier round of this investigation printed `String(err)` and lost Apple's `detail` entirely, which is the whole reason the first hypothesis looked wrong.

Tests +7 (733 total). Both audit scripts clean against spec 4.4.1.
