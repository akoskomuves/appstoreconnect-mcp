import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestNominations } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  NominationDeviceFamilySchema,
  NominationIdSchema,
  NominationTypeSchema,
  TerritoryIdSchema,
} from '../schemas.js';

// Featuring nominations — pitching a release to Apple's editorial team for
// App Store featuring (Today tab, curated collections). WWDC24 surface.
//
//   * Lifecycle: DRAFT → SUBMITTED → (Apple decides; no state feedback here)
//     with ARCHIVED as the shelf. `submitted` is an ATTRIBUTE flip, not a
//     separate endpoint: create with submitted:false to draft, review, then
//     PATCH submitted:true to send. There is no un-submit.
//   * The create REQUIRES submitted — this server defaults it to false so a
//     nomination is always reviewable before anything reaches Apple.
//   * relatedApps is the required relationship (one nomination can span
//     several apps); inAppEvents + supportedTerritories are optional.
//   * Wire key gotcha: `launchInSelectMarketsFirst` — "Markets", not
//     "Storefronts" (easy to mistype from the ASC UI wording).
//   * publishStartDate/publishEndDate are the window the release is
//     relevant for featuring; supplementalMaterialsUris carry press-kit /
//     TestFlight links for the editors.

const NOMINATION_FIELDS =
  'name,type,description,createdDate,lastModifiedDate,submittedDate,state,publishStartDate,publishEndDate,deviceFamilies,locales,hasInAppEvents,launchInSelectMarketsFirst,notes,preOrderEnabled';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface NominationOptionalAttributes {
  publishEndDate?: string | undefined;
  deviceFamilies?: string[] | undefined;
  locales?: string[] | undefined;
  supplementalMaterialsUris?: string[] | undefined;
  hasInAppEvents?: boolean | undefined;
  launchInSelectMarketsFirst?: boolean | undefined;
  notes?: string | undefined;
  preOrderEnabled?: boolean | undefined;
}

export interface NominationAttributesInput extends NominationOptionalAttributes {
  name?: string | undefined;
  type?: string | undefined;
  description?: string | undefined;
  submitted?: boolean | undefined;
  archived?: boolean | undefined;
  publishStartDate?: string | undefined;
}

export interface NominationCreateInput extends NominationOptionalAttributes {
  // Required by Apple's create schema — the type system enforces presence so
  // the builder can emit them unconditionally.
  name: string;
  type: string;
  description: string;
  submitted: boolean;
  publishStartDate: string;
  appIds: string[];
}

export interface NominationRelationshipsInput {
  appIds?: string[] | undefined;
  inAppEventIds?: string[] | undefined;
  territoryIds?: string[] | undefined;
}

function nominationAttributes(input: NominationAttributesInput): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) attributes[k] = v;
  }
  return attributes;
}

function nominationRelationships(input: NominationRelationshipsInput): Record<string, unknown> {
  const relationships: Record<string, unknown> = {};
  if (input.appIds !== undefined) {
    relationships.relatedApps = { data: input.appIds.map((id) => ({ type: 'apps', id })) };
  }
  if (input.inAppEventIds !== undefined) {
    relationships.inAppEvents = {
      data: input.inAppEventIds.map((id) => ({ type: 'appEvents', id })),
    };
  }
  if (input.territoryIds !== undefined) {
    relationships.supportedTerritories = {
      data: input.territoryIds.map((id) => ({ type: 'territories', id })),
    };
  }
  return relationships;
}

export function buildNominationCreateBody(
  attrs: NominationCreateInput,
  rels: Omit<NominationRelationshipsInput, 'appIds'>,
): JSONAPIBody {
  return {
    data: {
      type: 'nominations',
      attributes: {
        // The five attributes Apple's create schema marks required, emitted
        // unconditionally...
        name: attrs.name,
        type: attrs.type,
        description: attrs.description,
        submitted: attrs.submitted,
        publishStartDate: attrs.publishStartDate,
        // ...plus whatever optional attributes the caller supplied.
        ...nominationAttributes({
          publishEndDate: attrs.publishEndDate,
          deviceFamilies: attrs.deviceFamilies,
          locales: attrs.locales,
          supplementalMaterialsUris: attrs.supplementalMaterialsUris,
          hasInAppEvents: attrs.hasInAppEvents,
          launchInSelectMarketsFirst: attrs.launchInSelectMarketsFirst,
          notes: attrs.notes,
          preOrderEnabled: attrs.preOrderEnabled,
        }),
      },
      relationships: {
        // relatedApps is Apple's required relationship — always emitted.
        relatedApps: { data: attrs.appIds.map((id) => ({ type: 'apps', id })) },
        ...nominationRelationships(rels),
      },
    },
  };
}

