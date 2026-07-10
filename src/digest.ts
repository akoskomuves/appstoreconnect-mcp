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
    // ASC's SubscriptionPrice attribute is `preserved` (read-side); the POST
    // body uses `preserveCurrentPrice` (write-side). Different names, same idea.
    const preserve = attr<boolean>(price, 'preserved');
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

export function digestAppPrices(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'CCY' },
    { header: 'AMOUNT', align: 'right' },
    { header: 'KIND' },
    { header: 'STATE' },
    { header: 'START_DATE' },
    { header: 'PRICE_ID' },
    { header: 'POINT_ID' },
  ];

  // The /apps/{id}/appPriceSchedule response returns the schedule resource in
  // `data` and the AppPrice rows in `included`. To present the price table, we
  // walk `included` for appPrices, not `pages.data`.
  const appPrices = pages.included.filter((r) => r.type === 'appPrices');
  const rows = appPrices.map((price) => {
    const territoryRel = rel(price, 'territory');
    const pricePointRel = rel(price, 'appPricePoint');
    // Apple's /appPriceSchedule endpoint does not let us include the
    // appPricePoint resource inline (chained includes are rejected), so we
    // only have the price-point ID here — not the customer price. Use
    // asc_list_app_price_points(appId, territoryId) to resolve a specific
    // amount when needed.
    const territory = lookupIncluded(index, 'territories', territoryRel?.id);
    const pricePoint = lookupIncluded(index, 'appPricePoints', pricePointRel?.id);
    const startDate = attr<string | null>(price, 'startDate');
    const manual = attr<boolean>(price, 'manual');
    const state = startDate ? 'pending' : 'active';
    const amount = pricePoint ? s(attr(pricePoint, 'customerPrice')) : '—';
    return [
      s(territoryRel?.id),
      s(territory ? attr(territory, 'currency') : ''),
      amount,
      manual ? 'manual' : 'auto',
      state,
      s(startDate ?? ''),
      price.id,
      s(pricePointRel?.id ?? ''),
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));

  const pending = rows.filter((r) => r[4] === 'pending').length;
  const manualCount = rows.filter((r) => r[3] === 'manual').length;
  const baseTerritoryRel = pages.data[0] ? rel(pages.data[0], 'baseTerritory') : undefined;
  const baseLine = baseTerritoryRel ? ` — base territory ${baseTerritoryRel.id}` : '';
  const summary = `${appPrices.length} app prices (${manualCount} manual, ${appPrices.length - manualCount} auto) — ${pending} pending${baseLine}`;
  return `${summary}\n\n${formatTable(columns, rows)}`;
}

export function digestAppPricePoints(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'CCY' },
    { header: 'CUSTOMER_PRICE', align: 'right' },
    { header: 'PROCEEDS', align: 'right' },
    { header: 'POINT_ID' },
  ];
  const rows = pages.data.map((p) => {
    const territoryRel = rel(p, 'territory');
    const territory = lookupIncluded(index, 'territories', territoryRel?.id);
    return [
      s(territory ? attr(territory, 'currency') : territoryRel?.id),
      s(attr(p, 'customerPrice')),
      s(attr(p, 'proceeds')),
      p.id,
    ];
  });
  rows.sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0));
  return `${summaryFooter(pages, 'app price points')}\n\n${formatTable(columns, rows)}`;
}

export function digestIaps(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'PRODUCT_ID' },
    { header: 'TYPE' },
    { header: 'STATE' },
    { header: 'FAMILY_SHARABLE' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((iap) => [
    s(attr(iap, 'name')),
    s(attr(iap, 'productId')),
    s(attr(iap, 'inAppPurchaseType')),
    s(attr(iap, 'state')),
    s(attr(iap, 'familySharable')),
    iap.id,
  ]);
  return `${summaryFooter(pages, 'iaps')}\n\n${formatTable(columns, rows)}`;
}

export function digestIapPrices(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'CCY' },
    { header: 'AMOUNT', align: 'right' },
    { header: 'KIND' },
    { header: 'STATE' },
    { header: 'START_DATE' },
    { header: 'PRICE_ID' },
    { header: 'POINT_ID' },
  ];

  // Same shape as the app price schedule digest: schedule resource in `data`,
  // InAppPurchasePrice rows in `included`. Apple's price-schedule endpoint
  // rejects chained includes, so the appPricePoint amounts are not inline;
  // AMOUNT shows "—" and callers should use asc_list_iap_price_points to
  // resolve specific amounts.
  const iapPrices = pages.included.filter((r) => r.type === 'inAppPurchasePrices');
  const rows = iapPrices.map((price) => {
    const territoryRel = rel(price, 'territory');
    const pricePointRel = rel(price, 'inAppPurchasePricePoint');
    const territory = lookupIncluded(index, 'territories', territoryRel?.id);
    const pricePoint = lookupIncluded(index, 'inAppPurchasePricePoints', pricePointRel?.id);
    const startDate = attr<string | null>(price, 'startDate');
    const manual = attr<boolean>(price, 'manual');
    const state = startDate ? 'pending' : 'active';
    const amount = pricePoint ? s(attr(pricePoint, 'customerPrice')) : '—';
    return [
      s(territoryRel?.id),
      s(territory ? attr(territory, 'currency') : ''),
      amount,
      manual ? 'manual' : 'auto',
      state,
      s(startDate ?? ''),
      price.id,
      s(pricePointRel?.id ?? ''),
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));

  const pending = rows.filter((r) => r[4] === 'pending').length;
  const manualCount = rows.filter((r) => r[3] === 'manual').length;
  const baseTerritoryRel = pages.data[0] ? rel(pages.data[0], 'baseTerritory') : undefined;
  const baseLine = baseTerritoryRel ? ` — base territory ${baseTerritoryRel.id}` : '';
  const summary = `${iapPrices.length} iap prices (${manualCount} manual, ${iapPrices.length - manualCount} auto) — ${pending} pending${baseLine}`;
  return `${summary}\n\n${formatTable(columns, rows)}`;
}

export function digestIapPricePoints(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'CCY' },
    { header: 'CUSTOMER_PRICE', align: 'right' },
    { header: 'PROCEEDS', align: 'right' },
    { header: 'POINT_ID' },
  ];
  const rows = pages.data.map((p) => {
    const territoryRel = rel(p, 'territory');
    const territory = lookupIncluded(index, 'territories', territoryRel?.id);
    return [
      s(territory ? attr(territory, 'currency') : territoryRel?.id),
      s(attr(p, 'customerPrice')),
      s(attr(p, 'proceeds')),
      p.id,
    ];
  });
  rows.sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0));
  return `${summaryFooter(pages, 'iap price points')}\n\n${formatTable(columns, rows)}`;
}

export function digestPromotionalOffers(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'CODE' },
    { header: 'NAME' },
    { header: 'MODE' },
    { header: 'DURATION' },
    { header: 'PERIODS', align: 'right' },
    { header: 'PRICES', align: 'right' },
    { header: 'OFFER_ID' },
  ];
  const rows = pages.data.map((offer) => {
    // The to-many `prices` relationship lands in relationships rather than
    // included by default. Just count the linkages — the per-territory detail
    // belongs in asc_list_subscription_promotional_offer_prices, not here.
    const pricesRel = offer.relationships?.['prices']?.data;
    const priceCount = Array.isArray(pricesRel) ? pricesRel.length : '';
    return [
      s(attr(offer, 'offerCode')),
      s(attr(offer, 'name')),
      s(attr(offer, 'offerMode')),
      s(attr(offer, 'duration')),
      s(attr(offer, 'numberOfPeriods') ?? ''),
      s(priceCount),
      offer.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'promotional offers')}\n\n${formatTable(columns, rows)}`;
}

export function digestPromotionalOfferPrices(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'CCY' },
    { header: 'AMOUNT', align: 'right' },
    { header: 'POINT_ID' },
    { header: 'PRICE_ID' },
  ];
  const rows = pages.data.map((price) => {
    const territoryRel = rel(price, 'territory');
    const pricePointRel = rel(price, 'subscriptionPricePoint');
    const territory = lookupIncluded(index, 'territories', territoryRel?.id);
    const pricePoint = lookupIncluded(index, 'subscriptionPricePoints', pricePointRel?.id);
    return [
      s(territoryRel?.id),
      s(territory ? attr(territory, 'currency') : ''),
      s(pricePoint ? attr(pricePoint, 'customerPrice') : ''),
      s(pricePointRel?.id ?? ''),
      price.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'promo offer prices')}\n\n${formatTable(columns, rows)}`;
}

