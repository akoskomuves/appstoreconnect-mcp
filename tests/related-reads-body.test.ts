import { describe, expect, it } from 'vitest';
import {
  BY_ID_READS,
  buildByIdPath,
  buildEqualizationsPath,
  buildPerformanceOverviewPath,
  buildPriceSchedulePricesPath,
  buildRelatedPath,
  buildTesterUsagePath,
  digestRelatedMany,
  findRelatedRead,
  RELATED_READS,
  relatedKey,
} from '../src/domains/related-reads.js';

const cfg = (key: string) => {
  const c = findRelatedRead(key);
  if (!c) throw new Error(`missing ${key}`);
  return c;
};

describe('RELATED_READS table', () => {
  it('has unique keys', () => {
    const keys = RELATED_READS.map(relatedKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique by-id tool names', () => {
    const names = BY_ID_READS.map((c) => c.tool);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('buildRelatedPath', () => {
  it('builds a to-one path with no query', () => {
    expect(buildRelatedPath(cfg('builds.app'), 'B 1').path).toBe('/v1/builds/B%201/app');
  });

  it('adds limit=200 on to-many paths', () => {
    expect(buildRelatedPath(cfg('profiles.devices'), 'P').path).toBe(
      '/v1/profiles/P/devices?limit=200',
    );
  });

  it('uses the configured API version', () => {
    expect(buildRelatedPath(cfg('inAppPurchases.content'), 'I').path).toBe(
      '/v2/inAppPurchases/I/content',
    );
  });

  it('maps allowed filters to filter[name]', () => {
    expect(
      buildRelatedPath(cfg('subscriptionOfferCodes.prices'), 'O', { territory: 'USA' }).path,
    ).toBe('/v1/subscriptionOfferCodes/O/prices?filter%5Bterritory%5D=USA&limit=200');
  });

  it('leaves limit off where Apple refuses it', () => {
    expect(buildRelatedPath(cfg('bundleIds.bundleIdCapabilities'), 'B').path).toBe(
      '/v1/bundleIds/B/bundleIdCapabilities',
    );
  });

  it('refuses a filter the path does not take', () => {
    const r = buildRelatedPath(cfg('builds.icons'), 'B', { territory: 'USA' });
    expect(r.path).toBeUndefined();
    expect(r.error).toContain('allowed: none');
  });
});

describe('buildByIdPath', () => {
  it('encodes the id and honours v3', () => {
    const v3 = BY_ID_READS.find((c) => c.tool === 'asc_get_app_price_point_v3');
    if (!v3) throw new Error('missing');
    expect(buildByIdPath(v3, 'a/b')).toBe('/v3/appPricePoints/a%2Fb');
  });
});

describe('buildPriceSchedulePricesPath', () => {
  it('reads manual app prices with a date window', () => {
    expect(
      buildPriceSchedulePricesPath('appPriceSchedules', 'APP', 'manual', {
        territory: 'USA',
        startDate: '2026-01-01',
      }),
    ).toBe(
      '/v1/appPriceSchedules/APP/manualPrices?filter%5Bterritory%5D=USA&filter%5BstartDate%5D=2026-01-01&limit=200',
    );
  });

  it('drops date filters on the IAP schedule (Apple has none there)', () => {
    expect(
      buildPriceSchedulePricesPath('inAppPurchasePriceSchedules', 'IAP', 'automatic', {
        startDate: '2026-01-01',
      }),
    ).toBe('/v1/inAppPurchasePriceSchedules/IAP/automaticPrices?limit=200');
  });
});

describe('buildEqualizationsPath', () => {
  it('routes each kind to its own path', () => {
    expect(buildEqualizationsPath({ kind: 'app', pricePointId: 'X' })).toBe(
      '/v3/appPricePoints/X/equalizations?limit=200',
    );
    expect(buildEqualizationsPath({ kind: 'iap', pricePointId: 'X' })).toBe(
      '/v1/inAppPurchasePricePoints/X/equalizations?limit=200',
    );
  });

  it('reads adjustedEqualizations with the required planType', () => {
    expect(
      buildEqualizationsPath({
        kind: 'subscription',
        pricePointId: 'X',
        adjusted: true,
        planType: 'MONTHLY',
      }),
    ).toBe(
      '/v1/subscriptionPricePoints/X/adjustedEqualizations?filter%5BplanType%5D=MONTHLY&limit=200',
    );
  });

  it('never sends planType on a non-subscription path', () => {
    expect(buildEqualizationsPath({ kind: 'app', pricePointId: 'X', planType: 'MONTHLY' })).toBe(
      '/v3/appPricePoints/X/equalizations?limit=200',
    );
  });
});

describe('buildTesterUsagePath', () => {
  it('app scope with period and groupBy', () => {
    expect(buildTesterUsagePath({ appId: 'A', period: 'P30D', groupByTester: true }).path).toBe(
      '/v1/apps/A/metrics/betaTesterUsages?period=P30D&groupBy=betaTesters&limit=200',
    );
  });

  it('group scope', () => {
    expect(buildTesterUsagePath({ betaGroupId: 'G' }).path).toBe(
      '/v1/betaGroups/G/metrics/betaTesterUsages?groupBy=betaTesters&limit=200',
    );
  });

  it('tester scope sends filter[apps], which Apple requires', () => {
    expect(buildTesterUsagePath({ betaTesterId: 'T', appId: 'A', period: 'P7D' }).path).toBe(
      '/v1/betaTesters/T/metrics/betaTesterUsages?period=P7D&filter%5Bapps%5D=A&limit=200',
    );
  });

  it('always groups app/group scope per tester (Apple requires groupBy or filter)', () => {
    expect(buildTesterUsagePath({ appId: 'A', period: 'P7D' }).path).toBe(
      '/v1/apps/A/metrics/betaTesterUsages?period=P7D&groupBy=betaTesters&limit=200',
    );
    expect(buildTesterUsagePath({ appId: 'A', betaTesterFilter: 'T' }).path).toBe(
      '/v1/apps/A/metrics/betaTesterUsages?groupBy=betaTesters&filter%5BbetaTesters%5D=T&limit=200',
    );
  });

  it('refuses a tester scope without appId', () => {
    expect(buildTesterUsagePath({ betaTesterId: 'T' }).error).toContain('filter[apps]');
  });

  it('refuses no scope, and two scopes', () => {
    expect(buildTesterUsagePath({}).error).toBeDefined();
    expect(buildTesterUsagePath({ appId: 'A', betaGroupId: 'G' }).error).toBeDefined();
    expect(
      buildTesterUsagePath({ betaTesterId: 'T', betaGroupId: 'G', appId: 'A' }).error,
    ).toBeDefined();
  });

  it('refuses groupBy on the tester scope', () => {
    expect(
      buildTesterUsagePath({ betaTesterId: 'T', appId: 'A', groupByTester: true }).error,
    ).toBeDefined();
  });
});

describe('buildPerformanceOverviewPath', () => {
  it('omits the query without device types', () => {
    expect(buildPerformanceOverviewPath('A')).toBe('/v1/apps/A/performanceOverviews');
  });

  it('joins device types into one filter', () => {
    expect(buildPerformanceOverviewPath('A', ['iPhone', 'iPad'])).toBe(
      '/v1/apps/A/performanceOverviews?filter%5BdeviceType%5D=iPhone%2CiPad',
    );
  });
});

describe('digestRelatedMany', () => {
  it('says so when empty', () => {
    expect(
      digestRelatedMany({ data: [], included: [], pagesFetched: 1, truncated: false }, 'devices'),
    ).toBe('No devices found.');
  });

  it('tables id, type and scalar attributes, skipping objects', () => {
    const out = digestRelatedMany(
      {
        data: [
          {
            type: 'devices',
            id: 'D1',
            attributes: { name: 'Phone', platform: 'IOS', meta: { a: 1 } },
          },
          { type: 'devices', id: 'D2', attributes: { name: 'Pad', platform: null } },
        ],
        included: [],
        pagesFetched: 1,
        truncated: true,
      },
      'devices',
    );
    expect(out).toContain('2 devices (truncated');
    expect(out).toContain('name');
    expect(out).toContain('platform');
    expect(out).not.toContain('meta');
    expect(out).toMatch(/D2\s+devices\s+Pad/);
  });
});
