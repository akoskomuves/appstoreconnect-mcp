---
'@akoskomuves/appstoreconnect-mcp': minor
---

Fix: `asc_post_subscription_price` could not open a price schedule.

The tool marked `startDate` required and serialized it unconditionally, so there was no way to express a subscription's **first** price — and Apple rejects a dated first price with a 409. The opening row of a schedule is the undated baseline; a dated row is a price *change*, which presupposes a price to change from. The tool worked fine for later changes and simply could not create the one that has to come first, which meant every subscription still had to get its initial price set in the App Store Connect web UI.

Reported with a clean repro that isolated the variable: 409 at 1, 8 and 29 days out, with `preserveCurrentPrice` both true and false, and again after territory availability existed. The date's presence is the problem, not its distance.

Apple's contract agrees (OpenAPI spec 4.4.1): `SubscriptionPriceCreateRequest.data.required` is `['relationships', 'type']`, `attributes` has no required list at all, and both `startDate` and `preserveCurrentPrice` are `nullable: true`.

- **`startDate` is now optional.** Omit it for the opening price; pass it only once a price exists in that territory. When omitted the attributes block is dropped from the request entirely rather than sent empty, which is the shape least likely to trip a validator.
- **`preserveCurrentPrice` is no longer forced onto a baseline.** It means "grandfather the existing cohort at the price they subscribed under" — on an opening price there is no cohort and no previous price. It still defaults to `true` for dated changes, where it is the safe choice, and an explicit value is always honoured.
- **The result note now distinguishes the two cases** instead of describing every write as a scheduled change.
- **`ppp_apply_proposal` now shares the same builder.** It always supplies a `startDate` by construction, so its behaviour is unchanged — a test pins its wire output byte-for-byte, since that path has driven real production price changes.

Also corrected a false claim in the tool description: it advertised that "this server defaults to ≥7 days for safety", which nothing enforced. Apple validates the 24h minimum; the ≥7 day habit is now described as a recommendation rather than a guarantee the server does not make.

Tests +7 (733 total). `scripts/audit-fieldsets.py` and `scripts/audit-required-attributes.py` both clean against spec 4.4.1.