export function digestWinBackOffers(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'OFFER_ID' },
    { header: 'NAME' },
    { header: 'MODE' },
    { header: 'DURATION' },
    { header: 'PERIODS', align: 'right' },
    { header: 'PRICES', align: 'right' },
    { header: 'PRIORITY' },
    { header: 'START' },
    { header: 'END' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((offer) => {
    const pricesRel = offer.relationships?.['prices']?.data;
    const priceCount = Array.isArray(pricesRel) ? pricesRel.length : '';
    return [
      s(attr(offer, 'offerId')),
      s(attr(offer, 'referenceName')),
      s(attr(offer, 'offerMode')),
      s(attr(offer, 'duration')),
      s(attr(offer, 'periodCount') ?? ''),
      s(priceCount),
      s(attr(offer, 'priority')),
      s(attr(offer, 'startDate') ?? ''),
      s(attr(offer, 'endDate') ?? ''),
      offer.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'win-back offers')}\n\n${formatTable(columns, rows)}`;
}

export function digestWinBackOfferPrices(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'CCY' },
    { header: 'AMOUNT', align: 'right' },
    { header: 'POINT_ID' },
    { header: 'PRICE_ID' },
  ];
  const rows = pages.data.map((price) => {
    const territoryRel = rel(price, 'territory');
    const pricePointRel = rel(price, 'subscriptionPricePoint');
    const territory = lookupIncluded(index, 'territories', territoryRel?.id);
    const pricePoint = lookupIncluded(index, 'subscriptionPricePoints', pricePointRel?.id);
    return [
      s(territoryRel?.id),
      s(territory ? attr(territory, 'currency') : ''),
      s(pricePoint ? attr(pricePoint, 'customerPrice') : ''),
      s(pricePointRel?.id ?? ''),
      price.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'win-back offer prices')}\n\n${formatTable(columns, rows)}`;
}

// Generic digest for the review-asset resources (IAP/subscription images +
// App Store review screenshots). They share one read shape: fileName, fileSize,
// state, sourceFileChecksum (present once committed). COMMITTED marks whether
// the reservation's PATCH (uploaded=true + checksum) has landed.
export function digestReviewAssets(pages: CollectedPages, label: string): string {
  const columns: Column[] = [
    { header: 'FILE' },
    { header: 'SIZE', align: 'right' },
    { header: 'STATE' },
    { header: 'COMMITTED' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((a) => [
    s(attr(a, 'fileName')),
    s(attr(a, 'fileSize') ?? ''),
    s(attr(a, 'state') ?? ''),
    attr(a, 'sourceFileChecksum') ? 'yes' : 'no',
    a.id,
  ]);
  return `${summaryFooter(pages, label)}\n\n${formatTable(columns, rows)}`;
}

export function digestOfferCodes(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'CUST_ELIG' },
    { header: 'OFFER_ELIG' },
    { header: 'MODE' },
    { header: 'DURATION' },
    { header: 'PERIODS', align: 'right' },
    { header: 'ACTIVE' },
    { header: 'AUTO_RNW' },
    { header: 'CODES', align: 'right' },
    { header: 'PRICES', align: 'right' },
    { header: 'CAMPAIGN_ID' },
  ];
  const rows = pages.data.map((campaign) => {
    const elig = attr<string[]>(campaign, 'customerEligibilities');
    // Compact customer-eligibility cohorts into NEW/EXIST/EXP letters so the
    // column doesn't explode horizontally when all three cohorts are set.
    const eligShort = (elig ?? [])
      .map((e) => (e === 'NEW' ? 'N' : e === 'EXISTING' ? 'E' : e === 'EXPIRED' ? 'X' : e))
      .join('');
    // offerEligibility is a separate single-value enum governing how the code
    // composes with introductory offers (stack vs. replace). Short labels:
    // STACK / REPLACE.
    const offerEligRaw = attr<string>(campaign, 'offerEligibility');
    const offerEligShort =
      offerEligRaw === 'STACK_WITH_INTRO_OFFERS'
        ? 'STACK'
        : offerEligRaw === 'REPLACE_INTRO_OFFERS'
          ? 'REPLACE'
          : (offerEligRaw ?? '');
    const pricesRel = campaign.relationships?.['prices']?.data;
    const priceCount = Array.isArray(pricesRel) ? pricesRel.length : '';
    // CODES column: combined view of production + sandbox counts when both
    // are exposed (v0.8.1+ fields). Falls back to totalNumberOfCodes for
    // backward-compat when Apple omits the breakdown.
    const prodN = attr<number>(campaign, 'productionCodeCount');
    const sbxN = attr<number>(campaign, 'sandboxCodeCount');
    const totalN = attr<number>(campaign, 'totalNumberOfCodes');
    const codesCell =
      prodN !== undefined || sbxN !== undefined
        ? `${prodN ?? 0}/${sbxN ?? 0}`
        : totalN !== undefined
          ? String(totalN)
          : '';
    const autoRenew = attr<boolean>(campaign, 'autoRenewEnabled');
    const autoRenewCell = autoRenew === undefined ? '—' : autoRenew ? 'Y' : 'N';
    return [
      s(attr(campaign, 'name')),
      eligShort,
      offerEligShort,
      s(attr(campaign, 'offerMode')),
      s(attr(campaign, 'duration')),
      s(attr(campaign, 'numberOfPeriods') ?? ''),
      s(attr(campaign, 'active') ?? ''),
      autoRenewCell,
      codesCell,
      s(priceCount),
      campaign.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'offer code campaigns')} (CUST_ELIG: N=NEW E=EXISTING X=EXPIRED · OFFER_ELIG: STACK=stack-with-intro REPLACE=replace-intro · CODES: prod/sbx)\n\n${formatTable(columns, rows)}`;
}

export function digestOfferCodeOneTimeUseBatches(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'CREATED' },
    { header: 'CODES', align: 'right' },
    { header: 'ENV' },
    { header: 'EXPIRES' },
    { header: 'ACTIVE' },
    { header: 'BATCH_ID' },
  ];
  const rows = pages.data.map((batch) => {
    // Apple returns environment = "SANDBOX" | "PRODUCTION". Compact to SBX /
    // PROD so the column stays narrow. Sparse-fieldset responses or pre-
    // v0.8.1 batches may omit the field — render — so blank reads
    // distinctly from a known production batch.
    const envRaw = attr<string>(batch, 'environment');
    const envCell =
      envRaw === 'SANDBOX' ? 'SBX' : envRaw === 'PRODUCTION' ? 'PROD' : envRaw ? envRaw : '—';
    return [
      s(attr(batch, 'createdDate') ?? ''),
      s(attr(batch, 'numberOfCodes') ?? ''),
      envCell,
      s(attr(batch, 'expirationDate') ?? ''),
      s(attr(batch, 'active') ?? ''),
      batch.id,
    ];
  });
  // Newest first — operators usually care about the most-recently-generated
  // batch (the one they're about to hand out).
  rows.sort((a, b) => (b[0] ?? '').localeCompare(a[0] ?? ''));
  const total = pages.data.reduce(
    (n, batch) => n + (Number(attr(batch, 'numberOfCodes') ?? 0) || 0),
    0,
  );
  return `${summaryFooter(pages, 'one-time-use batches')} — ${total} total codes generated (ENV: SBX=sandbox PROD=production)\n\n${formatTable(columns, rows)}`;
}

export function digestOfferCodeCustomCodes(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'CUSTOM_CODE' },
    { header: 'CAP', align: 'right' },
    { header: 'EXPIRES' },
    { header: 'ACTIVE' },
    { header: 'CREATED' },
    { header: 'CUSTOM_CODE_ID' },
  ];
  const rows = pages.data.map((code) => [
    s(attr(code, 'customCode') ?? ''),
    s(attr(code, 'numberOfCodes') ?? ''),
    // Custom codes can omit expirationDate (Swift SDK optional) — render
    // a dash so an indefinite-redemption code reads distinctly from a
    // missing-field row.
    s(attr(code, 'expirationDate') ?? '—'),
    s(attr(code, 'active') ?? ''),
    s(attr(code, 'createdDate') ?? ''),
    code.id,
  ]);
  // Newest first by createdDate (column index 4).
  rows.sort((a, b) => (b[4] ?? '').localeCompare(a[4] ?? ''));
  const cap = pages.data.reduce(
    (n, code) => n + (Number(attr(code, 'numberOfCodes') ?? 0) || 0),
    0,
  );
  return `${summaryFooter(pages, 'custom codes')} — ${cap} total redemption cap across all codes\n\n${formatTable(columns, rows)}`;
}

export function digestIntroOffers(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'MODE' },
    { header: 'DURATION' },
    { header: 'PERIODS', align: 'right' },
    { header: 'PRICE', align: 'right' },
    { header: 'START' },
    { header: 'END' },
    { header: 'OFFER_ID' },
  ];
  const rows = pages.data.map((offer) => {
    const territoryRel = rel(offer, 'territory');
    const pricePointRel = rel(offer, 'subscriptionPricePoint');
    const pricePoint = lookupIncluded(index, 'subscriptionPricePoints', pricePointRel?.id);
    const offerMode = attr<string>(offer, 'offerMode') ?? '';
    return [
      // Apple's "all territories" wildcard returns null `territory` — surface
      // it explicitly so the table doesn't show a confusing blank.
      territoryRel?.id ? s(territoryRel.id) : '(all)',
      offerMode,
      s(attr(offer, 'duration')),
      s(attr(offer, 'numberOfPeriods') ?? ''),
      // FREE_TRIAL has no price even when an offer happens to carry a
      // price-point rel from a prior mode — render dash for clarity.
      offerMode === 'FREE_TRIAL' ? '—' : s(pricePoint ? attr(pricePoint, 'customerPrice') : ''),
      s(attr(offer, 'startDate') ?? ''),
      s(attr(offer, 'endDate') ?? ''),
      offer.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'introductory offers')}\n\n${formatTable(columns, rows)}`;
}

export function digestTerritories(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'CODE' }, { header: 'CURRENCY' }];
  const rows = pages.data.map((t) => [t.id, s(attr(t, 'currency'))]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'territories')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppInfos(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'STATE' },
    { header: 'STORE_STATE' },
    { header: 'AGE_RATING' },
    { header: 'APPINFO_ID' },
  ];
  const rows = pages.data.map((info) => [
    s(attr(info, 'state') ?? ''),
    s(attr(info, 'appStoreState') ?? ''),
    s(attr(info, 'appStoreAgeRating') ?? '—'),
    info.id,
  ]);
  return `${summaryFooter(pages, 'app infos')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppInfoLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'NAME' },
    { header: 'SUBTITLE' },
    { header: 'PRIV_URL' },
    { header: 'PRIV_CHOICES' },
    { header: 'PRIV_TEXT_LEN', align: 'right' },
    { header: 'LOC_ID' },
  ];
  const rows = pages.data.map((loc) => {
    const ppt = attr<string>(loc, 'privacyPolicyText') ?? '';
    const pUrl = attr<string>(loc, 'privacyPolicyUrl');
    const pChoices = attr<string>(loc, 'privacyChoicesUrl');
    return [
      s(attr(loc, 'locale') ?? ''),
      s(attr(loc, 'name') ?? ''),
      s(attr(loc, 'subtitle') ?? '—'),
      pUrl ? compactUrl(pUrl) : '—',
      pChoices ? compactUrl(pChoices) : '—',
      s(ppt.length),
      loc.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'app info localizations')} (URL columns show host only)\n\n${formatTable(columns, rows)}`;
}

