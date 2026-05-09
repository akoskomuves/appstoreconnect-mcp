---
'appstoreconnect-mcp': minor
---

Compact responses + auto-pagination across all read tools.

Each list/get tool now returns a clean text table by default (`asc_list_apps`, `asc_list_subscription_groups`, `asc_list_subscriptions`, `asc_list_subscription_prices`, `asc_list_subscription_price_points`, `asc_list_territories`, `asc_get_app`). Every tool accepts `raw: true` to get the original JSON:API payload, and paginated tools accept `maxItems` (default 500–1000).

Internal changes:

- New `paginate()` helper follows `links.next`, merges and dedupes `included` resources across pages.
- Sparse fieldsets (`fields[type]=…`) applied per tool to avoid pulling unused attributes.
- `&limit=200` set on all list endpoints (was missing on `subscriptionPrices`, capping responses at 50/175 territories).
- New `digest.ts` module with one digester per resource type, joining `data` ↔ `included` to surface the actually useful columns (territory + currency + amount instead of relationship URIs).

Net effect: a full 175-territory subscription price schedule fits in ~5 KB of text instead of ~90 KB of nested JSON.
