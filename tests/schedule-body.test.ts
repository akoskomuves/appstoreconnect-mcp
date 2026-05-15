import { describe, expect, it } from 'vitest';
import { APP_SCHEDULE_CONFIG, buildScheduleBody, IAP_SCHEDULE_CONFIG } from '../src/domains/ppp.js';

// These tests pin the JSON:API wire shape for the whole-schedule-replace POST.
// Apple is picky about the relationship name on the inline price rows — IAPs
// use `inAppPurchaseV2` even though the schedule's top-level rel is
// `inAppPurchase`. Easy regression target.

describe('buildScheduleBody (app)', () => {
  const body = buildScheduleBody(APP_SCHEDULE_CONFIG, 'APP-1', 'USA', [
    { territory: 'USA', pricePointId: 'point-usa' },
    { territory: 'BRA', pricePointId: 'point-bra', startDate: '2026-06-01' },
  ]) as {
    data: {
      type: string;
      relationships: {
        app: { data: { type: string; id: string } };
        baseTerritory: { data: { id: string } };
        manualPrices: { data: Array<{ type: string; id: string }> };
      };
    };
    included: Array<{
      type: string;
      id: string;
      attributes: Record<string, unknown>;
      relationships: Record<string, { data: { type: string; id: string } }>;
    }>;
  };

  it('uses appPriceSchedules as the schedule type', () => {
    expect(body.data.type).toBe('appPriceSchedules');
  });

  it('points the schedule at the owning app and the base territory', () => {
    expect(body.data.relationships.app.data).toEqual({ type: 'apps', id: 'APP-1' });
    expect(body.data.relationships.baseTerritory.data.id).toBe('USA');
  });

  it('builds one inline appPrice row per entry with temp IDs', () => {
    expect(body.included).toHaveLength(2);
    // Apple's JSON:API temp-ID convention for unsaved resources is `${N}` —
    // these are literal strings on the wire, not template substitutions. We
    // build them via concatenation so biome's noTemplateCurlyInString rule
    // doesn't false-flag them.
    const tempId = (n: number) => `$${'{'}${n}${'}'}`;
    expect(body.included[0]?.id).toBe(tempId(1));
    expect(body.included[1]?.id).toBe(tempId(2));
    expect(body.included.every((r) => r.type === 'appPrices')).toBe(true);
  });

  it('uses `app` as the inline price-row owning relationship', () => {
    expect(body.included[0]?.relationships.app?.data).toEqual({ type: 'apps', id: 'APP-1' });
  });

  it('omits startDate on the base row, sets it on others', () => {
    expect(body.included[0]?.attributes).toEqual({});
    expect(body.included[1]?.attributes).toEqual({ startDate: '2026-06-01' });
  });

  it('uses appPricePoint as the price-point relationship', () => {
    expect(body.included[0]?.relationships.appPricePoint?.data).toEqual({
      type: 'appPricePoints',
      id: 'point-usa',
    });
  });
});

describe('buildScheduleBody (iap)', () => {
  const body = buildScheduleBody(IAP_SCHEDULE_CONFIG, 'IAP-1', 'USA', [
    { territory: 'USA', pricePointId: 'iap-point-usa' },
    { territory: 'JPN', pricePointId: 'iap-point-jpn', startDate: '2026-06-01' },
  ]) as {
    data: {
      type: string;
      relationships: {
        inAppPurchase: { data: { type: string; id: string } };
      };
    };
    included: Array<{
      type: string;
      relationships: Record<string, { data: { type: string; id: string } }>;
    }>;
  };

  it('uses inAppPurchasePriceSchedules as the schedule type', () => {
    expect(body.data.type).toBe('inAppPurchasePriceSchedules');
  });

  it('top-level rel on the schedule is inAppPurchase', () => {
    expect(body.data.relationships.inAppPurchase.data).toEqual({
      type: 'inAppPurchases',
      id: 'IAP-1',
    });
  });

  it('inline price rows use inAppPurchaseV2 (NOT inAppPurchase) — Apple spec quirk', () => {
    expect(body.included[0]?.relationships.inAppPurchaseV2?.data).toEqual({
      type: 'inAppPurchases',
      id: 'IAP-1',
    });
    expect(body.included[0]?.relationships.inAppPurchase).toBeUndefined();
  });

  it('uses inAppPurchasePricePoint as the price-point relationship', () => {
    expect(body.included[0]?.relationships.inAppPurchasePricePoint?.data).toEqual({
      type: 'inAppPurchasePricePoints',
      id: 'iap-point-usa',
    });
  });
});
