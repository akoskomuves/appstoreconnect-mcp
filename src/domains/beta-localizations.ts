import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestBetaAppLocalizations, digestBetaBuildLocalizations } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  BetaAppDescriptionSchema,
  BetaAppLocalizationIdSchema,
  BetaBuildLocalizationIdSchema,
  BuildIdSchema,
  FeedbackEmailSchema,
  LocaleSchema,
  MarketingUrlSchema,
  PrivacyPolicyUrlSchema,
  WhatsNewSchema,
} from '../schemas.js';

// Beta localizations come in two flavors, both per-locale:
//
//   1. BetaBuildLocalization (per-build, per-locale): the "What to Test"
//      string shown to TestFlight users for ONE specific build. Apple
//      caps `whatsNew` at 4000 characters. Resource is unique per
//      (build, locale).
//
//   2. BetaAppLocalization (per-app, per-locale): the STANDING beta
//      description shown above "What to Test" — feedbackEmail,
//      marketingUrl, privacyPolicyUrl, tvOsPrivacyPolicy, description.
//      Resource is unique per (app, locale). Apple caps `description` at
//      4000 characters.
//
// Apple's wire-key quirks:
//   - Swift `marketingURL` -> wire `marketingUrl` (camelCase, not all-caps)
//   - Swift `privacyPolicyURL` -> wire `privacyPolicyUrl`
//   These two are the only ones to watch — `tvOsPrivacyPolicy`,
//   `feedbackEmail`, `description`, `locale`, `whatsNew` are all 1:1.
//
// Mutability:
//   - BetaBuildLocalization PATCH: only `whatsNew`. Locale is immutable
//     (it's the lookup key); to change locale, delete and re-create.
//   - BetaAppLocalization PATCH: all attrs except locale. Same rule for
//     locale.

const BETA_BUILD_LOCALIZATION_FIELDS = 'whatsNew,locale';
const BETA_APP_LOCALIZATION_FIELDS =
  'feedbackEmail,marketingUrl,privacyPolicyUrl,tvOsPrivacyPolicy,description,locale';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- BetaBuildLocalization body builders -----

export interface BetaBuildLocalizationCreateInput {
  buildId: string;
  locale: string;
  whatsNew?: string | undefined;
}

export function buildBetaBuildLocalizationCreateBody(
  input: BetaBuildLocalizationCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = { locale: input.locale };
  if (input.whatsNew !== undefined) attributes.whatsNew = input.whatsNew;
  return {
    data: {
      type: 'betaBuildLocalizations',
      attributes,
      relationships: {
        build: { data: { type: 'builds', id: input.buildId } },
      },
    },
  };
}

export interface BetaBuildLocalizationPatchInput {
  betaBuildLocalizationId: string;
  whatsNew: string;
}

export function buildBetaBuildLocalizationPatchBody(
  input: BetaBuildLocalizationPatchInput,
): JSONAPIBody {
  // Apple's BetaBuildLocalizationUpdateRequest accepts ONLY whatsNew.
  // Locale is the lookup key and immutable.
  return {
    data: {
      type: 'betaBuildLocalizations',
      id: input.betaBuildLocalizationId,
      attributes: { whatsNew: input.whatsNew },
    },
  };
}

// ----- BetaAppLocalization body builders -----

export interface BetaAppLocalizationCreateInput {
  appId: string;
  locale: string;
  description?: string | undefined;
  feedbackEmail?: string | undefined;
  marketingUrl?: string | undefined;
  privacyPolicyUrl?: string | undefined;
  tvOsPrivacyPolicy?: string | undefined;
}