export function digestAppCategories(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'CATEGORY_ID' },
    { header: 'PLATFORMS' },
    { header: 'SUBCATEGORIES' },
  ];
  const rows = pages.data.map((cat) => {
    const platforms = attr<string[]>(cat, 'platforms') ?? [];
    const subRel = cat.relationships?.['subcategories']?.data;
    const subIds: string[] = Array.isArray(subRel) ? subRel.map((d) => d.id) : [];
    // Resolve subcategory IDs to names via the included index.
    const subNames = subIds
      .map((id) => {
        const sub = lookupIncluded(index, 'appCategories', id);
        return sub?.id ?? id;
      })
      .join(', ');
    return [cat.id, platforms.join(','), subNames || '—'];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'app categories')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppTags(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'NAME' }, { header: 'VISIBLE' }, { header: 'TAG_ID' }];
  const rows = pages.data.map((tag) => {
    const visible = attr<boolean>(tag, 'visibleInAppStore');
    const visCell = visible === true ? 'Y' : visible === false ? 'N' : '—';
    return [s(attr(tag, 'name') ?? ''), visCell, tag.id];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'app tags')} (VISIBLE: Y=shown in App Store · N=hidden)\n\n${formatTable(columns, rows)}`;
}

export function digestSearchKeywords(pages: CollectedPages): string {
  // AppKeyword has NO attributes per Apple's contract — only `id`.
  // BUT: live smoke (2026-06-04) confirmed the IDs ARE the
  // human-readable keyword strings (Apple uses the keyword text as
  // the primary key). So `id` rendered alone is the actual keyword.
  // The set is BROADER than the version-level `keywords` field on
  // AppStoreVersionLocalization — Apple discovers additional terms
  // from app content. Useful for diagnosing "why does my app show
  // up for X" or "what searches drive impressions".
  const columns: Column[] = [{ header: 'KEYWORD' }];
  const rows = pages.data.map((kw) => [kw.id]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'search keywords')} (each ID is the keyword string itself — Apple uses the keyword as the primary key)\n\n${formatTable(columns, rows)}`;
}

export function digestReviewSubmissions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'STATE' },
    { header: 'PLATFORM' },
    { header: 'SUBMITTED' },
    { header: 'SUBMISSION_ID' },
  ];
  const rows = pages.data.map((sub) => {
    // Apple's State enum is long (READY_FOR_REVIEW, UNRESOLVED_ISSUES,
    // etc.). Pass through verbatim — the labels are informative enough
    // and compaction would make state diagnosis harder.
    const state = attr<string>(sub, 'state') ?? '';
    const platform = attr<string>(sub, 'platform') ?? '';
    const submitted = (attr<string>(sub, 'submittedDate') ?? '').slice(0, 10);
    return [state, platform, submitted, sub.id];
  });
  // Newest first by submittedDate (drafts that never got submitted will
  // have an empty submittedDate and sort last alphabetically — acceptable).
  rows.sort((a, b) => (b[2] ?? '').localeCompare(a[2] ?? ''));
  return `${summaryFooter(pages, 'review submissions')} (STATE: READY_FOR_REVIEW=draft · WAITING_FOR_REVIEW=submitted · IN_REVIEW · UNRESOLVED_ISSUES=Apple flagged · CANCELING / COMPLETING / COMPLETE)\n\n${formatTable(columns, rows)}`;
}

