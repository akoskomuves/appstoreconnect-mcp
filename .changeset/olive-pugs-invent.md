---
'@akoskomuves/appstoreconnect-mcp': minor
---

Token-cap fixes on the price/offer listers and the Xcode Cloud workflow read, plus a confirmed state gate on subscription localizations.

Four findings from a heavy live pricing + subscription session, ordered by what they cost the caller.

**`territoryId` on `asc_list_subscription_prices` and `asc_list_subscription_introductory_offers`.** Both return one row per territory, so an unfiltered call on a worldwide subscription is ~175 rows (~59k characters) — enough to blow a tool-result token cap on its own, repeatedly, when the caller only ever wanted one market. Both tools now take an optional `territoryId`; `asc_list_subscription_price_points` already did, so this is the same parameter applied one tool over. The narrowing is client-side (new `filterPagesByTerritory` in `jsonapi.ts`), matching the existing `nearAmount` precedent.

The load-bearing detail is the wildcard rule: an introductory offer created with no territory is Apple's "all territories" offer and is live in *every* market, so `territoryId` **keeps** wildcard rows on the offers lister. Dropping them would under-report what a customer in that territory actually sees. Price rows are always per-territory and have no such case.

**`asc_get_ci_workflow` gets a summary mode.** The raw document runs to ~90k characters and blew the cap twice in one session, because `include=xcodeVersion` makes Apple attach every test destination × runtime it knows about. The tool now returns a compact digest — enabled/locked/clean flags, start-condition branch patterns (prefix matches rendered `pattern*`), the `actions[]` table with type/platform/scheme/destination, and the **resolved** Xcode and macOS versions pairing the selection rule with the build it resolved to ("Latest Beta or Release (27A266a)"). Summary mode also sends sparse fieldsets that drop `testDestinations` at the API level rather than just hiding it. `raw:true` returns Apple's full document, matching how the rest of the server behaves.

**`asc_post_subscription_price` explains the `preserved` flag.** The tool says "always pass preserveCurrentPrice=true", Apple then returns `preserved: false` on the created row, and it keeps reading false in the price schedule for as long as it is the newest row. That looks exactly like the grandfathering silently failed, and cost one caller a delete-and-recreate through the raw API chasing it. It is correct behaviour: `preserved` means "this row's price is held for the cohort that subscribed under it", so it only flips true once a *newer* price supersedes it. The POST result and the price-schedule digest now both say so.

**The parent-state gate on `asc_patch_subscription_localization` is CONFIRMED, no longer "(likely)".** Observed live on three locales, identical each time:

```
409  ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE
     "Cannot edit SubscriptionLocalization when it is in ACTIVE state"
     source.pointer: /data/attributes/state
```

`ACTIVE` is in **neither** public enum — not `SubscriptionLocalizationState` (PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED) and not `Subscription.state` — and the list endpoint reported all three locales as `APPROVED` moments before the PATCH. So the resource's own reported state cannot serve as the gate; Apple checks something it does not expose.

The tool now pre-checks the localization state *and* the parent subscription state in one round-trip and refuses client-side with the recovery path (the App Store Connect **web UI** can still make this edit — the REST API cannot; adding a new locale still works). The gate is deliberately narrow: it refuses only on the combination actually observed — `APPROVED` copy under a locked parent — and passes everything else through, so copy still in `PREPARE_FOR_SUBMISSION` under a live subscription is never falsely blocked. Pre-check failure is non-fatal, and a post-flight enrichment covers what the pre-check cannot see. `asc_patch_iap_localization` keeps its "(likely)" note, now cross-referencing the confirmed sibling.

**Latent bug fixed in the neighbouring gate.** `asc_patch_app_store_version_localization`'s post-flight enrichment matched `err.message`, which is only the envelope (`App Store Connect API 409 on PATCH /v1/...`) — Apple's `detail` lives in `details`, so that branch could never fire. New `ascErrorText()` flattens both, and both gates now use it.

Spec claims in this change are pinned against Apple's official OpenAPI specification. Tests +46 (665 total) · typecheck clean · lint clean · build green.
