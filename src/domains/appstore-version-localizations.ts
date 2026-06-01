import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppStoreVersionLocalizations } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppStoreVersionIdSchema,
  AppStoreVersionLocalizationIdSchema,
  KeywordsSchema,
  LocaleSchema,
  MarketingUrlSchema,
  ProductDescriptionSchema,
  PromotionalTextSchema,
  ReleaseNotesSchema,
  SupportUrlSchema,
} from '../schemas.js';

// App Store version localizations carry the user-facing product page copy
// per (appStoreVersion, locale). This is the highest LLM-leverage surface in
// the whole project — the canonical workflow is "translate the English
// release notes into 35 locales using existing locale copy as voice
// reference, show me a diff, push on approval."
//
// Per-locale fields and Apple's caps:
//   - whatsNew (release notes): 4000 chars
//   - description (long product description): 4000 chars
//   - keywords (comma-separated ASO keywords): 100 chars TOTAL
//   - promotionalText: 170 chars (the only field that can be patched
//     post-release without a new version review)
//   - marketingUrl: standard URL
//   - supportUrl: standard URL (Apple requires this per locale)
//
// Wire-key gotcha (verified against AvdLee Swift SDK):
//   - Swift `marketingURL` -> wire `marketingUrl` (camelCase, NOT all-caps)
//   - Swift `supportURL`   -> wire `supportUrl`   (camelCase, NOT all-caps)
//   Same pattern as v0.9.0's BetaAppLocalization URLs — Apple is consistent
//   on stripping the all-caps URL suffix on the wire.
//
// Locale is immutable post-create (it's the lookup key — to change locale,
// delete the record and re-create).

const APP_STORE_VERSION_LOCALIZATION_FIELDS =
  'description,locale,keywords,marketingUrl,promotionalText,supportUrl,whatsNew';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface AppStoreVersionLocalizationCreateInput {
  appStoreVersionId: string;
  locale: string;
  whatsNew?: string | undefined;
  description?: string | undefined;
  keywords?: string | undefined;
  promotionalText?: string | undefined;
  marketingUrl?: string | undefined;
  supportUrl?: string | undefined;
}

export function buildAppStoreVersionLocalizationCreateBody(
  input: AppStoreVersionLocalizationCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = { locale: input.locale };
  if (input.whatsNew !== undefined) attributes.whatsNew = input.whatsNew;
  if (input.description !== undefined) attributes.description = input.description;
  if (input.keywords !== undefined) attributes.keywords = input.keywords;
  if (input.promotionalText !== undefined) attributes.promotionalText = input.promotionalText;
  // Wire keys: camelCase, NOT all-caps Swift names.
  if (input.marketingUrl !== undefined) attributes.marketingUrl = input.marketingUrl;
  if (input.supportUrl !== undefined) attributes.supportUrl = input.supportUrl;
  return {
    data: {
      type: 'appStoreVersionLocalizations',
      attributes,
      relationships: {
        appStoreVersion: {
          data: { type: 'appStoreVersions', id: input.appStoreVersionId },
        },
      },
    },
  };
}

export interface AppStoreVersionLocalizationPatchInput {
  appStoreVersionLocalizationId: string;
  whatsNew?: string | undefined;
  description?: string | undefined;
  keywords?: string | undefined;
  promotionalText?: string | undefined;
  marketingUrl?: string | undefined;
  supportUrl?: string | undefined;
}

