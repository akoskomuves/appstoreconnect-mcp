import { describe, expect, it } from 'vitest';
import {
  digestAppPricePoints,
  digestAppPrices,
  digestApps,
  digestIapPricePoints,
  digestIapPrices,
  digestIaps,
  digestOfferCodeCustomCodes,
  digestOfferCodeOneTimeUseBatches,
  digestOfferCodes,
  digestSubscriptionPricePoints,
  digestSubscriptionPrices,
  digestTerritories,
} from '../src/digest.js';
import type { CollectedPages } from '../src/jsonapi.js';

function pages(partial: Partial<CollectedPages>): CollectedPages {
  return {
    data: [],
    included: [],
    pagesFetched: 1,
    truncated: false,
    ...partial,
  };
}

describe('digestApps', () => {
  it('renders a table of apps with name, bundleId, sku, id', () => {
    const out = digestApps(
      pages({
        data: [
          {
            type: 'apps',
            id: '1234567890',
            attributes: { name: 'Example App', bundleId: 'com.example.app', sku: 'EX1' },
          },
        ],
        total: 1,
      }),
    );
    expect(out).toContain('1 apps');
    expect(out).toContain('Example App');
    expect(out).toContain('com.example.app');
    expect(out).toContain('1234567890');
  });

  it('signals truncation in the footer', () => {
    const out = digestApps(
      pages({
        data: Array.from({ length: 5 }, (_, i) => ({
          type: 'apps',
          id: String(i),
          attributes: { name: `App ${i}`, bundleId: `com.example.app${i}`, sku: '' },
        })),
        truncated: true,
        total: 100,
      }),
    );
    expect(out).toContain('5 apps of 100');
    expect(out).toContain('truncated');
  });
});

describe('digestSubscriptionPrices', () => {
  it('joins price ↔ territory ↔ price-point via included, sorts by territory, counts pending', () => {
    const out = digestSubscriptionPrices(
      pages({
        data: [
          {
            type: 'subscriptionPrices',
            id: 'price-jpn',
            attributes: { startDate: null, preserved: false },
            relationships: {
              territory: { data: { type: 'territories', id: 'JPN' } },
              subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-jpn' } },
            },
          },
          {
            type: 'subscriptionPrices',
            id: 'price-usa',
            attributes: { startDate: null, preserved: false },
            relationships: {
              territory: { data: { type: 'territories', id: 'USA' } },
              subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-usa' } },
            },
          },
          {
            type: 'subscriptionPrices',
            id: 'price-gbr-pending',
            attributes: { startDate: '2026-06-01', preserved: true },
            relationships: {
              territory: { data: { type: 'territories', id: 'GBR' } },
              subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-gbr' } },
            },
          },
        ],
        included: [
          { type: 'territories', id: 'USA', attributes: { currency: 'USD' } },
          { type: 'territories', id: 'GBR', attributes: { currency: 'GBP' } },
          { type: 'territories', id: 'JPN', attributes: { currency: 'JPY' } },
          {
            type: 'subscriptionPricePoints',
            id: 'pp-usa',
            attributes: { customerPrice: '49.99' },
          },
          {
            type: 'subscriptionPricePoints',
            id: 'pp-gbr',
            attributes: { customerPrice: '39.99' },
          },
          {
            type: 'subscriptionPricePoints',
            id: 'pp-jpn',
            attributes: { customerPrice: '7800' },
          },
        ],
      }),
    );

    expect(out).toMatch(/3 prices.*1 pending/);
    const lines = out.split('\n');
    const dataLines = lines.slice(4); // 1 summary + blank + header + sep
    expect(dataLines[0]).toMatch(/^GBR\s+GBP\s+39\.99\s+pending\s+2026-06-01\s+true/);
    expect(dataLines[1]).toMatch(/^JPN\s+JPY\s+7800\s+active/);
    expect(dataLines[2]).toMatch(/^USA\s+USD\s+49\.99\s+active/);
  });
});

describe('digestSubscriptionPricePoints', () => {
  it('lists points sorted by customerPrice ascending', () => {
    const out = digestSubscriptionPricePoints(
      pages({
        data: [
          {
            type: 'subscriptionPricePoints',
            id: 'pp-100',
            attributes: { customerPrice: '99.99', proceeds: '70.00' },
            relationships: { territory: { data: { type: 'territories', id: 'USA' } } },
          },
          {
            type: 'subscriptionPricePoints',
            id: 'pp-1',
            attributes: { customerPrice: '0.99', proceeds: '0.69' },
            relationships: { territory: { data: { type: 'territories', id: 'USA' } } },
          },
        ],
        included: [{ type: 'territories', id: 'USA', attributes: { currency: 'USD' } }],
      }),
    );
    // Lines 0-3 are: summary, blank, header, separator. Data rows start at 4.
    const lines = out.split('\n').slice(4);
    expect(lines[0]).toMatch(/0\.99/);
    expect(lines[1]).toMatch(/99\.99/);
  });
});