export function digestAppStoreVersions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'VERSION' },
    { header: 'PLATFORM' },
    { header: 'STATE' },
    { header: 'REL_TYPE' },
    { header: 'CREATED' },
    { header: 'VERSION_ID' },
  ];
  const rows = pages.data.map((v) => {
    // appStoreState enum values are long (e.g.
    // READY_FOR_DISTRIBUTION). Pass through as Apple sends — the
    // identifying token is in the prefix and operators learn the set.
    const state = attr<string>(v, 'appStoreState') ?? attr<string>(v, 'appVersionState') ?? '';
    const relType = attr<string>(v, 'releaseType') ?? '';
    const created = (attr<string>(v, 'createdDate') ?? '').slice(0, 10);
    return [
      s(attr(v, 'versionString') ?? ''),
      s(attr(v, 'platform') ?? ''),
      state,
      relType,
      created,
      v.id,
    ];
  });
  // Newest first by createdDate — we sort client-side because Apple
  // rejects `sort` on /v1/apps/{id}/appStoreVersions
  // (PARAMETER_ERROR.ILLEGAL). String compare on ISO dates is fine.
  rows.sort((a, b) => (b[4] ?? '').localeCompare(a[4] ?? ''));
  return `${summaryFooter(pages, 'app store versions')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppStoreVersionLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'WHATS_NEW_LEN', align: 'right' },
    { header: 'DESC_LEN', align: 'right' },
    { header: 'KEYWORDS_LEN', align: 'right' },
    { header: 'PROMO_LEN', align: 'right' },
    { header: 'WHATS_NEW_PREVIEW' },
    { header: 'LOC_ID' },
  ];
  const rows = pages.data.map((loc) => {
    const wn = attr<string>(loc, 'whatsNew') ?? '';
    const desc = attr<string>(loc, 'description') ?? '';
    const kw = attr<string>(loc, 'keywords') ?? '';
    const promo = attr<string>(loc, 'promotionalText') ?? '';
    const preview = wn.length <= 50 ? wn : `${wn.slice(0, 47)}...`;
    return [
      s(attr(loc, 'locale') ?? ''),
      s(wn.length),
      s(desc.length),
      s(kw.length),
      s(promo.length),
      preview.replace(/\s+/g, ' '),
      loc.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'app store version localizations')} (Apple caps: whatsNew/description 4000 · keywords 100 · promotionalText 170)\n\n${formatTable(columns, rows)}`;
}

export function digestSubscriptionLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'NAME' },
    { header: 'DESC_LEN', align: 'right' },
    { header: 'DESC_PREVIEW' },
    { header: 'STATE' },
    { header: 'LOC_ID' },
  ];
  const rows = pages.data.map((loc) => {
    const desc = attr<string>(loc, 'description') ?? '';
    const preview = desc.length <= 45 ? desc : `${desc.slice(0, 42)}...`;
    return [
      s(attr(loc, 'locale') ?? ''),
      s(attr(loc, 'name') ?? ''),
      s(desc.length),
      preview.replace(/\s+/g, ' '),
      s(attr(loc, 'state') ?? ''),
      loc.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'subscription localizations')} (STATE: PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED · Apple's documented caps: name 30 · description 45 (live API accepts longer descriptions))\n\n${formatTable(columns, rows)}`;
}

export function digestIapLocalizations(pages: CollectedPages): string {
  // Same shape as subscription localizations — share columns + caps. Apple
  // even reuses the same state enum.
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'NAME' },
    { header: 'DESC_LEN', align: 'right' },
    { header: 'DESC_PREVIEW' },
    { header: 'STATE' },
    { header: 'LOC_ID' },
  ];
  const rows = pages.data.map((loc) => {
    const desc = attr<string>(loc, 'description') ?? '';
    const preview = desc.length <= 45 ? desc : `${desc.slice(0, 42)}...`;
    return [
      s(attr(loc, 'locale') ?? ''),
      s(attr(loc, 'name') ?? ''),
      s(desc.length),
      preview.replace(/\s+/g, ' '),
      s(attr(loc, 'state') ?? ''),
      loc.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'IAP localizations')} (STATE: PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED · Apple's documented caps: name 30 · description 45 (live API accepts longer descriptions))\n\n${formatTable(columns, rows)}`;
}

export function digestBetaTesters(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'EMAIL' },
    { header: 'FIRST' },
    { header: 'LAST' },
    { header: 'INVITE' },
    { header: 'STATE' },
    { header: 'TESTER_ID' },
  ];
  const rows = pages.data.map((tester) => {
    // Apple's BetaInviteType enum: EMAIL / PUBLIC_LINK. Compact when present.
    const inviteRaw = attr<string>(tester, 'inviteType');
    const inviteCell =
      inviteRaw === 'EMAIL' ? 'EMAIL' : inviteRaw === 'PUBLIC_LINK' ? 'LINK' : (inviteRaw ?? '');
    // BetaTesterState enum: NOT_INVITED / INVITED / ACCEPTED / INSTALLED.
    // These are short enough to render verbatim.
    return [
      s(attr(tester, 'email') ?? ''),
      s(attr(tester, 'firstName') ?? ''),
      s(attr(tester, 'lastName') ?? ''),
      inviteCell,
      s(attr(tester, 'state') ?? ''),
      tester.id,
    ];
  });
  // Sort by email for stable display.
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'beta testers')} (INVITE: EMAIL / LINK · STATE: NOT_INVITED / INVITED / ACCEPTED / INSTALLED)\n\n${formatTable(columns, rows)}`;
}

export function digestBetaBuildLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'WHATS_NEW_LEN', align: 'right' },
    { header: 'WHATS_NEW_PREVIEW' },
    { header: 'LOC_ID' },
  ];
  const rows = pages.data.map((loc) => {
    const wn = attr<string>(loc, 'whatsNew') ?? '';
    // Show a 60-char preview so the table stays readable across many locales.
    const preview = wn.length <= 60 ? wn : `${wn.slice(0, 57)}...`;
    return [
      s(attr(loc, 'locale') ?? ''),
      s(wn.length),
      // Strip newlines for table rendering (whatsNew often has them).
      preview.replace(/\s+/g, ' '),
      loc.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'beta build localizations')}\n\n${formatTable(columns, rows)}`;
}