export function buildAppStoreVersionLocalizationPatchBody(
  input: AppStoreVersionLocalizationPatchInput,
): JSONAPIBody {
  // Apple's AppStoreVersionLocalizationUpdateRequest accepts everything
  // except locale (which is the lookup key, immutable). All attrs
  // encodeIfPresent.
  const attributes: Record<string, unknown> = {};
  if (input.whatsNew !== undefined) attributes.whatsNew = input.whatsNew;
  if (input.description !== undefined) attributes.description = input.description;
  if (input.keywords !== undefined) attributes.keywords = input.keywords;
  if (input.promotionalText !== undefined) attributes.promotionalText = input.promotionalText;
  if (input.marketingUrl !== undefined) attributes.marketingUrl = input.marketingUrl;
  if (input.supportUrl !== undefined) attributes.supportUrl = input.supportUrl;
  return {
    data: {
      type: 'appStoreVersionLocalizations',
      id: input.appStoreVersionLocalizationId,
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

export function registerAppStoreVersionLocalizations(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_app_store_version_localizations',
    {
      title: 'List App Store version localizations',
      description:
        'List App Store version localizations under one version. Each row carries locale + whatsNew length/preview + description length + keywords + promotionalText. Use to see which locales already have copy before adding/patching more. THIS IS THE LLM-WIN ENTRY POINT: list, pick a source locale, translate into target locales, patch each.',
      inputSchema: {
        appStoreVersionId: AppStoreVersionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appStoreVersionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appStoreVersionLocalizations]', APP_STORE_VERSION_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appStoreVersions/${encodeURIComponent(
        appStoreVersionId,
      )}/appStoreVersionLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestAppStoreVersionLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_store_version_localization',
    {
      title: 'Get an App Store version localization',
      description:
        'Fetch a single App Store version localization by ID. Returns the full whatsNew + description + keywords + promotionalText + marketingUrl + supportUrl text. Use as the source-of-truth read before PATCH (so the LLM can diff before writing).',
      inputSchema: {
        appStoreVersionLocalizationId: AppStoreVersionLocalizationIdSchema,
      },
    },
    async ({ appStoreVersionLocalizationId }) => {
      const path = `/v1/appStoreVersionLocalizations/${encodeURIComponent(
        appStoreVersionLocalizationId,
      )}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_store_version_localization',
    {
      title: 'Create an App Store version localization',
      description:
        'Create an AppStoreVersionLocalization for ONE version + ONE locale. Required: appStoreVersionId + locale. Optional: whatsNew (release notes, 4000), description (4000), keywords (100 TOTAL chars), promotionalText (170), marketingUrl, supportUrl. Apple requires supportUrl per locale for review; submissions without it are rejected. The (version, locale) pair must be unique — Apple rejects a duplicate. Locale is immutable post-create.',
      inputSchema: {
        appStoreVersionId: AppStoreVersionIdSchema,
        locale: LocaleSchema,
        whatsNew: ReleaseNotesSchema.optional(),
        description: ProductDescriptionSchema.optional(),
        keywords: KeywordsSchema.optional(),
        promotionalText: PromotionalTextSchema.optional(),
        marketingUrl: MarketingUrlSchema.optional(),
        supportUrl: SupportUrlSchema.optional(),
      },
    },
    async (input) => {
      const body = buildAppStoreVersionLocalizationCreateBody({
        appStoreVersionId: input.appStoreVersionId,
        locale: input.locale,
        ...(input.whatsNew !== undefined ? { whatsNew: input.whatsNew } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
        ...(input.promotionalText !== undefined ? { promotionalText: input.promotionalText } : {}),
        ...(input.marketingUrl !== undefined ? { marketingUrl: input.marketingUrl } : {}),
        ...(input.supportUrl !== undefined ? { supportUrl: input.supportUrl } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appStoreVersionLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppStoreVersionLocalization (version ${input.appStoreVersionId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_store_version_localization',
    {
      title: 'Patch an App Store version localization',
      description:
        'Update one or more attrs on an existing AppStoreVersionLocalization. All six attrs are individually optional (encodeIfPresent — only what you pass is sent). Locale is immutable. Tool refuses empty PATCH. ' +
        'Special case: promotionalText is the ONLY field that can be mutated after a version has been released without triggering a new app-review cycle — all other fields require version review on re-release. Apple silently surfaces this constraint via state machine errors; use accordingly.',
      inputSchema: {
        appStoreVersionLocalizationId: AppStoreVersionLocalizationIdSchema,
        whatsNew: ReleaseNotesSchema.optional(),
        description: ProductDescriptionSchema.optional(),
        keywords: KeywordsSchema.optional(),
        promotionalText: PromotionalTextSchema.optional(),
        marketingUrl: MarketingUrlSchema.optional(),
        supportUrl: SupportUrlSchema.optional(),
      },
    },
    async (input) => {
      const anyField = [
        input.whatsNew,
        input.description,
        input.keywords,
        input.promotionalText,
        input.marketingUrl,
        input.supportUrl,
      ].some((v) => v !== undefined);
      if (!anyField) {
        return {
          content: [
            {
              type: 'text',
              text: "Refused: pass at least one attribute to mutate. Empty PATCH would no-op on Apple's side and waste a round-trip.",
            },
          ],
          isError: true,
        };
      }
      const body = buildAppStoreVersionLocalizationPatchBody({
        appStoreVersionLocalizationId: input.appStoreVersionLocalizationId,
        ...(input.whatsNew !== undefined ? { whatsNew: input.whatsNew } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
        ...(input.promotionalText !== undefined ? { promotionalText: input.promotionalText } : {}),
        ...(input.marketingUrl !== undefined ? { marketingUrl: input.marketingUrl } : {}),
        ...(input.supportUrl !== undefined ? { supportUrl: input.supportUrl } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appStoreVersionLocalizations/${encodeURIComponent(
            input.appStoreVersionLocalizationId,
          )}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppStoreVersionLocalization ${input.appStoreVersionLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_store_version_localization',
    {
      title: 'Delete an App Store version localization',
      description:
        "DELETE an AppStoreVersionLocalization. The locale is removed for this version; users in that locale fall back to the default locale's copy on the product page. Doesn't affect other versions or other locales. Apple may reject if the version is in a state that locks localizations (e.g. in review).",
      inputSchema: {
        appStoreVersionLocalizationId: AppStoreVersionLocalizationIdSchema,
      },
    },
    async ({ appStoreVersionLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/appStoreVersionLocalizations/${encodeURIComponent(appStoreVersionLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Deleted AppStoreVersionLocalization ${appStoreVersionLocalizationId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
