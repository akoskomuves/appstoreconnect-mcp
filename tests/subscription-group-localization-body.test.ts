import { describe, expect, it } from 'vitest';
import {
  buildSubscriptionGroupLocalizationCreateBody,
  buildSubscriptionGroupLocalizationPatchBody,
} from '../src/domains/subscription-group-localizations.js';

// Pin the wire shape for:
//   POST  /v1/subscriptionGroupLocalizations
//   PATCH /v1/subscriptionGroupLocalizations/{id}
//
// Apple's quirks driving these assertions:
//   1. name + locale REQUIRED at create; customAppName optional. The parent
//      relationship key is `subscriptionGroup` (NOT `group`, which is what
//      Subscription uses for the same parent — the two resources disagree).
//   2. PATCH accepts name + customAppName only. Locale is the immutable
//      lookup key and `state` is server-managed; neither may be emitted.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildSubscriptionGroupLocalizationCreateBody', () => {
  it('uses the subscriptionGroup relationship key, not group', () => {
    // Subscription relates to the same parent under `group`; this resource
    // uses `subscriptionGroup`. Getting it wrong is a 409 with no hint.
    const body = buildSubscriptionGroupLocalizationCreateBody({
      groupId: 'GRP-1',
      name: 'MeritValue Premium',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('subscriptionGroupLocalizations');
    const rels = body.data.relationships as {
      subscriptionGroup: { data: { type: string; id: string } };
    };
    expect(rels.subscriptionGroup.data).toEqual({ type: 'subscriptionGroups', id: 'GRP-1' });
    expect((body.data.relationships as Record<string, unknown>).group).toBeUndefined();
  });

  it('sends name + locale and omits customAppName when absent', () => {
    const body = buildSubscriptionGroupLocalizationCreateBody({
      groupId: 'GRP-1',
      name: 'MeritValue Premium',
      locale: 'en-US',
    }) as Body;
    expect(body.data.attributes).toEqual({ name: 'MeritValue Premium', locale: 'en-US' });
  });

  it('includes customAppName when supplied', () => {
    const body = buildSubscriptionGroupLocalizationCreateBody({
      groupId: 'GRP-1',
      name: 'MeritValue Premium',
      locale: 'de-DE',
      customAppName: 'MeritValue',
    }) as Body;
    expect(body.data.attributes).toEqual({
      name: 'MeritValue Premium',
      locale: 'de-DE',
      customAppName: 'MeritValue',
    });
  });

  it('never sends an id on create', () => {
    const body = buildSubscriptionGroupLocalizationCreateBody({
      groupId: 'GRP-1',
      name: 'N',
      locale: 'en-US',
    }) as Body;
    expect(body.data.id).toBeUndefined();
  });
});

describe('buildSubscriptionGroupLocalizationPatchBody', () => {
  it('sends id + only the supplied attributes', () => {
    const body = buildSubscriptionGroupLocalizationPatchBody({
      subscriptionGroupLocalizationId: 'LOC-1',
      name: 'Updated heading',
    }) as Body;
    expect(body.data.type).toBe('subscriptionGroupLocalizations');
    expect(body.data.id).toBe('LOC-1');
    expect(body.data.attributes).toEqual({ name: 'Updated heading' });
  });

  it('has no codepath that emits locale (immutable lookup key)', () => {
    const body = buildSubscriptionGroupLocalizationPatchBody({
      subscriptionGroupLocalizationId: 'LOC-1',
      name: 'N',
      customAppName: 'App',
      // @ts-expect-error locale is immutable and not part of the patch input
      locale: 'fr-FR',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('locale' in attrs).toBe(false);
    expect(attrs).toEqual({ name: 'N', customAppName: 'App' });
  });

  it('has no codepath that emits state (server-managed)', () => {
    const body = buildSubscriptionGroupLocalizationPatchBody({
      subscriptionGroupLocalizationId: 'LOC-1',
      name: 'N',
      // @ts-expect-error state is server-managed and rejected from write bodies
      state: 'APPROVED',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('state' in attrs).toBe(false);
    expect(attrs).toEqual({ name: 'N' });
  });

  it('never sends relationships on patch', () => {
    const body = buildSubscriptionGroupLocalizationPatchBody({
      subscriptionGroupLocalizationId: 'LOC-1',
      customAppName: 'App',
    }) as Body;
    expect(body.data.relationships).toBeUndefined();
  });
});
