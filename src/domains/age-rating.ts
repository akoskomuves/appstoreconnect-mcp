import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAgeRatingDeclaration } from '../digest.js';
import { ASCError } from '../errors.js';
import {
  AgeRatingDeclarationIdSchema,
  AgeRatingFrequencySchema,
  AgeRatingOverrideV2Schema,
  AppIdSchema,
  KidsAgeBandSchema,
  KoreaAgeRatingOverrideSchema,
} from '../schemas.js';

// Age rating is the questionnaire App Review scores an app against. It gates
// submission: an app whose declaration has never been filled in cannot ship.
//
// SHAPE (verified against the live API 2026-07-30):
//
//   * The declaration hangs off APP INFO, not the version:
//       GET /v1/appInfos/{id}/ageRatingDeclaration   → 200
//       GET /v1/appStoreVersions/{id}/ageRatingDeclaration → 404
//     Age rating is per-app metadata, like categories — not per-release.
//
//   * `ageRatingDeclaration.id` IS the appInfo id. Same "Apple ids are not
//     opaque" family as AppKeyword.id == the keyword and
//     AppAvailability.id == the app id. That is why asc_patch_* can resolve
//     the target from an appId alone.
//
//   * Writes go to the flat resource, NOT the relationship path:
//       PATCH /v1/ageRatingDeclarations/{id}
//
//   * 29 attributes in three shapes: 13 content-frequency enums, 3 rating
//     overrides, and booleans. All are optional on PATCH — Apple merges, so
//     omitting a key leaves it untouched. That makes a partial PATCH safe,
//     but it also means you cannot "clear" a field by omitting it; send the
//     explicit NONE/false instead.
//
//   * `ageRatingOverride` (v1) is DEPRECATED in favour of
//     `ageRatingOverrideV2`. The two differ in vocabulary — v1 has
//     SEVENTEEN_PLUS where v2 has EIGHTEEN_PLUS — so they are not
//     interchangeable. Only v2 is exposed for writes here; reads surface
//     whatever Apple returns.
//
//   * `kidsAgeBand` lives HERE. It was removed from AppInfo (that removal
//     broke asc_list_app_infos in 2026-06-12 and is a different resource) —
//     do not conflate the two.

// The 13 attributes sharing the content-frequency vocabulary. Kept as one
// list so the schema, the body builder and the digest can never disagree
// about which keys are frequency-valued.
export const AGE_RATING_FREQUENCY_KEYS = [
  'alcoholTobaccoOrDrugUseOrReferences',
  'contests',
  'gamblingSimulated',
  'gunsOrOtherWeapons',
  'horrorOrFearThemes',
  'matureOrSuggestiveThemes',
  'medicalOrTreatmentInformation',
  'profanityOrCrudeHumor',
  'sexualContentGraphicAndNudity',
  'sexualContentOrNudity',
  'violenceCartoonOrFantasy',
  'violenceRealistic',
  'violenceRealisticProlongedGraphicOrSadistic',
] as const;

export const AGE_RATING_BOOLEAN_KEYS = [
  'advertising',
  'ageAssurance',
  'gambling',
  'healthOrWellnessTopics',
  'lootBox',
  'messagingAndChat',
  'parentalControls',
  'socialMedia',
  'socialMediaAgeRestricted',
  'unrestrictedWebAccess',
  'userGeneratedContent',
] as const;

export type AgeRatingFrequencyKey = (typeof AGE_RATING_FREQUENCY_KEYS)[number];
export type AgeRatingBooleanKey = (typeof AGE_RATING_BOOLEAN_KEYS)[number];

export interface AgeRatingDeclarationPatchInput {
  declarationId: string;
  attributes: Record<string, unknown>;
}

interface JSONAPIBody {
  data: {
    type: string;
    id: string;
    attributes: Record<string, unknown>;
  };
}

/**
 * Builds the PATCH body. Only keys the caller actually supplied are emitted —
 * Apple merges, so an omitted key is left untouched rather than cleared.
 */
