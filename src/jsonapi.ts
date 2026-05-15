import type { ASCClient } from './client.js';

export interface JSONAPIResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, JSONAPIRelationship>;
}

export interface JSONAPIRelationship {
  data?: { type: string; id: string } | Array<{ type: string; id: string }> | null;
  links?: { self?: string; related?: string };
}

export interface JSONAPIResponse<T = JSONAPIResource | JSONAPIResource[]> {
  data: T;
  included?: JSONAPIResource[];
  links?: { self?: string; next?: string; prev?: string; first?: string; last?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export interface CollectedPages {
  data: JSONAPIResource[];
  included: JSONAPIResource[];
  total?: number;
  pagesFetched: number;
  truncated: boolean;
}

const PAGE_HARD_CAP = 50;

/**
 * Auto-paginate an ASC list endpoint. Follows `links.next` until exhausted
 * or `maxItems` is reached, dedupes `included` resources by `${type}/${id}`,
 * and returns the merged collection.
 */
export async function paginate(
  client: ASCClient,
  initialPath: string,
  maxItems = 1000,
): Promise<CollectedPages> {
  const data: JSONAPIResource[] = [];
  const includedMap = new Map<string, JSONAPIResource>();
  let total: number | undefined;
  let next: string | null = initialPath;
  let pagesFetched = 0;
  let truncated = false;

  while (next && pagesFetched < PAGE_HARD_CAP) {
    const page: JSONAPIResponse<JSONAPIResource[]> =
      await client.request<JSONAPIResponse<JSONAPIResource[]>>(next);
    pagesFetched += 1;
    if (Array.isArray(page.data)) {
      for (const r of page.data) {
        if (data.length >= maxItems) {
          truncated = true;
          break;
        }
        data.push(r);
      }
    }
    for (const r of page.included ?? []) {
      const key = `${r.type}/${r.id}`;
      if (!includedMap.has(key)) includedMap.set(key, r);
    }
    if (page.meta?.paging?.total !== undefined) total = page.meta.paging.total;
    if (truncated) break;
    next = page.links?.next ?? null;
  }
  if (next) truncated = true;

  return {
    data,
    included: Array.from(includedMap.values()),
    ...(total !== undefined ? { total } : {}),
    pagesFetched,
    truncated,
  };
}

/**
 * Trim a paginated price-points response to the `count` entries closest to
 * `nearAmount` (by customerPrice). Apple's price-point endpoints don't support
 * a near-amount filter server-side — this is a client-side narrowing so the
 * model doesn't have to scan 600+ tiers when it already knows the target.
 *
 * The slice is sorted by customerPrice ascending on the way out so downstream
 * digests still see a stable shape.
 */
export function filterPagesByNearAmount(
  pages: CollectedPages,
  nearAmount: number,
  count: number,
): CollectedPages {
  const annotated = pages.data
    .map((r) => {
      const raw = r.attributes?.['customerPrice'] as string | undefined;
      const amt = raw === undefined ? Number.NaN : Number.parseFloat(raw);
      return { r, amt };
    })
    .filter((x) => Number.isFinite(x.amt));
  annotated.sort((a, b) => Math.abs(a.amt - nearAmount) - Math.abs(b.amt - nearAmount));
  const sliced = annotated.slice(0, count).sort((a, b) => a.amt - b.amt);
  return {
    ...pages,
    data: sliced.map((x) => x.r),
  };
}

export function buildIncludedIndex(included: JSONAPIResource[]): Map<string, JSONAPIResource> {
  const map = new Map<string, JSONAPIResource>();
  for (const r of included) {
    map.set(`${r.type}/${r.id}`, r);
  }
  return map;
}

export function lookupIncluded(
  index: Map<string, JSONAPIResource>,
  type: string,
  id: string | undefined,
): JSONAPIResource | undefined {
  if (!id) return undefined;
  return index.get(`${type}/${id}`);
}

/**
 * Right-pad / left-pad columns to align rows. Numeric columns can be marked
 * with `align: 'right'` for trailing-decimal alignment.
 */
export interface Column {
  header: string;
  align?: 'left' | 'right';
}

export function formatTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((c, i) => {
    let w = c.header.length;
    for (const row of rows) {
      const cell = row[i] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const pad = (cell: string, width: number, align: 'left' | 'right'): string =>
    align === 'right' ? cell.padStart(width) : cell.padEnd(width);
  const renderRow = (cells: string[]): string =>
    columns
      .map((c, i) => pad(cells[i] ?? '', widths[i] ?? 0, c.align ?? 'left'))
      .join('  ')
      .trimEnd();
  const header = renderRow(columns.map((c) => c.header));
  const sep = renderRow(columns.map((_, i) => '-'.repeat(widths[i] ?? 0)));
  return [header, sep, ...rows.map(renderRow)].join('\n');
}
