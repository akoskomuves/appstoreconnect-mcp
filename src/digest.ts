import {
  buildIncludedIndex,
  type CollectedPages,
  type Column,
  formatTable,
  type JSONAPIResource,
  lookupIncluded,
} from './jsonapi.js';

function attr<T>(resource: JSONAPIResource, key: string): T | undefined {
  return resource.attributes?.[key] as T | undefined;
}

function rel(resource: JSONAPIResource, key: string): { type: string; id: string } | undefined {
  const r = resource.relationships?.[key];
  if (!r?.data) return undefined;
  if (Array.isArray(r.data)) return r.data[0];
  return r.data;
}

function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function summaryFooter(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ` (truncated — set raw:true or pass maxItems to fetch more)` : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

export function digestApps(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'BUNDLE_ID' },
    { header: 'SKU' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((app) => [
    s(attr(app, 'name')),
    s(attr(app, 'bundleId')),
    s(attr(app, 'sku')),
    app.id,
  ]);
  return `${summaryFooter(pages, 'apps')}\n\n${formatTable(columns, rows)}`;
}

export function digestSubscriptionGroups(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'REFERENCE_NAME' }, { header: 'ID' }];
  const rows = pages.data.map((g) => [s(attr(g, 'referenceName')), g.id]);
  return `${summaryFooter(pages, 'groups')}\n\n${formatTable(columns, rows)}`;
}

export function digestSubscriptions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'PRODUCT_ID' },
    { header: 'PERIOD' },
    { header: 'STATE' },
    { header: 'GROUP_LEVEL', align: 'right' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((sub) => [
    s(attr(sub, 'name')),
    s(attr(sub, 'productId')),
    s(attr(sub, 'subscriptionPeriod')),
    s(attr(sub, 'state')),
    s(attr(sub, 'groupLevel')),
    sub.id,
  ]);
  return `${summaryFooter(pages, 'subscriptions')}\n\n${formatTable(columns, rows)}`;
}

export function digestSubscriptionPrices(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'CCY' },
    { header: 'AMOUNT', align: 'right' },
    { header: 'STATE' },
    { header: 'START_DATE' },
    { header: 'PRESERVE' },
    { header: 'PRICE_ID' },
    { header: 'POINT_ID' },
  ];
  const rows = pages.data.map((price) => {
    const territoryRel = rel(price, 'territory');
    const pricePointRel = rel(price, 'subscriptionPricePoint');
    const territory = lookupIncluded(index, 'territories', territoryRel?.id);
    const pricePoint = lookupIncluded(index, 'subscriptionPricePoints', pricePointRel?.id);
    const startDate = attr<string | null>(price, 'startDate');
    const preserve = attr<boolean>(price, 'preserveCurrentPrice');
    const state = startDate ? 'pending' : 'active';
    return [
      s(territoryRel?.id),
      s(territory ? attr(territory, 'currency') : ''),
      s(pricePoint ? attr(pricePoint, 'customerPrice') : ''),
      state,
      s(startDate ?? ''),
      s(preserve ?? false),
      price.id,
      s(pricePointRel?.id ?? ''),
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));

  const pending = rows.filter((r) => r[3] === 'pending').length;
  const summary = `${summaryFooter(pages, 'prices')} — ${pending} pending`;
  return `${summary}\n\n${formatTable(columns, rows)}`;
}

export function digestSubscriptionPricePoints(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'CCY' },
    { header: 'CUSTOMER_PRICE', align: 'right' },
    { header: 'PROCEEDS', align: 'right' },
    { header: 'PROCEEDS_Y2', align: 'right' },
    { header: 'POINT_ID' },
  ];
  const rows = pages.data.map((p) => {
    const territoryRel = rel(p, 'territory');
    const territory = lookupIncluded(index, 'territories', territoryRel?.id);
    return [
      s(territory ? attr(territory, 'currency') : territoryRel?.id),
      s(attr(p, 'customerPrice')),
      s(attr(p, 'proceeds')),
      s(attr(p, 'proceedsYear2')),
      p.id,
    ];
  });
  rows.sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0));
  return `${summaryFooter(pages, 'price points')}\n\n${formatTable(columns, rows)}`;
}

export function digestTerritories(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'CODE' }, { header: 'CURRENCY' }];
  const rows = pages.data.map((t) => [t.id, s(attr(t, 'currency'))]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'territories')}\n\n${formatTable(columns, rows)}`;
}

/**
 * Single-resource digest: when a tool returns one app/subscription/etc., this
 * pretty-prints the most useful attributes without the JSON:API noise.
 */
export function digestSingle(resource: JSONAPIResource, label: string): string {
  const lines = [`${label} ${resource.id}`];
  if (resource.attributes) {
    for (const [k, v] of Object.entries(resource.attributes)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') {
        lines.push(`  ${k}: ${JSON.stringify(v)}`);
      } else {
        lines.push(`  ${k}: ${String(v)}`);
      }
    }
  }
  return lines.join('\n');
}
