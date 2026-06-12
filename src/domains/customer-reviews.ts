import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestCustomerReviewSummarizations, digestCustomerReviews } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AppStoreVersionIdSchema,
  CustomerReviewIdSchema,
  CustomerReviewResponseIdSchema,
  ReviewRatingFilterSchema,
  ReviewSortSchema,
  SummarizationPlatformSchema,
  TerritoryIdSchema,
} from '../schemas.js';

// Customer reviews are CUSTOMER-created — read-only resources except for
// the developer's single public response per review.
//
// Surface map:
//   - Lists: GET /v1/apps/{id}/customerReviews and
//     GET /v1/appStoreVersions/{id}/customerReviews (same filter set —
//     the roadmap's "filter by version" is the version-scoped list).
//   - GET /v1/customerReviews/{id} + the to-one
//     GET /v1/customerReviews/{id}/response.
//   - Respond: POST /v1/customerReviewResponses (responseBody REQUIRED +
//     review relationship). ⚠️ PUBLIC-FACING: the response publishes on the
//     App Store product page under the review. Posting against a review
//     that already has a response REPLACES it (one response per review).
//     State PUBLISHED / PENDING_PUBLISH (Apple takes a moment to publish).
//   - DELETE /v1/customerReviewResponses/{id} — removes the public reply.
//
// Wire-key gotchas (verified against AvdLee Swift SDK):
//   - Swift `isExistsPublishedResponse` → wire `exists[publishedResponse]`
//     (an exists-param variant of the is-prefix strip — boolean filter on
//     whether the review already has a published developer response).
//   - `filter[rating]` values are STRINGS ("1".."5"), not numbers.
//   - Sort enum: createdDate / -createdDate / rating / -rating.
//   - Summarizations: `filter[platform]` is REQUIRED (the Swift GetParameters
//     has it non-optional); territory is optional. Resource carries Apple's
//     AI-aggregated summary text per (platform, territory, locale).
//
// There is no sentiment filter on Apple's side — rating (1–2★ vs 4–5★) is
// the working proxy.

const CUSTOMER_REVIEW_FIELDS = 'rating,title,body,reviewerNickname,createdDate,territory,response';
const REVIEW_RESPONSE_FIELDS = 'responseBody,lastModifiedDate,state,review';
const SUMMARIZATION_FIELDS = 'createdDate,locale,platform,text,territory';