export function digestBetaAppLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'DESC_LEN', align: 'right' },
    { header: 'FEEDBACK_EMAIL' },
    { header: 'MARKETING_URL' },
    { header: 'PRIVACY_URL' },
    { header: 'LOC_ID' },
  ];
  const rows = pages.data.map((loc) => {
    const desc = attr<string>(loc, 'description') ?? '';
    // Compact URL display: show host only when present, em-dash when not.
    const mark = attr<string>(loc, 'marketingUrl');
    const priv = attr<string>(loc, 'privacyPolicyUrl');
    return [
      s(attr(loc, 'locale') ?? ''),
      s(desc.length),
      s(attr(loc, 'feedbackEmail') ?? '—'),
      mark ? compactUrl(mark) : '—',
      priv ? compactUrl(priv) : '—',
      loc.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'beta app localizations')} (URL columns show host only — fetch the row to see the full URL)\n\n${formatTable(columns, rows)}`;
}

// Helper: render a URL as host-only for compact table display.
function compactUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.length <= 30 ? url : `${url.slice(0, 27)}...`;
  }
}

export function digestBetaAppReviewSubmissions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'STATE' },
    { header: 'SUBMITTED' },
    { header: 'BUILD_ID' },
    { header: 'SUBMISSION_ID' },
  ];
  const rows = pages.data.map((sub) => {
    // betaReviewState enum: WAITING_FOR_REVIEW / IN_REVIEW / APPROVED /
    // REJECTED. Compact labels: WAIT/REVIEW/OK/NO.
    const stateRaw = attr<string>(sub, 'betaReviewState');
    const stateCell =
      stateRaw === 'WAITING_FOR_REVIEW'
        ? 'WAIT'
        : stateRaw === 'IN_REVIEW'
          ? 'REVIEW'
          : stateRaw === 'APPROVED'
            ? 'OK'
            : stateRaw === 'REJECTED'
              ? 'NO'
              : (stateRaw ?? '');
    const submitted = (attr<string>(sub, 'submittedDate') ?? '').slice(0, 10);
    const buildRel = rel(sub, 'build');
    return [stateCell, submitted, s(buildRel?.id ?? ''), sub.id];
  });
  // Newest submission first.
  rows.sort((a, b) => (b[1] ?? '').localeCompare(a[1] ?? ''));
  return `${summaryFooter(pages, 'beta app review submissions')} (STATE: WAIT=waiting REVIEW=in-review OK=approved NO=rejected)\n\n${formatTable(columns, rows)}`;
}

export function digestBetaAppReviewDetails(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'CONTACT' },
    { header: 'EMAIL' },
    { header: 'DEMO_REQ' },
    { header: 'NOTES_LEN', align: 'right' },
    { header: 'DETAIL_ID' },
  ];
  const rows = pages.data.map((d) => {
    const first = attr<string>(d, 'contactFirstName') ?? '';
    const last = attr<string>(d, 'contactLastName') ?? '';
    const fullName = `${first} ${last}`.trim() || '—';
    const demoReq = attr<boolean>(d, 'demoAccountRequired');
    const demoCell = demoReq === true ? 'Y' : demoReq === false ? 'N' : '—';
    const notes = attr<string>(d, 'notes') ?? '';
    return [fullName, s(attr(d, 'contactEmail') ?? '—'), demoCell, s(notes.length), d.id];
  });
  return `${summaryFooter(pages, 'beta app review details')} (DEMO_REQ: Y/N/— per demoAccountRequired)\n\n${formatTable(columns, rows)}`;
}

export function digestPreReleaseVersions(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'VERSION' }, { header: 'PLATFORM' }, { header: 'PRV_ID' }];
  const rows = pages.data.map((v) => [
    s(attr(v, 'version') ?? ''),
    s(attr(v, 'platform') ?? ''),
    v.id,
  ]);
  // Sort by version descending (rough — string compare on semver-ish strings
  // is imperfect, but useful enough for the table view).
  rows.sort((a, b) => (b[0] ?? '').localeCompare(a[0] ?? ''));
  return `${summaryFooter(pages, 'pre-release versions')}\n\n${formatTable(columns, rows)}`;
}

export function digestBetaGroups(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'KIND' },
    { header: 'ALL_BUILDS' },
    { header: 'PUB_LINK' },
    { header: 'LIMIT', align: 'right' },
    { header: 'FEEDBACK' },
    { header: 'CREATED' },
    { header: 'GROUP_ID' },
  ];
  const rows = pages.data.map((group) => {
    // KIND: INT/EXT — Apple's isInternalGroup is a bool, default behavior
    // is external. Render — when sparse-fieldset / unknown.
    const isInternal = attr<boolean>(group, 'isInternalGroup');
    const kindCell = isInternal === true ? 'INT' : isInternal === false ? 'EXT' : '—';
    // ALL_BUILDS: Y/N/— for hasAccessToAllBuilds (auto-assignment of new
    // builds to this group).
    const allBuilds = attr<boolean>(group, 'hasAccessToAllBuilds');
    const allBuildsCell = allBuilds === true ? 'Y' : allBuilds === false ? 'N' : '—';
    // PUB_LINK: Y/N/— for publicLinkEnabled.
    const pubLink = attr<boolean>(group, 'publicLinkEnabled');
    const pubLinkCell = pubLink === true ? 'Y' : pubLink === false ? 'N' : '—';
    // LIMIT: empty if publicLinkLimitEnabled is false/absent.
    const limitEnabled = attr<boolean>(group, 'publicLinkLimitEnabled');
    const limit = attr<number>(group, 'publicLinkLimit');
    const limitCell = limitEnabled === true && limit !== undefined ? String(limit) : '';
    const feedback = attr<boolean>(group, 'feedbackEnabled');
    const feedbackCell = feedback === true ? 'Y' : feedback === false ? 'N' : '—';
    const created = (attr<string>(group, 'createdDate') ?? '').slice(0, 10);
    return [
      s(attr(group, 'name') ?? ''),
      kindCell,
      allBuildsCell,
      pubLinkCell,
      limitCell,
      feedbackCell,
      created,
      group.id,
    ];
  });
  // Sort by name for stable display.
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'beta groups')} (KIND: INT=internal EXT=external · ALL_BUILDS/PUB_LINK/FEEDBACK: Y/N/—)\n\n${formatTable(columns, rows)}`;
}

export function digestBuilds(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'VERSION' },
    { header: 'STATE' },
    { header: 'AUDIENCE' },
    { header: 'MIN_OS' },
    { header: 'UPLOADED' },
    { header: 'EXPIRES' },
    { header: 'EXP' },
    { header: 'BUILD_ID' },
  ];
  const rows = pages.data.map((build) => {
    // STATE column: Apple's enum is PROCESSING/FAILED/INVALID/VALID. Compact
    // labels: PROC/FAIL/INV/OK so the column stays narrow at scale.
    const stateRaw = attr<string>(build, 'processingState');
    const stateCell =
      stateRaw === 'VALID'
        ? 'OK'
        : stateRaw === 'PROCESSING'
          ? 'PROC'
          : stateRaw === 'FAILED'
            ? 'FAIL'
            : stateRaw === 'INVALID'
              ? 'INV'
              : (stateRaw ?? '');
    // AUDIENCE column: INTERNAL_ONLY → INT, APP_STORE_ELIGIBLE → STORE.
    const audRaw = attr<string>(build, 'buildAudienceType');
    const audCell =
      audRaw === 'INTERNAL_ONLY'
        ? 'INT'
        : audRaw === 'APP_STORE_ELIGIBLE'
          ? 'STORE'
          : (audRaw ?? '');
    // EXP: Y/N marker for the expired flag (distinct from EXPIRES date — a
    // build can have a future expiration date AND be marked expired, the
    // flag wins).
    const expired = attr<boolean>(build, 'expired');
    const expCell = expired === true ? 'Y' : expired === false ? 'N' : '—';
    // Trim ISO datetimes to date portion for the table — minute precision
    // is just noise here.
    const upload = (attr<string>(build, 'uploadedDate') ?? '').slice(0, 10);
    const expires = (attr<string>(build, 'expirationDate') ?? '').slice(0, 10);
    return [
      s(attr(build, 'version') ?? ''),
      stateCell,
      audCell,
      s(attr(build, 'minOsVersion') ?? ''),
      upload,
      expires,
      expCell,
      build.id,
    ];
  });
  // Newest upload first when the list endpoint didn't already sort. The
  // /v1/apps/{id}/builds path supports sort=-uploadedDate; keep a stable
  // tie-break for offline-loaded pages.
  rows.sort((a, b) => (b[4] ?? '').localeCompare(a[4] ?? ''));
  return `${summaryFooter(pages, 'builds')} (STATE: OK=valid PROC=processing FAIL=failed INV=invalid · AUDIENCE: INT=internal STORE=eligible · EXP: Y=expired N=active —=unknown)\n\n${formatTable(columns, rows)}`;
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

// ----- v0.13.0: Asset upload + Custom Product Pages -----

