import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppEventLocalizations, digestAppEvents } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppEventBadgeSchema,
  AppEventDeepLinkSchema,
  AppEventIdSchema,
  AppEventLocalizationIdSchema,
  AppEventLongDescriptionSchema,
  AppEventNameSchema,
  AppEventPrimaryLocaleSchema,
  AppEventPrioritySchema,
  AppEventPurchaseRequirementSchema,
  AppEventPurposeSchema,
  AppEventReferenceNameSchema,
  AppEventShortDescriptionSchema,
  AppEventTerritorySchedulesSchema,
  AppIdSchema,
  LocaleSchema,
} from '../schemas.js';

// AppEvent / AppEventLocalization wire shape:
//
//   * AppEventCreateRequest: required attrs = { referenceName }. Required
//     relationship = app. Optional attrs = { badge, deepLink,
//     purchaseRequirement, primaryLocale, priority, purpose,
//     territorySchedules }. archivedTerritorySchedules is read-only and
//     not on the create / update body shape.
//
//   * AppEventUpdateRequest: all attrs optional. Refuse empty PATCH.
//
//   * AppEventLocalizationCreateRequest: required attrs = { locale }.
//     Required relationship = appEvent. Optional attrs = { name (30),
//     shortDescription (50), longDescription (120) }.
//
//   * AppEventLocalizationUpdateRequest: optional attrs = { name,
//     shortDescription, longDescription }. Locale immutable. Refuse empty.
//
//   * AppEvent state machine (eventState attr, 10 values): DRAFT /
//     READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW / REJECTED /
//     ACCEPTED / APPROVED / PUBLISHED / PAST / ARCHIVED. Mirror v0.12 /
//     v0.13 conservatism: refuse only WAITING_FOR_REVIEW / IN_REVIEW
//     client-side (Apple holds writes during review); pass everything else
//     through to Apple.

const APP_EVENT_FIELDS =
  'referenceName,badge,eventState,deepLink,purchaseRequirement,primaryLocale,priority,purpose,territorySchedules,archivedTerritorySchedules';
const APP_EVENT_LOCALIZATION_FIELDS = 'locale,name,shortDescription,longDescription';

const APP_EVENT_FROZEN_STATES = new Set<string>(['WAITING_FOR_REVIEW', 'IN_REVIEW']);

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders: event -----

export interface AppEventCreateInput {
  appId: string;
  referenceName: string;
  badge?: string | undefined;
  deepLink?: string | undefined;
  purchaseRequirement?: string | undefined;
  primaryLocale?: string | undefined;
  priority?: string | undefined;
  purpose?: string | undefined;
  territorySchedules?: TerritoryScheduleInput[] | undefined;
}

export interface TerritoryScheduleInput {
  territories: string[];
  publishStart: string;
  eventStart: string;
  eventEnd: string;
}

