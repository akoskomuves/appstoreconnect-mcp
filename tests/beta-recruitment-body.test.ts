import { describe, expect, it } from 'vitest';
import {
  buildBetaRecruitmentCriterionCreateBody,
  buildBetaRecruitmentCriterionPatchBody,
} from '../src/domains/beta-recruitment.js';
import { buildBuildBetaNotificationCreateBody } from '../src/domains/build-beta-notifications.js';

// Pin the wire shapes for v0.16 BetaRecruitmentCriterion +
// BuildBetaNotification.
//
// Quirks driving these assertions:
//   1. BetaRecruitmentCriterionCreateRequest attributes are REQUIRED
//      (deviceFamilyOsVersionFilters is non-optional in the Swift contract)
//      — no no-attrs-omission case, unlike v0.15 PhasedRelease create.
//   2. Filter wire keys are verbatim camelCase (deviceFamily /
//      minimumOsInclusive / maximumOsInclusive) — no is-prefix or URL
//      strips on this shape; absent min/max must be OMITTED, not null.
//   3. BuildBetaNotificationCreateRequest has NO attributes block at all —
//      type + relationships only. Apple rejects a stray attributes:{}.
//   4. PATCH replaces the whole filter array (no per-entry add/remove).

describe('buildBetaRecruitmentCriterionCreateBody', () => {
  it('uses betaRecruitmentCriteria type with required attrs + betaGroup relationship', () => {
    const body = buildBetaRecruitmentCriterionCreateBody({
      betaGroupId: 'GROUP-1',
      filters: [{ deviceFamily: 'IPHONE', minimumOsInclusive: '17.0' }],
    });
    expect(body.data.type).toBe('betaRecruitmentCriteria');
    expect(body.data.attributes).toEqual({
      deviceFamilyOsVersionFilters: [{ deviceFamily: 'IPHONE', minimumOsInclusive: '17.0' }],
    });
    expect(body.data.relationships).toEqual({
      betaGroup: { data: { type: 'betaGroups', id: 'GROUP-1' } },
    });
    expect('id' in body.data).toBe(false);
  });

  it('always emits the attributes block (required by the contract, never omitted)', () => {
    const body = buildBetaRecruitmentCriterionCreateBody({
      betaGroupId: 'GROUP-1',
      filters: [{ deviceFamily: 'MAC' }],
    });
    expect('attributes' in body.data).toBe(true);
    expect(body.data.attributes.deviceFamilyOsVersionFilters).toEqual([{ deviceFamily: 'MAC' }]);
  });

  it('omits absent min/max keys entirely (no nulls on the wire)', () => {
    const body = buildBetaRecruitmentCriterionCreateBody({
      betaGroupId: 'GROUP-1',
      filters: [
        { deviceFamily: 'IPHONE', minimumOsInclusive: '17.0' },
        { deviceFamily: 'IPAD', maximumOsInclusive: '18.4' },
        { deviceFamily: 'VISION' },
      ],
    });
    const filters = body.data.attributes.deviceFamilyOsVersionFilters as Array<
      Record<string, unknown>
    >;
    expect(filters[0]).toEqual({ deviceFamily: 'IPHONE', minimumOsInclusive: '17.0' });
    expect('maximumOsInclusive' in (filters[0] ?? {})).toBe(false);
    expect(filters[1]).toEqual({ deviceFamily: 'IPAD', maximumOsInclusive: '18.4' });
    expect('minimumOsInclusive' in (filters[1] ?? {})).toBe(false);
    expect(filters[2]).toEqual({ deviceFamily: 'VISION' });
  });
});

describe('buildBetaRecruitmentCriterionPatchBody', () => {
  it('targets the criterion id and replaces the whole filter array', () => {
    const body = buildBetaRecruitmentCriterionPatchBody({
      criterionId: 'CRIT-1',
      filters: [{ deviceFamily: 'IPHONE', minimumOsInclusive: '18.0', maximumOsInclusive: '18.4' }],
    });
    expect(body.data.type).toBe('betaRecruitmentCriteria');
    expect(body.data.id).toBe('CRIT-1');
    expect(body.data.attributes).toEqual({
      deviceFamilyOsVersionFilters: [
        { deviceFamily: 'IPHONE', minimumOsInclusive: '18.0', maximumOsInclusive: '18.4' },
      ],
    });
    expect('relationships' in body.data).toBe(false);
  });
});

describe('buildBuildBetaNotificationCreateBody', () => {
  it('is relationships-only — NO attributes key anywhere in the body', () => {
    const body = buildBuildBetaNotificationCreateBody('BUILD-1');
    expect(body.data.type).toBe('buildBetaNotifications');
    expect(body.data.relationships).toEqual({
      build: { data: { type: 'builds', id: 'BUILD-1' } },
    });
    expect('attributes' in body.data).toBe(false);
    expect('id' in body.data).toBe(false);
  });
});
