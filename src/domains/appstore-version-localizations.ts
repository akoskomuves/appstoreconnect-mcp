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

// State-aware pre-check for asc_patch_app_store_version_localization.
//
// Apple's AppStoreVersion lives in a state machine that gates which
// localization attributes are mutable:
//
//   PREPARE_FOR_SUBMISSION / DEVELOPER_REJECTED / METADATA_REJECTED /
//   REJECTED / DEVELOPER_REMOVED_FROM_SALE / INVALID_BINARY
//     -> all six fields mutable (the editable set)
//
//   WAITING_FOR_REVIEW / IN_REVIEW / PROCESSING_FOR_APP_STORE
//     -> NOTHING mutable (Apple holds the resource for review/processing)
//
//   READY_FOR_SALE / PENDING_DEVELOPER_RELEASE / REPLACED_WITH_NEW_VERSION /
//   REMOVED_FROM_SALE
//     -> only `promotionalText` mutable. This is Apple's documented escape
//        hatch — promotionalText edits don't require a new review cycle.
//
// Apple enforces this server-side via 409 STATE_ERROR with detail like
// "Attribute 'marketingUrl' cannot be edited at this time", which doesn't
// say WHY or WHAT TO DO. The pre-check fetches the parent version's state
// in one round-trip and refuses client-side with a structured message
// when the input combination is incompatible.

// Apple's `AppStoreVersionState` enum buckets. Defensively-empty sets so
// new states Apple adds get the "pass-through" treatment by default.
const PROMO_ONLY_STATES = new Set<string>([
  'READY_FOR_SALE',
  'PENDING_DEVELOPER_RELEASE',
  'REPLACED_WITH_NEW_VERSION',
  'REMOVED_FROM_SALE',
]);

const FROZEN_STATES = new Set<string>([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PROCESSING_FOR_APP_STORE',
]);

interface AVLPatchInput {
  whatsNew?: string | undefined;
  description?: string | undefined;
  keywords?: string | undefined;
  promotionalText?: string | undefined;
  marketingUrl?: string | undefined;
  supportUrl?: string | undefined;
}

export interface StateGateResult {
  allow: boolean;
  state: string | undefined;
  allowed: string[];
  blocked: string[];
  reason?: string;
  nextEditablePath?: string;
}

export function evaluateStateGate(
  state: string | undefined,
  input: AVLPatchInput,
): StateGateResult {
  const requestedFields = Object.entries({
    whatsNew: input.whatsNew,
    description: input.description,
    keywords: input.keywords,
    promotionalText: input.promotionalText,
    marketingUrl: input.marketingUrl,
    supportUrl: input.supportUrl,
  })
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);

  // Unknown state -> pass through. Apple's API stays the authoritative gate.
  if (!state) return { allow: true, state, allowed: requestedFields, blocked: [] };

  if (FROZEN_STATES.has(state)) {
    return {
      allow: false,
      state,
      allowed: [],
      blocked: requestedFields,
      reason: `parent version is in ${state} — Apple holds all localization attributes during review/processing`,
      nextEditablePath:
        'Wait for review to complete (Apple typically takes 24-72h). If the version is rejected, the state flips to DEVELOPER_REJECTED / METADATA_REJECTED and all fields become editable again.',
    };
  }

  if (PROMO_ONLY_STATES.has(state)) {
    const blocked = requestedFields.filter((f) => f !== 'promotionalText');
    if (blocked.length === 0) {
      return { allow: true, state, allowed: ['promotionalText'], blocked: [] };
    }
    return {
      allow: false,
      state,
      allowed: ['promotionalText'],
      blocked,
      reason: `parent version is in ${state} — Apple only permits promotionalText edits without a new app-review cycle in this state`,
      nextEditablePath:
        'To edit other fields, create a new App Store version (asc_post_app_store_version — coming in v0.10.x) and patch its localizations. To keep your current promo edit, retry this call with promotionalText alone.',
    };
  }

  // Editable state (PREPARE_FOR_SUBMISSION, *_REJECTED, etc.) — pass through.
  return { allow: true, state, allowed: requestedFields, blocked: [] };
}

