---
"@akoskomuves/appstoreconnect-mcp": minor
---

Add retention messages and retention offers from App Store Connect API 4.6 (25 new tools).

When a subscriber starts to cancel an auto-renewable subscription, Apple can show them a retention message (a localized header and body, optionally with an image) and discounted retention offers for the same subscription. The new tools cover the whole surface: creating and deleting messages, their versions and localized text, the version's image placement, creating, editing and deleting offers and reading their prices, assigning a message to a subscription, and choosing which offers it presents. Every version has to pass App Review before customers see it: add it to a review submission with `asc_post_review_submission_item` (`itemType: "retentionMessageVersion"`).

Because all of this is customer-facing, the deletes check first and refuse when the message is assigned or has a version in review or approved, when a localization's version is in review or approved, or when an offer is still presented. Pass `force: true` to skip the check. Creates pre-flight Apple's 10-messages-per-app cap and refuse a duplicate message `referenceName` or offer `offerId`.

A read-only live check on 2026-11-13 ran every read endpoint against 14 apps and 32 subscriptions. All of them answered, and a subscription with no message returns `data: null`. The account had no retention messages or offers yet, so only empty reads were verified.
