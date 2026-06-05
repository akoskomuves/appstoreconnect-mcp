import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestAppCustomProductPageLocalizations,
  digestAppCustomProductPages,
  digestAppCustomProductPageVersions,
} from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppCustomProductPageIdSchema,
  AppCustomProductPageLocalizationIdSchema,
  AppCustomProductPageVersionIdSchema,
  AppIdSchema,
  CustomProductPageDeepLinkSchema,
  CustomProductPageNameSchema,
  CustomProductPagePromotionalTextSchema,
  CustomProductPageVisibleSchema,
  LocaleSchema,
} from '../schemas.js';

// Custom Product Pages wire shape:
//
//   * AppCustomProductPageCreateRequest: required attrs = { name }.
//     Required relationship = app. Optional relationships =
//     appCustomProductPageVersions, appStoreVersionTemplate,
//     customProductPageTemplate. The Swift contract also defines an
//     `included[]` field for nested inline creates — DEFERRED here; CPP +
//     version + localization land via separate POSTs.
//
//   * AppCustomProductPageUpdateRequest: optional attrs = { name, isVisible }.
//     WIRE-KEY GOTCHA: Swift `isVisible` → wire `visible` (same strip as
//     AppTag.visibleInAppStore and AppScreenshot.uploaded). Tool refuses
//     empty PATCH.
//
//   * AppCustomProductPageVersionCreateRequest: attributes block is OPTIONAL
//     in the Swift contract — the only attr is the optional `deepLink`.
//     When no deepLink is provided, body builder must OMIT the entire
//     attributes key (Apple rejects bare attrs:{} on this endpoint, same
//     pattern as v0.9 AppInfo PATCH).
//
//   * AppCustomProductPageLocalizationCreateRequest: required attrs =
//     { locale }. Optional attrs = { promotionalText }.
//
//   * AppCustomProductPageLocalizationUpdateRequest: only optional attr is
//     promotionalText. Empty PATCH refused.
//
//   * AppCustomProductPageVersion carries a state machine
//     (PREPARE_FOR_SUBMISSION / READY_FOR_REVIEW / WAITING_FOR_REVIEW /
//     IN_REVIEW / ACCEPTED / APPROVED / REPLACED_WITH_NEW_VERSION / REJECTED).
//     Same lifecycle as AppInfo — Apple holds writes during review.

const CPP_FIELDS = 'name,url,visible';
const CPP_VERSION_FIELDS = 'version,state,deepLink';
const CPP_LOCALIZATION_FIELDS = 'locale,promotionalText';

const CPP_VERSION_FROZEN_STATES = new Set<string>(['WAITING_FOR_REVIEW', 'IN_REVIEW']);

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders: page -----

export interface CustomProductPageCreateInput {
  appId: string;
  name: string;
}

