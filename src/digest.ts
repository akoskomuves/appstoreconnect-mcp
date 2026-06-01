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