// AppMediaAssetState / AppMediaVideoState are STRUCTS in Apple's contract,
// not enums: { errors: [], warnings: null, state: "COMPLETE" }. Pull the
// inner `state` for digest rendering; raw:true still emits the full object
// for callers that need errors/warnings.
function deliveryStateLabel(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'state' in raw) {
    const inner = (raw as { state?: unknown }).state;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

export function digestAppScreenshotSets(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'DISPLAY_TYPE' }, { header: 'SET_ID' }];
  const rows = pages.data.map((set) => [s(attr(set, 'screenshotDisplayType') ?? ''), set.id]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'screenshot sets')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppScreenshots(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'FILE_NAME' },
    { header: 'SIZE', align: 'right' },
    { header: 'STATE' },
    { header: 'CHECKSUM' },
    { header: 'SCREENSHOT_ID' },
  ];
  const rows = pages.data.map((shot) => {
    const checksum = attr<string>(shot, 'sourceFileChecksum');
    return [
      s(attr(shot, 'fileName') ?? ''),
      s(attr(shot, 'fileSize') ?? ''),
      deliveryStateLabel(attr(shot, 'assetDeliveryState')),
      checksum ? 'committed' : 'pending',
      shot.id,
    ];
  });
  return `${summaryFooter(pages, 'screenshots')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppPreviewSets(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'PREVIEW_TYPE' }, { header: 'SET_ID' }];
  const rows = pages.data.map((set) => [s(attr(set, 'previewType') ?? ''), set.id]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'preview sets')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppPreviews(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'FILE_NAME' },
    { header: 'SIZE', align: 'right' },
    { header: 'FRAME' },
    { header: 'ASSET_STATE' },
    { header: 'VIDEO_STATE' },
    { header: 'PREVIEW_ID' },
  ];
  const rows = pages.data.map((preview) => [
    s(attr(preview, 'fileName') ?? ''),
    s(attr(preview, 'fileSize') ?? ''),
    s(attr(preview, 'previewFrameTimeCode') ?? ''),
    deliveryStateLabel(attr(preview, 'assetDeliveryState')),
    deliveryStateLabel(attr(preview, 'videoDeliveryState')),
    preview.id,
  ]);
  return `${summaryFooter(pages, 'previews')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppCustomProductPages(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'VISIBLE' },
    { header: 'URL' },
    { header: 'CPP_ID' },
  ];
  const rows = pages.data.map((page) => [
    s(attr(page, 'name') ?? ''),
    s(attr(page, 'visible') ?? ''),
    s(attr(page, 'url') ?? ''),
    page.id,
  ]);
  return `${summaryFooter(pages, 'custom product pages')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppCustomProductPageVersions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'VERSION' },
    { header: 'STATE' },
    { header: 'DEEP_LINK' },
    { header: 'VERSION_ID' },
  ];
  const rows = pages.data.map((v) => [
    s(attr(v, 'version') ?? ''),
    s(attr(v, 'state') ?? ''),
    s(attr(v, 'deepLink') ?? ''),
    v.id,
  ]);
  return `${summaryFooter(pages, 'CPP versions')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppCustomProductPageLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'PROMO_LEN', align: 'right' },
    { header: 'PROMO_PREVIEW' },
    { header: 'LOC_ID' },
  ];
  const rows = pages.data.map((loc) => {
    const promo = attr<string>(loc, 'promotionalText') ?? '';
    const preview = promo.length <= 50 ? promo : `${promo.slice(0, 47)}...`;
    return [s(attr(loc, 'locale') ?? ''), s(promo.length), preview.replace(/\s+/g, ' '), loc.id];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'CPP localizations')} (Apple cap: promotionalText 170)\n\n${formatTable(columns, rows)}`;
}

// ----- v0.14.0: In-App Events + Promoted Purchases -----

export function digestAppEvents(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'REFERENCE_NAME' },
    { header: 'STATE' },
    { header: 'BADGE' },
    { header: 'PRIORITY' },
    { header: 'PURPOSE' },
    { header: 'TERR_COUNT', align: 'right' },
    { header: 'EVENT_ID' },
  ];
  const rows = pages.data.map((ev) => {
    const schedules = attr<unknown[]>(ev, 'territorySchedules');
    const territoryCount = Array.isArray(schedules) ? schedules.length : 0;
    return [
      s(attr(ev, 'referenceName') ?? ''),
      s(attr(ev, 'eventState') ?? ''),
      s(attr(ev, 'badge') ?? ''),
      s(attr(ev, 'priority') ?? ''),
      s(attr(ev, 'purpose') ?? ''),
      s(territoryCount),
      ev.id,
    ];
  });
  return `${summaryFooter(pages, 'app events')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppEventLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'LOCALE' },
    { header: 'NAME' },
    { header: 'SHORT_LEN', align: 'right' },
    { header: 'LONG_LEN', align: 'right' },
    { header: 'LOC_ID' },
  ];
  const rows = pages.data.map((loc) => {
    const short = attr<string>(loc, 'shortDescription') ?? '';
    const long = attr<string>(loc, 'longDescription') ?? '';
    return [
      s(attr(loc, 'locale') ?? ''),
      s(attr(loc, 'name') ?? ''),
      s(short.length),
      s(long.length),
      loc.id,
    ];
  });
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'event localizations')} (Apple caps: name 30 · shortDescription 50 · longDescription 120)\n\n${formatTable(columns, rows)}`;
}

export function digestAppEventScreenshots(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'FILE_NAME' },
    { header: 'SIZE', align: 'right' },
    { header: 'SLOT' },
    { header: 'STATE' },
    { header: 'SCREENSHOT_ID' },
  ];
  const rows = pages.data.map((shot) => [
    s(attr(shot, 'fileName') ?? ''),
    s(attr(shot, 'fileSize') ?? ''),
    s(attr(shot, 'appEventAssetType') ?? ''),
    deliveryStateLabel(attr(shot, 'assetDeliveryState')),
    shot.id,
  ]);
  return `${summaryFooter(pages, 'event screenshots')}\n\n${formatTable(columns, rows)}`;
}

export function digestAppEventVideoClips(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'FILE_NAME' },
    { header: 'SIZE', align: 'right' },
    { header: 'SLOT' },
    { header: 'FRAME' },
    { header: 'ASSET_STATE' },
    { header: 'VIDEO_STATE' },
    { header: 'CLIP_ID' },
  ];
  const rows = pages.data.map((clip) => [
    s(attr(clip, 'fileName') ?? ''),
    s(attr(clip, 'fileSize') ?? ''),
    s(attr(clip, 'appEventAssetType') ?? ''),
    s(attr(clip, 'previewFrameTimeCode') ?? ''),
    deliveryStateLabel(attr(clip, 'assetDeliveryState')),
    deliveryStateLabel(attr(clip, 'videoDeliveryState')),
    clip.id,
  ]);
  return `${summaryFooter(pages, 'event video clips')}\n\n${formatTable(columns, rows)}`;
}

export function digestPromotedPurchases(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'PRODUCT_ID' },
    { header: 'KIND' },
    { header: 'VISIBLE_ALL' },
    { header: 'ENABLED' },
    { header: 'STATE' },
    { header: 'PP_ID' },
  ];
  const rows = pages.data.map((pp) => {
    const iapRel = rel(pp, 'inAppPurchaseV2');
    const subRel = rel(pp, 'subscription');
    const linked = iapRel
      ? lookupIncluded(index, 'inAppPurchases', iapRel.id)
      : subRel
        ? lookupIncluded(index, 'subscriptions', subRel.id)
        : undefined;
    const productId = linked ? s(attr(linked, 'productId') ?? linked.id) : '';
    const kind = iapRel ? 'IAP' : subRel ? 'SUB' : '';
    return [
      productId,
      kind,
      s(attr(pp, 'visibleForAllUsers') ?? ''),
      s(attr(pp, 'enabled') ?? ''),
      s(attr(pp, 'state') ?? ''),
      pp.id,
    ];
  });
  return `${summaryFooter(pages, 'promoted purchases')} (STATE: PREPARE_FOR_SUBMISSION / IN_REVIEW / APPROVED / REJECTED)\n\n${formatTable(columns, rows)}`;
}

// ----- v0.15.0: App Availability + Phased Release + Encryption Declarations -----

// TerritoryAvailability.id is Apple-opaque: base64 of
// `{"s":<appId>,"t":<3-letter-code>}`. Decode for the human-readable
// TERR column; surface the full ID in TERR_ID so callers can pass it
// back verbatim to POST / end-preorder endpoints.
function decodeTerritoryCode(id: string): string {
  try {
    const json = Buffer.from(id, 'base64').toString('utf-8');
    const parsed = JSON.parse(json) as { t?: unknown };
    if (typeof parsed.t === 'string') return parsed.t;
  } catch {
    // not a base64 / JSON composite — fall back to raw id
  }
  return id;
}

export function digestTerritoryAvailabilities(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'TERR' },
    { header: 'AVAILABLE' },
    { header: 'RELEASE_DATE' },
    { header: 'PRE_ORDER' },
    { header: 'PRE_ORDER_DATE' },
    { header: 'TERR_ID' },
  ];
  const rows = pages.data.map((ta) => [
    decodeTerritoryCode(ta.id),
    s(attr(ta, 'available') ?? ''),
    s(attr(ta, 'releaseDate') ?? ''),
    s(attr(ta, 'preOrderEnabled') ?? ''),
    s(attr(ta, 'preOrderPublishDate') ?? ''),
    ta.id,
  ]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'territory availabilities')} (TERR decoded from id; TERR_ID is the Apple-opaque base64 composite to pass back to POST / end-preorder)\n\n${formatTable(columns, rows)}`;
}

