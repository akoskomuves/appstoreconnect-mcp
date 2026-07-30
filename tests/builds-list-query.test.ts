import { describe, expect, it } from 'vitest';
import { buildBuildsListQuery } from '../src/domains/builds.js';

// Apple's per-app RELATIONSHIP path /v1/apps/{id}/builds rejects `sort` AND
// `filter[…]` with 400 PARAMETER_ERROR.ILLEGAL. The team-wide COLLECTION
// /v1/builds accepts both, and filter[app] scopes it to one app.
//
// Verified live 2026-07-30:
//   /v1/apps/{id}/builds?filter[processingState]=VALID       -> 400 ILLEGAL
//   /v1/apps/{id}/builds                                     -> 200
//   /v1/builds?filter[app]={id}&filter[processingState]=VALID -> 200
//   ...&sort=-uploadedDate                                    -> 200
//
// These pin the routing so a filter can never be appended to the
// relationship path again.

const APP = '1234567890';

function parse(path: string) {
  const [base, qs] = path.split('?');
  return { base, params: new URLSearchParams(qs) };
}

describe('buildBuildsListQuery — per-app, unfiltered', () => {
  const { path, usesCollection } = buildBuildsListQuery({ appId: APP });

  it('uses the relationship path', () => {
    expect(parse(path).base).toBe(`/v1/apps/${APP}/builds`);
    expect(usesCollection).toBe(false);
  });

  it('carries NO sort and NO filter — both are 400 ILLEGAL here', () => {
    const { params } = parse(path);
    expect(params.get('sort')).toBeNull();
    expect([...params.keys()].filter((k) => k.startsWith('filter['))).toEqual([]);
  });

  it('still requests the sparse fieldset and page size', () => {
    const { params } = parse(path);
    expect(params.get('fields[builds]')).toContain('processingState');
    expect(params.get('limit')).toBe('200');
  });
});

describe('buildBuildsListQuery — per-app, filtered by processingState', () => {
  const { path, usesCollection } = buildBuildsListQuery({
    appId: APP,
    processingState: 'VALID',
  });

  it('routes to the team-wide collection instead of the relationship path', () => {
    // The regression: this used to hit /v1/apps/{id}/builds and 400.
    expect(parse(path).base).toBe('/v1/builds');
    expect(usesCollection).toBe(true);
  });

  it('scopes to the app via filter[app] rather than the path', () => {
    expect(parse(path).params.get('filter[app]')).toBe(APP);
  });

  it('applies the processingState filter', () => {
    expect(parse(path).params.get('filter[processingState]')).toBe('VALID');
  });

  it('can sort server-side here (the relationship path cannot)', () => {
    expect(parse(path).params.get('sort')).toBe('-uploadedDate');
  });
});

describe('buildBuildsListQuery — team-wide', () => {
  it('omits filter[app] when no app is given', () => {
    const { path } = buildBuildsListQuery({});
    const { base, params } = parse(path);
    expect(base).toBe('/v1/builds');
    expect(params.get('filter[app]')).toBeNull();
    expect(params.get('sort')).toBe('-uploadedDate');
  });

  it('filters by processingState with no app scope', () => {
    const { path } = buildBuildsListQuery({ processingState: 'PROCESSING' });
    const { base, params } = parse(path);
    expect(base).toBe('/v1/builds');
    expect(params.get('filter[processingState]')).toBe('PROCESSING');
    expect(params.get('filter[app]')).toBeNull();
  });
});

describe('buildBuildsListQuery — encoding', () => {
  it('percent-encodes the app id in the relationship path', () => {
    const { path } = buildBuildsListQuery({ appId: 'a/b' });
    expect(path).toContain('/v1/apps/a%2Fb/builds');
  });
});
