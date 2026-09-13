import { describe, expect, it } from 'vitest';
import {
  type CollectedPages,
  filterPagesByTerritory,
  territoryFilterNote,
} from '../src/jsonapi.js';

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

describe('territoryFilterNote', () => {
  // The regression this guards: a fetch that stopped early can leave the
  // requested territory unseen, and a bare empty table then reads as "this
  // territory has no price" — a silently WRONG answer rather than a missing
  // one. Callers narrow with a small maxItems precisely to save tokens, so
  // the two knobs would otherwise fight each other.
  it('flags an incomplete scan when nothing matched and the fetch was truncated', () => {
    const note = territoryFilterNote('JPN', 0, 50, true);
    expect(note).toContain('INCOMPLETE SCAN');
    expect(note).toContain('does NOT mean the territory has no entry');
    expect(note).toContain('raise maxItems');
  });

  it('does not cry incomplete when nothing matched but the scan was complete', () => {
    const note = territoryFilterNote('JPN', 0, 175, false);
    expect(note).not.toContain('INCOMPLETE SCAN');
    expect(note).toContain('0 of 175');
  });

  it('still warns when rows matched but the scan was truncated', () => {
    const note = territoryFilterNote('USA', 1, 50, true);
    expect(note).not.toContain('INCOMPLETE SCAN');
    expect(note).toContain('truncated');
  });

  it('reports the plain counts on a clean filtered scan', () => {
    const note = territoryFilterNote('USA', 1, 175, false);
    expect(note).toContain('Filtered to territory USA');
    expect(note).toContain('1 of 175');
    expect(note).not.toContain('truncated');
  });

  it('mentions wildcards only when they were kept', () => {
    expect(territoryFilterNote('USA', 2, 175, false, true)).toContain('all-territories wildcards');
    expect(territoryFilterNote('USA', 2, 175, false, false)).not.toContain('wildcard');
  });
});
