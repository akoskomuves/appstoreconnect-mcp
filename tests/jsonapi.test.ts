import { describe, expect, it } from 'vitest';
import type { ASCClient } from '../src/client.js';
import {
  buildIncludedIndex,
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