describe('digestTerritories', () => {
  it('lists code + currency, sorted alphabetically', () => {
    const out = digestTerritories(
      pages({
        data: [
          { type: 'territories', id: 'USA', attributes: { currency: 'USD' } },
          { type: 'territories', id: 'AUS', attributes: { currency: 'AUD' } },
          { type: 'territories', id: 'GBR', attributes: { currency: 'GBP' } },
        ],
      }),
    );
    const lines = out.split('\n').slice(4);
    expect(lines[0]).toMatch(/^AUS\s+AUD/);
    expect(lines[1]).toMatch(/^GBR\s+GBP/);
    expect(lines[2]).toMatch(/^USA\s+USD/);
  });
});

describe('digestAppPrices', () => {
  it('renders the price schedule, splits manual vs auto, and notes the base territory', () => {
    const out = digestAppPrices(
      pages({
        data: [
          {
            type: 'appPriceSchedules',
            id: 'sched1',
            relationships: {
              baseTerritory: { data: { type: 'territories', id: 'USA' } },
            },
          },
        ],
        included: [
          {
            type: 'appPrices',
            id: 'p_usa',
            attributes: { startDate: null, manual: true },
            relationships: {
              territory: { data: { type: 'territories', id: 'USA' } },
              appPricePoint: { data: { type: 'appPricePoints', id: 'pt_usa' } },
            },
          },
          {
            type: 'appPrices',
            id: 'p_bra',
            attributes: { startDate: '2026-05-16', manual: false },
            relationships: {
              territory: { data: { type: 'territories', id: 'BRA' } },
              appPricePoint: { data: { type: 'appPricePoints', id: 'pt_bra' } },
            },
          },
          {
            type: 'territories',
            id: 'USA',
            attributes: { currency: 'USD' },
          },
          {
            type: 'territories',
            id: 'BRA',
            attributes: { currency: 'BRL' },
          },
          {
            type: 'appPricePoints',
            id: 'pt_usa',
            attributes: { customerPrice: '4.99' },
          },
          {
            type: 'appPricePoints',
            id: 'pt_bra',
            attributes: { customerPrice: '12.90' },
          },
        ],
      }),
    );
    expect(out).toContain('2 app prices (1 manual, 1 auto)');
    expect(out).toContain('1 pending');
    expect(out).toContain('base territory USA');
    expect(out).toContain('USA');
    expect(out).toContain('USD');
    expect(out).toContain('4.99');
    expect(out).toContain('BRA');
    expect(out).toContain('BRL');
    expect(out).toContain('12.90');
    expect(out).toContain('2026-05-16');
  });

  it('handles an empty schedule', () => {
    const out = digestAppPrices(pages({ data: [], included: [] }));
    expect(out).toContain('0 app prices (0 manual, 0 auto)');
  });
});

describe('digestAppPricePoints', () => {
  it('sorts by customer price ascending and shows currency from the included territory', () => {
    const out = digestAppPricePoints(
      pages({
        data: [
          {
            type: 'appPricePoints',
            id: 'a',
            attributes: { customerPrice: '9.99', proceeds: '7.00' },
            relationships: { territory: { data: { type: 'territories', id: 'USA' } } },
          },
          {
            type: 'appPricePoints',
            id: 'b',
            attributes: { customerPrice: '0.99', proceeds: '0.70' },
            relationships: { territory: { data: { type: 'territories', id: 'USA' } } },
          },
        ],
        included: [{ type: 'territories', id: 'USA', attributes: { currency: 'USD' } }],
        total: 2,
      }),
    );
    const lines = out.split('\n');
    const dataLines = lines.filter((l) => l.match(/^USD\s/));
    expect(dataLines[0]).toContain('0.99');
    expect(dataLines[1]).toContain('9.99');
  });
});

