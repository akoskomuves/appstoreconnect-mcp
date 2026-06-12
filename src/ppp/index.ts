import indexData from '../../data/apple-music-prices.json' with { type: 'json' };

export interface AppleMusicEntry {
  territory: string;
  currency: string;
  individualPrice: number;
}

export interface AppleMusicIndex {
  snapshot: string;
  anchor: string;
  prices: AppleMusicEntry[];
}

export type RoundStrategy = 'nearest' | 'down' | 'up';

export function loadIndex(): AppleMusicIndex {
  const { snapshot, anchor, prices } = indexData as AppleMusicIndex & {
    $comment?: string;
  };
  return { snapshot, anchor, prices };
}

export function indexAsMap(index: AppleMusicIndex): Map<string, AppleMusicEntry> {
  return new Map(index.prices.map((p) => [p.territory, p]));
}

/**
 * PPP factor for a territory: how many local-currency units of *this market's
 * purchasing power* correspond to one anchor-currency unit. Computed from
 * Apple Music's own pricing — using the company's own market signal as the
 * implied PPP-FX rate, which sidesteps the need for a separate FX feed.
 */
export function computeFactor(localPrice: number, anchorPrice: number): number {
  if (anchorPrice === 0) throw new Error('Anchor price cannot be zero.');
  return localPrice / anchorPrice;
}

export function computeTarget(basePriceAnchor: number, factor: number): number {
  return basePriceAnchor * factor;
}

/**
 * Apply a sanity floor: never drop below `floorFactor × current local price`.
 * Guards against bad index data accidentally setting near-zero prices.
 */
export function applyFloor(target: number, currentLocal: number, floorFactor: number): number {
  const floor = currentLocal * floorFactor;
  return target < floor ? floor : target;
}

/**
 * Snap `target` to the nearest valid price-point amount according to the chosen
 * strategy. Returns undefined when no candidate is suitable (e.g. all candidates
 * are above target and strategy is 'down').
 */
export function snapToTier(
  target: number,
  candidates: number[],
  strategy: RoundStrategy = 'nearest',
): number | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => a - b);
  if (strategy === 'down') {
    let pick: number | undefined;
    for (const c of sorted) {
      if (c <= target) pick = c;
      else break;
    }
    return pick ?? sorted[0];
  }
  if (strategy === 'up') {
    for (const c of sorted) {
      if (c >= target) return c;
    }
    return sorted[sorted.length - 1];
  }
  // nearest — ties resolve toward the lower candidate (more conservative).
  let best: number | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of sorted) {
    const d = Math.abs(c - target);
    if (d < bestDist || (d === bestDist && c < (best ?? Number.POSITIVE_INFINITY))) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Parse a customerPrice string from the ASC API. Strings carry currency-specific
 * decimal places without a separator (e.g. "29.99" or "1490" or "1499.99").
 * We treat them all as JS numbers since each subscription is single-currency.
 */
export function parseDecimal(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function percentChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

/**
 * Real-FX factor for currency-mismatch territories (v0.22).
 *
 * The plain `computeFactor` is only dimensionally valid when the index
 * entry's currency equals the territory's ASC billing currency. When they
 * differ (USD-billed Gulf storefronts vs BHD/KWD/OMR-priced Apple Music),
 * user-supplied FX rates rescue the territory:
 *
 *   factor = (indexLocal × usd(indexCcy)) / (anchorLocal × usd(anchorCcy))
 *   target_billing = basePriceAnchor × factor / usd(billingCcy) × usd(anchorCcy)
 *
 * `usdPerUnit` maps a currency code to the USD value of ONE unit of it
 * (e.g. { BHD: 2.65, EUR: 1.16 }); USD itself defaults to 1. Rates are
 * USER-SUPPLIED by design — this server only ever talks to Apple's API and
 * adding a third-party FX feed would widen its egress surface.
 *
 * Returns undefined when any needed rate is missing — callers fall back to
 * the currency-mismatch skip.
 */
export function fxAdjustedTarget(args: {
  basePriceAnchor: number;
  indexLocal: number;
  indexCurrency: string;
  anchorLocal: number;
  anchorCurrency: string;
  billingCurrency: string;
  usdPerUnit: Record<string, number>;
}): { factor: number; targetLocal: number } | undefined {
  const rate = (ccy: string): number | undefined => (ccy === 'USD' ? 1 : args.usdPerUnit[ccy]);
  const idx = rate(args.indexCurrency);
  const anchor = rate(args.anchorCurrency);
  const billing = rate(args.billingCurrency);
  if (idx === undefined || anchor === undefined || billing === undefined) return undefined;
  if (idx <= 0 || anchor <= 0 || billing <= 0 || args.anchorLocal === 0) return undefined;
  // Dimensionless PPP factor with both sides in USD terms.
  const factor = (args.indexLocal * idx) / (args.anchorLocal * anchor);
  // basePriceAnchor is in the anchor's currency; convert anchor → USD →
  // billing currency.
  const targetLocal = (args.basePriceAnchor * factor * anchor) / billing;
  return { factor, targetLocal };
}