export function buildCustomProductPageCreateBody(input: CustomProductPageCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'appCustomProductPages',
      attributes: {
        name: input.name,
      },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export interface CustomProductPagePatchInput {
  appCustomProductPageId: string;
  name?: string | undefined;
  visible?: boolean | undefined;
}

export function buildCustomProductPagePatchBody(input: CustomProductPagePatchInput): JSONAPIBody {
  // Wire-key gotcha: Swift `isVisible` → wire `visible` on Apple's side.
  // Caller has already guarded empty input at the tool layer.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.visible !== undefined) attributes.visible = input.visible;
  return {
    data: {
      type: 'appCustomProductPages',
      id: input.appCustomProductPageId,
      attributes,
    },
  };
}

// ----- Body builders: version -----

export interface CustomProductPageVersionCreateInput {
  appCustomProductPageId: string;
  deepLink?: string | undefined;
}

export function buildCustomProductPageVersionCreateBody(
  input: CustomProductPageVersionCreateInput,
): JSONAPIBody {
  // No-attrs-block omission: the entire attributes key is OPTIONAL in the
  // Swift contract. When no deepLink is provided, OMIT the attributes key
  // entirely — Apple has rejected bare attrs:{} on similar endpoints.
  const relationships = {
    appCustomProductPage: {
      data: { type: 'appCustomProductPages', id: input.appCustomProductPageId },
    },
  };
  if (input.deepLink === undefined) {
    return {
      data: {
        type: 'appCustomProductPageVersions',
        relationships,
      },
    };
  }
  return {
    data: {
      type: 'appCustomProductPageVersions',
      attributes: { deepLink: input.deepLink },
      relationships,
    },
  };
}

// ----- Body builders: localization -----

export interface CustomProductPageLocalizationCreateInput {
  appCustomProductPageVersionId: string;
  locale: string;
  promotionalText?: string | undefined;
}

export function buildCustomProductPageLocalizationCreateBody(
  input: CustomProductPageLocalizationCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = { locale: input.locale };
  if (input.promotionalText !== undefined) {
    attributes.promotionalText = input.promotionalText;
  }
  return {
    data: {
      type: 'appCustomProductPageLocalizations',
      attributes,
      relationships: {
        appCustomProductPageVersion: {
          data: {
            type: 'appCustomProductPageVersions',
            id: input.appCustomProductPageVersionId,
          },
        },
      },
    },
  };
}

export interface CustomProductPageLocalizationPatchInput {
  appCustomProductPageLocalizationId: string;
  promotionalText: string;
}

export function buildCustomProductPageLocalizationPatchBody(
  input: CustomProductPageLocalizationPatchInput,
): JSONAPIBody {
  // Locale is immutable (lookup key); UpdateRequest excludes it.
  return {
    data: {
      type: 'appCustomProductPageLocalizations',
      id: input.appCustomProductPageLocalizationId,
      attributes: { promotionalText: input.promotionalText },
    },
  };
}

// ----- State gate for CPP versions -----

export interface CustomProductPageVersionPatchGateResult {
  allow: boolean;
  state: string | undefined;
  reason?: string;
  nextEditablePath?: string;
}

export function evaluateCustomProductPageVersionGate(
  state: string | undefined,
): CustomProductPageVersionPatchGateResult {
  if (!state) return { allow: true, state };
  if (CPP_VERSION_FROZEN_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `AppCustomProductPageVersion state is ${state} — Apple holds it during review and rejects writes to its child localizations / assets`,
      nextEditablePath:
        'Wait for review to complete; on a rejection, the state flips to REJECTED and writes resume. To cancel the in-flight review, cancel the parent ReviewSubmission via asc_patch_review_submission action: "cancel".',
    };
  }
  return { allow: true, state };
}

function formatPatchGateRefusal(g: CustomProductPageVersionPatchGateResult): string {
  return [
    `Refused: CPP write blocked by current AppCustomProductPageVersion state.`,
    ``,
    `State:  ${g.state ?? '(unknown)'}`,
    `Reason: ${g.reason ?? ''}`,
    ``,
    `Next:   ${g.nextEditablePath ?? ''}`,
  ].join('\n');
}

