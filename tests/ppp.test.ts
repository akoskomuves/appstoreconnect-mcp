import { describe, expect, it } from 'vitest';
import {
  applyFloor,
  computeFactor,
  computeTarget,
  fxAdjustedTarget,
  loadIndex,
  parseDecimal,
  percentChange,
  snapToTier,
} from '../src/ppp/index.js';

describe('computeFactor', () => {
  it('is 1.0 for the anchor itself', () => {
    expect(computeFactor(10.99, 10.99)).toBeCloseTo(1.0, 5);
  });

  it('captures emerging-market discount via Apple Music ratio', () => {
    // BRA Apple Music R$21.90 vs USA $10.99 → 1.99 BRL per USD-of-purchasing-power.
    expect(computeFactor(21.9, 10.99)).toBeCloseTo(1.992, 2);
  });

  it('captures premium-market lift', () => {
    // CHE CHF 12.95 vs USA $10.99 → 1.18.
    expect(computeFactor(12.95, 10.99)).toBeCloseTo(1.178, 2);
  });

  it('throws on zero anchor', () => {
    expect(() => computeFactor(10, 0)).toThrow(/Anchor/);
  });
});

describe('computeTarget', () => {
  it('multiplies the anchor base price by the factor', () => {
    expect(computeTarget(29.99, 1.992)).toBeCloseTo(59.74, 2);
    expect(computeTarget(29.99, 1.0)).toBeCloseTo(29.99, 2);
  });
});

describe('applyFloor', () => {
  it('returns the target when above the floor', () => {
    expect(applyFloor(20, 100, 0.15)).toBe(20);
  });

  it('clamps to floor when target is below', () => {
    expect(applyFloor(2, 100, 0.15)).toBe(15);
  });

  it('disables when floorFactor is 0', () => {
    expect(applyFloor(0.5, 100, 0)).toBe(0.5);
  });
});

describe('snapToTier', () => {
  const candidates = [0.99, 1.99, 4.99, 9.99, 14.99, 19.99, 29.99, 49.99, 99.99];

  it('nearest picks the closest candidate', () => {
    expect(snapToTier(15.5, candidates, 'nearest')).toBe(14.99);
    expect(snapToTier(17.5, candidates, 'nearest')).toBe(19.99);
  });

  it('nearest breaks ties toward the lower candidate', () => {
    expect(snapToTier(17.49, candidates, 'nearest')).toBe(14.99);
  });

  it('down picks the highest candidate ≤ target', () => {
    expect(snapToTier(15.5, candidates, 'down')).toBe(14.99);
    expect(snapToTier(15.0, candidates, 'down')).toBe(14.99);
    expect(snapToTier(0.5, candidates, 'down')).toBe(0.99); // below all → return floor
  });

  it('up picks the lowest candidate ≥ target', () => {
    expect(snapToTier(15.5, candidates, 'up')).toBe(19.99);
    expect(snapToTier(200, candidates, 'up')).toBe(99.99); // above all → cap
  });

  it('returns undefined for empty candidates', () => {
    expect(snapToTier(10, [], 'nearest')).toBeUndefined();
  });
});

describe('parseDecimal', () => {
  it('parses well-formed numeric strings', () => {
    expect(parseDecimal('29.99')).toBe(29.99);
    expect(parseDecimal('1490')).toBe(1490);
  });

  it('returns undefined for empty / non-numeric', () => {
    expect(parseDecimal(undefined)).toBeUndefined();
    expect(parseDecimal('')).toBeUndefined();
    expect(parseDecimal('abc')).toBeUndefined();
  });
});

describe('percentChange', () => {
  it('returns negative for drops', () => {
    expect(percentChange(100, 70)).toBeCloseTo(-30, 5);
  });

  it('returns positive for lifts', () => {
    expect(percentChange(100, 130)).toBeCloseTo(30, 5);
  });

  it('returns 0 for zero base', () => {
    expect(percentChange(0, 50)).toBe(0);
  });
});

describe('loadIndex', () => {
  it('loads the bundled snapshot with USA as anchor', () => {
    const index = loadIndex();
    expect(index.anchor).toBe('USA');
    const usa = index.prices.find((p) => p.territory === 'USA');
    expect(usa?.individualPrice).toBe(10.99);
    expect(usa?.currency).toBe('USD');
    // Spot-check a known emerging-market entry exists.
    expect(index.prices.find((p) => p.territory === 'BRA')).toBeDefined();
    expect(index.prices.find((p) => p.territory === 'HUN')).toBeDefined();
  });
});

describe('fxAdjustedTarget (v0.22 real-FX)', () => {
  // Scenario: USD-billed Gulf storefront (billing USD), Apple Music priced
  // in BHD. usdPerUnit: BHD=2.65. Anchor: USA, USD.
  it('rescues a currency-mismatch territory with a dimension-correct factor', () => {
    const out = fxAdjustedTarget({
      basePriceAnchor: 9.99,
      indexLocal: 2.2, // BHD Apple Music price
      indexCurrency: 'BHD',
      anchorLocal: 10.99, // USD Apple Music price (anchor)
      anchorCurrency: 'USD',
      billingCurrency: 'USD',
      usdPerUnit: { BHD: 2.65 },
    });
    expect(out).toBeDefined();
    // factor = (2.2 × 2.65) / (10.99 × 1) ≈ 0.5305
    expect(out?.factor).toBeCloseTo((2.2 * 2.65) / 10.99, 6);
    // target in USD = 9.99 × factor × 1 / 1
    expect(out?.targetLocal).toBeCloseTo(9.99 * ((2.2 * 2.65) / 10.99), 6);
  });

  it('reduces to plain factor math when all currencies match', () => {
    const out = fxAdjustedTarget({
      basePriceAnchor: 9.99,
      indexLocal: 5.0,
      indexCurrency: 'USD',
      anchorLocal: 10.0,
      anchorCurrency: 'USD',
      billingCurrency: 'USD',
      usdPerUnit: {},
    });
    expect(out?.factor).toBeCloseTo(0.5, 9);
    expect(out?.targetLocal).toBeCloseTo(4.995, 9);
  });

  it('converts the target into a non-USD billing currency', () => {
    const out = fxAdjustedTarget({
      basePriceAnchor: 9.99,
      indexLocal: 10.0,
      indexCurrency: 'USD',
      anchorLocal: 10.0,
      anchorCurrency: 'USD',
      billingCurrency: 'EUR',
      usdPerUnit: { EUR: 1.25 },
    });
    // factor = 1; target = 9.99 USD → / 1.25 USD-per-EUR = 7.992 EUR
    expect(out?.targetLocal).toBeCloseTo(7.992, 6);
  });

  it('returns undefined when a needed rate is missing or invalid', () => {
    const base = {
      basePriceAnchor: 9.99,
      indexLocal: 2.2,
      indexCurrency: 'BHD',
      anchorLocal: 10.99,
      anchorCurrency: 'USD',
      billingCurrency: 'USD',
    };
    expect(fxAdjustedTarget({ ...base, usdPerUnit: {} })).toBeUndefined();
    expect(fxAdjustedTarget({ ...base, usdPerUnit: { BHD: 0 } })).toBeUndefined();
    expect(fxAdjustedTarget({ ...base, usdPerUnit: { BHD: -1 } })).toBeUndefined();
    expect(
      fxAdjustedTarget({ ...base, anchorLocal: 0, usdPerUnit: { BHD: 2.65 } }),
    ).toBeUndefined();
  });
});
