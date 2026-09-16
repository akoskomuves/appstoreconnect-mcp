import { describe, expect, it } from 'vitest';
import {
  buildSubscriptionCreateBody,
  buildSubscriptionGroupCreateBody,
  buildSubscriptionGroupPatchBody,
  buildSubscriptionPatchBody,
  evaluateSubscriptionDeleteGate,
  evaluateSubscriptionGroupDeleteGate,
} from '../src/domains/subscriptions.js';

// Pin the wire shape for the four writable endpoints that create the
// subscription hierarchy itself:
//   POST   /v1/subscriptionGroups
//   PATCH  /v1/subscriptionGroups/{id}
//   POST   /v1/subscriptions
//   PATCH  /v1/subscriptions/{id}
//
// Apple's contract (OpenAPI spec 4.4.1) driving these assertions:
//   1. Group create: referenceName REQUIRED + app rel REQUIRED. Group patch
//      carries referenceName and nothing else — no app rel, groups do not
//      move between apps.
//   2. Subscription create: name + productId REQUIRED + group rel REQUIRED.
//      subscriptionPeriod / familySharable / reviewNote / groupLevel are all
//      encodeIfPresent — an omitted key is NOT the same as a null key.
//   3. productId is ABSENT from SubscriptionUpdateRequest. The patch builder
//      must have no codepath that can emit it: the identifier is permanent
//      because receipts and live entitlements key off it.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildSubscriptionGroupCreateBody', () => {
  it('uses subscriptionGroups type with referenceName + app relationship', () => {
    const body = buildSubscriptionGroupCreateBody({
      appId: 'APP-1',
      referenceName: 'MeritValue Premium (grp)',
    }) as Body;
    expect(body.data.type).toBe('subscriptionGroups');
    expect(body.data.attributes).toEqual({ referenceName: 'MeritValue Premium (grp)' });
    const rels = body.data.relationships as { app: { data: { type: string; id: string } } };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
  });

  it('never sends an id on create', () => {
    const body = buildSubscriptionGroupCreateBody({ appId: 'APP-1', referenceName: 'G' }) as Body;
    expect(body.data.id).toBeUndefined();
  });
});

describe('buildSubscriptionGroupPatchBody', () => {
  it('sends id + referenceName only, with no relationships', () => {
    const body = buildSubscriptionGroupPatchBody({
      groupId: 'GRP-1',
      referenceName: 'Renamed',
    }) as Body;
    expect(body.data.type).toBe('subscriptionGroups');
    expect(body.data.id).toBe('GRP-1');
    expect(body.data.attributes).toEqual({ referenceName: 'Renamed' });
    // A group cannot be reassigned to another app.
    expect(body.data.relationships).toBeUndefined();
  });
});