async function fetchCustomProductPageVersionState(
  client: ASCClient,
  versionId: string,
): Promise<string | undefined> {
  const path = `/v1/appCustomProductPageVersions/${encodeURIComponent(versionId)}?fields[appCustomProductPageVersions]=state`;
  try {
    const res = await client.request<{
      data?: { attributes?: { state?: string } };
    }>(path, { method: 'GET' });
    return res?.data?.attributes?.state;
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

export function registerCustomProductPages(server: McpServer, client: ASCClient): void {
  // ----- AppCustomProductPage -----

  server.registerTool(
    'asc_list_app_custom_product_pages',
    {
      title: 'List Custom Product Pages for an app',
      description:
        'List AppCustomProductPage records under an app. Each row carries the page name, the public URL (once a version is APPROVED), the visible flag (wire `visible`, Swift `isVisible`), and the page ID. Use to inspect which CPP variants exist before patching, adding versions, or deleting.',
      inputSchema: {
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appCustomProductPages]', CPP_FIELDS);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/appCustomProductPages?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppCustomProductPages(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_custom_product_page',
    {
      title: 'Get an AppCustomProductPage',
      description:
        'Fetch a single AppCustomProductPage with its versions expanded. Returns the page metadata + every AppCustomProductPageVersion under it (with state + deepLink). Use to navigate from a page to its current version.',
      inputSchema: {
        appCustomProductPageId: AppCustomProductPageIdSchema,
      },
    },
    async ({ appCustomProductPageId }) => {
      const path = `/v1/appCustomProductPages/${encodeURIComponent(appCustomProductPageId)}?include=appCustomProductPageVersions`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_custom_product_page',
    {
      title: 'Create an AppCustomProductPage',
      description:
        'Create an AppCustomProductPage for an app with a reference name (UI-only, not customer-facing). Required: appId + name. Apple automatically creates an initial AppCustomProductPageVersion in PREPARE_FOR_SUBMISSION — fetch it via asc_get_app_custom_product_page and attach localizations / asset sets to that version.',
      inputSchema: {
        appId: AppIdSchema,
        name: CustomProductPageNameSchema,
      },
    },
    async (input) => {
      const body = buildCustomProductPageCreateBody({ appId: input.appId, name: input.name });
      try {
        const data = await client.request<unknown>('/v1/appCustomProductPages', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppCustomProductPage "${input.name}" on app ${input.appId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_custom_product_page',
    {
      title: 'Patch an AppCustomProductPage (name / visible)',
      description:
        'Update name and/or visibility on an existing AppCustomProductPage. Wire-key gotcha: Swift `isVisible` → wire `visible` (same strip pattern as AppTag.visibleInAppStore). Toggling visible=false retracts the public URL without deleting the page. Tool refuses empty PATCH.',
      inputSchema: {
        appCustomProductPageId: AppCustomProductPageIdSchema,
        name: CustomProductPageNameSchema.optional(),
        visible: CustomProductPageVisibleSchema.optional(),
      },
    },
    async (input) => {
      if (input.name === undefined && input.visible === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of name or visible. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildCustomProductPagePatchBody({
        appCustomProductPageId: input.appCustomProductPageId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.visible !== undefined ? { visible: input.visible } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appCustomProductPages/${encodeURIComponent(input.appCustomProductPageId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppCustomProductPage ${input.appCustomProductPageId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_custom_product_page',
    {
      title: 'Delete an AppCustomProductPage',
      description:
        'DELETE an AppCustomProductPage. Removes the page + every version + every localization + every asset set under it. The public CPP URL stops resolving immediately. Apple may refuse if a version is currently IN_REVIEW.',
      inputSchema: {
        appCustomProductPageId: AppCustomProductPageIdSchema,
      },
    },
    async ({ appCustomProductPageId }) => {
      try {
        await client.request<unknown>(
          `/v1/appCustomProductPages/${encodeURIComponent(appCustomProductPageId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted AppCustomProductPage ${appCustomProductPageId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- AppCustomProductPageVersion -----

  server.registerTool(
    'asc_list_app_custom_product_page_versions',
    {
      title: 'List versions for a Custom Product Page',
      description:
        'List AppCustomProductPageVersion records under a CPP. Each row carries the version string (typically auto-generated), state (PREPARE_FOR_SUBMISSION / READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW / ACCEPTED / APPROVED / REPLACED_WITH_NEW_VERSION / REJECTED), deepLink, and version ID.',
      inputSchema: {
        appCustomProductPageId: AppCustomProductPageIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appCustomProductPageId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appCustomProductPageVersions]', CPP_VERSION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appCustomProductPages/${encodeURIComponent(appCustomProductPageId)}/appCustomProductPageVersions?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestAppCustomProductPageVersions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_custom_product_page_version',
    {
      title: 'Get an AppCustomProductPageVersion',
      description:
        'Fetch a single AppCustomProductPageVersion with its localizations expanded. Returns the version metadata (state, deepLink) + every AppCustomProductPageLocalization under it.',
      inputSchema: {
        appCustomProductPageVersionId: AppCustomProductPageVersionIdSchema,
      },
    },
    async ({ appCustomProductPageVersionId }) => {
      const path = `/v1/appCustomProductPageVersions/${encodeURIComponent(appCustomProductPageVersionId)}?include=appCustomProductPageLocalizations`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_custom_product_page_version',
    {
      title: 'Create an AppCustomProductPageVersion',
      description:
        'Create a new AppCustomProductPageVersion under a CPP. Required: appCustomProductPageId. Optional: deepLink (URL appended to the CPP click-through). No-attrs-block gotcha: when deepLink is omitted, the body sends NO attributes key at all (Apple rejects bare attrs:{} on this endpoint, same as v0.9 AppInfo PATCH). New versions land in PREPARE_FOR_SUBMISSION.',
      inputSchema: {
        appCustomProductPageId: AppCustomProductPageIdSchema,
        deepLink: CustomProductPageDeepLinkSchema.optional(),
      },
    },
    async (input) => {
      const body = buildCustomProductPageVersionCreateBody({
        appCustomProductPageId: input.appCustomProductPageId,
        ...(input.deepLink !== undefined ? { deepLink: input.deepLink } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appCustomProductPageVersions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppCustomProductPageVersion under CPP ${input.appCustomProductPageId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_custom_product_page_version',
    {
      title: 'Delete an AppCustomProductPageVersion',
      description:
        'DELETE an AppCustomProductPageVersion. Removes every localization + asset set under it. Apple gates this — versions in WAITING_FOR_REVIEW / IN_REVIEW typically cannot be deleted directly.',
      inputSchema: {
        appCustomProductPageVersionId: AppCustomProductPageVersionIdSchema,
      },
    },
    async ({ appCustomProductPageVersionId }) => {
      try {
        await client.request<unknown>(
          `/v1/appCustomProductPageVersions/${encodeURIComponent(appCustomProductPageVersionId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Deleted AppCustomProductPageVersion ${appCustomProductPageVersionId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- AppCustomProductPageLocalization -----

  server.registerTool(
    'asc_list_app_custom_product_page_localizations',
    {
      title: 'List localizations for a CPP version',
      description:
        'List AppCustomProductPageLocalization records under an AppCustomProductPageVersion. Each row carries locale + promotionalText length + a short preview + the localization ID. Per (version, locale).',
      inputSchema: {
        appCustomProductPageVersionId: AppCustomProductPageVersionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appCustomProductPageVersionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appCustomProductPageLocalizations]', CPP_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appCustomProductPageVersions/${encodeURIComponent(appCustomProductPageVersionId)}/appCustomProductPageLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestAppCustomProductPageLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_custom_product_page_localization',
    {
      title: 'Get an AppCustomProductPageLocalization',
      description:
        'Fetch a single AppCustomProductPageLocalization by ID. Returns locale + promotionalText + the relationship IDs for any attached screenshot sets, preview sets, and search keywords.',
      inputSchema: {
        appCustomProductPageLocalizationId: AppCustomProductPageLocalizationIdSchema,
      },
    },
    async ({ appCustomProductPageLocalizationId }) => {
      const path = `/v1/appCustomProductPageLocalizations/${encodeURIComponent(appCustomProductPageLocalizationId)}?include=appScreenshotSets,appPreviewSets,searchKeywords`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_custom_product_page_localization',
    {
      title: 'Create an AppCustomProductPageLocalization',
      description:
        'Create an AppCustomProductPageLocalization under a CPP version for ONE locale. Required: appCustomProductPageVersionId + locale. Optional: promotionalText (170 chars). The (version, locale) pair must be unique. Pre-check refuses for frozen states (WAITING_FOR_REVIEW, IN_REVIEW).',
      inputSchema: {
        appCustomProductPageVersionId: AppCustomProductPageVersionIdSchema,
        locale: LocaleSchema,
        promotionalText: CustomProductPagePromotionalTextSchema.optional(),
      },
    },
    async (input) => {
      const state = await fetchCustomProductPageVersionState(
        client,
        input.appCustomProductPageVersionId,
      );
      const gate = evaluateCustomProductPageVersionGate(state);
      if (!gate.allow) {
        return {
          content: [{ type: 'text', text: formatPatchGateRefusal(gate) }],
          isError: true,
        };
      }
      const body = buildCustomProductPageLocalizationCreateBody({
        appCustomProductPageVersionId: input.appCustomProductPageVersionId,
        locale: input.locale,
        ...(input.promotionalText !== undefined ? { promotionalText: input.promotionalText } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appCustomProductPageLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppCustomProductPageLocalization (version ${input.appCustomProductPageVersionId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_custom_product_page_localization',
    {
      title: 'Patch an AppCustomProductPageLocalization',
      description:
        'Update promotionalText on an existing CPP localization. promotionalText is the ONLY mutable field (locale is immutable). Tool refuses empty PATCH; pass an empty string to clear if Apple allows it.',
      inputSchema: {
        appCustomProductPageLocalizationId: AppCustomProductPageLocalizationIdSchema,
        promotionalText: CustomProductPagePromotionalTextSchema,
      },
    },
    async (input) => {
      const body = buildCustomProductPageLocalizationPatchBody({
        appCustomProductPageLocalizationId: input.appCustomProductPageLocalizationId,
        promotionalText: input.promotionalText,
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appCustomProductPageLocalizations/${encodeURIComponent(input.appCustomProductPageLocalizationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppCustomProductPageLocalization ${input.appCustomProductPageLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_custom_product_page_localization',
    {
      title: 'Delete an AppCustomProductPageLocalization',
      description:
        'DELETE an AppCustomProductPageLocalization. Customers in this locale fall back to the parent AppStoreVersionLocalization. Apple may refuse if the parent version is in a frozen state.',
      inputSchema: {
        appCustomProductPageLocalizationId: AppCustomProductPageLocalizationIdSchema,
      },
    },
    async ({ appCustomProductPageLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/appCustomProductPageLocalizations/${encodeURIComponent(appCustomProductPageLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Deleted AppCustomProductPageLocalization ${appCustomProductPageLocalizationId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
