import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestTerritories } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AvailableInNewTerritoriesSchema,
  InAppPurchaseAvailabilityIdSchema,
  InAppPurchaseIdSchema,
  SubscriptionAvailabilityIdSchema,
  SubscriptionIdSchema,
  SubscriptionPlanAvailabilityIdSchema,
  SubscriptionPlanTypeSchema,
  TerritoryIdSchema,
} from '../schemas.js';

// Per-territory availability of IAPs and subscriptions — the sibling of
// v0.15's AppAvailabilityV2, with one load-bearing difference:
//
//   * The `availableTerritories` relationship targets plain `territories`
//     resources, so the IDs are BARE 3-letter ISO codes (USA / BRA / JPN) —
//     NOT the Apple-opaque per-(app, territory) composites that
//     appAvailabilities uses. Same concept, opposite ID convention.
//
//   * Subscription + IAP availabilities are POST-only (no PATCH / DELETE):
//     to change availability, POST a new record carrying the FULL territory
//     list and Apple swaps over — identical replace semantics to
//     AppAvailabilityV2.
//
//   * subscriptionPlanAvailabilities (per-plan-type availability, planType
//     MONTHLY | UPFRONT) is the exception: it HAS a PATCH (attributes +
//     availableTerritories relationship) and is discovered via
//     GET /v1/subscriptions/{id}/planAvailabilities.
//
//   * Reads hang off the parent (/v1/subscriptions/{id}/subscriptionAvailability,
//     /v2/inAppPurchases/{id}/inAppPurchaseAvailability — note the v2 parent
//     path for IAPs) plus /availableTerritories subresources on the flat ids.
//
//   * ID SEMANTICS (verified live 2026-08-13): SubscriptionAvailability.id ==
//     the subscription id (the AppAvailability.id == app id pattern again),
//     but SubscriptionPlanAvailability.id is an Apple-OPAQUE base64 composite
//     — never construct it, always read it from the planAvailabilities list.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

function territoryLinkage(territoryIds: string[]) {
  return { data: territoryIds.map((id) => ({ type: 'territories', id })) };
}

// ----- Body builders -----

export interface SubscriptionAvailabilityCreateInput {
  subscriptionId: string;
  availableInNewTerritories: boolean;
  territoryIds: string[];
}

export function buildSubscriptionAvailabilityCreateBody(
  input: SubscriptionAvailabilityCreateInput,
): JSONAPIBody {
  return {
    data: {
      type: 'subscriptionAvailabilities',
      attributes: { availableInNewTerritories: input.availableInNewTerritories },
      relationships: {
        subscription: { data: { type: 'subscriptions', id: input.subscriptionId } },
        availableTerritories: territoryLinkage(input.territoryIds),
      },
    },
  };
}

export interface IapAvailabilityCreateInput {
  iapId: string;
  availableInNewTerritories: boolean;
  territoryIds: string[];
}

export function buildIapAvailabilityCreateBody(input: IapAvailabilityCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'inAppPurchaseAvailabilities',
      attributes: { availableInNewTerritories: input.availableInNewTerritories },
      relationships: {
        inAppPurchase: { data: { type: 'inAppPurchases', id: input.iapId } },
        availableTerritories: territoryLinkage(input.territoryIds),
      },
    },
  };
}

export interface SubscriptionPlanAvailabilityCreateInput {
  subscriptionId: string;
  planType: 'MONTHLY' | 'UPFRONT';
  availableInNewTerritories?: boolean | undefined;
  territoryIds: string[];
}

export function buildSubscriptionPlanAvailabilityCreateBody(
  input: SubscriptionPlanAvailabilityCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = { planType: input.planType };
  if (input.availableInNewTerritories !== undefined) {
    attributes.availableInNewTerritories = input.availableInNewTerritories;
  }
  return {
    data: {
      type: 'subscriptionPlanAvailabilities',
      attributes,
      relationships: {
        subscription: { data: { type: 'subscriptions', id: input.subscriptionId } },
        availableTerritories: territoryLinkage(input.territoryIds),
      },
    },
  };
}

export interface SubscriptionPlanAvailabilityPatchInput {
  planAvailabilityId: string;
  availableInNewTerritories?: boolean | undefined;
  territoryIds?: string[] | undefined;
}

