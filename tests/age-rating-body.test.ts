import { describe, expect, it } from 'vitest';
import { digestAgeRatingDeclaration } from '../src/digest.js';
import {
  AGE_RATING_BOOLEAN_KEYS,
  AGE_RATING_FREQUENCY_KEYS,
  buildAgeRatingDeclarationPatchBody,
} from '../src/domains/age-rating.js';
import {
  AgeRatingFrequencySchema,
  AgeRatingOverrideV2Schema,
  KidsAgeBandSchema,
  KoreaAgeRatingOverrideSchema,
} from '../src/schemas.js';

// Pin the age-rating wire contract. Everything asserted here was read off the
// LIVE API or Apple's published enum lists on 2026-07-30:
//
//   1. The declaration hangs off APP INFO
//      (/v1/appStoreVersions/{id}/ageRatingDeclaration 404s), and its id IS
//      the appInfo id.
//   2. Writes go to the flat resource PATCH /v1/ageRatingDeclarations/{id},
//      with the id repeated in the body (409 otherwise).
//   3. Apple MERGES on PATCH — omitted keys keep their value. The builder
//      must therefore emit only what the caller supplied, so an undefined
//      never lands on the wire as an accidental clear.
//   4. `ageRatingOverride` (v1) is deprecated and NOT interchangeable with
//      `ageRatingOverrideV2`: v1 has SEVENTEEN_PLUS, v2 has EIGHTEEN_PLUS.

type Body = {
  data: { type: string; id: string; attributes: Record<string, unknown> };
};

