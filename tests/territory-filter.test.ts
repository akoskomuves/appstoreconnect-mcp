import { describe, expect, it } from 'vitest';
import { type CollectedPages, filterPagesByTerritory } from '../src/jsonapi.js';

// Narrowing a price / introductory-offer list to one territory.
//
// The load-bearing rule is the wildcard one: an introductory offer created
// WITHOUT a territory is Apple's "all territories" offer and is live in every
// market, so a single-territory view that dropped it would under-report what
// the customer in that market actually sees. Price rows never have this shape
// (every price is per-territory), which is why the flag is opt-in.

function row(id: string, territoryId: string | null): CollectedPages['data'][number] {
  return {
    type: 'subscriptionPrices',
    id,
    attributes: {},
    relationships:
      territoryId === null ? {} : { territory: { data: { type: 'territories', id: territoryId } } },
  };
}

function pages(data: CollectedPages['data'], total?: number): CollectedPages {
  return {
    data,
    included: [],
    pagesFetched: 1,
    truncated: false,
    ...(total !== undefined ? { total } : {}),
  };
}

describe('filterPagesByTerritory', () => {
  it('keeps only rows matching the requested territory', () => {
    const out = filterPagesByTerritory(
      pages([row('a', 'USA'), row('b', 'GBR'), row('c', 'DEU')]),
      'USA',
    );
    expect(out.data.map((r) => r.id)).toEqual(['a']);
  });

  it('drops wildcard (territory-less) rows by default', () => {
    const out = filterPagesByTerritory(pages([row('a', 'USA'), row('w', null)]), 'USA');
    expect(out.data.map((r) => r.id)).toEqual(['a']);
  });

  it('keeps wildcard rows when keepWildcard is set — an all-territories offer IS live in the requested market', () => {
    const out = filterPagesByTerritory(pages([row('a', 'USA'), row('w', null)]), 'USA', true);
    expect(out.data.map((r) => r.id)).toEqual(['a', 'w']);
  });

  it('keeps a wildcard row even when no concrete row matches', () => {
    const out = filterPagesByTerritory(pages([row('b', 'GBR'), row('w', null)]), 'USA', true);
    expect(out.data.map((r) => r.id)).toEqual(['w']);
  });

  it('matches territory codes case-insensitively', () => {
    const out = filterPagesByTerritory(pages([row('a', 'USA')]), 'usa');
    expect(out.data.map((r) => r.id)).toEqual(['a']);
  });

  it('restates total to the filtered count so the digest footer is not the pre-filter page total', () => {
    const out = filterPagesByTerritory(
      pages([row('a', 'USA'), row('b', 'GBR'), row('c', 'DEU')], 175),
      'USA',
    );
    expect(out.total).toBe(1);
  });

  it('preserves truncated and included untouched', () => {
    const input: CollectedPages = {
      data: [row('a', 'USA')],
      included: [{ type: 'territories', id: 'USA', attributes: { currency: 'USD' } }],
      pagesFetched: 3,
      truncated: true,
    };
    const out = filterPagesByTerritory(input, 'USA');
    expect(out.truncated).toBe(true);
    expect(out.pagesFetched).toBe(3);
    expect(out.included).toHaveLength(1);
  });

  it('returns an empty result rather than throwing when nothing matches', () => {
    const out = filterPagesByTerritory(pages([row('a', 'USA')]), 'JPN');
    expect(out.data).toEqual([]);
    expect(out.total).toBe(0);
  });
});
