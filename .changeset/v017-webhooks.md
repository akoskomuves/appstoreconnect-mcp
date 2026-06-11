---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.17 — Webhooks. Per-app event push from App Store Connect: register an HTTPS endpoint for a set of event types, audit per-attempt delivery history, retry failures, and verify the pipe with test pings. Closes the loop with v0.16: `BETA_FEEDBACK_CRASH_SUBMISSION_CREATED` / `BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED` events push what the feedback read tools pull.

**8 new tools in 1 sub-domain** — `src/domains/webhooks.ts`.

**CRUD (5 tools)**

- `asc_list_webhooks` — GET `/v1/apps/{id}/webhooks`. Name, enabled state, endpoint URL, subscribed event types per row. The secret never appears (write-only).
- `asc_get_webhook` — single webhook with app relationship.
- `asc_post_webhook` — POST `/v1/webhooks`. ALL FIVE attributes required: name, url (HTTPS), secret (HMAC-SHA256 signing key for the `X-Apple-Signature` header), eventTypes (≥1 of 12), enabled.
- `asc_patch_webhook` — mutate name / url / secret (rotation) / eventTypes (whole-array replace) / enabled (pause–resume). Refuses empty PATCH client-side.
- `asc_delete_webhook` — permanent; delivery history goes with it. Pause via `enabled=false` instead when in doubt.

**Deliveries + redelivery + ping (3 tools)**

- `asc_list_webhook_deliveries` — GET `/v1/webhooks/{id}/deliveries` with `filter[deliveryState]` (SUCCEEDED / FAILED / PENDING) and createdDate-window filters. Digest resolves each delivery's event type via `include=event` (the v0.16 live-smoke lesson applied at design time) and shows response HTTP status + error message per attempt.
- `asc_post_webhook_redelivery` — POST `/v1/webhookDeliveries`, relationships-only body whose `template` relationship is SELF-REFERENTIAL (type `webhookDeliveries`, pointing at the existing delivery to retry). New attempt arrives with `redelivery=true`.
- `asc_post_webhook_ping` — POST `/v1/webhookPings`, relationships-only. Response resource is id-only; the ping lands at the endpoint with `ping=true` and shows up in the deliveries list.

**Apple-contract gotchas pinned by tests:**

1. **is-prefix strips**, three new instances: `isEnabled`→`enabled` (Webhook create/patch — asserted on writes), `isRedelivery`→`redelivery` (WebhookDelivery, read-only), `isPing`→`ping` (WebhookEvent, read-only) — the read-only pair pinned via the sparse-fieldset constants.
2. **WebhookCreateRequest attributes are ALL REQUIRED** — no partial create; the body builder takes all five non-optionally.
3. **`secret` is WRITE-ONLY** — absent from the readable fields enum, never echoed by GET; rotatable via PATCH.
4. **Relationships-only creates** on redelivery + ping (no attributes block at all, same family as v0.16 BuildBetaNotification); redelivery's `template` is self-referential.
5. **Verbose date-filter keys**: `filter[createdDateGreaterThanOrEqualTo]` / `filter[createdDateLessThan]` — not a bare `filter[createdDate]` range.
6. **`include=event` on the deliveries list** baked in at design time (v0.16 lesson: relationship objects don't materialize without include).

**Live-smoke spec corrections caught on 2026-06-11** (full create → get → ping → deliveries → redeliver → patch → delete drill against WikiCatch via `scripts/smoke-webhooks.ts` — every tool path live-verified, drill cleans up after itself):

1. **The deliveries list REQUIRES `filter[createdDateGreaterThanOrEqualTo]`** — Apple 400s without it ("Filter is required and only one must be provided", a misleading message: `filter[deliveryState]` alone does NOT satisfy it). The value must be a full ISO 8601 date-time (bare dates rejected), at most 10 days in the past, not in the future. The tool now defaults the filter to the widest window Apple accepts (~10 days back) so a bare "list deliveries" call works.
2. **Ping events arrive with `eventType=null` + `ping=true`** — the digest renders them as `PING (ping)`.
3. Verified clean live: secret never echoed on GET, redelivery creates a new attempt with `redelivery=true` (PENDING → FAILED against the dummy endpoint), patch rename + `enabled=false` pause, delete, and the included-event digest resolution.

**Out of scope:** MarketplaceWebhook (EU DMA alternative distribution) stays in the v1.0+ bucket.

**Schemas (5 new):** `WebhookIdSchema`, `WebhookDeliveryIdSchema`, `WebhookEventTypeSchema` (12-value enum), `WebhookSecretSchema`, `WebhookDeliveryStateSchema`.

**Digests (2 new):** `digestWebhooks`, `digestWebhookDeliveries` (FAILED rows reference the redelivery tool in the legend).