export function digestAppEncryptionDeclarations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'STATE' },
    { header: 'CODE' },
    { header: 'EXEMPT' },
    { header: 'PROPRIETARY' },
    { header: 'THIRD_PARTY' },
    { header: 'FRANCE' },
    { header: 'CREATED' },
    { header: 'DECL_ID' },
  ];
  const rows = pages.data.map((d) => [
    s(attr(d, 'appEncryptionDeclarationState') ?? ''),
    s(attr(d, 'codeValue') ?? ''),
    s(attr(d, 'exempt') ?? ''),
    s(attr(d, 'containsProprietaryCryptography') ?? ''),
    s(attr(d, 'containsThirdPartyCryptography') ?? ''),
    s(attr(d, 'availableOnFrenchStore') ?? ''),
    s(attr(d, 'createdDate') ?? ''),
    d.id,
  ]);
  return `${summaryFooter(pages, 'encryption declarations')} (STATE: CREATED / IN_REVIEW / APPROVED / REJECTED / INVALID / EXPIRED)\n\n${formatTable(columns, rows)}`;
}

function commentPreview(v: unknown): string {
  const c = s(v);
  return c.length <= 45 ? c : `${c.slice(0, 42)}...`;
}

export function digestBetaFeedbackScreenshotSubmissions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'CREATED' },
    { header: 'DEVICE' },
    { header: 'OS' },
    { header: 'COMMENT' },
    { header: 'SHOTS' },
    { header: 'BUILD_ID' },
    { header: 'TESTER_ID' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((sub) => {
    const shots = attr<unknown[]>(sub, 'screenshots');
    return [
      (attr<string>(sub, 'createdDate') ?? '').slice(0, 10),
      s(attr(sub, 'deviceModel') ?? ''),
      s(attr(sub, 'osVersion') ?? ''),
      commentPreview(attr(sub, 'comment') ?? ''),
      shots ? String(shots.length) : '',
      rel(sub, 'build')?.id ?? '',
      rel(sub, 'tester')?.id ?? '',
      sub.id,
    ];
  });
  return `${summaryFooter(pages, 'screenshot feedback submissions')} (screenshot image URLs expire — fetch a single submission with asc_get_beta_feedback_screenshot_submission to see url + expirationDate per image)\n\n${formatTable(columns, rows)}`;
}

export function digestBetaFeedbackCrashSubmissions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'CREATED' },
    { header: 'DEVICE' },
    { header: 'OS' },
    { header: 'PLATFORM' },
    { header: 'COMMENT' },
    { header: 'BUILD_ID' },
    { header: 'TESTER_ID' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((sub) => [
    (attr<string>(sub, 'createdDate') ?? '').slice(0, 10),
    s(attr(sub, 'deviceModel') ?? ''),
    s(attr(sub, 'osVersion') ?? ''),
    s(attr(sub, 'devicePlatform') ?? ''),
    commentPreview(attr(sub, 'comment') ?? ''),
    rel(sub, 'build')?.id ?? '',
    rel(sub, 'tester')?.id ?? '',
    sub.id,
  ]);
  return `${summaryFooter(pages, 'crash feedback submissions')} (crash log text: asc_get_beta_feedback_crash_log with the ID)\n\n${formatTable(columns, rows)}`;
}

export function digestBetaRecruitmentCriterionOptions(pages: CollectedPages): string {
  // The options endpoint returns resource(s) whose attributes hold
  // deviceFamilyOsVersions: [{ deviceFamily, osVersions: [...] }] — flatten to
  // one row per device family.
  const columns: Column[] = [{ header: 'DEVICE_FAMILY' }, { header: 'OS_VERSIONS' }];
  const rows: string[][] = [];
  for (const opt of pages.data) {
    const families =
      attr<Array<{ deviceFamily?: string; osVersions?: string[] }>>(
        opt,
        'deviceFamilyOsVersions',
      ) ?? [];
    for (const fam of families) {
      rows.push([s(fam.deviceFamily ?? ''), (fam.osVersions ?? []).join(', ')]);
    }
  }
  return `${summaryFooter(pages, 'criterion option records')} (one row per device family; OS_VERSIONS are the values Apple accepts in deviceFamilyOsVersionFilters min/max)\n\n${formatTable(columns, rows)}`;
}

export function digestWebhooks(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'ENABLED' },
    { header: 'EVENT_TYPES' },
    { header: 'URL' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((wh) => {
    const events = attr<string[]>(wh, 'eventTypes') ?? [];
    const url = s(attr(wh, 'url') ?? '');
    return [
      s(attr(wh, 'name') ?? ''),
      s(attr(wh, 'enabled') ?? ''),
      events.join(', '),
      url.length <= 40 ? url : `${url.slice(0, 37)}...`,
      wh.id,
    ];
  });
  return `${summaryFooter(pages, 'webhooks')} (secret is write-only — never shown)\n\n${formatTable(columns, rows)}`;
}

export function digestWebhookDeliveries(pages: CollectedPages): string {
  const included = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'CREATED' },
    { header: 'STATE' },
    { header: 'REDELIV' },
    { header: 'HTTP' },
    { header: 'EVENT_TYPE' },
    { header: 'ERROR' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((d) => {
    const eventRel = rel(d, 'event');
    const event = lookupIncluded(included, 'webhookEvents', eventRel?.id);
    const eventType = event ? s(attr(event, 'eventType') ?? '') : '';
    const isPing = event ? attr<boolean>(event, 'ping') : undefined;
    const response = attr<{ httpStatusCode?: number }>(d, 'response');
    const error = s(attr(d, 'errorMessage') ?? '');
    return [
      (attr<string>(d, 'createdDate') ?? '').slice(0, 16),
      s(attr(d, 'deliveryState') ?? ''),
      s(attr(d, 'redelivery') ?? ''),
      response?.httpStatusCode !== undefined ? String(response.httpStatusCode) : '',
      isPing === true ? `${eventType || 'PING'} (ping)` : eventType,
      error.length <= 40 ? error : `${error.slice(0, 37)}...`,
      d.id,
    ];
  });
  return `${summaryFooter(pages, 'deliveries')} (retry FAILED rows via asc_post_webhook_redelivery with the ID as template)\n\n${formatTable(columns, rows)}`;
}

export function digestAnalyticsReportRequests(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'ACCESS_TYPE' }, { header: 'STOPPED' }, { header: 'ID' }];
  const rows = pages.data.map((r) => [
    s(attr(r, 'accessType') ?? ''),
    s(attr(r, 'stoppedDueToInactivity') ?? ''),
    r.id,
  ]);
  return `${summaryFooter(pages, 'report requests')} (STOPPED=true on an ONGOING request: Apple auto-paused it — delete + recreate to resume)\n\n${formatTable(columns, rows)}`;
}

export function digestAnalyticsReports(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'CATEGORY' }, { header: 'NAME' }, { header: 'ID' }];
  const rows = pages.data.map((r) => [
    s(attr(r, 'category') ?? ''),
    s(attr(r, 'name') ?? ''),
    r.id,
  ]);
  rows.sort(
    (a, b) => (a[0] ?? '').localeCompare(b[0] ?? '') || (a[1] ?? '').localeCompare(b[1] ?? ''),
  );
  return `${summaryFooter(pages, 'reports')} (drill into one with asc_list_analytics_report_instances)\n\n${formatTable(columns, rows)}`;
}

export function digestAnalyticsReportInstances(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'GRANULARITY' },
    { header: 'PROCESSING_DATE' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((i) => [
    s(attr(i, 'granularity') ?? ''),
    s(attr(i, 'processingDate') ?? ''),
    i.id,
  ]);
  rows.sort((a, b) => (b[1] ?? '').localeCompare(a[1] ?? ''));
  return `${summaryFooter(pages, 'instances')} (newest first; drill with asc_list_analytics_report_segments)\n\n${formatTable(columns, rows)}`;
}

export function digestAnalyticsReportSegments(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'SEG' },
    { header: 'SIZE_BYTES' },
    { header: 'CHECKSUM' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((seg, idx) => [
    `#${idx + 1}`,
    s(attr(seg, 'sizeInBytes') ?? ''),
    s(attr(seg, 'checksum') ?? ''),
    seg.id,
  ]);
  // The download tool needs each URL VERBATIM — never truncate them into a
  // table cell. Full URLs follow the table, numbered to match the SEG column.
  const urls = pages.data
    .map((seg, idx) => `#${idx + 1} ${s(attr(seg, 'url') ?? '(no url)')}`)
    .join('\n');
  return `${summaryFooter(pages, 'segments')} (URLs are pre-signed + time-limited — download promptly with asc_download_analytics_report_segment, passing the URL verbatim)\n\n${formatTable(columns, rows)}\n\nSegment URLs:\n${urls}`;
}

