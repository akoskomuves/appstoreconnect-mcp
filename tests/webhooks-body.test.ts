import { describe, expect, it } from 'vitest';
import {
  buildWebhookCreateBody,
  buildWebhookDeliveryListQuery,
  buildWebhookPatchBody,
  buildWebhookPingBody,
  buildWebhookRedeliveryBody,
} from '../src/domains/webhooks.js';

// Pin the wire shapes for v0.17 Webhooks.
//
// Quirks driving these assertions:
//   1. WIRE-KEY GOTCHA: Swift `isEnabled` → wire `enabled` on Webhook
//      create/patch (the recurring is-prefix strip; `isRedelivery`→
//      `redelivery` and `isPing`→`ping` are read-only siblings pinned via
//      the fields constants).
//   2. WebhookCreateRequest attributes are ALL FIVE REQUIRED (enabled,
//      eventTypes, name, secret, url) — no partial create.
//   3. Redelivery + ping creates are RELATIONSHIPS-ONLY (no attributes
//      block at all, same family as v0.16 BuildBetaNotification). The
//      redelivery `template` relationship is SELF-REFERENTIAL (type
//      webhookDeliveries).
//   4. Delivery date filters use VERBOSE keys:
//      filter[createdDateGreaterThanOrEqualTo] / filter[createdDateLessThan].

describe('buildWebhookCreateBody', () => {
  it('emits all five required attrs with wire key `enabled` (NOT Swift `isEnabled`)', () => {
    const body = buildWebhookCreateBody({
      appId: 'APP-1',
      name: 'ci-bot',
      url: 'https://example.com/hook',
      secret: 's3cret',
      eventTypes: ['BUILD_UPLOAD_STATE_UPDATED'],
      enabled: true,
    });
    expect(body.data.type).toBe('webhooks');
    expect(body.data.attributes).toEqual({
      name: 'ci-bot',
      url: 'https://example.com/hook',
      secret: 's3cret',
      eventTypes: ['BUILD_UPLOAD_STATE_UPDATED'],
      enabled: true,
    });
    expect('isEnabled' in (body.data.attributes ?? {})).toBe(false);
    expect(body.data.relationships).toEqual({
      app: { data: { type: 'apps', id: 'APP-1' } },
    });
    expect('id' in body.data).toBe(false);
  });
});

describe('buildWebhookPatchBody', () => {
  it('targets the webhook id and includes only provided attrs', () => {
    const body = buildWebhookPatchBody({ webhookId: 'WH-1', enabled: false });
    expect(body.data.type).toBe('webhooks');
    expect(body.data.id).toBe('WH-1');
    expect(body.data.attributes).toEqual({ enabled: false });
    expect('relationships' in body.data).toBe(false);
  });

  it('uses wire key `enabled` and passes eventTypes as a whole-array replace', () => {
    const body = buildWebhookPatchBody({
      webhookId: 'WH-1',
      enabled: true,
      eventTypes: ['APP_STORE_VERSION_APP_VERSION_STATE_UPDATED', 'BUILD_UPLOAD_STATE_UPDATED'],
    });
    const attrs = body.data.attributes ?? {};
    expect(attrs.enabled).toBe(true);
    expect('isEnabled' in attrs).toBe(false);
    expect(attrs.eventTypes).toEqual([
      'APP_STORE_VERSION_APP_VERSION_STATE_UPDATED',
      'BUILD_UPLOAD_STATE_UPDATED',
    ]);
  });

  it('supports secret rotation as a plain attribute', () => {
    const body = buildWebhookPatchBody({ webhookId: 'WH-1', secret: 'new-secret' });
    expect(body.data.attributes).toEqual({ secret: 'new-secret' });
  });
});

describe('buildWebhookRedeliveryBody', () => {
  it('is relationships-only with a SELF-REFERENTIAL template relationship', () => {
    const body = buildWebhookRedeliveryBody('DEL-1');
    expect(body.data.type).toBe('webhookDeliveries');
    expect(body.data.relationships).toEqual({
      template: { data: { type: 'webhookDeliveries', id: 'DEL-1' } },
    });
    expect('attributes' in body.data).toBe(false);
    expect('id' in body.data).toBe(false);
  });
});

describe('buildWebhookPingBody', () => {
  it('is relationships-only — NO attributes key anywhere in the body', () => {
    const body = buildWebhookPingBody('WH-1');
    expect(body.data.type).toBe('webhookPings');
    expect(body.data.relationships).toEqual({
      webhook: { data: { type: 'webhooks', id: 'WH-1' } },
    });
    expect('attributes' in body.data).toBe(false);
  });
});

describe('buildWebhookDeliveryListQuery', () => {
  it('uses the VERBOSE date-filter wire keys', () => {
    const params = buildWebhookDeliveryListQuery({
      createdAfterOrAt: '2026-06-09T00:00:00Z',
      createdBefore: '2026-06-10T00:00:00Z',
    });
    expect(params.get('filter[createdDateGreaterThanOrEqualTo]')).toBe('2026-06-09T00:00:00Z');
    expect(params.get('filter[createdDateLessThan]')).toBe('2026-06-10T00:00:00Z');
    expect(params.get('filter[createdDate]')).toBeNull();
  });

  it('always includes event (relationships absent without include — v0.16 lesson)', () => {
    expect(buildWebhookDeliveryListQuery({}).get('include')).toBe('event');
  });

  it('requests the wire-form read fields redelivery and ping (is-prefix stripped)', () => {
    const params = buildWebhookDeliveryListQuery({});
    const deliveryFields = params.get('fields[webhookDeliveries]') ?? '';
    const eventFields = params.get('fields[webhookEvents]') ?? '';
    expect(deliveryFields).toContain('redelivery');
    expect(deliveryFields).not.toContain('isRedelivery');
    expect(eventFields).toContain('ping');
    expect(eventFields).not.toContain('isPing');
  });

  it('joins deliveryState filters and omits absent filters', () => {
    const params = buildWebhookDeliveryListQuery({ deliveryStates: ['FAILED', 'PENDING'] });
    expect(params.get('filter[deliveryState]')).toBe('FAILED,PENDING');
    expect(params.get('filter[createdDateGreaterThanOrEqualTo]')).toBeNull();
    expect(params.get('filter[createdDateLessThan]')).toBeNull();
  });
});