export function buildAppEventCreateBody(input: AppEventCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = { referenceName: input.referenceName };
  if (input.badge !== undefined) attributes.badge = input.badge;
  if (input.deepLink !== undefined) attributes.deepLink = input.deepLink;
  if (input.purchaseRequirement !== undefined) {
    attributes.purchaseRequirement = input.purchaseRequirement;
  }
  if (input.primaryLocale !== undefined) attributes.primaryLocale = input.primaryLocale;
  if (input.priority !== undefined) attributes.priority = input.priority;
  if (input.purpose !== undefined) attributes.purpose = input.purpose;
  if (input.territorySchedules !== undefined) {
    attributes.territorySchedules = input.territorySchedules;
  }
  return {
    data: {
      type: 'appEvents',
      attributes,
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export interface AppEventPatchInput {
  appEventId: string;
  referenceName?: string | undefined;
  badge?: string | undefined;
  deepLink?: string | undefined;
  purchaseRequirement?: string | undefined;
  primaryLocale?: string | undefined;
  priority?: string | undefined;
  purpose?: string | undefined;
  territorySchedules?: TerritoryScheduleInput[] | undefined;
}

export function buildAppEventPatchBody(input: AppEventPatchInput): JSONAPIBody {
  // Caller has already guarded empty input at the tool layer.
  const attributes: Record<string, unknown> = {};
  if (input.referenceName !== undefined) attributes.referenceName = input.referenceName;
  if (input.badge !== undefined) attributes.badge = input.badge;
  if (input.deepLink !== undefined) attributes.deepLink = input.deepLink;
  if (input.purchaseRequirement !== undefined) {
    attributes.purchaseRequirement = input.purchaseRequirement;
  }
  if (input.primaryLocale !== undefined) attributes.primaryLocale = input.primaryLocale;
  if (input.priority !== undefined) attributes.priority = input.priority;
  if (input.purpose !== undefined) attributes.purpose = input.purpose;
  if (input.territorySchedules !== undefined) {
    attributes.territorySchedules = input.territorySchedules;
  }
  return {
    data: {
      type: 'appEvents',
      id: input.appEventId,
      attributes,
    },
  };
}

// ----- Body builders: localization -----

export interface AppEventLocalizationCreateInput {
  appEventId: string;
  locale: string;
  name?: string | undefined;
  shortDescription?: string | undefined;
  longDescription?: string | undefined;
}

export function buildAppEventLocalizationCreateBody(
  input: AppEventLocalizationCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = { locale: input.locale };
  if (input.name !== undefined) attributes.name = input.name;
  if (input.shortDescription !== undefined) attributes.shortDescription = input.shortDescription;
  if (input.longDescription !== undefined) attributes.longDescription = input.longDescription;
  return {
    data: {
      type: 'appEventLocalizations',
      attributes,
      relationships: {
        appEvent: { data: { type: 'appEvents', id: input.appEventId } },
      },
    },
  };
}

export interface AppEventLocalizationPatchInput {
  appEventLocalizationId: string;
  name?: string | undefined;
  shortDescription?: string | undefined;
  longDescription?: string | undefined;
}

export function buildAppEventLocalizationPatchBody(
  input: AppEventLocalizationPatchInput,
): JSONAPIBody {
  // Locale is immutable (lookup key); UpdateRequest excludes it.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.shortDescription !== undefined) attributes.shortDescription = input.shortDescription;
  if (input.longDescription !== undefined) attributes.longDescription = input.longDescription;
  return {
    data: {
      type: 'appEventLocalizations',
      id: input.appEventLocalizationId,
      attributes,
    },
  };
}

// ----- State gate -----

export interface AppEventStateGateResult {
  allow: boolean;
  state: string | undefined;
  reason?: string;
  nextEditablePath?: string;
}

export function evaluateAppEventStateGate(state: string | undefined): AppEventStateGateResult {
  if (!state) return { allow: true, state };
  if (APP_EVENT_FROZEN_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `AppEvent eventState is ${state} — Apple holds the event during review and rejects writes to its attributes / localizations`,
      nextEditablePath:
        'Wait for review to complete; on a rejection, the state flips to REJECTED and writes resume. To cancel the in-flight review, withdraw the parent ReviewSubmission via asc_patch_review_submission action: "cancel" (only works while the submission is WAITING_FOR_REVIEW / IN_REVIEW).',
    };
  }
  return { allow: true, state };
}

function formatStateGateRefusal(g: AppEventStateGateResult): string {
  return [
    `Refused: AppEvent write blocked by current eventState.`,
    ``,
    `State:  ${g.state ?? '(unknown)'}`,
    `Reason: ${g.reason ?? ''}`,
    ``,
    `Next:   ${g.nextEditablePath ?? ''}`,
  ].join('\n');
}

async function fetchAppEventState(
  client: ASCClient,
  appEventId: string,
): Promise<string | undefined> {
  const path = `/v1/appEvents/${encodeURIComponent(appEventId)}?fields[appEvents]=eventState`;
  try {
    const res = await client.request<{ data?: { attributes?: { eventState?: string } } }>(path, {
      method: 'GET',
    });
    return res?.data?.attributes?.eventState;
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

export function registerAppEvents(server: McpServer, client: ASCClient): void {
  // ----- AppEvent -----

  server.registerTool(
    'asc_list_app_events',
    {
      title: 'List App Events for an app',
      description:
        'List AppEvent records for an app. Each row carries the referenceName, current eventState (DRAFT / READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW / REJECTED / ACCEPTED / APPROVED / PUBLISHED / PAST / ARCHIVED), badge, purpose, priority, primaryLocale, and the count of territory schedules. Use to find the event ID before fetching its localizations or assets.',
      inputSchema: {
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appEvents]', APP_EVENT_FIELDS);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/appEvents?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppEvents(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_event',
    {
      title: 'Get an AppEvent',
      description:
        'Fetch a single AppEvent by ID with its localizations expanded. Returns the full attribute surface including territorySchedules (writable per-territory schedule entries) and archivedTerritorySchedules (read-only history).',
      inputSchema: {
        appEventId: AppEventIdSchema,
      },
    },
    async ({ appEventId }) => {
      const path = `/v1/appEvents/${encodeURIComponent(appEventId)}?include=localizations`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_event',
    {
      title: 'Create an AppEvent',
      description:
        'Create an AppEvent on an app. Required: appId + referenceName (internal-only, NOT customer-facing — set per-locale name via asc_post_app_event_localization). Optional: badge, deepLink, purchaseRequirement, primaryLocale, priority, purpose, territorySchedules. New events land in DRAFT. Add localizations + screenshots + video clips before submitting for review.',
      inputSchema: {
        appId: AppIdSchema,
        referenceName: AppEventReferenceNameSchema,
        badge: AppEventBadgeSchema.optional(),
        deepLink: AppEventDeepLinkSchema.optional(),
        purchaseRequirement: AppEventPurchaseRequirementSchema.optional(),
        primaryLocale: AppEventPrimaryLocaleSchema.optional(),
        priority: AppEventPrioritySchema.optional(),
        purpose: AppEventPurposeSchema.optional(),
        territorySchedules: AppEventTerritorySchedulesSchema.optional(),
      },
    },
    async (input) => {
      const body = buildAppEventCreateBody({
        appId: input.appId,
        referenceName: input.referenceName,
        ...(input.badge !== undefined ? { badge: input.badge } : {}),
        ...(input.deepLink !== undefined ? { deepLink: input.deepLink } : {}),
        ...(input.purchaseRequirement !== undefined
          ? { purchaseRequirement: input.purchaseRequirement }
          : {}),
        ...(input.primaryLocale !== undefined ? { primaryLocale: input.primaryLocale } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.territorySchedules !== undefined
          ? { territorySchedules: input.territorySchedules }
          : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appEvents', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppEvent "${input.referenceName}" on app ${input.appId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_event',
    {
      title: 'Patch an AppEvent',
      description:
        "Update an AppEvent's attributes. Pre-check refuses for clearly frozen states (WAITING_FOR_REVIEW, IN_REVIEW). All attrs encodeIfPresent — only what you pass is sent. Tool refuses empty PATCH.",
      inputSchema: {
        appEventId: AppEventIdSchema,
        referenceName: AppEventReferenceNameSchema.optional(),
        badge: AppEventBadgeSchema.optional(),
        deepLink: AppEventDeepLinkSchema.optional(),
        purchaseRequirement: AppEventPurchaseRequirementSchema.optional(),
        primaryLocale: AppEventPrimaryLocaleSchema.optional(),
        priority: AppEventPrioritySchema.optional(),
        purpose: AppEventPurposeSchema.optional(),
        territorySchedules: AppEventTerritorySchedulesSchema.optional(),
      },
    },
    async (input) => {
      const anyAttr =
        input.referenceName !== undefined ||
        input.badge !== undefined ||
        input.deepLink !== undefined ||
        input.purchaseRequirement !== undefined ||
        input.primaryLocale !== undefined ||
        input.priority !== undefined ||
        input.purpose !== undefined ||
        input.territorySchedules !== undefined;
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
      const state = await fetchAppEventState(client, input.appEventId);
      const gate = evaluateAppEventStateGate(state);
      if (!gate.allow) {
        return {
          content: [{ type: 'text', text: formatStateGateRefusal(gate) }],
          isError: true,
        };
      }
      const body = buildAppEventPatchBody({
        appEventId: input.appEventId,
        ...(input.referenceName !== undefined ? { referenceName: input.referenceName } : {}),
        ...(input.badge !== undefined ? { badge: input.badge } : {}),
        ...(input.deepLink !== undefined ? { deepLink: input.deepLink } : {}),
        ...(input.purchaseRequirement !== undefined
          ? { purchaseRequirement: input.purchaseRequirement }
          : {}),
        ...(input.primaryLocale !== undefined ? { primaryLocale: input.primaryLocale } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.territorySchedules !== undefined
          ? { territorySchedules: input.territorySchedules }
          : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appEvents/${encodeURIComponent(input.appEventId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppEvent ${input.appEventId} (state: ${gate.state ?? 'unknown'}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_event',
    {
      title: 'Delete an AppEvent',
      description:
        'DELETE an AppEvent. Removes the event + every localization + every asset. Apple may refuse if the event is PUBLISHED or IN_REVIEW.',
      inputSchema: {
        appEventId: AppEventIdSchema,
      },
    },
    async ({ appEventId }) => {
      try {
        await client.request<unknown>(`/v1/appEvents/${encodeURIComponent(appEventId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Deleted AppEvent ${appEventId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- AppEventLocalization -----

  server.registerTool(
    'asc_list_app_event_localizations',
    {
      title: 'List AppEvent localizations',
      description:
        'List AppEventLocalization records under an AppEvent. Each row carries locale + name + shortDescription length + longDescription length + the localization ID. Per (event, locale). Use to inspect existing per-locale copy before adding new locales or patching existing ones.',
      inputSchema: {
        appEventId: AppEventIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appEventId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appEventLocalizations]', APP_EVENT_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appEvents/${encodeURIComponent(appEventId)}/localizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppEventLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_event_localization',
    {
      title: 'Get an AppEventLocalization',
      description:
        'Fetch a single AppEventLocalization by ID. Returns the locale + name + shortDescription + longDescription + the relationship IDs for any attached event screenshots and video clips.',
      inputSchema: {
        appEventLocalizationId: AppEventLocalizationIdSchema,
      },
    },
    async ({ appEventLocalizationId }) => {
      const path = `/v1/appEventLocalizations/${encodeURIComponent(appEventLocalizationId)}?include=appEventScreenshots,appEventVideoClips`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_event_localization',
    {
      title: 'Create an AppEventLocalization',
      description:
        'Create an AppEventLocalization for ONE (event, locale) pair. Required: appEventId + locale. Optional copy attrs: name (30 chars), shortDescription (50 chars), longDescription (120 chars). The (event, locale) pair must be unique — Apple rejects duplicates. Pre-check refuses for frozen parent-event states (WAITING_FOR_REVIEW, IN_REVIEW).',
      inputSchema: {
        appEventId: AppEventIdSchema,
        locale: LocaleSchema,
        name: AppEventNameSchema.optional(),
        shortDescription: AppEventShortDescriptionSchema.optional(),
        longDescription: AppEventLongDescriptionSchema.optional(),
      },
    },
    async (input) => {
      const state = await fetchAppEventState(client, input.appEventId);
      const gate = evaluateAppEventStateGate(state);
      if (!gate.allow) {
        return {
          content: [{ type: 'text', text: formatStateGateRefusal(gate) }],
          isError: true,
        };
      }
      const body = buildAppEventLocalizationCreateBody({
        appEventId: input.appEventId,
        locale: input.locale,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.shortDescription !== undefined
          ? { shortDescription: input.shortDescription }
          : {}),
        ...(input.longDescription !== undefined ? { longDescription: input.longDescription } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appEventLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppEventLocalization (event ${input.appEventId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_event_localization',
    {
      title: 'Patch an AppEventLocalization',
      description:
        'Update name / shortDescription / longDescription on an existing AppEventLocalization. Locale is immutable (excluded from UpdateRequest). All three attrs are encodeIfPresent. Tool refuses empty PATCH.',
      inputSchema: {
        appEventLocalizationId: AppEventLocalizationIdSchema,
        name: AppEventNameSchema.optional(),
        shortDescription: AppEventShortDescriptionSchema.optional(),
        longDescription: AppEventLongDescriptionSchema.optional(),
      },
    },
    async (input) => {
      if (
        input.name === undefined &&
        input.shortDescription === undefined &&
        input.longDescription === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of name, shortDescription, or longDescription. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildAppEventLocalizationPatchBody({
        appEventLocalizationId: input.appEventLocalizationId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.shortDescription !== undefined
          ? { shortDescription: input.shortDescription }
          : {}),
        ...(input.longDescription !== undefined ? { longDescription: input.longDescription } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appEventLocalizations/${encodeURIComponent(input.appEventLocalizationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppEventLocalization ${input.appEventLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_event_localization',
    {
      title: 'Delete an AppEventLocalization',
      description:
        "DELETE an AppEventLocalization. Removes the per-locale copy + every event screenshot + video clip under it. Customers in this locale fall back to the event's primaryLocale.",
      inputSchema: {
        appEventLocalizationId: AppEventLocalizationIdSchema,
      },
    },
    async ({ appEventLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/appEventLocalizations/${encodeURIComponent(appEventLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted AppEventLocalization ${appEventLocalizationId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