export function buildNominationPatchBody(
  nominationId: string,
  attrs: NominationAttributesInput,
  rels: NominationRelationshipsInput,
): JSONAPIBody {
  const data: JSONAPIBody['data'] = {
    type: 'nominations',
    // Apple requires the id in the body as well as the URL (409 otherwise).
    id: nominationId,
    attributes: nominationAttributes(attrs),
  };
  const relationships = nominationRelationships(rels);
  if (Object.keys(relationships).length > 0) data.relationships = relationships;
  return { data };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// Shared optional-attribute schemas so create + patch can't drift.
const OPTIONAL_ATTR_SCHEMAS = {
  publishEndDate: z
    .string()
    .optional()
    .describe(
      'End of the relevance window — full ISO 8601 date-TIME (bare dates are rejected). Omit for open-ended.',
    ),
  deviceFamilies: z.array(NominationDeviceFamilySchema).optional(),
  locales: z
    .array(z.string())
    .optional()
    .describe('Locales the nominated experience is localized in (BCP-47, e.g. en-US).'),
  supplementalMaterialsUris: z
    .array(z.string())
    .optional()
    .describe('Links for the editors: press kit, demo video, TestFlight invite.'),
  hasInAppEvents: z.boolean().optional(),
  launchInSelectMarketsFirst: z
    .boolean()
    .optional()
    .describe('Wire key is launchInSelectMarketsFirst — "Markets", not "Storefronts".'),
  notes: z.string().optional().describe('Anything else the editorial team should know.'),
  preOrderEnabled: z.boolean().optional(),
  inAppEventIds: z
    .array(z.string())
    .optional()
    .describe('In-app event ids to attach (asc_list_app_events).'),
  territoryIds: z
    .array(TerritoryIdSchema)
    .optional()
    .describe('Territories the nomination applies to. Omit for all.'),
};

export function registerNominations(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_nominations',
    {
      title: 'List featuring nominations',
      description:
        "List the team's App Store featuring nominations, filterable by app, state (DRAFT / SUBMITTED / ARCHIVED) and type. Newest-modified first.",
      inputSchema: z.object({
        appId: AppIdSchema.optional().describe('Only nominations related to this app.'),
        state: z.enum(['DRAFT', 'SUBMITTED', 'ARCHIVED']).optional(),
        nominationType: NominationTypeSchema.optional(),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, state, nominationType, maxItems, raw }) => {
      // Two live-caught quirks (2026-08-13) shape this handler:
      //   1. Apple REQUIRES filter[state] (400 PARAMETER_ERROR.REQUIRED
      //      without it) even though the spec marks it optional.
      //   2. It accepts exactly ONE value — "Expect one of DRAFT,SUBMITTED,
      //      ARCHIVED" on a comma-joined list.
      // So "all states" fans out to one request per state and merges.
      const states = state ? [state] : (['DRAFT', 'SUBMITTED', 'ARCHIVED'] as const);
      try {
        const merged: Awaited<ReturnType<typeof paginate>> = {
          data: [],
          included: [],
          pagesFetched: 0,
          truncated: false,
        };
        for (const st of states) {
          const params = new URLSearchParams();
          params.set('fields[nominations]', NOMINATION_FIELDS);
          params.set('sort', '-lastModifiedDate');
          params.set('limit', '200');
          params.set('filter[state]', st);
          if (appId) params.set('filter[relatedApps]', appId);
          if (nominationType) params.set('filter[type]', nominationType);
          const pages = await paginate(client, `/v1/nominations?${params.toString()}`, maxItems);
          merged.data.push(...pages.data);
          merged.pagesFetched += pages.pagesFetched;
          if (pages.truncated) merged.truncated = true;
        }
        merged.data.sort((a, b) =>
          String(b.attributes?.lastModifiedDate ?? '').localeCompare(
            String(a.attributes?.lastModifiedDate ?? ''),
          ),
        );
        const text = raw ? JSON.stringify(merged, null, 2) : digestNominations(merged);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_nomination',
    {
      title: 'Get a featuring nomination',
      description:
        'Fetch one nomination with its full description, notes, publish window, device families, locales, supplemental links, and related apps/events/territories.',
      inputSchema: z.object({
        nominationId: NominationIdSchema,
      }),
    },
    async ({ nominationId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/nominations/${encodeURIComponent(nominationId)}?include=relatedApps,inAppEvents,supportedTerritories`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_nomination',
    {
      title: 'Create a featuring nomination (as a draft by default)',
      description:
        "Create a featuring nomination pitching a release to Apple's editorial team. Defaults to a DRAFT (submitted:false) so it can be reviewed with asc_get_nomination before anything reaches Apple — flip it live later with asc_patch_nomination submitted:true, or pass submitted:true here to send immediately. ⚠️ Submission is one-way: there is no un-submit, only archive. publishStartDate is the start of the release's relevance window (e.g. the launch date).",
      inputSchema: z.object({
        name: z.string().min(1).describe('Internal name for the nomination.'),
        nominationType: NominationTypeSchema,
        description: z
          .string()
          .min(1)
          .describe('The pitch: what the release is and why it deserves featuring.'),
        publishStartDate: z
          .string()
          .min(4)
          .describe(
            'Start of the relevance window. Apple requires a FULL ISO 8601 date-TIME (e.g. 2026-09-14T00:00:00Z) — a bare date 409s with ENTITY_ERROR.ATTRIBUTE.TYPE.',
          ),
        appIds: z
          .array(AppIdSchema)
          .min(1)
          .describe('App(s) the nomination is for (relatedApps relationship).'),
        submitted: z
          .boolean()
          .default(false)
          .describe('false (default) = create as reviewable DRAFT. true = send to Apple NOW.'),
        ...OPTIONAL_ATTR_SCHEMAS,
      }),
    },
    async (input) => {
      const { nominationType, inAppEventIds, territoryIds, ...rest } = input;
      const body = buildNominationCreateBody(
        { ...rest, type: nominationType },
        { inAppEventIds, territoryIds },
      );
      try {
        const data = await client.request<{ data?: { id?: string } }>('/v1/nominations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const id = data?.data?.id;
        return {
          content: [
            {
              type: 'text',
              text: `${input.submitted ? 'Created AND SUBMITTED' : 'Created DRAFT'} nomination${id ? ` ${id}` : ''}.${input.submitted ? '' : ' Review it with asc_get_nomination, then submit with asc_patch_nomination submitted:true.'}\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_nomination',
    {
      title: 'Update a featuring nomination (or submit / archive it)',
      description:
        "⚠️ PATCH a nomination. Apple REQUIRES submitted or archived on EVERY patch (400 PARAMETER_ERROR.REQUIRED otherwise — caught live 2026-08-13): pass submitted:false when editing a draft (keeps it a draft), submitted:true to SEND it to Apple's editorial team (one-way, no un-submit), or archived:true to shelve it. Other attributes edit in place; relationship arrays (appIds / inAppEventIds / territoryIds) REPLACE the existing set when passed.",
      inputSchema: z.object({
        nominationId: NominationIdSchema,
        name: z.string().optional(),
        nominationType: NominationTypeSchema.optional(),
        description: z.string().optional(),
        publishStartDate: z.string().optional(),
        submitted: z
          .boolean()
          .optional()
          .describe(
            'REQUIRED unless archived is passed. false = keep as draft (use this when editing); true = submit the draft to Apple NOW (one-way).',
          ),
        archived: z.boolean().optional().describe('true = shelve the nomination.'),
        appIds: z.array(AppIdSchema).optional(),
        ...OPTIONAL_ATTR_SCHEMAS,
      }),
    },
    async (input) => {
      const { nominationId, nominationType, appIds, inAppEventIds, territoryIds, ...rest } = input;
      const attrs = { ...rest, type: nominationType };
      // Apple requires submitted or archived on EVERY nomination PATCH — an
      // attributes-only edit without one 400s. Refuse client-side with the
      // rule spelled out rather than surfacing Apple's bare error.
      if (input.submitted === undefined && input.archived === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Apple requires `submitted` or `archived` on every nomination PATCH. Pass submitted:false to edit while keeping it a draft, submitted:true to submit to Apple (one-way), or archived:true to shelve it.',
            },
          ],
          isError: true,
        };
      }
      const body = buildNominationPatchBody(nominationId, attrs, {
        appIds,
        inAppEventIds,
        territoryIds,
      });
      try {
        const data = await client.request<unknown>(
          `/v1/nominations/${encodeURIComponent(nominationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `${input.submitted ? 'SUBMITTED' : 'Patched'} nomination ${nominationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_nomination',
    {
      title: 'Delete a featuring nomination',
      description:
        'Delete a nomination (drafts). For a submitted one, archive instead (asc_patch_nomination archived:true).',
      inputSchema: z.object({
        nominationId: NominationIdSchema,
      }),
    },
    async ({ nominationId }) => {
      try {
        await client.request<void>(`/v1/nominations/${encodeURIComponent(nominationId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Deleted nomination ${nominationId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
