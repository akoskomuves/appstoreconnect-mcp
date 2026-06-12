import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppInfoLocalizations, digestAppInfos } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppCategoryIdSchema,
  AppIdSchema,
  AppInfoIdSchema,
  AppInfoLocalizationIdSchema,
  AppInfoLocalizationNameSchema,
  LocaleSchema,
  PrivacyChoicesUrlSchema,
  PrivacyPolicyTextSchema,
  PrivacyPolicyUrlSchema,
  SubtitleSchema,
} from '../schemas.js';

// AppInfo is the per-app metadata layer above the version — it carries
// primary/secondary category relationships and the appStoreAgeRating.
// Most other age-rating attributes (australiaAgeRating, brazilAgeRatingV2,
// franceAgeRating, koreaAgeRating) are marked DEPRECATED in Apple's
// contract; we expose them on read but skip them on writes.
//
// LIVE-USAGE BUG FIX (reported 2026-06-12): `kidsAgeBand` was REMOVED from
// Apple's AppInfo contract after v0.12 shipped — keeping it in the sparse
// fieldset made every asc_list_app_infos call 400. Apple deletes fields
// from live contracts; a 400 PARAMETER_ERROR on a fields[…] value is the
// signature.
//
// Apple manages create/delete on AppInfo automatically. Typically one
// AppInfo per app for the App Store track; macOS notarization may add a
// second. Only PATCH is exposed — and PATCH is RELATIONSHIPS-ONLY:
// AppInfoUpdateRequest has no Attributes block, just the six category
// relationship slots (primaryCategory, primarySubcategoryOne,
// primarySubcategoryTwo, secondaryCategory, secondarySubcategoryOne,
// secondarySubcategoryTwo).
//
// State machine on AppInfo (separate from but related to AppStoreVersion's
// appStoreState; AppInfo has an additional REPLACED_WITH_NEW_INFO state):
//
//   PREPARE_FOR_SUBMISSION / DEVELOPER_REJECTED / REJECTED
//     -> categories mutable
//   WAITING_FOR_REVIEW / IN_REVIEW
//     -> nothing mutable (Apple is reviewing)
//   READY_FOR_REVIEW / ACCEPTED / READY_FOR_DISTRIBUTION / PENDING_RELEASE /
//   REPLACED_WITH_NEW_INFO
//     -> usually frozen; Apple's error gates it. Pass-through for now.
//
// Defer: full pre-check matrix on AppInfo PATCH. Hardcode just the obvious
// frozen states for now and pass through everything else.

const APP_INFO_FIELDS = 'appStoreState,state,appStoreAgeRating';
const APP_INFO_LOCALIZATION_FIELDS =
  'locale,name,subtitle,privacyPolicyUrl,privacyChoicesUrl,privacyPolicyText';

const APP_INFO_FROZEN_STATES = new Set<string>(['WAITING_FOR_REVIEW', 'IN_REVIEW']);

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- AppInfo PATCH body -----

export interface AppInfoPatchInput {
  appInfoId: string;
  primaryCategoryId?: string | null | undefined;
  primarySubcategoryOneId?: string | null | undefined;
  primarySubcategoryTwoId?: string | null | undefined;
  secondaryCategoryId?: string | null | undefined;
  secondarySubcategoryOneId?: string | null | undefined;
  secondarySubcategoryTwoId?: string | null | undefined;
}

export function buildAppInfoPatchBody(input: AppInfoPatchInput): JSONAPIBody {
  // Apple's AppInfoUpdateRequest has NO attributes block — only relationships.
  // Body builder OMITs the attributes key entirely. Each category slot
  // accepts data: { type, id } to set, data: null to clear. undefined
  // means "leave it alone".
  const relationships: Record<string, unknown> = {};
  const setSlot = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null) {
      relationships[key] = { data: null };
    } else {
      relationships[key] = { data: { type: 'appCategories', id: value } };
    }
  };
  setSlot('primaryCategory', input.primaryCategoryId);
  setSlot('primarySubcategoryOne', input.primarySubcategoryOneId);
  setSlot('primarySubcategoryTwo', input.primarySubcategoryTwoId);
  setSlot('secondaryCategory', input.secondaryCategoryId);
  setSlot('secondarySubcategoryOne', input.secondarySubcategoryOneId);
  setSlot('secondarySubcategoryTwo', input.secondarySubcategoryTwoId);
  return {
    data: {
      type: 'appInfos',
      id: input.appInfoId,
      relationships,
    },
  };
}

// ----- AppInfoLocalization body builders -----

export interface AppInfoLocalizationCreateInput {
  appInfoId: string;
  locale: string;
  name: string;
  subtitle?: string | undefined;
  privacyPolicyUrl?: string | undefined;
  privacyChoicesUrl?: string | undefined;
  privacyPolicyText?: string | undefined;
}

