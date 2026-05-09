import { describe, expect, it } from 'vitest';
import {
  digestApps,
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
            id: '6758548046',
            attributes: { name: 'WikiCatch', bundleId: 'com.akoskomuves.WikiCatch', sku: 'WC1' },
          },
        ],
        total: 1,
      }),
    );
    expect(out).toContain('1 apps');
    expect(out).toContain('WikiCatch');
    expect(out).toContain('com.akoskomuves.WikiCatch');
    expect(out).toContain('6758548046');
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
