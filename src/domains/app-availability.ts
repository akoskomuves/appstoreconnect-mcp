import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestTerritoryAvailabilities } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AvailableInNewTerritoriesSchema,
  TerritoryAvailabilityIdSchema,
} from '../schemas.js';

// AppAvailabilityV2 wire shape:
//
//   * AppAvailabilityV2CreateRequest: required attrs =
//     { isAvailableInNewTerritories }, required relationships = app +
//     territoryAvailabilities (to-many). WIRE-KEY GOTCHA: Swift
//     `isAvailableInNewTerritories` → wire `availableInNewTerritories`
//     (same is-prefix strip family as v0.13 isVisible → visible,
//     v0.14 isVisibleForAllUsers → visibleForAllUsers).
//
//   * POST-only. No PATCH / DELETE on AppAvailabilityV2. To change
//     availability, POST a NEW record with the full territory list.
//     Apple swaps over atomically.
//
//   * TerritoryAvailability IDs are APPLE-OPAQUE per-(app, territory)
//     composites: base64 of `{"s":<appId>,"t":<3-letter-code>}`. NOT the
//     bare territory code. Discovered live 2026-06-09 — opposite of
//     v0.12 AppKeyword (where id IS the human-readable string). Get IDs
//     from asc_list_territory_availabilities, then pass them through to
//     POST / end-preorder verbatim.
//
//   * AppAvailabilityV2CreateRequest also accepts `included[]` for
//     TerritoryAvailabilityInlineCreate (per-territory release dates =
//     soft-launch scheduling). DEFERRED to v0.16 — v0.15 uses existing
//     territory IDs only.
//
//   * EndAppAvailabilityPreOrder is a separate POST resource carrying
//     ONLY a relationships block with territoryAvailabilities[]. Ends
//     pre-order in the specified territories. No attributes.

const TERRITORY_AVAILABILITY_FIELDS =
  'available,releaseDate,preOrderEnabled,preOrderPublishDate,contentStatuses';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface AppAvailabilityV2CreateInput {
  appId: string;
  availableInNewTerritories: boolean;
  territoryIds: string[];
}

export function buildAppAvailabilityV2CreateBody(input: AppAvailabilityV2CreateInput): JSONAPIBody {
  // Wire-key gotcha: Swift `isAvailableInNewTerritories` → wire
  // `availableInNewTerritories`. Emit the short form on writes.
  return {
    data: {
      type: 'appAvailabilities',
      attributes: {
        availableInNewTerritories: input.availableInNewTerritories,
      },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
        territoryAvailabilities: {
          data: input.territoryIds.map((id) => ({ type: 'territoryAvailabilities', id })),
        },
      },
    },
  };
}

export interface EndAppAvailabilityPreOrderInput {
  territoryIds: string[];
}