describe('buildAgeRatingDeclarationPatchBody', () => {
  it('uses the ageRatingDeclarations type and repeats the id in the body', () => {
    const body = buildAgeRatingDeclarationPatchBody({
      declarationId: 'AI-1',
      attributes: { violenceRealistic: 'INFREQUENT_OR_MILD' },
    }) as Body;
    expect(body.data.type).toBe('ageRatingDeclarations');
    expect(body.data.id).toBe('AI-1');
  });

  it('emits only supplied keys — undefined never reaches the wire', () => {
    // Critical: Apple merges, so a stray key would overwrite a real answer.
    const body = buildAgeRatingDeclarationPatchBody({
      declarationId: 'AI-1',
      attributes: { gambling: true, violenceRealistic: undefined, contests: undefined },
    }) as Body;
    expect(body.data.attributes).toEqual({ gambling: true });
    expect('violenceRealistic' in body.data.attributes).toBe(false);
  });

  it('preserves explicit falsy answers (false / NONE are real values, not absence)', () => {
    const body = buildAgeRatingDeclarationPatchBody({
      declarationId: 'AI-1',
      attributes: { gambling: false, violenceRealistic: 'NONE' },
    }) as Body;
    expect(body.data.attributes).toEqual({ gambling: false, violenceRealistic: 'NONE' });
  });

  it('carries no relationships block', () => {
    const body = buildAgeRatingDeclarationPatchBody({
      declarationId: 'AI-1',
      attributes: { advertising: true },
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});

describe('age-rating vocabularies', () => {
  it('frequency accepts every value Apple documents', () => {
    for (const v of [
      'NONE',
      'INFREQUENT_OR_MILD',
      'FREQUENT_OR_INTENSE',
      'INFREQUENT',
      'FREQUENT',
    ]) {
      expect(AgeRatingFrequencySchema.safeParse(v).success).toBe(true);
    }
    expect(AgeRatingFrequencySchema.safeParse('MILD').success).toBe(false);
  });

  it('overrideV2 uses EIGHTEEN_PLUS, not the deprecated v1 SEVENTEEN_PLUS', () => {
    expect(AgeRatingOverrideV2Schema.safeParse('EIGHTEEN_PLUS').success).toBe(true);
    // Passing the v1 vocabulary to the v2 attribute is a real mistake to catch.
    expect(AgeRatingOverrideV2Schema.safeParse('SEVENTEEN_PLUS').success).toBe(false);
  });

  it('korea override is its own short vocabulary', () => {
    expect(KoreaAgeRatingOverrideSchema.safeParse('FIFTEEN_PLUS').success).toBe(true);
    expect(KoreaAgeRatingOverrideSchema.safeParse('NINETEEN_PLUS').success).toBe(true);
    expect(KoreaAgeRatingOverrideSchema.safeParse('NINE_PLUS').success).toBe(false);
  });

  it('kids age band has exactly the three Apple bands', () => {
    for (const v of ['FIVE_AND_UNDER', 'SIX_TO_EIGHT', 'NINE_TO_ELEVEN']) {
      expect(KidsAgeBandSchema.safeParse(v).success).toBe(true);
    }
    expect(KidsAgeBandSchema.safeParse('TWELVE_PLUS').success).toBe(false);
  });
});

describe('attribute key lists', () => {
  // The live declaration returned 29 attributes: 13 frequency + 11 boolean +
  // ageRatingOverride(v1, deprecated) + ageRatingOverrideV2 +
  // koreaAgeRatingOverride + kidsAgeBand + developerAgeRatingInfoUrl.
  it('covers the 13 frequency-valued questions', () => {
    expect(AGE_RATING_FREQUENCY_KEYS).toHaveLength(13);
    expect(AGE_RATING_FREQUENCY_KEYS).toContain('violenceRealisticProlongedGraphicOrSadistic');
    expect(new Set(AGE_RATING_FREQUENCY_KEYS).size).toBe(13);
  });

  it('covers the 11 boolean questions', () => {
    expect(AGE_RATING_BOOLEAN_KEYS).toHaveLength(11);
    expect(AGE_RATING_BOOLEAN_KEYS).toContain('ageAssurance');
    expect(AGE_RATING_BOOLEAN_KEYS).toContain('lootBox');
    expect(new Set(AGE_RATING_BOOLEAN_KEYS).size).toBe(11);
  });

  it('keeps the two vocabularies disjoint', () => {
    const overlap = AGE_RATING_FREQUENCY_KEYS.filter((k) =>
      (AGE_RATING_BOOLEAN_KEYS as readonly string[]).includes(k),
    );
    expect(overlap).toEqual([]);
  });

  it('13 + 11 + 5 singletons accounts for all 29 live attributes', () => {
    const singletons = [
      'ageRatingOverride',
      'ageRatingOverrideV2',
      'koreaAgeRatingOverride',
      'kidsAgeBand',
      'developerAgeRatingInfoUrl',
    ];
    expect(
      AGE_RATING_FREQUENCY_KEYS.length + AGE_RATING_BOOLEAN_KEYS.length + singletons.length,
    ).toBe(29);
  });
});

describe('digestAgeRatingDeclaration', () => {
  // The live smoke target has an all-default declaration, so the non-default
  // rendering path can't be exercised against real data — covered here.
  const wrap = (attributes: Record<string, unknown>) => ({
    data: { id: 'AI-1', type: 'ageRatingDeclarations', attributes },
  });

  it('says so plainly when every content question is at its default', () => {
    const out = digestAgeRatingDeclaration(
      wrap({ violenceRealistic: 'NONE', gambling: false, ageRatingOverrideV2: 'NONE' }),
    );
    expect(out).toContain('All content questions are at their default');
  });

  it('surfaces only the non-default answers', () => {
    const out = digestAgeRatingDeclaration(
      wrap({
        violenceRealistic: 'FREQUENT_OR_INTENSE',
        violenceCartoonOrFantasy: 'NONE',
        gambling: true,
        advertising: false,
      }),
    );
    expect(out).toContain('violenceRealistic');
    expect(out).toContain('FREQUENT_OR_INTENSE');
    expect(out).toContain('gambling');
    // Defaults are noise on a 29-attribute resource — they stay out.
    expect(out).not.toContain('violenceCartoonOrFantasy');
    expect(out).not.toContain('advertising');
  });

  it('always shows the overrides, including when unset', () => {
    // An unset override is a real answer, so absence must be visible.
    const out = digestAgeRatingDeclaration(wrap({ gambling: true }));
    expect(out).toContain('ageRatingOverrideV2');
    expect(out).toContain('koreaAgeRatingOverride');
    expect(out).toContain('not a Kids app');
  });

  it('flags a lingering deprecated v1 override, but only when set', () => {
    expect(digestAgeRatingDeclaration(wrap({ ageRatingOverride: 'NONE' }))).not.toContain(
      'DEPRECATED',
    );
    expect(digestAgeRatingDeclaration(wrap({ ageRatingOverride: 'SEVENTEEN_PLUS' }))).toContain(
      'DEPRECATED',
    );
  });

  it('warns that PATCH merges', () => {
    expect(digestAgeRatingDeclaration(wrap({}))).toContain('merge');
  });

  it('handles an empty document without throwing', () => {
    expect(digestAgeRatingDeclaration({})).toContain('No age rating declaration');
  });
});
