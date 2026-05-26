import { describe, expect, it } from 'vitest';
import type { ASCClient } from '../src/client.js';
import {
  buildIncludedIndex,
  filterPagesByNearAmount,
  formatTable,
  type JSONAPIResource,
  type JSONAPIResponse,
  paginate,
} from '../src/jsonapi.js';

function fakeClient(pages: JSONAPIResponse[]): { client: ASCClient; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const client: ASCClient = {
    request: async <T>(path: string): Promise<T> => {
      calls.push(path);
      const page = pages[i++];
      if (!page) throw new Error(`No more pages staged at call ${i}`);
      return page as T;
    },
    // paginate() doesn't call requestText; this stub exists only to satisfy
    // the ASCClient interface and would fail loudly if accidentally invoked.
    requestText: async () => {
      throw new Error('requestText not stubbed in paginate tests');
    },
  };
  return { client, calls };
}

describe('paginate', () => {
  it('returns a single page when there is no next link', async () => {
    const { client, calls } = fakeClient([
      {
        data: [
          { type: 'apps', id: '1' },
          { type: 'apps', id: '2' },
        ],
        meta: { paging: { total: 2 } },
      },
    ]);
    const result = await paginate(client, '/v1/apps');
    expect(result.data.length).toBe(2);
    expect(result.included).toEqual([]);
    expect(result.total).toBe(2);
    expect(result.pagesFetched).toBe(1);
    expect(result.truncated).toBe(false);
    expect(calls).toEqual(['/v1/apps']);
  });

  it('follows links.next through multiple pages and dedupes included', async () => {
    const { client, calls } = fakeClient([
      {
        data: [{ type: 'subscriptionPrices', id: 'p1' }],
        included: [
          { type: 'territories', id: 'USA', attributes: { currency: 'USD' } },
          { type: 'subscriptionPricePoints', id: 'pp1', attributes: { customerPrice: '10' } },
        ],
        links: { next: '/v1/.../prices?cursor=2' },
        meta: { paging: { total: 3 } },
      },
      {
        data: [{ type: 'subscriptionPrices', id: 'p2' }],
        included: [
          // duplicate territory — must dedupe
          { type: 'territories', id: 'USA', attributes: { currency: 'USD' } },
          { type: 'territories', id: 'GBR', attributes: { currency: 'GBP' } },
        ],
        links: { next: '/v1/.../prices?cursor=3' },
      },
      {
        data: [{ type: 'subscriptionPrices', id: 'p3' }],
        meta: { paging: { total: 3 } },
      },
    ]);
    const result = await paginate(client, '/v1/.../prices');
    expect(result.data.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    expect(result.included.length).toBe(3); // deduped
    expect(result.pagesFetched).toBe(3);
    expect(result.truncated).toBe(false);
    expect(calls.length).toBe(3);
  });

  it('respects maxItems and reports truncated', async () => {
    const { client } = fakeClient([
      {
        data: [
          { type: 'apps', id: '1' },
          { type: 'apps', id: '2' },
        ],
        links: { next: '/v1/apps?cursor=2' },
      },
      {
        data: [
          { type: 'apps', id: '3' },
          { type: 'apps', id: '4' },
        ],
      },
    ]);
    const result = await paginate(client, '/v1/apps', 3);
    expect(result.data.length).toBe(3);
    expect(result.truncated).toBe(true);
  });
});

describe('buildIncludedIndex', () => {
  it('keys resources by type+id', () => {
    const included: JSONAPIResource[] = [
      { type: 'territories', id: 'USA' },
      { type: 'territories', id: 'GBR' },
      { type: 'subscriptionPricePoints', id: 'pp1' },
    ];
    const index = buildIncludedIndex(included);
    expect(index.size).toBe(3);
    expect(index.get('territories/USA')?.id).toBe('USA');
    expect(index.get('subscriptionPricePoints/pp1')?.id).toBe('pp1');
  });
});

describe('filterPagesByNearAmount', () => {
  const candidates: JSONAPIResource[] = [
    { type: 'appPricePoints', id: 'p1', attributes: { customerPrice: '0.99' } },
    { type: 'appPricePoints', id: 'p2', attributes: { customerPrice: '4.99' } },
    { type: 'appPricePoints', id: 'p3', attributes: { customerPrice: '9.99' } },
    { type: 'appPricePoints', id: 'p4', attributes: { customerPrice: '14.99' } },
    { type: 'appPricePoints', id: 'p5', attributes: { customerPrice: '29.99' } },
    { type: 'appPricePoints', id: 'p6', attributes: { customerPrice: '49.99' } },
  ];
  const pages = {
    data: candidates,
    included: [] as JSONAPIResource[],
    pagesFetched: 1,
    truncated: false,
  };

  it('returns the N tiers closest to nearAmount, sorted ascending', () => {
    // Target 15 vs candidates 0.99, 4.99, 9.99, 14.99, 29.99, 49.99 →
    // top 3 by |amt-15|: 14.99 (0.01), 9.99 (5.01), 4.99 (10.01).
    const result = filterPagesByNearAmount(pages, 15, 3);
    expect(result.data.map((r) => r.id)).toEqual(['p2', 'p3', 'p4']);
  });

  it('handles nearAmount below the cheapest tier', () => {
    const result = filterPagesByNearAmount(pages, 0.1, 2);
    expect(result.data.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('handles nearAmount above the most expensive tier', () => {
    const result = filterPagesByNearAmount(pages, 100, 2);
    expect(result.data.map((r) => r.id)).toEqual(['p5', 'p6']);
  });

  it('skips entries with missing or non-numeric customerPrice', () => {
    const mixed = {
      ...pages,
      data: [
        { type: 'appPricePoints', id: 'a', attributes: { customerPrice: '5' } },
        { type: 'appPricePoints', id: 'b', attributes: {} },
        { type: 'appPricePoints', id: 'c', attributes: { customerPrice: 'oops' } },
        { type: 'appPricePoints', id: 'd', attributes: { customerPrice: '10' } },
      ],
    };
    const result = filterPagesByNearAmount(mixed, 7, 5);
    expect(result.data.map((r) => r.id)).toEqual(['a', 'd']);
  });
});

describe('formatTable', () => {
  it('right-pads left-aligned columns and right-pads right-aligned columns', () => {
    const out = formatTable(
      [{ header: 'NAME' }, { header: 'AMOUNT', align: 'right' }],
      [
        ['Apple', '49.99'],
        ['Pear', '7.99'],
      ],
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('NAME   AMOUNT');
    expect(lines[1]).toBe('-----  ------');
    expect(lines[2]).toBe('Apple   49.99');
    expect(lines[3]).toBe('Pear     7.99');
  });
});
