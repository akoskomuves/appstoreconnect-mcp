import { describe, expect, it } from 'vitest';
import {
  buildExperimentCreateBody,
  buildExperimentPatchBody,
  buildTreatmentCreateBody,
  buildTreatmentLocalizationCreateBody,
  buildTreatmentPatchBody,
} from '../src/domains/version-experiments.js';

// Pin the wire shapes for v0.20 App Store Version Experiments V2.
//
// Quirks driving these assertions:
//   1. WIRE-KEY GOTCHA: Swift `isStarted` → wire `started` on the
//      experiment PATCH (the is-prefix strip family).
//   2. Experiment create: ALL THREE attributes required (name, platform,
//      trafficProportion) + app relationship. JSON:API type is
//      `appStoreVersionExperiments` on BOTH /v1 and /v2 paths.
//   3. Treatment create emits the appStoreVersionExperimentV2 relationship
//      — never the deprecated v1 `appStoreVersionExperiment` sibling.
//   4. URL-version QUIRK (pinned in the domain, asserted here as a
//      reminder): list = /v1/apps/{id}/appStoreVersionExperimentsV2,
//      CRUD = /v2/appStoreVersionExperiments.

describe('buildExperimentCreateBody', () => {
  it('emits all three required attrs + app relationship', () => {
    const body = buildExperimentCreateBody({
      appId: 'APP-1',
      name: 'icon-test-summer',
      platform: 'IOS',
      trafficProportion: 30,
    });
    expect(body.data.type).toBe('appStoreVersionExperiments');
    expect(body.data.attributes).toEqual({
      name: 'icon-test-summer',
      platform: 'IOS',
      trafficProportion: 30,
    });
    expect(body.data.relationships).toEqual({
      app: { data: { type: 'apps', id: 'APP-1' } },
    });
    expect('id' in body.data).toBe(false);
  });
});

describe('buildExperimentPatchBody', () => {
  it('emits wire key `started` (NOT Swift `isStarted`)', () => {
    const body = buildExperimentPatchBody({ experimentId: 'EXP-1', started: true });
    expect(body.data.id).toBe('EXP-1');
    expect(body.data.attributes).toEqual({ started: true });
    expect('isStarted' in (body.data.attributes ?? {})).toBe(false);
  });

  it('includes only provided attrs', () => {
    const body = buildExperimentPatchBody({ experimentId: 'EXP-1', trafficProportion: 50 });
    expect(body.data.attributes).toEqual({ trafficProportion: 50 });
    expect('relationships' in body.data).toBe(false);
  });
});

describe('buildTreatmentCreateBody', () => {
  it('emits the V2 experiment relationship — never the deprecated v1 one', () => {
    const body = buildTreatmentCreateBody({ experimentId: 'EXP-1', name: 'blue-icon' });
    expect(body.data.type).toBe('appStoreVersionExperimentTreatments');
    expect(body.data.attributes).toEqual({ name: 'blue-icon' });
    expect(body.data.relationships).toEqual({
      appStoreVersionExperimentV2: {
        data: { type: 'appStoreVersionExperiments', id: 'EXP-1' },
      },
    });
    expect('appStoreVersionExperiment' in (body.data.relationships ?? {})).toBe(false);
  });

  it('includes appIconName only when provided', () => {
    const withIcon = buildTreatmentCreateBody({
      experimentId: 'EXP-1',
      name: 'alt-icon',
      appIconName: 'AppIcon-Blue',
    });
    expect(withIcon.data.attributes).toEqual({ name: 'alt-icon', appIconName: 'AppIcon-Blue' });
    const without = buildTreatmentCreateBody({ experimentId: 'EXP-1', name: 'plain' });
    expect('appIconName' in (without.data.attributes ?? {})).toBe(false);
  });
});

describe('buildTreatmentPatchBody', () => {
  it('targets the treatment id with only provided attrs', () => {
    const body = buildTreatmentPatchBody({ treatmentId: 'TR-1', appIconName: 'AppIcon-Red' });
    expect(body.data.id).toBe('TR-1');
    expect(body.data.attributes).toEqual({ appIconName: 'AppIcon-Red' });
  });
});

describe('buildTreatmentLocalizationCreateBody', () => {
  it('emits required locale + treatment relationship', () => {
    const body = buildTreatmentLocalizationCreateBody({ treatmentId: 'TR-1', locale: 'en-US' });
    expect(body.data.type).toBe('appStoreVersionExperimentTreatmentLocalizations');
    expect(body.data.attributes).toEqual({ locale: 'en-US' });
    expect(body.data.relationships).toEqual({
      appStoreVersionExperimentTreatment: {
        data: { type: 'appStoreVersionExperimentTreatments', id: 'TR-1' },
      },
    });
  });
});
