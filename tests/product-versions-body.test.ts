import { describe, expect, it } from 'vitest';
import {
  buildProductVersionCreateBody,
  buildProductVersionListQuery,
  digestProductVersions,
  productVersionListPath,
  relCount,
} from '../src/domains/product-versions.js';
import type { CollectedPages } from '../src/jsonapi.js';

// Pin the wire shape of the three version resources (API 4.4.1):
//   POST /v1/inAppPurchaseVersions      relationships.inAppPurchase   → inAppPurchases
//   POST /v1/subscriptionVersions       relationships.subscription    → subscriptions
//   POST /v1/subscriptionGroupVersions  relationships.subscriptionGroup → subscriptionGroups
// All three are relationships-only: no attributes block at all.

function pages(data: CollectedPages['data']): CollectedPages {
  return { data, included: [], pagesFetched: 1, truncated: false };
}

describe('buildProductVersionCreateBody', () => {
  it('IAP version relates to inAppPurchase (not inAppPurchaseV2)', () => {
    expect(buildProductVersionCreateBody('iap', 'IAP1')).toEqual({
      data: {
        type: 'inAppPurchaseVersions',
        relationships: { inAppPurchase: { data: { type: 'inAppPurchases', id: 'IAP1' } } },
      },
    });
  });

  it('subscription version relates to subscription', () => {
    expect(buildProductVersionCreateBody('subscription', 'S1')).toEqual({
      data: {
        type: 'subscriptionVersions',
        relationships: { subscription: { data: { type: 'subscriptions', id: 'S1' } } },
      },
    });
  });

  it('subscription group version relates to subscriptionGroup', () => {
    expect(buildProductVersionCreateBody('subscriptionGroup', 'G1')).toEqual({
      data: {
        type: 'subscriptionGroupVersions',
        relationships: {
          subscriptionGroup: { data: { type: 'subscriptionGroups', id: 'G1' } },
        },
      },
    });
  });

  it('never sends attributes', () => {
    for (const kind of ['iap', 'subscription', 'subscriptionGroup'] as const) {
      expect(buildProductVersionCreateBody(kind, 'X').data).not.toHaveProperty('attributes');
    }
  });
});

describe('version list path + query', () => {
  it('IAP versions hang off the v2 IAP resource', () => {
    expect(productVersionListPath('iap', 'a/b')).toBe('/v2/inAppPurchases/a%2Fb/versions');
    expect(productVersionListPath('subscription', 'S')).toBe('/v1/subscriptions/S/versions');
    expect(productVersionListPath('subscriptionGroup', 'G')).toBe(
      '/v1/subscriptionGroups/G/versions',
    );
  });

  it('includes the localization linkage within Apple’s limit[localizations] max of 50', () => {
    const q = buildProductVersionListQuery('subscription', ['PREPARE_FOR_SUBMISSION', 'APPROVED']);
    expect(q.get('fields[subscriptionVersions]')).toBe('version,state,localizations');
    expect(q.get('include')).toBe('localizations');
    expect(q.get('fields[subscriptionLocalizations]')).toBe('locale');
    expect(q.get('limit[localizations]')).toBe('50');
    expect(q.get('filter[state]')).toBe('PREPARE_FOR_SUBMISSION,APPROVED');
    expect(q.get('limit')).toBe('200');
  });

  it('omits filter[state] when no state is given', () => {
    const q = buildProductVersionListQuery('subscriptionGroup');
    expect(q.has('filter[state]')).toBe(false);
    expect(q.get('fields[subscriptionGroupLocalizations]')).toBe('locale');
  });
});

describe('digestProductVersions', () => {
  it('sorts newest version first and counts localizations', () => {
    const text = digestProductVersions(
      pages([
        {
          type: 'subscriptionVersions',
          id: 'v1',
          attributes: { version: 1, state: 'REPLACED_WITH_NEW_VERSION' },
          relationships: {
            localizations: { data: [{ type: 'subscriptionLocalizations', id: 'l' }] },
          },
        },
        {
          type: 'subscriptionVersions',
          id: 'v2',
          attributes: { version: 2, state: 'PREPARE_FOR_SUBMISSION' },
        },
      ]),
      'subscription versions',
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('2 subscription versions');
    expect(text.indexOf('v2')).toBeLessThan(text.indexOf('v1'));
    expect(text).toContain('PREPARE_FOR_SUBMISSION');
  });

  it('relCount prefers Apple’s paging total over the (limited) linkage length', () => {
    expect(
      relCount(
        {
          type: 't',
          id: 'x',
          relationships: {
            localizations: {
              data: [{ type: 'l', id: '1' }],
              meta: { paging: { total: 64 } },
            } as never,
          },
        },
        'localizations',
      ),
    ).toBe('64');
    expect(relCount({ type: 't', id: 'x' }, 'localizations')).toBe('');
  });
});

describe('section D tool registration', async () => {
  const { registerProductVersions } = await import('../src/domains/product-versions.js');
  const { registerIapOfferCodes } = await import('../src/domains/iap-offer-codes.js');
  const { registerBuildUploads } = await import('../src/domains/build-uploads.js');
  const names: string[] = [];
  const server = { registerTool: (name: string) => names.push(name) } as never;
  registerProductVersions(server, {} as never);
  registerIapOfferCodes(server, {} as never);
  registerBuildUploads(server, {} as never);

  it('registers unique asc_ tool names', () => {
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('asc_'))).toBe(true);
  });

  it('covers the four related reads named in the gap list', () => {
    for (const n of [
      'asc_list_iap_versions',
      'asc_list_subscription_versions',
      'asc_list_subscription_group_versions',
      'asc_list_iap_offer_codes',
      'asc_list_build_uploads',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('gives subscription groups no image tools (their versions have no images)', () => {
    expect(names.some((n) => n.startsWith('asc_list_subscription_group_version_image'))).toBe(
      false,
    );
  });
});
