---
"@akoskomuves/appstoreconnect-mcp": minor
---

v0.19 — Customer reviews + review summarizations. The last planned roadmap row before v1.0+: read what customers say, reply publicly (with guardrails), and pull Apple's AI-aggregated review summary.

**6 new tools in 1 sub-domain** — `src/domains/customer-reviews.ts`.

- `asc_list_customer_reviews` — app-wide (`/v1/apps/{id}/customerReviews`) or version-scoped (`/v1/appStoreVersions/{id}/customerReviews`); pass exactly one of appId / appStoreVersionId. Filters: rating (STRINGS "1".."5" per the wire contract), territory, and `hasPublishedResponse` (wire `exists[publishedResponse]`) — `false` is the unanswered queue. Sorts: ±createdDate, ±rating. Digest shows star bars, title/body previews, and the developer-response state via `include=response`.
- `asc_get_customer_review` — full review body + response included.
- `asc_get_customer_review_response` — the review's single developer reply (state PUBLISHED / PENDING_PUBLISH).
- `asc_post_customer_review_response` — ⚠️ **PUBLIC-FACING WRITE**: publishes the reply on the App Store under the review; one response per review (re-posting REPLACES). The tool description instructs models to draft → show the human → post only on explicit approval. responseBody capped at 5,970 chars per Apple's UI limit.
- `asc_delete_customer_review_response` — removes the public reply; the review itself is untouched.
- `asc_list_customer_review_summarizations` — Apple's AI-aggregated summary per (platform, territory, locale), the same text shown on the product page. `filter[platform]` REQUIRED by Apple; empty lists are common (feature rollout + review-volume gated).

**Apple-contract gotchas pinned by tests:**

1. **Exists-param strip variant**: Swift `isExistsPublishedResponse` → wire `exists[publishedResponse]` — a new member of the is-prefix strip family, on a query param rather than an attribute.
2. **`filter[rating]` values are strings**, not numbers.
3. **CustomerReviewResponseV1CreateRequest**: responseBody attribute REQUIRED + review relationship.
4. **`include=response`** baked into the list (v0.16 lesson — relationship objects don't materialize without include).
5. No sentiment filter exists on Apple's side — rating is the documented proxy.

**Schemas (5 new):** `CustomerReviewIdSchema`, `CustomerReviewResponseIdSchema`, `ReviewRatingFilterSchema`, `ReviewSortSchema`, `SummarizationPlatformSchema`.

**Digests (2 new):** `digestCustomerReviews` (star bars + response state), `digestCustomerReviewSummarizations` (full summary text blocks).
