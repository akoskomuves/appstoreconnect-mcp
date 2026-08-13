import { describe, expect, it } from 'vitest';
import {
  buildClearPurchaseHistoryBody,
  buildSandboxTesterPatchBody,
} from '../src/domains/sandbox-testers.js';

// Wire-shape pins for the /v2 sandbox-tester writes.
// Load-bearing rules:
//   1. data.type is 'sandboxTesters' (plural) for the PATCH, and the singular
//      'sandboxTestersClearPurchaseHistoryRequest' for the clear-history POST
//      (Apple names that create-request resource in the SINGULAR — easy typo).
//   2. PATCH carries the resource id in the body; only supplied attributes.
//   3. Clear-history is relationships-only: a to-many sandboxTesters linkage,
//      no attributes block.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildSandboxTesterPatchBody', () => {
  it('carries the resource id and only supplied attributes', () => {
    const body = buildSandboxTesterPatchBody({
      testerId: 'TESTER-1',
      subscriptionRenewalRate: 'MONTHLY_RENEWAL_EVERY_FIVE_MINUTES',
    }) as Body;
    expect(body.data.type).toBe('sandboxTesters');
    expect(body.data.id).toBe('TESTER-1');
    expect(body.data.attributes).toEqual({
      subscriptionRenewalRate: 'MONTHLY_RENEWAL_EVERY_FIVE_MINUTES',
    });
  });

  it('interruptPurchases keeps its natural wire key (no is-prefix games)', () => {
    const body = buildSandboxTesterPatchBody({
      testerId: 'TESTER-1',
      interruptPurchases: true,
    }) as Body;
    expect(body.data.attributes).toEqual({ interruptPurchases: true });
  });
});

describe('buildClearPurchaseHistoryBody', () => {
  const body = buildClearPurchaseHistoryBody(['T-1', 'T-2']) as Body;

  it('uses the SINGULAR request type with a to-many testers linkage', () => {
    expect(body.data.type).toBe('sandboxTestersClearPurchaseHistoryRequest');
    expect(
      (body.data.relationships as Record<string, { data: unknown }>).sandboxTesters?.data,
    ).toEqual([
      { type: 'sandboxTesters', id: 'T-1' },
      { type: 'sandboxTesters', id: 'T-2' },
    ]);
  });

  it('has no attributes block', () => {
    expect('attributes' in body.data).toBe(false);
  });
});