export function buildAppInfoLocalizationCreateBody(
  input: AppInfoLocalizationCreateInput,
): JSONAPIBody {
  // Required: locale + name + appInfo rel. Optional: subtitle, privacyPolicyUrl,
  // privacyChoicesUrl, privacyPolicyText. Wire-key gotcha: Swift
  // `privacyPolicyURL` / `privacyChoicesURL` → wire camelCase
  // privacyPolicyUrl / privacyChoicesUrl. Same strip pattern as
  // marketingUrl/supportUrl on AppStoreVersionLocalization.
  const attributes: Record<string, unknown> = {
    locale: input.locale,
    name: input.name,
  };
  if (input.subtitle !== undefined) attributes.subtitle = input.subtitle;
  if (input.privacyPolicyUrl !== undefined) attributes.privacyPolicyUrl = input.privacyPolicyUrl;
  if (input.privacyChoicesUrl !== undefined) attributes.privacyChoicesUrl = input.privacyChoicesUrl;
  if (input.privacyPolicyText !== undefined) attributes.privacyPolicyText = input.privacyPolicyText;
  return {
    data: {
      type: 'appInfoLocalizations',
      attributes,
      relationships: {
        appInfo: { data: { type: 'appInfos', id: input.appInfoId } },
      },
    },
  };
}

export interface AppInfoLocalizationPatchInput {
  appInfoLocalizationId: string;
  name?: string | undefined;
  subtitle?: string | undefined;
  privacyPolicyUrl?: string | undefined;
  privacyChoicesUrl?: string | undefined;
  privacyPolicyText?: string | undefined;
}

export function buildAppInfoLocalizationPatchBody(
  input: AppInfoLocalizationPatchInput,
): JSONAPIBody {
  // Locale is immutable (lookup key); Apple's UpdateRequest excludes it.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.subtitle !== undefined) attributes.subtitle = input.subtitle;
  if (input.privacyPolicyUrl !== undefined) attributes.privacyPolicyUrl = input.privacyPolicyUrl;
  if (input.privacyChoicesUrl !== undefined) attributes.privacyChoicesUrl = input.privacyChoicesUrl;
  if (input.privacyPolicyText !== undefined) attributes.privacyPolicyText = input.privacyPolicyText;
  return {
    data: {
      type: 'appInfoLocalizations',
      id: input.appInfoLocalizationId,
      attributes,
    },
  };
}

// ----- AppInfo PATCH pre-check (lightweight: only refuse on clearly frozen states) -----

export interface AppInfoPatchGateResult {
  allow: boolean;
  state: string | undefined;
  reason?: string;
  nextEditablePath?: string;
}

export function evaluateAppInfoPatchGate(state: string | undefined): AppInfoPatchGateResult {
  if (!state) return { allow: true, state };
  if (APP_INFO_FROZEN_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `AppInfo state is ${state} — Apple holds it during review and rejects PATCH on the category relationships`,
      nextEditablePath:
        'Wait for review to complete; on a rejection, the state flips to DEVELOPER_REJECTED / REJECTED and categories become editable again. To cancel the in-flight review entirely, cancel the parent ReviewSubmission via asc_patch_review_submission action: "cancel".',
    };
  }
  return { allow: true, state };
}

function formatPatchGateRefusal(g: AppInfoPatchGateResult): string {
  return [
    `Refused: AppInfo PATCH blocked by current state.`,
    ``,
    `State:  ${g.state ?? '(unknown)'}`,
    `Reason: ${g.reason ?? ''}`,
    ``,
    `Next:   ${g.nextEditablePath ?? ''}`,
  ].join('\n');
}

