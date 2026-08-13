import { describe, expect, it } from 'vitest';
import { buildNominationCreateBody, buildNominationPatchBody } from '../src/domains/nominations.js';

// Wire-shape pins for featuring nominations.
// Load-bearing rules:
//   1. `submitted` is a REQUIRED create attribute — the draft-vs-send switch
//      travels in the body (false = DRAFT), not as a separate endpoint.
//   2. relatedApps is the required relationship; inAppEvents and
//      supportedTerritories keys appear only when supplied.
//   3. Wire key is `launchInSelectMarketsFirst` — Markets, not Storefronts.
//   4. PATCH carries the resource id and omits the relationships block
//      entirely when no relationship changed.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

const rel = (body: Body, key: string) =>
  (body.data.relationships as Record<string, { data: unknown }>)[key]?.data;

describe('buildNominationCreateBody', () => {
  const body = buildNominationCreateBody(
    {
      name: 'Big Launch',
      type: 'APP_LAUNCH',
      description: 'Day-one release with on-device AI.',
      submitted: false,
      publishStartDate: '2026-09-14',
      launchInSelectMarketsFirst: true,
      appIds: ['APP-1', 'APP-2'],
    },
    {},
  ) as Body;

  it('uses nominations type and carries the draft switch explicitly', () => {
    expect(body.data.type).toBe('nominations');
    expect(body.data.attributes?.submitted).toBe(false);
  });

  it('relatedApps is a to-many apps linkage', () => {
    expect(rel(body, 'relatedApps')).toEqual([
      { type: 'apps', id: 'APP-1' },
      { type: 'apps', id: 'APP-2' },
    ]);
  });

  it('omits optional relationship keys entirely when not supplied', () => {
    expect('inAppEvents' in (body.data.relationships ?? {})).toBe(false);
    expect('supportedTerritories' in (body.data.relationships ?? {})).toBe(false);
  });

  it('uses the launchInSelectMarketsFirst wire key (Markets, not Storefronts)', () => {
    expect(body.data.attributes?.launchInSelectMarketsFirst).toBe(true);
    expect('launchInSelectStorefrontsFirst' in (body.data.attributes ?? {})).toBe(false);
  });
});

describe('buildNominationPatchBody', () => {
  it('submit flip: id in body, submitted:true, no relationships block', () => {
    const body = buildNominationPatchBody('NOM-1', { submitted: true }, {}) as Body;
    expect(body.data.id).toBe('NOM-1');
    expect(body.data.attributes).toEqual({ submitted: true });
    expect('relationships' in body.data).toBe(false);
  });

  it('relationship arrays replace the set when supplied', () => {
    const body = buildNominationPatchBody('NOM-1', {}, { territoryIds: ['USA', 'JPN'] }) as Body;
    expect(rel(body, 'supportedTerritories')).toEqual([
      { type: 'territories', id: 'USA' },
      { type: 'territories', id: 'JPN' },
    ]);
  });
});