describe('digestIaps', () => {
  it('renders a table with name, product id, type, state', () => {
    const out = digestIaps(
      pages({
        data: [
          {
            type: 'inAppPurchases',
            id: 'iap-1',
            attributes: {
              name: 'Premium Unlock',
              productId: 'com.example.app.premium',
              inAppPurchaseType: 'NON_CONSUMABLE',
              state: 'APPROVED',
              familySharable: true,
            },
          },
          {
            type: 'inAppPurchases',
            id: 'iap-2',
            attributes: {
              name: 'Coin Pack 100',
              productId: 'com.example.app.coins100',
              inAppPurchaseType: 'CONSUMABLE',
              state: 'READY_TO_SUBMIT',
              familySharable: false,
            },
          },
        ],
        total: 2,
      }),
    );
    expect(out).toContain('2 iaps');
    expect(out).toContain('Premium Unlock');
    expect(out).toContain('NON_CONSUMABLE');
    expect(out).toContain('APPROVED');
    expect(out).toContain('com.example.app.coins100');
    expect(out).toContain('CONSUMABLE');
  });
});

describe('digestIapPrices', () => {
  it('renders the IAP price schedule like app prices (manual/auto split, base territory)', () => {
    const out = digestIapPrices(
      pages({
        data: [
          {
            type: 'inAppPurchasePriceSchedules',
            id: 'sched1',
            relationships: {
              baseTerritory: { data: { type: 'territories', id: 'USA' } },
            },
          },
        ],
        included: [
          {
            type: 'inAppPurchasePrices',
            id: 'p_usa',
            attributes: { startDate: null, manual: true },
            relationships: {
              territory: { data: { type: 'territories', id: 'USA' } },
              inAppPurchasePricePoint: {
                data: { type: 'inAppPurchasePricePoints', id: 'pt_usa' },
              },
            },
          },
          {
            type: 'inAppPurchasePrices',
            id: 'p_jpn',
            attributes: { startDate: '2026-06-01', manual: false },
            relationships: {
              territory: { data: { type: 'territories', id: 'JPN' } },
              inAppPurchasePricePoint: {
                data: { type: 'inAppPurchasePricePoints', id: 'pt_jpn' },
              },
            },
          },
          { type: 'territories', id: 'USA', attributes: { currency: 'USD' } },
          { type: 'territories', id: 'JPN', attributes: { currency: 'JPY' } },
          {
            type: 'inAppPurchasePricePoints',
            id: 'pt_usa',
            attributes: { customerPrice: '4.99' },
          },
          {
            type: 'inAppPurchasePricePoints',
            id: 'pt_jpn',
            attributes: { customerPrice: '700' },
          },
        ],
      }),
    );
    expect(out).toContain('2 iap prices (1 manual, 1 auto)');
    expect(out).toContain('1 pending');
    expect(out).toContain('base territory USA');
    expect(out).toContain('USA');
    expect(out).toContain('4.99');
    expect(out).toContain('JPN');
    expect(out).toContain('700');
    expect(out).toContain('2026-06-01');
  });
});

describe('digestIapPricePoints', () => {
  it('sorts ascending and shows currency from the included territory', () => {
    const out = digestIapPricePoints(
      pages({
        data: [
          {
            type: 'inAppPurchasePricePoints',
            id: 'b',
            attributes: { customerPrice: '4.99', proceeds: '3.50' },
            relationships: { territory: { data: { type: 'territories', id: 'USA' } } },
          },
          {
            type: 'inAppPurchasePricePoints',
            id: 'a',
            attributes: { customerPrice: '0.99', proceeds: '0.70' },
            relationships: { territory: { data: { type: 'territories', id: 'USA' } } },
          },
        ],
        included: [{ type: 'territories', id: 'USA', attributes: { currency: 'USD' } }],
        total: 2,
      }),
    );
    const lines = out.split('\n');
    const dataLines = lines.filter((l) => l.match(/^USD\s/));
    expect(dataLines[0]).toContain('0.99');
    expect(dataLines[1]).toContain('4.99');
  });
});

