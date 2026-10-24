import { describe, expect, it } from 'vitest';
import {
  buildAltDomainCreateBody,
  buildAltKeyCreateBody,
  buildAltPackageCreateBody,
  buildMarketplaceSearchDetailCreateBody,
  buildMarketplaceSearchDetailPatchBody,
  buildMarketplaceWebhookCreateBody,
  buildMarketplaceWebhookPatchBody,
  buildMarketplaceWebhookV2CreateBody,
  isMarketplaceWebhook,
  MARKETPLACE_EVENT_TYPES,
} from '../src/domains/alternative-distribution.js';

// Pin the wire shapes for v1.0 EU DMA / alternative distribution.
//
// Quirks driving these assertions:
//   1. URL-strip family: Swift `catalogURL` → wire `catalogUrl`
//      (MarketplaceSearchDetail) and Swift `endpointURL` → wire
//      `endpointUrl` (MarketplaceWebhook).
//   2. Package create is RELATIONSHIPS-ONLY (no attributes block).
//   3. Key create takes the PUBLIC key only, app relationship optional —
//      omitted entirely when not provided.
//   4. Marketplace webhook secret is write-only (create requires it;
//      PATCH includes it only when rotating).

describe('buildAltDomainCreateBody', () => {
  it('emits both required attrs with no relationships', () => {
    const body = buildAltDomainCreateBody({ domain: 'example.com', referenceName: 'main site' });
    expect(body.data.type).toBe('alternativeDistributionDomains');
    expect(body.data.attributes).toEqual({ domain: 'example.com', referenceName: 'main site' });
    expect('relationships' in body.data).toBe(false);
  });
});

describe('buildAltKeyCreateBody', () => {
  it('emits the public key and omits the app relationship when absent', () => {
    const body = buildAltKeyCreateBody({ publicKey: '-----BEGIN PUBLIC KEY-----…' });
    expect(body.data.attributes).toEqual({ publicKey: '-----BEGIN PUBLIC KEY-----…' });
    expect('relationships' in body.data).toBe(false);
  });

  it('scopes to an app when provided', () => {
    const body = buildAltKeyCreateBody({ publicKey: 'PEM', appId: 'APP-1' });
    expect(body.data.relationships).toEqual({
      app: { data: { type: 'apps', id: 'APP-1' } },
    });
  });
});

describe('buildAltPackageCreateBody', () => {
  it('is relationships-only — NO attributes key', () => {
    const body = buildAltPackageCreateBody({ appStoreVersionId: 'VER-1' });
    expect(body.data.type).toBe('alternativeDistributionPackages');
    expect(body.data.relationships).toEqual({
      appStoreVersion: { data: { type: 'appStoreVersions', id: 'VER-1' } },
    });
    expect('attributes' in body.data).toBe(false);
  });
});

describe('marketplace search detail bodies', () => {
  it('create emits wire key catalogUrl (NOT Swift catalogURL) + app relationship', () => {
    const body = buildMarketplaceSearchDetailCreateBody({
      appId: 'APP-1',
      catalogUrl: 'https://example.com/catalog',
    });
    expect(body.data.attributes).toEqual({ catalogUrl: 'https://example.com/catalog' });
    expect('catalogURL' in (body.data.attributes ?? {})).toBe(false);
    expect(body.data.relationships).toEqual({
      app: { data: { type: 'apps', id: 'APP-1' } },
    });
  });

  it('patch targets the id with catalogUrl only', () => {
    const body = buildMarketplaceSearchDetailPatchBody({
      searchDetailId: 'MSD-1',
      catalogUrl: 'https://example.com/v2',
    });
    expect(body.data.id).toBe('MSD-1');
    expect(body.data.attributes).toEqual({ catalogUrl: 'https://example.com/v2' });
  });
});

describe('marketplace webhook bodies', () => {
  it('create emits wire key endpointUrl (NOT Swift endpointURL) + required secret', () => {
    const body = buildMarketplaceWebhookCreateBody({
      endpointUrl: 'https://example.com/hook',
      secret: 's3cret',
    });
    expect(body.data.attributes).toEqual({
      endpointUrl: 'https://example.com/hook',
      secret: 's3cret',
    });
    expect('endpointURL' in (body.data.attributes ?? {})).toBe(false);
  });

  it('patch includes only provided attrs (secret rotation support)', () => {
    const rotate = buildMarketplaceWebhookPatchBody({ webhookId: 'MW-1', secret: 'new' });
    expect(rotate.data.attributes).toEqual({ secret: 'new' });
    const move = buildMarketplaceWebhookPatchBody({
      webhookId: 'MW-1',
      endpointUrl: 'https://example.com/v2',
    });
    expect(move.data.attributes).toEqual({ endpointUrl: 'https://example.com/v2' });
  });
});

// /v1/marketplaceWebhooks is deprecated. Marketplace notifications are now
// regular webhooks on the MARKETPLACE app, subscribed to the
// ALTERNATIVE_DISTRIBUTION_* events (Apple's webhook-events documentation).
describe('marketplace webhook migration → /v1/webhooks', () => {
  it('creates a regular webhook on the marketplace app with all three events by default', () => {
    const body = buildMarketplaceWebhookV2CreateBody({
      marketplaceAppId: 'MKT-APP',
      endpointUrl: 'https://example.com/mkt',
      secret: 's',
    });
    expect(body.data.type).toBe('webhooks');
    expect(body.data.attributes).toEqual({
      name: 'marketplace',
      url: 'https://example.com/mkt',
      secret: 's',
      eventTypes: [
        'ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED',
        'ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED',
        'ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED',
      ],
      enabled: true,
    });
    expect(body.data.relationships).toEqual({ app: { data: { type: 'apps', id: 'MKT-APP' } } });
    // The old wire key must not leak into the new body.
    expect('endpointUrl' in (body.data.attributes ?? {})).toBe(false);
  });

  it('honours name, an event subset and enabled:false', () => {
    const body = buildMarketplaceWebhookV2CreateBody({
      marketplaceAppId: 'MKT-APP',
      endpointUrl: 'https://example.com/mkt',
      secret: 's',
      name: 'catalog',
      eventTypes: ['ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED'],
      enabled: false,
    });
    expect(body.data.attributes).toMatchObject({
      name: 'catalog',
      eventTypes: ['ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED'],
      enabled: false,
    });
  });

  it('the event list is exactly the spec ALTERNATIVE_DISTRIBUTION_* values', () => {
    expect(MARKETPLACE_EVENT_TYPES.every((e) => e.startsWith('ALTERNATIVE_DISTRIBUTION_'))).toBe(
      true,
    );
    expect(MARKETPLACE_EVENT_TYPES).toHaveLength(3);
  });

  it('narrows an app webhook list to marketplace webhooks', () => {
    const mk = (eventTypes: unknown) => ({ type: 'webhooks', id: 'w', attributes: { eventTypes } });
    expect(isMarketplaceWebhook(mk(['ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED']))).toBe(
      true,
    );
    expect(
      isMarketplaceWebhook(
        mk(['BUILD_UPLOAD_STATE_UPDATED', 'ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED']),
      ),
    ).toBe(true);
    expect(isMarketplaceWebhook(mk(['BUILD_UPLOAD_STATE_UPDATED']))).toBe(false);
    expect(isMarketplaceWebhook(mk(undefined))).toBe(false);
  });
});