export function buildAgeRatingDeclarationPatchBody(
  input: AgeRatingDeclarationPatchInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.attributes)) {
    if (v !== undefined) attributes[k] = v;
  }
  return {
    data: {
      // Apple requires the id in the body as well as the URL (409 otherwise).
      type: 'ageRatingDeclarations',
      id: input.declarationId,
      attributes,
    },
  };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

interface AppInfoRef {
  id?: string;
}

/**
 * Resolves the declaration id (== appInfo id) for an app.
 *
 * Apple usually keeps one AppInfo per app but can keep several across
 * NOTARIZATION / APP_STORE tracks, and picking the wrong one would silently
 * rate the wrong track — so ambiguity is reported rather than guessed.
 */
export async function resolveDeclarationId(
  client: ASCClient,
  appId: string,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const res = await client.request<{ data?: AppInfoRef[] }>(
    `/v1/apps/${encodeURIComponent(appId)}/appInfos?limit=10`,
  );
  const ids = (res.data ?? []).map((d) => d.id).filter((id): id is string => Boolean(id));
  if (ids.length === 1 && ids[0]) return { ok: true, id: ids[0] };
  if (ids.length === 0) {
    return {
      ok: false,
      message: `App ${appId} has no appInfos, so it has no age-rating declaration to patch.`,
    };
  }
  return {
    ok: false,
    message: `App ${appId} has ${ids.length} appInfos (Apple keeps separate ones across NOTARIZATION / APP_STORE tracks). Re-run with an explicit declarationId — the declaration id equals the appInfo id. Candidates: ${ids.join(', ')}`,
  };
}

