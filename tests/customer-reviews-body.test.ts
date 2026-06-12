import { describe, expect, it } from 'vitest';
import {
  buildReviewListQuery,
  buildReviewResponseCreateBody,
} from '../src/domains/customer-reviews.js';

// Pin the wire shapes for v0.19 customer reviews.
//
// Quirks driving these assertions:
//   1. EXISTS-PARAM STRIP: Swift `isExistsPublishedResponse` → wire
//      `exists[publishedResponse]` (boolean filter, new variant of the
//      is-prefix strip family).
//   2. `filter[rating]` values are STRINGS ("1".."5"), not numbers.
//   3. CustomerReviewResponseV1CreateRequest: responseBody attribute
//      REQUIRED + review relationship — the public-reply create shape.
//   4. include=response is always sent so the digest can render the
//      developer-reply state (v0.16 lesson).

describe('buildReviewListQuery', () => {
  it('always includes response and defaults to newest-first', () => {
    const params = buildReviewListQuery({});
    expect(params.get('include')).toBe('response');
    expect(params.get('sort')).toBe('-createdDate');
    expect(params.get('fields[customerReviews]')).toContain('reviewerNickname');
    expect(params.get('fields[customerReviewResponses]')).toContain('state');
  });

  it('emits the exists[publishedResponse] wire key (NOT a flat isExists key)', () => {
    const yes = buildReviewListQuery({ hasPublishedResponse: true });
    const no = buildReviewListQuery({ hasPublishedResponse: false });
    expect(yes.get('exists[publishedResponse]')).toBe('true');
    expect(no.get('exists[publishedResponse]')).toBe('false');
    expect(yes.get('isExistsPublishedResponse')).toBeNull();
    expect(buildReviewListQuery({}).get('exists[publishedResponse]')).toBeNull();
  });

  it('passes rating strings and territories as comma-joined filters', () => {
    const params = buildReviewListQuery({
      ratings: ['1', '2'],
      territories: ['USA', 'GBR'],
      sort: '-rating',
    });
    expect(params.get('filter[rating]')).toBe('1,2');
    expect(params.get('filter[territory]')).toBe('USA,GBR');
    expect(params.get('sort')).toBe('-rating');
  });
});

describe('buildReviewResponseCreateBody', () => {
  it('emits required responseBody attribute + review relationship', () => {
    const body = buildReviewResponseCreateBody({
      reviewId: 'REV-1',
      responseBody: 'Thanks — fixed in 2.5!',
    });
    expect(body.data.type).toBe('customerReviewResponses');
    expect(body.data.attributes).toEqual({ responseBody: 'Thanks — fixed in 2.5!' });
    expect(body.data.relationships).toEqual({
      review: { data: { type: 'customerReviews', id: 'REV-1' } },
    });
    expect('id' in body.data).toBe(false);
  });
});