interface JSONAPIBody {
  data: {
    type: string;
    attributes: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
}

export function buildReviewResponseCreateBody(input: {
  reviewId: string;
  responseBody: string;
}): JSONAPIBody {
  // responseBody is REQUIRED (non-optional in the Swift contract); the only
  // relationship is the review.
  return {
    data: {
      type: 'customerReviewResponses',
      attributes: { responseBody: input.responseBody },
      relationships: {
        review: { data: { type: 'customerReviews', id: input.reviewId } },
      },
    },
  };
}

export interface ReviewListFilters {
  territories?: string[] | undefined;
  ratings?: string[] | undefined;
  hasPublishedResponse?: boolean | undefined;
  sort?: string | undefined;
}

export function buildReviewListQuery(filters: ReviewListFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set('fields[customerReviews]', CUSTOMER_REVIEW_FIELDS);
  params.set('fields[customerReviewResponses]', REVIEW_RESPONSE_FIELDS);
  // include=response so the digest can show whether/what the developer
  // replied (v0.16 lesson: relationship objects don't materialize without
  // include).
  params.set('include', 'response');
  if (filters.territories?.length) params.set('filter[territory]', filters.territories.join(','));
  // Wire contract takes rating values as STRINGS.
  if (filters.ratings?.length) params.set('filter[rating]', filters.ratings.join(','));
  if (filters.hasPublishedResponse !== undefined) {
    // Swift `isExistsPublishedResponse` → wire `exists[publishedResponse]`.
    params.set('exists[publishedResponse]', String(filters.hasPublishedResponse));
  }
  params.set('sort', filters.sort ?? '-createdDate');
  params.set('limit', '200');
  return params;
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerCustomerReviews(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_customer_reviews',
    {
      title: 'List customer reviews',
      description:
        'List published App Store reviews via GET /v1/apps/{id}/customerReviews (or scope to one version via appStoreVersionId — pass exactly one of the two). Filter by star rating (strings "1".."5"), territory, and whether a developer response already exists (hasPublishedResponse=false → the unanswered queue). Sort by createdDate or rating. Each row shows rating, title, reviewer, territory, response state, and IDs. No sentiment filter exists on Apple\'s side — use rating as the proxy ("1-star reviews mentioning the export bug" → filter ratings:["1"], then read bodies).',
      inputSchema: {
        appId: AppIdSchema.optional().describe(
          'App-wide review list. Pass exactly one of appId / appStoreVersionId.',
        ),
        appStoreVersionId: AppStoreVersionIdSchema.optional().describe(
          'Scope to reviews left on one specific version.',
        ),
        ratings: ReviewRatingFilterSchema.optional(),
        territories: z
          .array(TerritoryIdSchema)
          .optional()
          .describe('3-letter territory codes, e.g. ["USA","GBR"].'),
        hasPublishedResponse: z
          .boolean()
          .optional()
          .describe(
            'true: only reviews that already have a published developer response. false: the unanswered queue. Wire key exists[publishedResponse].',
          ),
        sort: ReviewSortSchema.default('-createdDate'),
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      },
    },
    async (input) => {
      if ((input.appId === undefined) === (input.appStoreVersionId === undefined)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Pass exactly one of appId (app-wide) or appStoreVersionId (version-scoped).',
            },
          ],
          isError: true,
        };
      }
      const params = buildReviewListQuery({
        ...(input.territories?.length ? { territories: input.territories } : {}),
        ...(input.ratings?.length ? { ratings: input.ratings } : {}),
        ...(input.hasPublishedResponse !== undefined
          ? { hasPublishedResponse: input.hasPublishedResponse }
          : {}),
        sort: input.sort,
      });
      const path = input.appId
        ? `/v1/apps/${encodeURIComponent(input.appId)}/customerReviews?${params.toString()}`
        : `/v1/appStoreVersions/${encodeURIComponent(input.appStoreVersionId ?? '')}/customerReviews?${params.toString()}`;
      try {
        const pages = await paginate(client, path, input.maxItems);
        const text = input.raw ? JSON.stringify(pages, null, 2) : digestCustomerReviews(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_customer_review',
    {
      title: 'Get a customer review',
      description:
        'GET /v1/customerReviews/{id} with the developer response included — the full review body (the list digest previews it) plus response state if one exists.',
      inputSchema: {
        reviewId: CustomerReviewIdSchema,
      },
    },
    async ({ reviewId }) => {
      const path = `/v1/customerReviews/${encodeURIComponent(reviewId)}?include=response`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_customer_review_response',
    {
      title: 'Get the developer response to a review',
      description:
        "GET /v1/customerReviews/{id}/response — the review's single developer response (responseBody, state PUBLISHED / PENDING_PUBLISH, lastModifiedDate). A review with no response returns 200 with data:null (observed live, NOT an error) — the tool reports that plainly.",
      inputSchema: {
        reviewId: CustomerReviewIdSchema,
      },
    },
    async ({ reviewId }) => {
      const path = `/v1/customerReviews/${encodeURIComponent(reviewId)}/response`;
      try {
        const data = await client.request<{ data?: unknown }>(path, { method: 'GET' });
        // LIVE-SMOKE FINDING (2026-06-12): no-response reviews return 200
        // with data:null — not a 404.
        if (data && 'data' in data && data.data === null) {
          return {
            content: [
              {
                type: 'text',
                text: `Review ${reviewId} has no developer response yet. Draft one and (after human approval) post it with asc_post_customer_review_response.`,
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_customer_review_response',
    {
      title: 'Respond to a customer review (PUBLIC)',
      description:
        '⚠️ PUBLIC-FACING WRITE: POST /v1/customerReviewResponses publishes your reply ON THE APP STORE under the review (state PENDING_PUBLISH → PUBLISHED, usually within a day; the reviewer is notified by Apple). One response per review — posting against an already-answered review REPLACES the previous response. Draft the text, show it to the human, and only call this after explicit approval.',
      inputSchema: {
        reviewId: CustomerReviewIdSchema,
        responseBody: z
          .string()
          .min(1)
          .max(5970)
          .describe(
            "The public reply text. Apple's UI caps responses around 5,970 characters; plain text only (no markdown/links rendering).",
          ),
      },
    },
    async ({ reviewId, responseBody }) => {
      const body = buildReviewResponseCreateBody({ reviewId, responseBody });
      try {
        const data = await client.request<unknown>('/v1/customerReviewResponses', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Response submitted for review ${reviewId} (publishes after Apple processing).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_customer_review_response',
    {
      title: 'Delete a developer response',
      description:
        'DELETE /v1/customerReviewResponses/{id} — remove your public reply from the App Store. The review itself is untouched (customer reviews cannot be deleted by developers). Get the response ID from asc_get_customer_review_response or the list digest.',
      inputSchema: {
        responseId: CustomerReviewResponseIdSchema,
      },
    },
    async ({ responseId }) => {
      try {
        await client.request<unknown>(
          `/v1/customerReviewResponses/${encodeURIComponent(responseId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [{ type: 'text', text: `Deleted review response ${responseId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_customer_review_summarizations',
    {
      title: 'List customer review summarizations',
      description:
        "GET /v1/apps/{id}/customerReviewSummarizations — Apple's AI-aggregated review summary per (platform, territory, locale): the same summary text shown on the App Store product page. filter[platform] is REQUIRED by Apple; territory optional. Summarizations exist only where Apple has rolled the feature out and the app has enough reviews — an empty list is common.",
      inputSchema: {
        appId: AppIdSchema,
        platform: SummarizationPlatformSchema,
        territories: z
          .array(TerritoryIdSchema)
          .optional()
          .describe('Optional 3-letter territory codes filter.'),
        maxItems: z.number().int().positive().max(500).default(200),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, platform, territories, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[customerReviewSummarizations]', SUMMARIZATION_FIELDS);
      params.set('filter[platform]', platform);
      if (territories?.length) params.set('filter[territory]', territories.join(','));
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/customerReviewSummarizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestCustomerReviewSummarizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