function formatStateGateRefusal(g: StateGateResult): string {
  return [
    `Refused: AppStoreVersionLocalization PATCH blocked by parent App Store Version state.`,
    ``,
    `State:    ${g.state ?? '(unknown)'}`,
    `Allowed:  ${g.allowed.length > 0 ? g.allowed.join(', ') : '(none — version is frozen)'}`,
    `Blocked:  ${g.blocked.join(', ')}`,
    `Reason:   ${g.reason ?? ''}`,
    ``,
    `Next:     ${g.nextEditablePath ?? ''}`,
  ].join('\n');
}

interface AVLWithVersionResponse {
  data?: { type?: string; id?: string };
  included?: Array<{
    type?: string;
    id?: string;
    attributes?: { appStoreState?: string; appVersionState?: string };
  }>;
}

async function fetchParentVersionState(
  client: ASCClient,
  appStoreVersionLocalizationId: string,
): Promise<string | undefined> {
  // One round-trip with sparse fieldset: returns the localization +
  // the parent version's state in `included[]`. Cheaper than two GETs.
  const path =
    `/v1/appStoreVersionLocalizations/${encodeURIComponent(appStoreVersionLocalizationId)}` +
    `?include=appStoreVersion` +
    `&fields[appStoreVersions]=appStoreState,appVersionState` +
    `&fields[appStoreVersionLocalizations]=locale`;
  try {
    const res = await client.request<AVLWithVersionResponse>(path, { method: 'GET' });
    const version = (res?.included ?? []).find((r) => r.type === 'appStoreVersions');
    // Prefer appStoreState (the long-established field). Fall back to
    // appVersionState (Apple's newer attribute that may eventually
    // replace appStoreState).
    return version?.attributes?.appStoreState ?? version?.attributes?.appVersionState;
  } catch {
    // Pre-check failure should NOT block the PATCH. Apple's server-side
    // error is informative enough for the rare case where this read fails.
    return undefined;
  }
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
        'Update attrs on an existing AppStoreVersionLocalization. ' +
        '** PARENT VERSION STATE GATES WHICH FIELDS ARE MUTABLE: ** ' +
        '(a) In PREPARE_FOR_SUBMISSION / *_REJECTED / DEVELOPER_REMOVED_FROM_SALE — all six fields editable. ' +
        '(b) In READY_FOR_SALE / PENDING_DEVELOPER_RELEASE / REPLACED_WITH_NEW_VERSION / REMOVED_FROM_SALE — ONLY promotionalText is editable. To change anything else, create a new App Store version (asc_post_app_store_version — coming in v0.10.x). ' +
        '(c) In WAITING_FOR_REVIEW / IN_REVIEW / PROCESSING_FOR_APP_STORE — NOTHING is editable until Apple finishes the cycle. ' +
        'The tool pre-checks the parent version state with one GET (one round-trip) and refuses incompatible PATCHes client-side with a structured {state, allowed, blocked, reason, nextEditablePath} message — rather than letting Apple return a bare "Attribute X cannot be edited at this time" error and rejecting the whole batch atomically. ' +
        'All attrs are encodeIfPresent (only what you pass is sent). Locale is immutable.',
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
      // State-aware pre-check: fetch the parent version state in one
      // round-trip and refuse incompatible batches client-side. See
      // evaluateStateGate's comment block for the state machine spec.
      const parentState = await fetchParentVersionState(
        client,
        input.appStoreVersionLocalizationId,
      );
      const gate = evaluateStateGate(parentState, input);
      if (!gate.allow) {
        return {
          content: [{ type: 'text', text: formatStateGateRefusal(gate) }],
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
              text: `Patched AppStoreVersionLocalization ${input.appStoreVersionLocalizationId} (parent version state: ${gate.state ?? 'unknown'}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        // Fallback enrichment when the pre-check passed but Apple still
        // returned a state-machine error. Covers the race window between
        // pre-check fetch and PATCH (rare — a version transitioned mid-call).
        const msg = err instanceof ASCError ? `${err.message}` : '';
        if (msg.includes('cannot be edited at this time') || msg.includes('STATE_ERROR')) {
          return {
            content: [
              {
                type: 'text',
                text: `Apple rejected the PATCH with a state-machine error. The parent version state may have transitioned between the pre-check (${gate.state ?? 'unknown'}) and the PATCH call. Retry asc_get_app_store_version on the parent to see the current state.\n\n${formatASCError(err)}`,
              },
            ],
            isError: true,
          };
        }
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