export function buildEndAppAvailabilityPreOrderBody(
  input: EndAppAvailabilityPreOrderInput,
): JSONAPIBody {
  // EndAppAvailabilityPreOrder is relationships-only — no attributes block.
  // Same shape pattern as v0.9 AppInfo PATCH (relationships-only).
  return {
    data: {
      type: 'endAppAvailabilityPreOrders',
      relationships: {
        territoryAvailabilities: {
          data: input.territoryIds.map((id) => ({ type: 'territoryAvailabilities', id })),
        },
      },
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

export interface TerritoryAvailabilityPatchInput {
  territoryAvailabilityId: string;
  available?: boolean | undefined;
  releaseDate?: string | undefined;
  preOrderEnabled?: boolean | undefined;
}

export function buildTerritoryAvailabilityPatchBody(
  input: TerritoryAvailabilityPatchInput,
): JSONAPIBody {
  // v0.22 pre-order surface: PATCH /v1/territoryAvailabilities/{id} mutates
  // available / releaseDate / preOrderEnabled per territory. The ID is the
  // Apple-opaque base64 composite from asc_list_territory_availabilities
  // (v0.15 discovery) — never a bare ISO code. Wire keys are verbatim
  // camelCase (no is-prefix strips on this shape).
  const attributes: Record<string, unknown> = {};
  if (input.available !== undefined) attributes.available = input.available;
  if (input.releaseDate !== undefined) attributes.releaseDate = input.releaseDate;
  if (input.preOrderEnabled !== undefined) attributes.preOrderEnabled = input.preOrderEnabled;
  return {
    data: {
      type: 'territoryAvailabilities',
      id: input.territoryAvailabilityId,
      attributes,
    },
  };
}

export function registerAppAvailability(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_get_app_availability_v2',
    {
      title: 'Get the AppAvailabilityV2 for an app',
      description:
        'Fetch the current AppAvailabilityV2 for an app. Returns the master `availableInNewTerritories` flag (whether Apple auto-adds the app when new territories launch) + the linkage to the territoryAvailabilities the app is currently sold in. Use asc_list_territory_availabilities to enumerate the territories.',
      inputSchema: z.object({
        appId: AppIdSchema,
      }),
    },
    async ({ appId }) => {
      const path = `/v1/apps/${encodeURIComponent(appId)}/appAvailabilityV2`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_territory_availabilities',
    {
      title: 'List territory availabilities for an app',
      description:
        'List TerritoryAvailability records for an app. The digest TERR column shows the decoded 3-letter ISO territory code (e.g. USA / BRA / JPN), but the actual TERR_ID column is an Apple-opaque base64 composite — `{"s":<appId>,"t":<code>}`. Each row carries whether the app is currently `available`, releaseDate (soft-launch date if scheduled), preOrderEnabled, preOrderPublishDate. Pass the TERR_ID (not the 3-letter code) to asc_post_app_availability_v2 / asc_end_app_availability_pre_order. NOTE: Apple\'s AppAvailability resource ID equals the app ID — both surfaces share the numeric identifier.',
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[territoryAvailabilities]', TERRITORY_AVAILABILITY_FIELDS);
      params.set('limit', '200');
      // Apple's territoryAvailabilities listing lives at /v2/appAvailabilities/{id}.
      // AppAvailability.id == appId (Apple shares the numeric identifier across
      // the two surfaces). The v1 /apps/{id}/appAvailabilityV2/territoryAvailabilities
      // path does not exist (PATH_ERROR on the live API).
      const path = `/v2/appAvailabilities/${encodeURIComponent(appId)}/territoryAvailabilities?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestTerritoryAvailabilities(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_availability_v2',
    {
      title: 'Replace the AppAvailabilityV2 for an app (POST-only — full replacement)',
      description:
        'Create a new AppAvailabilityV2 for an app — Apple atomically swaps over to it. There is NO PATCH for this resource; you replace the whole availability by POSTing a new record. Required: appId + availableInNewTerritories + the FULL list of TerritoryAvailability IDs the app should be sold in (Apple-opaque base64 composites from asc_list_territory_availabilities; missing ones get removed). Wire-key gotcha: Swift `isAvailableInNewTerritories` → wire `availableInNewTerritories`. The IDs are NOT 3-letter codes — they are per-(app, territory) opaque blobs.',
      inputSchema: z.object({
        appId: AppIdSchema,
        availableInNewTerritories: AvailableInNewTerritoriesSchema,
        territoryIds: z
          .array(TerritoryAvailabilityIdSchema)
          .min(1)
          .describe(
            'Full list of TerritoryAvailability IDs (Apple-opaque base64 composites, NOT bare 3-letter codes — get them from asc_list_territory_availabilities). Apple uses this as the COMPLETE list; any territories not in the array are removed.',
          ),
      }),
    },
    async ({ appId, availableInNewTerritories, territoryIds }) => {
      const body = buildAppAvailabilityV2CreateBody({
        appId,
        availableInNewTerritories,
        territoryIds,
      });
      try {
        const data = await client.request<unknown>('/v1/appAvailabilities', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Replaced AppAvailabilityV2 on app ${appId} (${territoryIds.length} territories, availableInNewTerritories=${availableInNewTerritories}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_end_app_availability_pre_order',
    {
      title: 'End app pre-order in selected territories',
      description:
        'POST an EndAppAvailabilityPreOrder resource carrying the list of TerritoryAvailability IDs in which to end pre-order. Apple stops accepting pre-orders in those territories — the app either goes live (if past releaseDate) or back to "not-yet-available". Relationships-only body (no attributes). Pass the opaque base64 IDs from asc_list_territory_availabilities (NOT bare 3-letter codes).',
      inputSchema: z.object({
        territoryIds: z
          .array(TerritoryAvailabilityIdSchema)
          .min(1)
          .describe(
            'List of TerritoryAvailability IDs (Apple-opaque base64 composites — get them from asc_list_territory_availabilities) in which to end pre-order. Apple ends pre-order only in these territories; other territories continue their pre-order schedules.',
          ),
      }),
    },
    async ({ territoryIds }) => {
      const body = buildEndAppAvailabilityPreOrderBody({ territoryIds });
      try {
        const data = await client.request<unknown>('/v1/endAppAvailabilityPreOrders', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Ended pre-order in ${territoryIds.length} territories.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_territory_availability',
    {
      title: 'Patch a territory availability (pre-order / release date)',
      description:
        'PATCH /v1/territoryAvailabilities/{id} — per-territory pre-order + release control: available (sell here or not), releaseDate (YYYY-MM-DD; with preOrderEnabled=true this is the announced release date customers pre-order against), preOrderEnabled (start taking pre-orders in this territory; end them with asc_end_app_availability_pre_order). The ID is the APPLE-OPAQUE composite from asc_list_territory_availabilities — bare 3-letter codes are rejected. Pass at least one attribute. ⚠️ available=false pulls the app from sale in that territory — customer-facing; confirm intent first.',
      inputSchema: z.object({
        territoryAvailabilityId: TerritoryAvailabilityIdSchema,
        available: z
          .boolean()
          .optional()
          .describe('false REMOVES the app from sale in this territory (customer-facing).'),
        releaseDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
          .optional()
          .describe(
            'Release date for this territory (pre-order target date when preOrderEnabled).',
          ),
        preOrderEnabled: z
          .boolean()
          .optional()
          .describe('true: open pre-orders in this territory (requires a future releaseDate).'),
      }),
    },
    async (input) => {
      const anyField = [input.available, input.releaseDate, input.preOrderEnabled].some(
        (v) => v !== undefined,
      );
      if (!anyField) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of available, releaseDate, preOrderEnabled.',
            },
          ],
          isError: true,
        };
      }
      const body = buildTerritoryAvailabilityPatchBody({
        territoryAvailabilityId: input.territoryAvailabilityId,
        ...(input.available !== undefined ? { available: input.available } : {}),
        ...(input.releaseDate !== undefined ? { releaseDate: input.releaseDate } : {}),
        ...(input.preOrderEnabled !== undefined ? { preOrderEnabled: input.preOrderEnabled } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/territoryAvailabilities/${encodeURIComponent(input.territoryAvailabilityId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched territory availability ${input.territoryAvailabilityId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