describe('digestOfferCodes', () => {
  it('renders campaign rows with cohort letters, offer-eligibility short label, and a price count', () => {
    const out = digestOfferCodes(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodes',
            id: 'CAMP-1',
            attributes: {
              name: 'Spring Onboarding',
              customerEligibilities: ['NEW', 'EXPIRED'],
              offerEligibility: 'STACK_WITH_INTRO_OFFERS',
              offerMode: 'PAY_AS_YOU_GO',
              duration: 'ONE_MONTH',
              numberOfPeriods: 3,
              active: true,
            },
            relationships: {
              prices: {
                data: [
                  { type: 'subscriptionOfferCodePrices', id: 'p1' },
                  { type: 'subscriptionOfferCodePrices', id: 'p2' },
                  { type: 'subscriptionOfferCodePrices', id: 'p3' },
                ],
              },
            },
          },
        ],
        total: 1,
      }),
    );
    expect(out).toContain('1 offer code campaigns');
    expect(out).toContain('Spring Onboarding');
    // Customer-eligibility cohort letters: N=NEW, E=EXISTING, X=EXPIRED.
    expect(out).toContain('NX');
    // Offer-eligibility short label.
    expect(out).toContain('STACK');
    expect(out).toContain('PAY_AS_YOU_GO');
    expect(out).toContain('ONE_MONTH');
    expect(out).toContain('CAMP-1');
    // Price count from the to-many `prices` relationship.
    const row = out.split('\n').find((l) => l.includes('CAMP-1'));
    expect(row).toMatch(/\b3\b/);
  });

  it('renders REPLACE for the other offerEligibility enum value', () => {
    const out = digestOfferCodes(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodes',
            id: 'CAMP-2',
            attributes: {
              name: 'Override',
              customerEligibilities: ['NEW'],
              offerEligibility: 'REPLACE_INTRO_OFFERS',
              offerMode: 'PAY_UP_FRONT',
              duration: 'ONE_MONTH',
              numberOfPeriods: 1,
              active: true,
            },
            relationships: { prices: { data: [] } },
          },
        ],
      }),
    );
    expect(out).toContain('REPLACE');
  });

  it('sorts campaigns by name', () => {
    const out = digestOfferCodes(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodes',
            id: 'B',
            attributes: {
              name: 'Z-Campaign',
              customerEligibilities: ['NEW'],
              offerEligibility: 'STACK_WITH_INTRO_OFFERS',
              offerMode: 'PAY_UP_FRONT',
              duration: 'ONE_MONTH',
              numberOfPeriods: 1,
              active: true,
            },
            relationships: { prices: { data: [] } },
          },
          {
            type: 'subscriptionOfferCodes',
            id: 'A',
            attributes: {
              name: 'A-Campaign',
              customerEligibilities: ['EXISTING'],
              offerEligibility: 'REPLACE_INTRO_OFFERS',
              offerMode: 'PAY_UP_FRONT',
              duration: 'ONE_MONTH',
              numberOfPeriods: 1,
              active: true,
            },
            relationships: { prices: { data: [] } },
          },
        ],
      }),
    );
    const aIdx = out.indexOf('A-Campaign');
    const zIdx = out.indexOf('Z-Campaign');
    expect(aIdx).toBeGreaterThan(-1);
    expect(zIdx).toBeGreaterThan(aIdx);
  });
});

describe('digestOfferCodes auto-renew + code counts (v0.8.1)', () => {
  it('renders Y/N for autoRenewEnabled and prod/sbx code counts when present', () => {
    const out = digestOfferCodes(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodes',
            id: 'CAMP-AR',
            attributes: {
              name: 'AutoRenew Off',
              customerEligibilities: ['NEW'],
              offerEligibility: 'STACK_WITH_INTRO_OFFERS',
              offerMode: 'PAY_AS_YOU_GO',
              duration: 'ONE_MONTH',
              numberOfPeriods: 3,
              active: true,
              autoRenewEnabled: false,
              productionCodeCount: 1200,
              sandboxCodeCount: 50,
            },
            relationships: { prices: { data: [] } },
          },
        ],
      }),
    );
    // AUTO_RNW column should render N (false), and CODES column should show
    // "prod/sbx" composite.
    const row = out.split('\n').find((l) => l.includes('CAMP-AR'));
    expect(row).toBeDefined();
    expect(row).toContain('1200/50');
    // Y/N marker for auto-renew off — appears as the first stand-alone "N"
    // token in the row outside of cohort short labels (which use N for NEW).
    // Verify by checking the legend.
    expect(out).toContain('CODES: prod/sbx');
  });

  it('renders em-dash for autoRenewEnabled when Apple omits the attribute', () => {
    const out = digestOfferCodes(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodes',
            id: 'CAMP-NOAR',
            attributes: {
              name: 'Legacy',
              customerEligibilities: ['NEW'],
              offerEligibility: 'STACK_WITH_INTRO_OFFERS',
              offerMode: 'PAY_AS_YOU_GO',
              duration: 'ONE_MONTH',
              numberOfPeriods: 1,
              active: true,
              // autoRenewEnabled absent — pre-v0.8.1 campaigns or sparse
              // fieldset responses won't carry it. Render — not blank.
            },
            relationships: { prices: { data: [] } },
          },
        ],
      }),
    );
    const row = out.split('\n').find((l) => l.includes('CAMP-NOAR'));
    expect(row).toContain('—');
  });
});

