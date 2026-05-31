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
