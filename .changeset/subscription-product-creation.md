---
'@akoskomuves/appstoreconnect-mcp': minor
---

Create subscription groups and subscriptions — the first step of monetizing an app, which this server could not do until now.

Every subscription surface here — localizations, prices, availabilities, intro/promo/win-back offers, offer codes, submissions — operated on a `Subscription` that already existed. There was no way to make one. An agent asked to set up billing got exactly as far as "now open App Store Connect in a browser". Apple exposes both creates (`POST /v1/subscriptionGroups`, `POST /v1/subscriptions`, OpenAPI spec 4.4.1); the gap was ours.

**13 new tools.** Groups: `asc_get/post/patch/delete_subscription_group`. Products: `asc_get/post/patch/delete_subscription`. And the group's customer-facing heading, previously uncovered entirely: `asc_list/get/post/patch/delete_subscription_group_localization`.

**The naming trap, handled in every description.** Four `name`-ish attributes sit in this hierarchy and only two reach customers:

| Resource | Attribute | Who sees it |
|---|---|---|
| `SubscriptionGroup` | `referenceName` | internal |
| `SubscriptionGroupLocalization` | `name` | **customer** |
| `Subscription` | `name` | internal |
| `SubscriptionLocalization` | `name` | **customer** |

Getting it backwards ships a store listing that reads like a Jira ticket, so the tool descriptions state it at every opportunity rather than once in a doc.

**What the tools refuse to let you do:**

- **`productId` is permanent.** It is absent from Apple's `SubscriptionUpdateRequest`, and `buildSubscriptionPatchBody` has no codepath that can emit it — receipts and every live subscriber's entitlement key off that string. Apple also never releases a product identifier for reuse on an account, even after the subscription is deleted, so `asc_delete_subscription` says so in its success message.
- **Deletes are gated client-side, not left to a bare 409.** `asc_delete_subscription` pre-checks state and refuses for the three under-review states and the three shipped states — including `DEVELOPER_REMOVED_FROM_SALE` / `REMOVED_FROM_SALE`, because removing a product from sale does not undo the purchases that already happened. The refusal points at `asc_post_subscription_availability` as the actual way to stop selling something live. `asc_delete_subscription_group` lists the group's children first and names the specific products blocking the delete. Both gates pass through on an unknown state, both take `force: true`, and both say so in the refusal — the shipped-state half is inferred from Apple's documented states rather than observed, so a client-side guess must never be the last word on a delete Apple would accept. When the pre-check itself fails (a 5xx or a permissions 403 on the GET), the result says the DELETE went out unguarded instead of implying a guard ran.
- **Nested offer arrays are deliberately unsupported.** `SubscriptionUpdateRequest` also accepts inline relationship arrays — wire keys `introductoryOffers` / `promotionalOffers` / `prices`. `scripts/audit-required-attributes.py` now reports these as MISSING against the new PATCH call site, labelled by included-schema name (`SubscriptionUpdateRequest[subscriptionIntroductoryOffers]`) rather than relationship key; both spellings are written into the builder comment so the next spec bump can match either and does not re-litigate it. Their wire semantic is *replace*: a caller passing one offer would silently delete the others, bypassing the cap pre-flights and offer-code collision checks the dedicated tools already do.
- **`reviewNote` and `customAppName` can be cleared.** Apple marks both `nullable`, so passing `null` on the PATCH removes the value — clearing a `customAppName` override sends that locale back to inheriting the real App Store app name. Omitting the key still leaves the current value alone.

`customAppName` on the group localization is surfaced too — the per-locale override for how the *app* name reads inside the subscription sheet — with the wire gotcha handled that its parent relationship key is `subscriptionGroup`, while `Subscription` calls the same parent `group`.

No client-side length caps on any of the new free-text attributes: Apple's contract documents none, App Store Connect's web UI is stricter than the API, and a wrong guess refuses a write Apple would accept. The UI limits are in the descriptions instead.

Live-smoked against a real account on 2026-09-16: full create → get → patch → delete on a subscription group and its localization, everything cleaned up, `state` on a fresh group localization confirmed as `PREPARE_FOR_SUBMISSION`. `scripts/smoke-subscription-products.ts` runs that drill; the subscription create is opt-in behind `SMOKE_BURN_PRODUCT_ID` because it reserves a product identifier on the account permanently.

`scripts/audit-fieldsets.py` clean against spec 4.4.1. Tests +28 (726 total).