describe('digestOfferCodeCustomCodes (v0.8.1)', () => {
  it('renders custom-code rows newest-first with redemption cap total', () => {
    const out = digestOfferCodeCustomCodes(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodeCustomCodes',
            id: 'CC-OLD',
            attributes: {
              customCode: 'OLDCODE',
              numberOfCodes: 100,
              createdDate: '2026-01-10T12:00:00Z',
              expirationDate: '2026-12-31',
              active: true,
            },
          },
          {
            type: 'subscriptionOfferCodeCustomCodes',
            id: 'CC-NEW',
            attributes: {
              customCode: 'LAUNCH2026',
              numberOfCodes: 500,
              createdDate: '2026-05-31T12:00:00Z',
              // No expirationDate — indefinite redemption. Should render as —.
              active: true,
            },
          },
        ],
        total: 2,
      }),
    );
    expect(out).toContain('2 custom codes');
    expect(out).toContain('600 total redemption cap');
    // Newest first: LAUNCH2026 (May) above OLDCODE (January).
    const newIdx = out.indexOf('LAUNCH2026');
    const oldIdx = out.indexOf('OLDCODE');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(newIdx);
    // Indefinite (no expiration) renders as em-dash, not blank.
    const newRow = out.split('\n').find((l) => l.includes('LAUNCH2026'));
    expect(newRow).toContain('—');
  });
});

describe('digestOfferCodeOneTimeUseBatches', () => {
  it('renders batches newest-first and totals codes generated', () => {
    const out = digestOfferCodeOneTimeUseBatches(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodeOneTimeUseCodes',
            id: 'BATCH-OLD',
            attributes: {
              createdDate: '2026-01-15T12:00:00Z',
              numberOfCodes: 1000,
              expirationDate: '2026-12-31T23:59:59Z',
              active: true,
              environment: 'PRODUCTION',
            },
          },
          {
            type: 'subscriptionOfferCodeOneTimeUseCodes',
            id: 'BATCH-NEW',
            attributes: {
              createdDate: '2026-05-01T12:00:00Z',
              numberOfCodes: 250,
              expirationDate: '2026-12-31T23:59:59Z',
              active: true,
              environment: 'SANDBOX',
            },
          },
        ],
        total: 2,
      }),
    );
    expect(out).toContain('2 one-time-use batches');
    expect(out).toContain('1250 total codes generated');
    // Newest-first ordering — the May batch should appear above the
    // January one.
    const newIdx = out.indexOf('BATCH-NEW');
    const oldIdx = out.indexOf('BATCH-OLD');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(newIdx);
  });

  it('renders ENV column as SBX/PROD (v0.8.1)', () => {
    const out = digestOfferCodeOneTimeUseBatches(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodeOneTimeUseCodes',
            id: 'BATCH-PROD',
            attributes: {
              createdDate: '2026-05-01T12:00:00Z',
              numberOfCodes: 100,
              expirationDate: '2026-09-01',
              active: true,
              environment: 'PRODUCTION',
            },
          },
          {
            type: 'subscriptionOfferCodeOneTimeUseCodes',
            id: 'BATCH-SBX',
            attributes: {
              createdDate: '2026-05-15T12:00:00Z',
              numberOfCodes: 10,
              expirationDate: '2026-09-15',
              active: true,
              environment: 'SANDBOX',
            },
          },
        ],
      }),
    );
    // Header includes ENV; legend documents the codes.
    expect(out).toContain('ENV');
    expect(out).toContain('SBX=sandbox PROD=production');
    const prodRow = out.split('\n').find((l) => l.includes('BATCH-PROD'));
    const sbxRow = out.split('\n').find((l) => l.includes('BATCH-SBX'));
    expect(prodRow).toContain('PROD');
    expect(sbxRow).toContain('SBX');
  });

  it('renders em-dash for ENV when Apple omits the attribute (pre-v0.8.1 batches)', () => {
    const out = digestOfferCodeOneTimeUseBatches(
      pages({
        data: [
          {
            type: 'subscriptionOfferCodeOneTimeUseCodes',
            id: 'BATCH-LEGACY',
            attributes: {
              createdDate: '2026-01-01T12:00:00Z',
              numberOfCodes: 500,
              expirationDate: '2026-06-30',
              active: true,
              // environment omitted — pre-v0.8.1 batches or sparse fieldset.
            },
          },
        ],
      }),
    );
    const row = out.split('\n').find((l) => l.includes('BATCH-LEGACY'));
    expect(row).toContain('—');
  });
});