export function buildSubscriptionPlanAvailabilityPatchBody(
  input: SubscriptionPlanAvailabilityPatchInput,
): JSONAPIBody {
  const data: JSONAPIBody['data'] = {
    type: 'subscriptionPlanAvailabilities',
    // Apple requires the id in the body as well as the URL (409 otherwise).
    id: input.planAvailabilityId,
  };
  if (input.availableInNewTerritories !== undefined) {
    data.attributes = { availableInNewTerritories: input.availableInNewTerritories };
  }
  if (input.territoryIds !== undefined) {
    data.relationships = { availableTerritories: territoryLinkage(input.territoryIds) };
  }
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

const TERRITORY_IDS_SCHEMA = z
  .array(TerritoryIdSchema)
  .min(1)
  .describe(
    'FULL list of bare 3-letter ISO territory codes (USA / BRA / JPN — plain Territory ids, NOT the opaque composites app availability uses). Apple treats this as the COMPLETE list; territories not in the array are removed.',
  );

export function registerAvailabilities(server: McpServer, client: ASCClient): void {
  // ----- Subscription availability -----

  server.registerTool(
    'asc_get_subscription_availability',
    {
      title: 'Get the availability of a subscription',
      description:
        "Fetch a subscription's SubscriptionAvailability — availableInNewTerritories plus the record id to pass to asc_list_subscription_available_territories. Reads through the parent (/v1/subscriptions/{id}/subscriptionAvailability).",
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
      }),
    },
    async ({ subscriptionId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/subscriptionAvailability`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_subscription_available_territories',
    {
      title: 'List territories a subscription is available in',
      description:
        'List the Territory rows behind a SubscriptionAvailability (bare 3-letter ISO ids). Pass the availability id from asc_get_subscription_availability.',
      inputSchema: z.object({
        availabilityId: SubscriptionAvailabilityIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ availabilityId, maxItems, raw }) => {
      const path = `/v1/subscriptionAvailabilities/${encodeURIComponent(
        availabilityId,
      )}/availableTerritories?limit=200`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestTerritories(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_availability',
    {
      title: 'Replace the availability of a subscription (POST-only — full replacement)',
      description:
        'Create a new SubscriptionAvailability — Apple atomically swaps over to it. There is NO PATCH; POST the FULL territory list (bare 3-letter ISO codes) every time; missing territories get removed. availableInNewTerritories controls whether Apple auto-adds the subscription when new storefronts launch. ⚠️ Removing a territory pulls the subscription from sale there — customer-facing.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        availableInNewTerritories: AvailableInNewTerritoriesSchema,
        territoryIds: TERRITORY_IDS_SCHEMA,
      }),
    },
    async ({ subscriptionId, availableInNewTerritories, territoryIds }) => {
      const body = buildSubscriptionAvailabilityCreateBody({
        subscriptionId,
        availableInNewTerritories,
        territoryIds,
      });
      try {
        const data = await client.request<unknown>('/v1/subscriptionAvailabilities', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Replaced availability on subscription ${subscriptionId} (${territoryIds.length} territories, availableInNewTerritories=${availableInNewTerritories}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- IAP availability -----

  server.registerTool(
    'asc_get_iap_availability',
    {
      title: 'Get the availability of an in-app purchase',
      description:
        "Fetch an IAP's InAppPurchaseAvailability — availableInNewTerritories plus the record id to pass to asc_list_iap_available_territories. Reads through the V2 parent (/v2/inAppPurchases/{id}/inAppPurchaseAvailability).",
      inputSchema: z.object({
        iapId: InAppPurchaseIdSchema,
      }),
    },
    async ({ iapId }) => {
      try {
        const data = await client.request<unknown>(
          `/v2/inAppPurchases/${encodeURIComponent(iapId)}/inAppPurchaseAvailability`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_iap_available_territories',
    {
      title: 'List territories an in-app purchase is available in',
      description:
        'List the Territory rows behind an InAppPurchaseAvailability (bare 3-letter ISO ids). Pass the availability id from asc_get_iap_availability.',
      inputSchema: z.object({
        availabilityId: InAppPurchaseAvailabilityIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ availabilityId, maxItems, raw }) => {
      const path = `/v1/inAppPurchaseAvailabilities/${encodeURIComponent(
        availabilityId,
      )}/availableTerritories?limit=200`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestTerritories(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_iap_availability',
    {
      title: 'Replace the availability of an in-app purchase (POST-only — full replacement)',
      description:
        'Create a new InAppPurchaseAvailability — Apple atomically swaps over to it. There is NO PATCH; POST the FULL territory list (bare 3-letter ISO codes) every time; missing territories get removed. ⚠️ Removing a territory pulls the IAP from sale there — customer-facing.',
      inputSchema: z.object({
        iapId: InAppPurchaseIdSchema,
        availableInNewTerritories: AvailableInNewTerritoriesSchema,
        territoryIds: TERRITORY_IDS_SCHEMA,
      }),
    },
    async ({ iapId, availableInNewTerritories, territoryIds }) => {
      const body = buildIapAvailabilityCreateBody({
        iapId,
        availableInNewTerritories,
        territoryIds,
      });
      try {
        const data = await client.request<unknown>('/v1/inAppPurchaseAvailabilities', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Replaced availability on IAP ${iapId} (${territoryIds.length} territories, availableInNewTerritories=${availableInNewTerritories}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Subscription plan availability (per plan type) -----

  server.registerTool(
    'asc_list_subscription_plan_availabilities',
    {
      title: 'List plan availabilities of a subscription',
      description:
        "List a subscription's SubscriptionPlanAvailability records — per-plan-type (MONTHLY / UPFRONT) territory availability. Returns each record's id, planType and availableInNewTerritories; drill territories with asc_list_subscription_plan_available_territories.",
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
      }),
    },
    async ({ subscriptionId, maxItems }) => {
      const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/planAvailabilities?limit=200`;
      try {
        const pages = await paginate(client, path, maxItems);
        return { content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_subscription_plan_available_territories',
    {
      title: 'List territories a subscription plan is available in',
      description:
        'List the Territory rows behind a SubscriptionPlanAvailability (bare 3-letter ISO ids). Pass the record id from asc_list_subscription_plan_availabilities.',
      inputSchema: z.object({
        planAvailabilityId: SubscriptionPlanAvailabilityIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ planAvailabilityId, maxItems, raw }) => {
      const path = `/v1/subscriptionPlanAvailabilities/${encodeURIComponent(
        planAvailabilityId,
      )}/availableTerritories?limit=200`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestTerritories(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_plan_availability',
    {
      title: 'Create a subscription plan availability',
      description:
        'Create a SubscriptionPlanAvailability — per-plan-type (planType MONTHLY | UPFRONT) territory availability on a subscription. Pass the full territory list as bare 3-letter ISO codes. Unlike subscription/IAP availability this resource supports PATCH afterwards (asc_patch_subscription_plan_availability).',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        planType: SubscriptionPlanTypeSchema.describe(
          'Plan type this availability applies to: MONTHLY (recurring per-period billing) or UPFRONT (single up-front charge). Immutable after creation.',
        ),
        availableInNewTerritories: AvailableInNewTerritoriesSchema.optional(),
        territoryIds: TERRITORY_IDS_SCHEMA,
      }),
    },
    async ({ subscriptionId, planType, availableInNewTerritories, territoryIds }) => {
      const body = buildSubscriptionPlanAvailabilityCreateBody({
        subscriptionId,
        planType,
        availableInNewTerritories,
        territoryIds,
      });
      try {
        const data = await client.request<unknown>('/v1/subscriptionPlanAvailabilities', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created ${planType} plan availability on subscription ${subscriptionId} (${territoryIds.length} territories).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription_plan_availability',
    {
      title: 'Update a subscription plan availability',
      description:
        'PATCH a SubscriptionPlanAvailability: availableInNewTerritories and/or the availableTerritories list (FULL replacement of the territory set when passed — bare 3-letter ISO codes). planType is immutable. Pass at least one of the two. ⚠️ Removing territories is customer-facing.',
      inputSchema: z.object({
        planAvailabilityId: SubscriptionPlanAvailabilityIdSchema,
        availableInNewTerritories: AvailableInNewTerritoriesSchema.optional(),
        territoryIds: TERRITORY_IDS_SCHEMA.optional(),
      }),
    },
    async ({ planAvailabilityId, availableInNewTerritories, territoryIds }) => {
      if (availableInNewTerritories === undefined && territoryIds === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of availableInNewTerritories, territoryIds.',
            },
          ],
          isError: true,
        };
      }
      const body = buildSubscriptionPlanAvailabilityPatchBody({
        planAvailabilityId,
        availableInNewTerritories,
        territoryIds,
      });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionPlanAvailabilities/${encodeURIComponent(planAvailabilityId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched plan availability ${planAvailabilityId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