export function registerAgeRating(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_get_age_rating_declaration',
    {
      title: 'Get the age rating declaration',
      description:
        "Read an app's age-rating questionnaire — the answers App Review scores the rating from. Pass appId (resolved via the app's appInfo) or an explicit declarationId. Returns a grouped table of the non-default answers plus every override; pass raw:true for all 29 attributes. Age rating is per-APP metadata (it hangs off appInfo), not per-version — there is no separate rating per release.",
      inputSchema: z.object({
        appId: AppIdSchema.optional().describe(
          'Resolve the declaration from the app. Use this unless the app has multiple appInfos.',
        ),
        declarationId: AgeRatingDeclarationIdSchema.optional().describe(
          'Explicit declaration id (== the appInfo id). Takes precedence over appId.',
        ),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, declarationId, raw }) => {
      if (!appId && !declarationId) {
        return {
          content: [{ type: 'text', text: 'Pass either appId or declarationId.' }],
          isError: true,
        };
      }
      try {
        let id = declarationId;
        if (!id && appId) {
          const resolved = await resolveDeclarationId(client, appId);
          if (!resolved.ok) {
            return { content: [{ type: 'text', text: resolved.message }], isError: true };
          }
          id = resolved.id;
        }
        // Read through the appInfo relationship — the flat
        // /v1/ageRatingDeclarations/{id} GET is not exposed by Apple.
        const data = await client.request<unknown>(
          `/v1/appInfos/${encodeURIComponent(id as string)}/ageRatingDeclaration`,
        );
        const text = raw
          ? JSON.stringify(data, null, 2)
          : digestAgeRatingDeclaration(data as Parameters<typeof digestAgeRatingDeclaration>[0]);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_age_rating_declaration',
    {
      title: 'Update the age rating declaration',
      description:
        'Answer the age-rating questionnaire. Every field is optional and Apple MERGES — omitted keys keep their current value, so a partial update is safe, but you cannot clear a field by omitting it (send the explicit NONE / false). Content questions take a frequency: NONE / INFREQUENT_OR_MILD / FREQUENT_OR_INTENSE (some newer categories use INFREQUENT / FREQUENT). Raising any answer raises the computed rating. Overrides can only push the rating UP, never down. Writes to /v1/ageRatingDeclarations/{id}; the id equals the appInfo id and is resolved for you from appId. ⚠️ This drives the public age rating and can gate App Review — review the current answers with asc_get_age_rating_declaration first.',
      inputSchema: z.object({
        appId: AppIdSchema.optional().describe(
          'Resolve the declaration from the app. Use this unless the app has multiple appInfos.',
        ),
        declarationId: AgeRatingDeclarationIdSchema.optional().describe(
          'Explicit declaration id (== the appInfo id). Takes precedence over appId.',
        ),

        // Content frequency questions.
        alcoholTobaccoOrDrugUseOrReferences: AgeRatingFrequencySchema.optional(),
        contests: AgeRatingFrequencySchema.optional(),
        gamblingSimulated: AgeRatingFrequencySchema.optional(),
        gunsOrOtherWeapons: AgeRatingFrequencySchema.optional(),
        horrorOrFearThemes: AgeRatingFrequencySchema.optional(),
        matureOrSuggestiveThemes: AgeRatingFrequencySchema.optional(),
        medicalOrTreatmentInformation: AgeRatingFrequencySchema.optional(),
        profanityOrCrudeHumor: AgeRatingFrequencySchema.optional(),
        sexualContentGraphicAndNudity: AgeRatingFrequencySchema.optional(),
        sexualContentOrNudity: AgeRatingFrequencySchema.optional(),
        violenceCartoonOrFantasy: AgeRatingFrequencySchema.optional(),
        violenceRealistic: AgeRatingFrequencySchema.optional(),
        violenceRealisticProlongedGraphicOrSadistic: AgeRatingFrequencySchema.optional(),

        // Yes/no questions.
        advertising: z.boolean().optional().describe('App displays advertising.'),
        ageAssurance: z.boolean().optional().describe('App performs age assurance/verification.'),
        gambling: z.boolean().optional().describe('Real-money gambling.'),
        healthOrWellnessTopics: z.boolean().optional(),
        lootBox: z.boolean().optional().describe('Randomised paid items (loot boxes).'),
        messagingAndChat: z.boolean().optional(),
        parentalControls: z.boolean().optional(),
        socialMedia: z.boolean().optional(),
        socialMediaAgeRestricted: z.boolean().optional(),
        unrestrictedWebAccess: z
          .boolean()
          .optional()
          .describe('Unfiltered access to the web (an in-app browser without filtering).'),
        userGeneratedContent: z.boolean().optional(),

        // Overrides + extras.
        ageRatingOverrideV2: AgeRatingOverrideV2Schema.optional(),
        koreaAgeRatingOverride: KoreaAgeRatingOverrideSchema.optional(),
        kidsAgeBand: KidsAgeBandSchema.optional(),
        developerAgeRatingInfoUrl: z
          .string()
          .url()
          .optional()
          .describe('URL with further age-rating information for reviewers.'),
      }),
    },
    async (input) => {
      const { appId, declarationId, ...rest } = input;
      if (!appId && !declarationId) {
        return {
          content: [{ type: 'text', text: 'Pass either appId or declarationId.' }],
          isError: true,
        };
      }
      const attributes = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(attributes).length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one age-rating attribute. A PATCH with no attributes is a wasted round-trip — Apple merges, so it would change nothing.',
            },
          ],
          isError: true,
        };
      }
      try {
        let id = declarationId;
        if (!id && appId) {
          const resolved = await resolveDeclarationId(client, appId);
          if (!resolved.ok) {
            return { content: [{ type: 'text', text: resolved.message }], isError: true };
          }
          id = resolved.id;
        }
        const body = buildAgeRatingDeclarationPatchBody({
          declarationId: id as string,
          attributes,
        });
        const data = await client.request<unknown>(
          `/v1/ageRatingDeclarations/${encodeURIComponent(id as string)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        const changed = Object.keys(attributes).sort().join(', ');
        return {
          content: [
            {
              type: 'text',
              text: `Updated age rating declaration ${id} (${Object.keys(attributes).length} attribute(s): ${changed}).\n\n${digestAgeRatingDeclaration(
                data as Parameters<typeof digestAgeRatingDeclaration>[0],
              )}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
