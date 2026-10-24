import { describe, expect, it } from 'vitest';
import {
  buildIapCreateBody,
  buildIapPatchBody,
  evaluateIapDeleteGate,
} from '../src/domains/iap-products.js';

describe('buildIapCreateBody', () => {
  it('sends the three required attributes and the app relationship', () => {
    expect(
      buildIapCreateBody({
        appId: 'APP-1',
        productId: 'com.example.coins',
        name: 'Coins 100',
        inAppPurchaseType: 'CONSUMABLE',
      }),
    ).toEqual({
      data: {
        type: 'inAppPurchases',
        attributes: {
          name: 'Coins 100',
          productId: 'com.example.coins',
          inAppPurchaseType: 'CONSUMABLE',
        },
        relationships: { app: { data: { type: 'apps', id: 'APP-1' } } },
      },
    });
  });

  it('adds optional reviewNote / familySharable only when given', () => {
    const body = buildIapCreateBody({
      appId: 'A',
      productId: 'p',
      name: 'n',
      inAppPurchaseType: 'NON_CONSUMABLE',
      familySharable: false,
    });
    expect(body.data.attributes).toMatchObject({ familySharable: false });
    expect('reviewNote' in (body.data.attributes ?? {})).toBe(false);
  });
});

describe('buildIapPatchBody', () => {
  it('never sends productId or inAppPurchaseType, passes null through to clear', () => {
    const body = buildIapPatchBody({ iapId: 'I', reviewNote: null, name: 'x' });
    expect(body).toEqual({
      data: { type: 'inAppPurchases', id: 'I', attributes: { name: 'x', reviewNote: null } },
    });
  });
});

describe('evaluateIapDeleteGate', () => {
  it('allows drafts and unknown state', () => {
    for (const s of [
      'MISSING_METADATA',
      'WAITING_FOR_UPLOAD',
      'READY_TO_SUBMIT',
      'REJECTED',
      undefined,
    ]) {
      expect(evaluateIapDeleteGate(s).allow).toBe(true);
    }
  });
  it('refuses under review and shipped states with a remedy', () => {
    for (const s of ['IN_REVIEW', 'WAITING_FOR_REVIEW', 'APPROVED', 'REMOVED_FROM_SALE']) {
      const g = evaluateIapDeleteGate(s);
      expect(g.allow).toBe(false);
      expect(g.next).toBeTruthy();
    }
    expect(evaluateIapDeleteGate('APPROVED').next).toContain('asc_post_iap_availability');
  });
});
