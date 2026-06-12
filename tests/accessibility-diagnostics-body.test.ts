import { describe, expect, it } from 'vitest';
import {
  buildAccessibilityDeclarationCreateBody,
  buildAccessibilityDeclarationPatchBody,
  SUPPORT_FLAG_KEYS,
} from '../src/domains/accessibility-declarations.js';
import { buildPerfPowerMetricsQuery } from '../src/domains/diagnostics.js';

// Pin the wire shapes for v0.21 diagnostics + accessibility declarations.
//
// Quirks driving these assertions:
//   1. The LARGEST is-prefix strip family yet: nine Swift `isSupports*`
//      attrs → wire `supports*`, plus PATCH-only Swift `isPublish` →
//      wire `publish` (customer-facing when true).
//   2. Omitted support flags are OMITTED on the wire — not sent as false
//      ("not declared" ≠ "declared unsupported").
//   3. perfPowerMetrics filters are plain filter[platform/metricType/
//      deviceType] params on a non-JSON:API endpoint.

describe('buildAccessibilityDeclarationCreateBody', () => {
  it('emits required deviceFamily + only the provided flags (wire keys, no is-prefix)', () => {
    const body = buildAccessibilityDeclarationCreateBody({
      appId: 'APP-1',
      deviceFamily: 'IPHONE',
      flags: { supportsVoiceover: true, supportsCaptions: false },
    });
    expect(body.data.type).toBe('accessibilityDeclarations');
    expect(body.data.attributes).toEqual({
      deviceFamily: 'IPHONE',
      supportsVoiceover: true,
      supportsCaptions: false,
    });
    for (const key of Object.keys(body.data.attributes)) {
      expect(key.startsWith('isSupports')).toBe(false);
    }
    expect(body.data.relationships).toEqual({
      app: { data: { type: 'apps', id: 'APP-1' } },
    });
  });

  it('omits undeclared flags entirely (not false)', () => {
    const body = buildAccessibilityDeclarationCreateBody({
      appId: 'APP-1',
      deviceFamily: 'MAC',
      flags: {},
    });
    expect(body.data.attributes).toEqual({ deviceFamily: 'MAC' });
  });

  it('covers all nine flag keys', () => {
    expect(SUPPORT_FLAG_KEYS).toHaveLength(9);
    const all: Record<string, boolean> = {};
    for (const k of SUPPORT_FLAG_KEYS) all[k] = true;
    const body = buildAccessibilityDeclarationCreateBody({
      appId: 'APP-1',
      deviceFamily: 'IPAD',
      flags: all,
    });
    expect(Object.keys(body.data.attributes)).toHaveLength(10); // deviceFamily + 9
  });
});

describe('buildAccessibilityDeclarationPatchBody', () => {
  it('emits wire key `publish` (NOT Swift `isPublish`)', () => {
    const body = buildAccessibilityDeclarationPatchBody({
      declarationId: 'DECL-1',
      publish: true,
      flags: {},
    });
    expect(body.data.id).toBe('DECL-1');
    expect(body.data.attributes).toEqual({ publish: true });
    expect('isPublish' in body.data.attributes).toBe(false);
  });

  it('mixes flag edits and publish, omitting publish when absent', () => {
    const body = buildAccessibilityDeclarationPatchBody({
      declarationId: 'DECL-1',
      flags: { supportsReducedMotion: true },
    });
    expect(body.data.attributes).toEqual({ supportsReducedMotion: true });
    expect('publish' in body.data.attributes).toBe(false);
  });
});

describe('buildPerfPowerMetricsQuery', () => {
  it('sets only provided filters with the documented keys', () => {
    const params = buildPerfPowerMetricsQuery({ metricType: 'LAUNCH', deviceType: 'iPhone15,2' });
    expect(params.get('filter[metricType]')).toBe('LAUNCH');
    expect(params.get('filter[deviceType]')).toBe('iPhone15,2');
    expect(params.get('filter[platform]')).toBeNull();
    expect(buildPerfPowerMetricsQuery({}).toString()).toBe('');
  });
});