describe('buildSubscriptionCreateBody', () => {
  it('sends only the required attributes when nothing optional is passed', () => {
    const body = buildSubscriptionCreateBody({
      groupId: 'GRP-1',
      name: 'MV Analyst Monthly',
      productId: 'com.akoskomuves.MeritValue.analyst.monthly',
    }) as Body;
    expect(body.data.type).toBe('subscriptions');
    expect(body.data.attributes).toEqual({
      name: 'MV Analyst Monthly',
      productId: 'com.akoskomuves.MeritValue.analyst.monthly',
    });
    const rels = body.data.relationships as { group: { data: { type: string; id: string } } };
    expect(rels.group.data).toEqual({ type: 'subscriptionGroups', id: 'GRP-1' });
  });

  it('includes every optional attribute when supplied', () => {
    const body = buildSubscriptionCreateBody({
      groupId: 'GRP-1',
      name: 'MV Analyst Yearly',
      productId: 'com.example.yearly',
      subscriptionPeriod: 'ONE_YEAR',
      familySharable: true,
      reviewNote: 'Paywall is behind Settings -> Upgrade.',
      groupLevel: 1,
    }) as Body;
    expect(body.data.attributes).toEqual({
      name: 'MV Analyst Yearly',
      productId: 'com.example.yearly',
      subscriptionPeriod: 'ONE_YEAR',
      familySharable: true,
      reviewNote: 'Paywall is behind Settings -> Upgrade.',
      groupLevel: 1,
    });
  });

  it('omits optional keys rather than sending null (Apple rejects null period)', () => {
    const body = buildSubscriptionCreateBody({
      groupId: 'GRP-1',
      name: 'N',
      productId: 'P',
      subscriptionPeriod: undefined,
      familySharable: undefined,
      reviewNote: undefined,
      groupLevel: undefined,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(Object.keys(attrs).sort()).toEqual(['name', 'productId']);
    expect('subscriptionPeriod' in attrs).toBe(false);
  });

  it('keeps familySharable:false and groupLevel:0-adjacent falsy values distinct from omitted', () => {
    // `false` is a meaningful value, not an absence — a naive truthiness
    // check in the builder would silently drop it.
    const body = buildSubscriptionCreateBody({
      groupId: 'GRP-1',
      name: 'N',
      productId: 'P',
      familySharable: false,
    }) as Body;
    expect(body.data.attributes).toEqual({ name: 'N', productId: 'P', familySharable: false });
  });
});

describe('buildSubscriptionPatchBody', () => {
  it('sends id + only the supplied attributes', () => {
    const body = buildSubscriptionPatchBody({
      subscriptionId: 'SUB-1',
      name: 'Renamed internally',
    }) as Body;
    expect(body.data.type).toBe('subscriptions');
    expect(body.data.id).toBe('SUB-1');
    expect(body.data.attributes).toEqual({ name: 'Renamed internally' });
  });

  it('has no codepath that emits productId', () => {
    const body = buildSubscriptionPatchBody({
      subscriptionId: 'SUB-1',
      name: 'N',
      subscriptionPeriod: 'ONE_MONTH',
      familySharable: true,
      reviewNote: 'note',
      groupLevel: 2,
      // @ts-expect-error productId is deliberately not part of the patch input
      productId: 'com.example.sneaky',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('productId' in attrs).toBe(false);
    expect(attrs).toEqual({
      name: 'N',
      subscriptionPeriod: 'ONE_MONTH',
      familySharable: true,
      reviewNote: 'note',
      groupLevel: 2,
    });
  });

  it('emits an explicit null to clear reviewNote (Apple marks it nullable)', () => {
    // null is a value, not an absence: it is the documented way to clear the
    // note. A builder keyed on truthiness would drop it and silently no-op.
    const body = buildSubscriptionPatchBody({
      subscriptionId: 'SUB-1',
      reviewNote: null,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs).toEqual({ reviewNote: null });
    expect('reviewNote' in attrs).toBe(true);
  });

  it('never sends relationships (group reassignment is not a PATCH operation)', () => {
    const body = buildSubscriptionPatchBody({ subscriptionId: 'SUB-1', groupLevel: 3 }) as Body;
    expect(body.data.relationships).toBeUndefined();
  });
});

describe('evaluateSubscriptionDeleteGate', () => {
  it('allows draft states', () => {
    for (const state of [
      'MISSING_METADATA',
      'READY_TO_SUBMIT',
      'DEVELOPER_ACTION_NEEDED',
      'REJECTED',
    ]) {
      expect(evaluateSubscriptionDeleteGate(state).allow).toBe(true);
    }
  });

  it('refuses while Apple holds the record for review', () => {
    for (const state of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_BINARY_APPROVAL']) {
      const gate = evaluateSubscriptionDeleteGate(state);
      expect(gate.allow).toBe(false);
      expect(gate.reason).toContain(state);
      expect(gate.next).toBeTruthy();
    }
  });

  it('refuses anything that has ever shipped, including removed-from-sale', () => {
    // "Removed from sale" does not undo purchases that already happened, so
    // the record stays load-bearing and Apple keeps refusing the delete.
    for (const state of ['APPROVED', 'DEVELOPER_REMOVED_FROM_SALE', 'REMOVED_FROM_SALE']) {
      const gate = evaluateSubscriptionDeleteGate(state);
      expect(gate.allow).toBe(false);
      expect(gate.next).toContain('asc_post_subscription_availability');
    }
  });

  it('passes through when the state is unknown', () => {
    // A failed pre-check must never block a DELETE Apple would have accepted.
    expect(evaluateSubscriptionDeleteGate(undefined).allow).toBe(true);
  });
});

describe('evaluateSubscriptionGroupDeleteGate', () => {
  it('allows an empty group', () => {
    const gate = evaluateSubscriptionGroupDeleteGate([]);
    expect(gate.allow).toBe(true);
    expect(gate.blockingSubscriptions).toEqual([]);
  });

  it('allows a group holding only drafts', () => {
    const gate = evaluateSubscriptionGroupDeleteGate([
      { id: 'S1', name: 'Draft monthly', state: 'MISSING_METADATA' },
      { id: 'S2', name: 'Draft yearly', state: 'READY_TO_SUBMIT' },
    ]);
    expect(gate.allow).toBe(true);
  });

  it('refuses and names the blocking products', () => {
    const gate = evaluateSubscriptionGroupDeleteGate([
      { id: 'S1', name: 'Draft', state: 'MISSING_METADATA' },
      { id: 'S2', name: 'Live monthly', state: 'APPROVED' },
      { id: 'S3', name: 'In review', state: 'IN_REVIEW' },
    ]);
    expect(gate.allow).toBe(false);
    expect(gate.blockingSubscriptions.map((s) => s.id)).toEqual(['S2', 'S3']);
    expect(gate.reason).toContain('2');
  });

  it('ignores children whose state could not be read', () => {
    // Same principle as the single-subscription gate: unknown is not blocking.
    const gate = evaluateSubscriptionGroupDeleteGate([{ id: 'S1', name: 'Unknown' }]);
    expect(gate.allow).toBe(true);
  });
});