async function fetchAppInfoState(
  client: ASCClient,
  appInfoId: string,
): Promise<string | undefined> {
  const path = `/v1/appInfos/${encodeURIComponent(appInfoId)}?fields[appInfos]=state,appStoreState`;
  try {
    const res = await client.request<{
      data?: { attributes?: { state?: string; appStoreState?: string } };
    }>(path, { method: 'GET' });
    return res?.data?.attributes?.state ?? res?.data?.attributes?.appStoreState;
  } catch {
    return undefined;
  }
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerAppInfo(server: McpServer, client: ASCClient): void {
  // ----- AppInfo (3 tools) -----

  server.registerTool(
    'asc_list_app_infos',
    {
      title: 'List App Infos for an app',
      description:
        'List AppInfo records for an app. Apps typically have one AppInfo per distribution track — most apps have just one (the App Store track); macOS notarization can introduce a second. Each row shows the state, appStoreState (mirrored from the linked AppStoreVersion), and appStoreAgeRating. Use to find the AppInfo ID before patching categories or fetching localizations.',
      inputSchema: {
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appInfos]', APP_INFO_FIELDS);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/appInfos?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppInfos(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_info',
    {
      title: 'Get an AppInfo',
      description:
        'Fetch a single AppInfo with its category relationships + localizations expanded. The relationships block carries the IDs for primary/secondary categories + subcategories — use asc_list_app_categories to resolve those IDs to human-readable names.',
      inputSchema: {
        appInfoId: AppInfoIdSchema,
      },
    },
    async ({ appInfoId }) => {
      const path =
        `/v1/appInfos/${encodeURIComponent(appInfoId)}` +
        `?include=primaryCategory,primarySubcategoryOne,primarySubcategoryTwo,` +
        `secondaryCategory,secondarySubcategoryOne,secondarySubcategoryTwo,appInfoLocalizations`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_info',
    {
      title: 'Patch an AppInfo (set category relationships)',
      description:
        'Set primary/secondary category + subcategory relationships on an AppInfo. AppInfoUpdateRequest is RELATIONSHIPS-ONLY (no mutable attributes). Each slot accepts a category ID (set/swap) or null (clear). All six slots are independently optional. ' +
        "Pre-check refuses for clearly frozen states (WAITING_FOR_REVIEW, IN_REVIEW) where Apple holds the resource during review. Other states pass through — Apple's PATCH rules vary subtly with state. " +
        'Use asc_list_app_categories first to resolve human-readable category names to category IDs.',
      inputSchema: {
        appInfoId: AppInfoIdSchema,
        primaryCategoryId: AppCategoryIdSchema.nullable()
          .optional()
          .describe('Set the primary category. null clears. undefined leaves it alone.'),
        primarySubcategoryOneId: AppCategoryIdSchema.nullable().optional(),
        primarySubcategoryTwoId: AppCategoryIdSchema.nullable().optional(),
        secondaryCategoryId: AppCategoryIdSchema.nullable().optional(),
        secondarySubcategoryOneId: AppCategoryIdSchema.nullable().optional(),
        secondarySubcategoryTwoId: AppCategoryIdSchema.nullable().optional(),
      },
    },
    async (input) => {
      const anySlot =
        input.primaryCategoryId !== undefined ||
        input.primarySubcategoryOneId !== undefined ||
        input.primarySubcategoryTwoId !== undefined ||
        input.secondaryCategoryId !== undefined ||
        input.secondarySubcategoryOneId !== undefined ||
        input.secondarySubcategoryTwoId !== undefined;
      if (!anySlot) {
        return {
          content: [
            {
              type: 'text',
              text: "Refused: pass at least one category slot. Empty PATCH would no-op on Apple's side.",
            },
          ],
          isError: true,
        };
      }
      const state = await fetchAppInfoState(client, input.appInfoId);
      const gate = evaluateAppInfoPatchGate(state);
      if (!gate.allow) {
        return {
          content: [{ type: 'text', text: formatPatchGateRefusal(gate) }],
          isError: true,
        };
      }
      const body = buildAppInfoPatchBody({
        appInfoId: input.appInfoId,
        ...(input.primaryCategoryId !== undefined
          ? { primaryCategoryId: input.primaryCategoryId }
          : {}),
        ...(input.primarySubcategoryOneId !== undefined
          ? { primarySubcategoryOneId: input.primarySubcategoryOneId }
          : {}),
        ...(input.primarySubcategoryTwoId !== undefined
          ? { primarySubcategoryTwoId: input.primarySubcategoryTwoId }
          : {}),
        ...(input.secondaryCategoryId !== undefined
          ? { secondaryCategoryId: input.secondaryCategoryId }
          : {}),
        ...(input.secondarySubcategoryOneId !== undefined
          ? { secondarySubcategoryOneId: input.secondarySubcategoryOneId }
          : {}),
        ...(input.secondarySubcategoryTwoId !== undefined
          ? { secondarySubcategoryTwoId: input.secondarySubcategoryTwoId }
          : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appInfos/${encodeURIComponent(input.appInfoId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppInfo ${input.appInfoId} categories (state: ${gate.state ?? 'unknown'}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- AppInfoLocalization (5 tools) -----

  server.registerTool(
    'asc_list_app_info_localizations',
    {
      title: 'List AppInfo localizations',
      description:
        'List AppInfoLocalization records under an AppInfo. Each row carries locale + name + subtitle + privacy URLs/text. Use to inspect existing per-locale copy before adding new locales or patching existing ones.',
      inputSchema: {
        appInfoId: AppInfoIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appInfoId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appInfoLocalizations]', APP_INFO_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appInfos/${encodeURIComponent(appInfoId)}/appInfoLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppInfoLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_info_localization',
    {
      title: 'Get an AppInfo localization',
      description:
        'Fetch a single AppInfoLocalization by ID. Returns the full name + subtitle + privacy URLs/text for the locale.',
      inputSchema: {
        appInfoLocalizationId: AppInfoLocalizationIdSchema,
      },
    },
    async ({ appInfoLocalizationId }) => {
      const path = `/v1/appInfoLocalizations/${encodeURIComponent(appInfoLocalizationId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_info_localization',
    {
      title: 'Create an AppInfo localization',
      description:
        'Create an AppInfoLocalization for ONE AppInfo + ONE locale. Required: appInfoId + locale + name (30 chars). Optional: subtitle (30 chars), privacyPolicyUrl, privacyChoicesUrl (CCPA/CPRA flows), privacyPolicyText (inline text for territories that require it). ' +
        'Wire-key gotcha: Swift `privacyPolicyURL` / `privacyChoicesURL` map to wire-camelCase `privacyPolicyUrl` / `privacyChoicesUrl`. The (appInfo, locale) pair must be unique — Apple rejects a duplicate. Locale is immutable post-create.',
      inputSchema: {
        appInfoId: AppInfoIdSchema,
        locale: LocaleSchema,
        name: AppInfoLocalizationNameSchema,
        subtitle: SubtitleSchema.optional(),
        privacyPolicyUrl: PrivacyPolicyUrlSchema.optional(),
        privacyChoicesUrl: PrivacyChoicesUrlSchema.optional(),
        privacyPolicyText: PrivacyPolicyTextSchema.optional(),
      },
    },
    async (input) => {
      const body = buildAppInfoLocalizationCreateBody({
        appInfoId: input.appInfoId,
        locale: input.locale,
        name: input.name,
        ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
        ...(input.privacyPolicyUrl !== undefined
          ? { privacyPolicyUrl: input.privacyPolicyUrl }
          : {}),
        ...(input.privacyChoicesUrl !== undefined
          ? { privacyChoicesUrl: input.privacyChoicesUrl }
          : {}),
        ...(input.privacyPolicyText !== undefined
          ? { privacyPolicyText: input.privacyPolicyText }
          : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appInfoLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppInfoLocalization (AppInfo ${input.appInfoId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_info_localization',
    {
      title: 'Patch an AppInfo localization',
      description:
        'Update name / subtitle / privacy fields on an existing AppInfoLocalization. All five attrs are encodeIfPresent (only what you pass is sent). Locale is immutable. ' +
        "Wire-key gotcha: privacyPolicyUrl / privacyChoicesUrl are camelCase (NOT Swift's all-caps URL suffix). Tool refuses empty PATCH.",
      inputSchema: {
        appInfoLocalizationId: AppInfoLocalizationIdSchema,
        name: AppInfoLocalizationNameSchema.optional(),
        subtitle: SubtitleSchema.optional(),
        privacyPolicyUrl: PrivacyPolicyUrlSchema.optional(),
        privacyChoicesUrl: PrivacyChoicesUrlSchema.optional(),
        privacyPolicyText: PrivacyPolicyTextSchema.optional(),
      },
    },
    async (input) => {
      const anyAttr = [
        input.name,
        input.subtitle,
        input.privacyPolicyUrl,
        input.privacyChoicesUrl,
        input.privacyPolicyText,
      ].some((v) => v !== undefined);
      if (!anyAttr) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one attribute to mutate. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildAppInfoLocalizationPatchBody({
        appInfoLocalizationId: input.appInfoLocalizationId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
        ...(input.privacyPolicyUrl !== undefined
          ? { privacyPolicyUrl: input.privacyPolicyUrl }
          : {}),
        ...(input.privacyChoicesUrl !== undefined
          ? { privacyChoicesUrl: input.privacyChoicesUrl }
          : {}),
        ...(input.privacyPolicyText !== undefined
          ? { privacyPolicyText: input.privacyPolicyText }
          : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appInfoLocalizations/${encodeURIComponent(input.appInfoLocalizationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppInfoLocalization ${input.appInfoLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_info_localization',
    {
      title: 'Delete an AppInfo localization',
      description:
        "DELETE an AppInfoLocalization. The locale-specific app-level copy is removed (subtitle, privacy URLs, etc.). Customers in that locale fall back to the default locale's AppInfoLocalization. Apple may reject if the parent AppInfo is in a frozen state.",
      inputSchema: {
        appInfoLocalizationId: AppInfoLocalizationIdSchema,
      },
    },
    async ({ appInfoLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/appInfoLocalizations/${encodeURIComponent(appInfoLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted AppInfoLocalization ${appInfoLocalizationId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
