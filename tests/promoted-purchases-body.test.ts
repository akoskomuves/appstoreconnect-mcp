import { describe, expect, it } from 'vitest';
import {
  buildPromotedPurchaseCreateBody,
  buildPromotedPurchasePatchBody,
  buildPromotedPurchasesOrderBody,
} from '../src/domains/promoted-purchases.js';

// Pin the wire shape for the PromotedPurchase writes + the per-app
// ordering linkages PATCH.
//
// Quirks driving these assertions:
//   1. WIRE-KEY GOTCHAS — `isVisibleForAllUsers` → wire `visibleForAllUsers`,
//      `isEnabled` → wire `enabled` (same is-prefix-strip family as
//      v0.13 AppCustomProductPage.isVisible and AppTag.isVisibleInAppStore).
//   2. Create requires exactly one of inAppPurchaseV2 / subscription
//      relationship — body builder lets caller send either or neither
//      (the tool layer enforces the one-of constraint with a clear error;
//      body shape is permissive).
//   3. AppPromotedPurchasesLinkagesRequest is BARE ARRAY-under-data — no
//      `attributes` / `relationships` envelope. Apple uses the ARRAY ORDER
//      as the storefront display order.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildPromotedPurchaseCreateBody', () => {
  it('emits wire key `visibleForAllUsers` (NOT Swift `isVisibleForAllUsers`)', () => {
    const body = buildPromotedPurchaseCreateBody({
      appId: 'APP-1',
      visibleForAllUsers: true,
      inAppPurchaseV2Id: 'IAP-1',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.visibleForAllUsers).toBe(true);
    expect('isVisibleForAllUsers' in attrs).toBe(false);
  });

  it('emits wire key `enabled` (NOT Swift `isEnabled`) when provided', () => {
    const body = buildPromotedPurchaseCreateBody({
      appId: 'APP-1',
      visibleForAllUsers: false,
      enabled: true,
      subscriptionId: 'SUB-1',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.enabled).toBe(true);
    expect('isEnabled' in attrs).toBe(false);
  });

  it('OMITS enabled when not provided (encodeIfPresent)', () => {
    const body = buildPromotedPurchaseCreateBody({
      appId: 'APP-1',
      visibleForAllUsers: false,
      inAppPurchaseV2Id: 'IAP-1',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs).toEqual({ visibleForAllUsers: false });
    expect('enabled' in attrs).toBe(false);
  });

  it('attaches inAppPurchaseV2 with type "inAppPurchases" (NOT "inAppPurchaseV2")', () => {
    const body = buildPromotedPurchaseCreateBody({
      appId: 'APP-1',
      visibleForAllUsers: true,
      inAppPurchaseV2Id: 'IAP-1',
    }) as Body;
    const rels = body.data.relationships as Record<string, { data: { type: string; id: string } }>;
    expect(rels.inAppPurchaseV2?.data).toEqual({ type: 'inAppPurchases', id: 'IAP-1' });
    expect('subscription' in rels).toBe(false);
  });

  it('attaches subscription with type "subscriptions"', () => {
    const body = buildPromotedPurchaseCreateBody({
      appId: 'APP-1',
      visibleForAllUsers: true,
      subscriptionId: 'SUB-1',
    }) as Body;
    const rels = body.data.relationships as Record<string, { data: { type: string; id: string } }>;
    expect(rels.subscription?.data).toEqual({ type: 'subscriptions', id: 'SUB-1' });
    expect('inAppPurchaseV2' in rels).toBe(false);
  });
});

describe('buildPromotedPurchasePatchBody', () => {
  it('uses promotedPurchases type + resource id', () => {
    const body = buildPromotedPurchasePatchBody({
      promotedPurchaseId: 'PP-1',
      enabled: false,
    }) as Body;
    expect(body.data.type).toBe('promotedPurchases');
    expect(body.data.id).toBe('PP-1');
  });

  it('emits both wire-key-stripped attrs when both provided', () => {
    const body = buildPromotedPurchasePatchBody({
      promotedPurchaseId: 'PP-1',
      visibleForAllUsers: false,
      enabled: true,
    }) as Body;
    expect(body.data.attributes).toEqual({ visibleForAllUsers: false, enabled: true });
  });

  it('OMITS undefined attrs', () => {
    const body = buildPromotedPurchasePatchBody({
      promotedPurchaseId: 'PP-1',
      enabled: false,
    }) as Body;
    expect(body.data.attributes).toEqual({ enabled: false });
  });
});

describe('buildPromotedPurchasesOrderBody', () => {
  it('emits bare array under data — NO envelope wrapper', () => {
    const body = buildPromotedPurchasesOrderBody({
      promotedPurchaseIds: ['PP-1', 'PP-2', 'PP-3'],
    });
    expect(body).toEqual({
      data: [
        { type: 'promotedPurchases', id: 'PP-1' },
        { type: 'promotedPurchases', id: 'PP-2' },
        { type: 'promotedPurchases', id: 'PP-3' },
      ],
    });
  });

  it('preserves the input order (Apple uses array order as storefront order)', () => {
    const body = buildPromotedPurchasesOrderBody({
      promotedPurchaseIds: ['Z', 'A', 'M'],
    });
    expect(body.data.map((d) => d.id)).toEqual(['Z', 'A', 'M']);
  });
});
