import { describe, expect, it } from 'vitest';
import {
  buildAppEventCreateBody,
  buildAppEventLocalizationCreateBody,
  buildAppEventLocalizationPatchBody,
  buildAppEventPatchBody,
  evaluateAppEventStateGate,
} from '../src/domains/app-events.js';

// Pin the wire shape for the AppEvent + AppEventLocalization writes:
//   POST  /v1/appEvents
//   PATCH /v1/appEvents/{id}
//   POST  /v1/appEventLocalizations
//   PATCH /v1/appEventLocalizations/{id}
//
// Quirks driving these assertions:
//   1. AppEventCreateRequest: required attrs = { referenceName }. Optional
//      attrs OMITTED via encodeIfPresent. territorySchedules is an array of
//      structs and passes through verbatim.
//   2. AppEventLocalizationUpdateRequest excludes locale (immutable on
//      update — only on create attrs).
//   3. State gate refuses WAITING_FOR_REVIEW / IN_REVIEW only; everything
//      else passes through.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppEventCreateBody', () => {
  it('uses appEvents type with required attrs + app relationship', () => {
    const body = buildAppEventCreateBody({
      appId: 'APP-1',
      referenceName: 'Salmon Season Opens',
    }) as Body;
    expect(body.data.type).toBe('appEvents');
    expect(body.data.attributes).toEqual({ referenceName: 'Salmon Season Opens' });
    const rels = body.data.relationships as { app: { data: { type: string; id: string } } };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
  });

  it('emits all optional attrs when provided', () => {
    const body = buildAppEventCreateBody({
      appId: 'APP-1',
      referenceName: 'Spring Sale',
      badge: 'SPECIAL_EVENT',
      deepLink: 'https://example.com/spring',
      purchaseRequirement: 'IN_APP_PURCHASE',
      primaryLocale: 'en-US',
      priority: 'HIGH',
      purpose: 'ATTRACT_NEW_USERS',
      territorySchedules: [
        {
          territories: ['USA', 'CAN'],
          publishStart: '2026-06-10T00:00:00Z',
          eventStart: '2026-06-15T00:00:00Z',
          eventEnd: '2026-06-30T00:00:00Z',
        },
      ],
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.badge).toBe('SPECIAL_EVENT');
    expect(attrs.priority).toBe('HIGH');
    expect(attrs.purpose).toBe('ATTRACT_NEW_USERS');
    expect(Array.isArray(attrs.territorySchedules)).toBe(true);
    const schedule = (attrs.territorySchedules as Array<Record<string, unknown>>)[0];
    expect(schedule?.territories).toEqual(['USA', 'CAN']);
    expect(schedule?.publishStart).toBe('2026-06-10T00:00:00Z');
  });

  it('OMITS undefined optional attrs', () => {
    const body = buildAppEventCreateBody({
      appId: 'APP-1',
      referenceName: 'X',
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(Object.keys(attrs)).toEqual(['referenceName']);
    expect('badge' in attrs).toBe(false);
    expect('territorySchedules' in attrs).toBe(false);
  });
});

describe('buildAppEventPatchBody', () => {
  it('uses appEvents type + resource id', () => {
    const body = buildAppEventPatchBody({
      appEventId: 'EV-1',
      badge: 'NEW_SEASON',
    }) as Body;
    expect(body.data.type).toBe('appEvents');
    expect(body.data.id).toBe('EV-1');
  });

  it('OMITS undefined attrs (encodeIfPresent)', () => {
    const body = buildAppEventPatchBody({
      appEventId: 'EV-1',
      priority: 'NORMAL',
    }) as Body;
    expect(body.data.attributes).toEqual({ priority: 'NORMAL' });
  });

  it('does not emit a relationships block', () => {
    const body = buildAppEventPatchBody({
      appEventId: 'EV-1',
      badge: 'LIVE_EVENT',
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});

describe('buildAppEventLocalizationCreateBody', () => {
  it('requires locale + appEvent relationship', () => {
    const body = buildAppEventLocalizationCreateBody({
      appEventId: 'EV-1',
      locale: 'en-US',
    }) as Body;
    expect(body.data.type).toBe('appEventLocalizations');
    expect(body.data.attributes).toEqual({ locale: 'en-US' });
    const rels = body.data.relationships as {
      appEvent: { data: { type: string; id: string } };
    };
    expect(rels.appEvent.data).toEqual({ type: 'appEvents', id: 'EV-1' });
  });

  it('emits the copy attrs when provided', () => {
    const body = buildAppEventLocalizationCreateBody({
      appEventId: 'EV-1',
      locale: 'en-US',
      name: 'Spring Sale',
      shortDescription: '20% off premium for 14 days',
      longDescription: 'Limited-time offer on the premium subscription. Tap to upgrade.',
    }) as Body;
    expect(body.data.attributes).toEqual({
      locale: 'en-US',
      name: 'Spring Sale',
      shortDescription: '20% off premium for 14 days',
      longDescription: 'Limited-time offer on the premium subscription. Tap to upgrade.',
    });
  });
});

describe('buildAppEventLocalizationPatchBody', () => {
  it('uses appEventLocalizations type + resource id + no locale (immutable)', () => {
    const body = buildAppEventLocalizationPatchBody({
      appEventLocalizationId: 'EVL-1',
      name: 'Renamed',
    }) as Body;
    expect(body.data.type).toBe('appEventLocalizations');
    expect(body.data.id).toBe('EVL-1');
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('locale' in attrs).toBe(false);
    expect(attrs.name).toBe('Renamed');
  });

  it('OMITS undefined attrs', () => {
    const body = buildAppEventLocalizationPatchBody({
      appEventLocalizationId: 'EVL-1',
      shortDescription: 'New short',
    }) as Body;
    expect(body.data.attributes).toEqual({ shortDescription: 'New short' });
  });
});

describe('evaluateAppEventStateGate', () => {
  it('refuses WAITING_FOR_REVIEW', () => {
    const r = evaluateAppEventStateGate('WAITING_FOR_REVIEW');
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('WAITING_FOR_REVIEW');
    expect(r.nextEditablePath).toContain('cancel');
  });

  it('refuses IN_REVIEW', () => {
    expect(evaluateAppEventStateGate('IN_REVIEW').allow).toBe(false);
  });

  it('allows DRAFT + REJECTED + PUBLISHED (mid-event copy tweaks pass through)', () => {
    expect(evaluateAppEventStateGate('DRAFT').allow).toBe(true);
    expect(evaluateAppEventStateGate('REJECTED').allow).toBe(true);
    expect(evaluateAppEventStateGate('PUBLISHED').allow).toBe(true);
  });

  it('passes through unknown / undefined states', () => {
    expect(evaluateAppEventStateGate(undefined).allow).toBe(true);
    expect(evaluateAppEventStateGate('FUTURE_APPLE_STATE').allow).toBe(true);
  });
});