export function digestCustomerReviews(pages: CollectedPages): string {
  const included = buildIncludedIndex(pages.included);
  const columns: Column[] = [
    { header: 'CREATED' },
    { header: 'RATING' },
    { header: 'TERR' },
    { header: 'NICKNAME' },
    { header: 'TITLE' },
    { header: 'BODY' },
    { header: 'RESPONSE' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((review) => {
    const respRel = rel(review, 'response');
    const resp = lookupIncluded(included, 'customerReviewResponses', respRel?.id);
    const respState = resp ? s(attr(resp, 'state') ?? 'YES') : '';
    const title = s(attr(review, 'title') ?? '');
    const body = s(attr(review, 'body') ?? '');
    return [
      (attr<string>(review, 'createdDate') ?? '').slice(0, 10),
      '★'.repeat(Number(attr(review, 'rating') ?? 0)),
      s(attr(review, 'territory') ?? ''),
      s(attr(review, 'reviewerNickname') ?? ''),
      title.length <= 30 ? title : `${title.slice(0, 27)}...`,
      body.length <= 45 ? body : `${body.slice(0, 42)}...`,
      respState,
      review.id,
    ];
  });
  return `${summaryFooter(pages, 'reviews')} (BODY/TITLE previewed — full text via asc_get_customer_review; RESPONSE = developer-reply state, blank = unanswered)\n\n${formatTable(columns, rows)}`;
}

export function digestCustomerReviewSummarizations(pages: CollectedPages): string {
  if (pages.data.length === 0) {
    return `${summaryFooter(pages, 'summarizations')} (none — Apple generates these only where the feature is live and the app has enough reviews)`;
  }
  const blocks = pages.data.map((sum) => {
    const terr = rel(sum, 'territory')?.id ?? '';
    const header = `--- ${s(attr(sum, 'platform') ?? '')} · ${terr} · ${s(attr(sum, 'locale') ?? '')} · ${(attr<string>(sum, 'createdDate') ?? '').slice(0, 10)} · ${sum.id}`;
    return `${header}\n${s(attr(sum, 'text') ?? '(no text)')}`;
  });
  return `${summaryFooter(pages, 'summarizations')}\n\n${blocks.join('\n\n')}`;
}

export function digestVersionExperiments(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'STATE' },
    { header: 'PLATFORM' },
    { header: 'TRAFFIC%' },
    { header: 'REVIEW_REQ' },
    { header: 'START' },
    { header: 'END' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((exp) => [
    s(attr(exp, 'name') ?? ''),
    s(attr(exp, 'state') ?? ''),
    s(attr(exp, 'platform') ?? ''),
    s(attr(exp, 'trafficProportion') ?? ''),
    s(attr(exp, 'reviewRequired') ?? ''),
    (attr<string>(exp, 'startDate') ?? '').slice(0, 10),
    (attr<string>(exp, 'endDate') ?? '').slice(0, 10),
    exp.id,
  ]);
  return `${summaryFooter(pages, 'experiments')} (lifecycle: PREPARE_FOR_SUBMISSION → submit via review submission → APPROVED → patch started=true)\n\n${formatTable(columns, rows)}`;
}

export function digestExperimentTreatments(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'ICON_NAME' },
    { header: 'PROMOTED' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((t) => [
    s(attr(t, 'name') ?? ''),
    s(attr(t, 'appIconName') ?? ''),
    (attr<string>(t, 'promotedDate') ?? '').slice(0, 10),
    t.id,
  ]);
  return `${summaryFooter(pages, 'treatments')} (PROMOTED set = this variant won and was pushed to the live page)\n\n${formatTable(columns, rows)}`;
}

export function digestTreatmentLocalizations(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'LOCALE' }, { header: 'ID' }];
  const rows = pages.data.map((loc) => [s(attr(loc, 'locale') ?? ''), loc.id]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${summaryFooter(pages, 'treatment localizations')} (attach variant assets via the v0.13 set tools with parentType appStoreVersionExperimentTreatmentLocalizations)\n\n${formatTable(columns, rows)}`;
}

export function digestDiagnosticSignatures(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'TYPE' },
    { header: 'WEIGHT' },
    { header: 'SIGNATURE' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((sig) => {
    const signature = s(attr(sig, 'signature') ?? '');
    const weight = attr<number>(sig, 'weight');
    return [
      s(attr(sig, 'diagnosticType') ?? ''),
      weight !== undefined ? weight.toFixed(4) : '',
      signature.length <= 70 ? signature : `${signature.slice(0, 67)}...`,
      sig.id,
    ];
  });
  rows.sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0));
  return `${summaryFooter(pages, 'diagnostic signatures')} (heaviest first; call stacks via asc_get_diagnostic_logs)\n\n${formatTable(columns, rows)}`;
}

export function digestAccessibilityDeclarations(pages: CollectedPages): string {
  const flagKeys = [
    ['supportsVoiceover', 'VO'],
    ['supportsVoiceControl', 'VC'],
    ['supportsLargerText', 'LT'],
    ['supportsDarkInterface', 'DI'],
    ['supportsReducedMotion', 'RM'],
    ['supportsCaptions', 'CAP'],
    ['supportsAudioDescriptions', 'AD'],
    ['supportsSufficientContrast', 'SC'],
    ['supportsDifferentiateWithoutColorAlone', 'DWC'],
  ] as const;
  const columns: Column[] = [
    { header: 'FAMILY' },
    { header: 'STATE' },
    ...flagKeys.map(([, short]) => ({ header: short })),
    { header: 'ID' },
  ];
  const rows = pages.data.map((d) => [
    s(attr(d, 'deviceFamily') ?? ''),
    s(attr(d, 'state') ?? ''),
    ...flagKeys.map(([key]) => {
      const v = attr<boolean>(d, key);
      return v === true ? 'Y' : v === false ? 'N' : '—';
    }),
    d.id,
  ]);
  return `${summaryFooter(pages, 'accessibility declarations')} (VO=VoiceOver VC=VoiceControl LT=LargerText DI=DarkInterface RM=ReducedMotion CAP=Captions AD=AudioDescriptions SC=SufficientContrast DWC=DifferentiateWithoutColor; — = not declared)\n\n${formatTable(columns, rows)}`;
}

export function digestAlternativeDistributionDomains(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'DOMAIN' },
    { header: 'REFERENCE_NAME' },
    { header: 'CREATED' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((d) => [
    s(attr(d, 'domain') ?? ''),
    s(attr(d, 'referenceName') ?? ''),
    (attr<string>(d, 'createdDate') ?? '').slice(0, 10),
    d.id,
  ]);
  return `${summaryFooter(pages, 'domains')}\n\n${formatTable(columns, rows)}`;
}

export function digestAlternativeDistributionPackageVersions(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'VERSION' },
    { header: 'STATE' },
    { header: 'URL_EXPIRES' },
    { header: 'CHECKSUM' },
    { header: 'ID' },
  ];
  const rows = pages.data.map((v) => [
    s(attr(v, 'version') ?? ''),
    s(attr(v, 'state') ?? ''),
    (attr<string>(v, 'urlExpirationDate') ?? '').slice(0, 16),
    s(attr(v, 'fileChecksum') ?? ''),
    v.id,
  ]);
  const urls = pages.data
    .map((v, idx) => `#${idx + 1} ${s(attr(v, 'url') ?? '(no url — state not COMPLETED)')}`)
    .join('\n');
  return `${summaryFooter(pages, 'package versions')} (URLs pre-signed + time-limited — download promptly, never with the ASC bearer)\n\n${formatTable(columns, rows)}\n\nDownload URLs:\n${urls}`;
}

export function digestMarketplaceWebhooks(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'ENDPOINT_URL' }, { header: 'ID' }];
  const rows = pages.data.map((w) => [s(attr(w, 'endpointUrl') ?? ''), w.id]);
  return `${summaryFooter(pages, 'marketplace webhooks')} (secret write-only — never shown)\n\n${formatTable(columns, rows)}`;
}
