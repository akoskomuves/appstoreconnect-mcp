import { describe, expect, it } from 'vitest';
import { buildFeedbackListQuery } from '../src/domains/beta-feedback.js';

// Pin the query wire shape for the v0.16 beta-feedback list endpoints.
//
// Quirks driving these assertions:
//   1. WIRE-KEY GOTCHA: Swift `buildBundleID` → wire `buildBundleId`
//      (trailing-ID strip, same family as marketingURL → marketingUrl).
//      The sparse fieldset must carry the wire form.
//   2. DOTTED FILTER: the build-version filter is
//      `filter[build.preReleaseVersion]` (filters on the RELATED build's
//      pre-release version), not a flat key on the submission.
//   3. The two siblings use different fields[] keys and differ by exactly
//      one field: screenshots (screenshot) vs crashLog (crash).
//   4. LIVE-SMOKE FINDING (2026-06-10): without include=build,tester Apple
//      omits the build/tester relationship objects ENTIRELY (sparse
//      fieldsets alone don't materialize them) — the digest's BUILD_ID /
//      TESTER_ID columns render empty. include must always be present.

describe('buildFeedbackListQuery', () => {
  it('uses the wire key buildBundleId (NOT Swift buildBundleID) in sparse fieldsets', () => {
    const params = buildFeedbackListQuery('screenshot', {});
    const fields = params.get('fields[betaFeedbackScreenshotSubmissions]') ?? '';
    expect(fields).toContain('buildBundleId');
    expect(fields).not.toContain('buildBundleID');
  });

  it('screenshot kind requests screenshots, crash kind requests crashLog', () => {
    const shot = buildFeedbackListQuery('screenshot', {});
    const crash = buildFeedbackListQuery('crash', {});
    expect(shot.get('fields[betaFeedbackScreenshotSubmissions]')).toContain('screenshots');
    expect(shot.get('fields[betaFeedbackCrashSubmissions]')).toBeNull();
    expect(crash.get('fields[betaFeedbackCrashSubmissions]')).toContain('crashLog');
    expect(crash.get('fields[betaFeedbackCrashSubmissions]')).not.toContain('screenshots');
    expect(crash.get('fields[betaFeedbackScreenshotSubmissions]')).toBeNull();
  });

  it('always includes build,tester (Apple omits the relationships without include)', () => {
    expect(buildFeedbackListQuery('screenshot', {}).get('include')).toBe('build,tester');
    expect(buildFeedbackListQuery('crash', {}).get('include')).toBe('build,tester');
  });

  it('emits the dotted filter[build.preReleaseVersion] key', () => {
    const params = buildFeedbackListQuery('crash', { preReleaseVersions: ['2.5.0', '2.6.0'] });
    expect(params.get('filter[build.preReleaseVersion]')).toBe('2.5.0,2.6.0');
  });

  it('joins multi-value filters with commas under the documented filter keys', () => {
    const params = buildFeedbackListQuery('screenshot', {
      deviceModels: ['iPhone15,2'],
      osVersions: ['17.4.1', '18.0'],
      appPlatforms: ['IOS'],
      devicePlatforms: ['IOS', 'MAC_OS'],
      buildIds: ['BUILD-1'],
      testerIds: ['TESTER-1'],
    });
    expect(params.get('filter[deviceModel]')).toBe('iPhone15,2');
    expect(params.get('filter[osVersion]')).toBe('17.4.1,18.0');
    expect(params.get('filter[appPlatform]')).toBe('IOS');
    expect(params.get('filter[devicePlatform]')).toBe('IOS,MAC_OS');
    expect(params.get('filter[build]')).toBe('BUILD-1');
    expect(params.get('filter[tester]')).toBe('TESTER-1');
  });

  it('omits filter keys entirely when not provided', () => {
    const params = buildFeedbackListQuery('screenshot', {});
    for (const key of [
      'filter[deviceModel]',
      'filter[osVersion]',
      'filter[appPlatform]',
      'filter[devicePlatform]',
      'filter[build]',
      'filter[build.preReleaseVersion]',
      'filter[tester]',
    ]) {
      expect(params.get(key)).toBeNull();
    }
  });

  it('defaults to newest-first sort and flips with newestFirst=false', () => {
    expect(buildFeedbackListQuery('crash', {}).get('sort')).toBe('-createdDate');
    expect(buildFeedbackListQuery('crash', { newestFirst: true }).get('sort')).toBe('-createdDate');
    expect(buildFeedbackListQuery('crash', { newestFirst: false }).get('sort')).toBe('createdDate');
  });
});