export function buildBetaAppLocalizationCreateBody(
  input: BetaAppLocalizationCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = { locale: input.locale };
  if (input.description !== undefined) attributes.description = input.description;
  if (input.feedbackEmail !== undefined) attributes.feedbackEmail = input.feedbackEmail;
  // Wire keys per Apple: marketingUrl + privacyPolicyUrl (camelCase, not
  // Swift's all-caps URL suffix). Easy to get wrong from intuition.
  if (input.marketingUrl !== undefined) attributes.marketingUrl = input.marketingUrl;
  if (input.privacyPolicyUrl !== undefined) attributes.privacyPolicyUrl = input.privacyPolicyUrl;
  if (input.tvOsPrivacyPolicy !== undefined) attributes.tvOsPrivacyPolicy = input.tvOsPrivacyPolicy;
  return {
    data: {
      type: 'betaAppLocalizations',
      attributes,
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export interface BetaAppLocalizationPatchInput {
  betaAppLocalizationId: string;
  description?: string | undefined;
  feedbackEmail?: string | undefined;
  marketingUrl?: string | undefined;
  privacyPolicyUrl?: string | undefined;
  tvOsPrivacyPolicy?: string | undefined;
}

export function buildBetaAppLocalizationPatchBody(
  input: BetaAppLocalizationPatchInput,
): JSONAPIBody {
  // Apple's BetaAppLocalizationUpdateRequest accepts all attrs except
  // locale (which is immutable). encodeIfPresent on all of them.
  const attributes: Record<string, unknown> = {};
  if (input.description !== undefined) attributes.description = input.description;
  if (input.feedbackEmail !== undefined) attributes.feedbackEmail = input.feedbackEmail;
  if (input.marketingUrl !== undefined) attributes.marketingUrl = input.marketingUrl;
  if (input.privacyPolicyUrl !== undefined) attributes.privacyPolicyUrl = input.privacyPolicyUrl;
  if (input.tvOsPrivacyPolicy !== undefined) attributes.tvOsPrivacyPolicy = input.tvOsPrivacyPolicy;
  return {
    data: {
      type: 'betaAppLocalizations',
      id: input.betaAppLocalizationId,
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

export function registerBetaLocalizations(server: McpServer, client: ASCClient): void {
  // ----- BetaBuildLocalization (per-build "What to Test") -----

  server.registerTool(
    'asc_list_beta_build_localizations',
    {
      title: 'List per-build "What to Test" localizations',
      description:
        'List BetaBuildLocalizations under a build. Each row is one locale\'s "What to Test" entry for that build (max 4000 chars). Use to see what locales already have copy before adding/patching more.',
      inputSchema: z.object({
        buildId: BuildIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[betaBuildLocalizations]', BETA_BUILD_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/builds/${encodeURIComponent(
        buildId,
      )}/betaBuildLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBetaBuildLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_build_localization',
    {
      title: 'Get a per-build "What to Test" localization',
      description:
        'Fetch a single BetaBuildLocalization by ID. Returns the locale + the full whatsNew text. Use before PATCH to read current copy.',
      inputSchema: z.object({
        betaBuildLocalizationId: BetaBuildLocalizationIdSchema,
      }),
    },
    async ({ betaBuildLocalizationId }) => {
      const path = `/v1/betaBuildLocalizations/${encodeURIComponent(betaBuildLocalizationId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_beta_build_localization',
    {
      title: 'Create a per-build "What to Test" localization',
      description:
        'Create a BetaBuildLocalization for ONE build + ONE locale. whatsNew is optional at create time (you can leave it blank and patch later). The (build, locale) pair must be unique — Apple rejects a duplicate. Locale is immutable post-create; to change locale, delete this resource and re-create.',
      inputSchema: z.object({
        buildId: BuildIdSchema,
        locale: LocaleSchema,
        whatsNew: WhatsNewSchema.optional().describe(
          'Per-build "What to Test" body, max 4000 characters. Optional at create — set or patch later via asc_patch_beta_build_localization.',
        ),
      }),
    },
    async (input) => {
      const body = buildBetaBuildLocalizationCreateBody({
        buildId: input.buildId,
        locale: input.locale,
        ...(input.whatsNew !== undefined ? { whatsNew: input.whatsNew } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/betaBuildLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created BetaBuildLocalization (build ${input.buildId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_beta_build_localization',
    {
      title: 'Patch a per-build "What to Test" localization',
      description:
        "Update the whatsNew body on an existing BetaBuildLocalization. Apple PATCH on this resource accepts ONLY whatsNew — locale is immutable. Pass the new copy verbatim (no diff/merge); the value replaces what's there.",
      inputSchema: z.object({
        betaBuildLocalizationId: BetaBuildLocalizationIdSchema,
        whatsNew: WhatsNewSchema,
      }),
    },
    async ({ betaBuildLocalizationId, whatsNew }) => {
      const body = buildBetaBuildLocalizationPatchBody({ betaBuildLocalizationId, whatsNew });
      try {
        const data = await client.request<unknown>(
          `/v1/betaBuildLocalizations/${encodeURIComponent(betaBuildLocalizationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched BetaBuildLocalization ${betaBuildLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_beta_build_localization',
    {
      title: 'Delete a per-build "What to Test" localization',
      description:
        "DELETE a BetaBuildLocalization. The locale is removed for this build; testers in that locale fall back to whatever default locale TestFlight chooses. Doesn't affect the build itself.",
      inputSchema: z.object({
        betaBuildLocalizationId: BetaBuildLocalizationIdSchema,
      }),
    },
    async ({ betaBuildLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/betaBuildLocalizations/${encodeURIComponent(betaBuildLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted BetaBuildLocalization ${betaBuildLocalizationId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- BetaAppLocalization (per-app standing beta description) -----

  server.registerTool(
    'asc_list_beta_app_localizations',
    {
      title: 'List per-app beta localizations',
      description:
        'List BetaAppLocalizations under an app. Each row carries description + feedbackEmail + marketingUrl + privacyPolicyUrl + tvOsPrivacyPolicy + locale. These are the standing beta-app fields shown in TestFlight above each build\'s "What to Test".',
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[betaAppLocalizations]', BETA_APP_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(
        appId,
      )}/betaAppLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBetaAppLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_beta_app_localization',
    {
      title: 'Get a per-app beta localization',
      description: 'Fetch a single BetaAppLocalization by ID.',
      inputSchema: z.object({
        betaAppLocalizationId: BetaAppLocalizationIdSchema,
      }),
    },
    async ({ betaAppLocalizationId }) => {
      const path = `/v1/betaAppLocalizations/${encodeURIComponent(betaAppLocalizationId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_beta_app_localization',
    {
      title: 'Create a per-app beta localization',
      description:
        'Create a BetaAppLocalization for ONE app + ONE locale. Required: appId + locale. Optional: description, feedbackEmail, marketingUrl (camelCase wire key — NOT marketingURL), privacyPolicyUrl, tvOsPrivacyPolicy. The (app, locale) pair must be unique — Apple rejects a duplicate. Locale is immutable post-create.',
      inputSchema: z.object({
        appId: AppIdSchema,
        locale: LocaleSchema,
        description: BetaAppDescriptionSchema.optional(),
        feedbackEmail: FeedbackEmailSchema.optional(),
        marketingUrl: MarketingUrlSchema.optional(),
        privacyPolicyUrl: PrivacyPolicyUrlSchema.optional(),
        tvOsPrivacyPolicy: z
          .string()
          .max(4000)
          .optional()
          .describe(
            'Optional tvOS-specific privacy policy text (not URL — full text body). Only meaningful for tvOS apps.',
          ),
      }),
    },
    async (input) => {
      const body = buildBetaAppLocalizationCreateBody({
        appId: input.appId,
        locale: input.locale,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.feedbackEmail !== undefined ? { feedbackEmail: input.feedbackEmail } : {}),
        ...(input.marketingUrl !== undefined ? { marketingUrl: input.marketingUrl } : {}),
        ...(input.privacyPolicyUrl !== undefined
          ? { privacyPolicyUrl: input.privacyPolicyUrl }
          : {}),
        ...(input.tvOsPrivacyPolicy !== undefined
          ? { tvOsPrivacyPolicy: input.tvOsPrivacyPolicy }
          : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/betaAppLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created BetaAppLocalization (app ${input.appId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_beta_app_localization',
    {
      title: 'Patch a per-app beta localization',
      description:
        'Update one or more attrs on an existing BetaAppLocalization. All five attrs are individually optional (encodeIfPresent — only what you pass is sent). Locale is immutable. Tool refuses an empty PATCH (no attrs passed) at the tool layer.',
      inputSchema: z.object({
        betaAppLocalizationId: BetaAppLocalizationIdSchema,
        description: BetaAppDescriptionSchema.optional(),
        feedbackEmail: FeedbackEmailSchema.optional(),
        marketingUrl: MarketingUrlSchema.optional(),
        privacyPolicyUrl: PrivacyPolicyUrlSchema.optional(),
        tvOsPrivacyPolicy: z.string().max(4000).optional(),
      }),
    },
    async (input) => {
      const anyField = [
        input.description,
        input.feedbackEmail,
        input.marketingUrl,
        input.privacyPolicyUrl,
        input.tvOsPrivacyPolicy,
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
      const body = buildBetaAppLocalizationPatchBody({
        betaAppLocalizationId: input.betaAppLocalizationId,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.feedbackEmail !== undefined ? { feedbackEmail: input.feedbackEmail } : {}),
        ...(input.marketingUrl !== undefined ? { marketingUrl: input.marketingUrl } : {}),
        ...(input.privacyPolicyUrl !== undefined
          ? { privacyPolicyUrl: input.privacyPolicyUrl }
          : {}),
        ...(input.tvOsPrivacyPolicy !== undefined
          ? { tvOsPrivacyPolicy: input.tvOsPrivacyPolicy }
          : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/betaAppLocalizations/${encodeURIComponent(input.betaAppLocalizationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched BetaAppLocalization ${input.betaAppLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_beta_app_localization',
    {
      title: 'Delete a per-app beta localization',
      description:
        'DELETE a BetaAppLocalization. The locale-specific copy is removed; testers in that locale fall back to whatever default TestFlight uses. Per-build "What to Test" localizations are NOT affected.',
      inputSchema: z.object({
        betaAppLocalizationId: BetaAppLocalizationIdSchema,
      }),
    },
    async ({ betaAppLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/betaAppLocalizations/${encodeURIComponent(betaAppLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted BetaAppLocalization ${betaAppLocalizationId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
