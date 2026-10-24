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
//
//   * MIGRATION (API 4.4 deprecated SubscriptionAvailability for
//     SubscriptionPlanAvailability): the three subscription-availability
//     tools keep their names and inputs but no longer call
//     /v1/subscriptionAvailabilities or /v1/subscriptions/{id}/subscriptionAvailability.
//     Verified live 2026-10-24 on two shipping subscriptions (monthly + annual):
//     every subscription already has an UPFRONT plan availability (opaque id
//     decodes to {"a":"<subscription id>","p":"0"}) whose territory set is
//     IDENTICAL to the legacy record's. UPFRONT is the standard "pay the full
//     period price up front" plan; MONTHLY is the newer "monthly billing with a
//     12-month commitment" plan. So the legacy record == the UPFRONT plan, and
//     the tools read/write that plan instead.

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

// The plan type the deprecated SubscriptionAvailability resource maps onto.
export const STANDARD_PLAN_TYPE = 'UPFRONT';

interface PlanAvailabilityRecord {
  id: string;
  attributes?: { planType?: string; availableInNewTerritories?: boolean };
}

// Pick the standard (UPFRONT) plan availability out of a subscription's
// planAvailabilities list — the record the deprecated SubscriptionAvailability
// mirrored. Returns undefined when the subscription has none yet.
export function pickStandardPlanAvailability<T extends PlanAvailabilityRecord>(
  records: readonly T[],
): T | undefined {
  return records.find((r) => r.attributes?.planType === STANDARD_PLAN_TYPE);
}

// SubscriptionPlanAvailability ids are base64 of {"a":"<subscription id>","p":"<n>"}.
// Callers of asc_list_subscription_available_territories may still pass the
// legacy id (== the subscription id), so tell the two apart without trusting
// the composite for anything else.
export function isPlanAvailabilityId(id: string): boolean {
  if (/^\d+$/.test(id)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(id, 'base64').toString('utf8')) as unknown;
    return typeof decoded === 'object' && decoded !== null && 'a' in decoded;
  } catch {
    return false;
  }
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

async function findStandardPlanAvailability(
  client: ASCClient,
  subscriptionId: string,
): Promise<PlanAvailabilityRecord | undefined> {
  const res = await client.request<{ data?: PlanAvailabilityRecord[] }>(
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/planAvailabilities?limit=200`,
  );
  return pickStandardPlanAvailability(res.data ?? []);
}

const TERRITORY_IDS_SCHEMA = z
  .array(TerritoryIdSchema)
  .min(1)
  .describe(
    'FULL list of bare 3-letter ISO territory codes (USA / BRA / JPN — plain Territory ids, NOT the opaque composites app availability uses). Apple treats this as the COMPLETE list; territories not in the array are removed.',
  );

export function registerAvailabilities(server: McpServer, client: ASCClient): void {
  // ----- Subscription availability (served by the UPFRONT plan availability) -----

  server.registerTool(
    'asc_get_subscription_availability',
    {
      title: 'Get the availability of a subscription',
      description:
        "Fetch a subscription's standard availability — availableInNewTerritories plus the record id to pass to asc_list_subscription_available_territories. Reads /v1/subscriptions/{id}/planAvailabilities and returns the UPFRONT plan record, which is what the deprecated SubscriptionAvailability resource mirrored (same territory set, verified live). Any MONTHLY (12-month-commitment) plan record is listed too. Returns a note, not an error, when the subscription has no availability yet.",
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
      }),
    },
    async ({ subscriptionId }) => {
      try {
        const res = await client.request<{ data?: PlanAvailabilityRecord[] }>(
          `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/planAvailabilities?limit=200`,
        );
        const records = res.data ?? [];
        const standard = pickStandardPlanAvailability(records);
        if (!standard) {
          return {
            content: [
              {
                type: 'text',
                text: `Subscription ${subscriptionId} has no UPFRONT plan availability yet — it is not available in any territory. Set one with asc_post_subscription_availability.${records.length ? `\n\nOther plan records:\n${JSON.stringify(records, null, 2)}` : ''}`,
              },
            ],
          };
        }
        const others = records.filter((r) => r !== standard);
        return {
          content: [
            {
              type: 'text',
              text: `Standard (UPFRONT) availability of subscription ${subscriptionId}: availableInNewTerritories=${standard.attributes?.availableInNewTerritories}. Pass id ${standard.id} to asc_list_subscription_available_territories.${others.length ? ` Also has ${others.length} other plan record(s) (MONTHLY = 12-month commitment).` : ''}\n\n${JSON.stringify(res, null, 2)}`,
            },
          ],
        };
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
        "List the Territory rows (bare 3-letter ISO ids) a subscription is available in. Pass the plan-availability id from asc_get_subscription_availability, or the subscription id itself (the old SubscriptionAvailability id) — the tool then reads that subscription's UPFRONT plan. Uses /v1/subscriptionPlanAvailabilities/{id}/availableTerritories; the deprecated /v1/subscriptionAvailabilities path is no longer called.",
      inputSchema: z.object({
        availabilityId: SubscriptionAvailabilityIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ availabilityId, maxItems, raw }) => {
      try {
        let planAvailabilityId = availabilityId;
        if (!isPlanAvailabilityId(availabilityId)) {
          const standard = await findStandardPlanAvailability(client, availabilityId);
          if (!standard) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Subscription ${availabilityId} has no UPFRONT plan availability — it is available in 0 territories.`,
                },
              ],
            };
          }
          planAvailabilityId = standard.id;
        }
        const path = `/v1/subscriptionPlanAvailabilities/${encodeURIComponent(
          planAvailabilityId,
        )}/availableTerritories?limit=200`;
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
      title: 'Replace the availability of a subscription (full replacement)',
      description:
        "Set where a subscription is sold. Pass the FULL territory list (bare 3-letter ISO codes) every time; missing territories get removed. availableInNewTerritories controls whether Apple auto-adds the subscription when new storefronts launch. Writes the subscription's UPFRONT plan availability (the replacement for the deprecated SubscriptionAvailability): PATCHes the existing record, or POSTs one with planType UPFRONT if the subscription has none. Use asc_post_subscription_plan_availability for the MONTHLY (12-month commitment) plan. ⚠️ Removing a territory pulls the subscription from sale there — customer-facing.",
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        availableInNewTerritories: AvailableInNewTerritoriesSchema,
        territoryIds: TERRITORY_IDS_SCHEMA,
      }),
    },
    async ({ subscriptionId, availableInNewTerritories, territoryIds }) => {
      try {
        const standard = await findStandardPlanAvailability(client, subscriptionId);
        const data = standard
          ? await client.request<unknown>(
              `/v1/subscriptionPlanAvailabilities/${encodeURIComponent(standard.id)}`,
              {
                method: 'PATCH',
                body: JSON.stringify(
                  buildSubscriptionPlanAvailabilityPatchBody({
                    planAvailabilityId: standard.id,
                    availableInNewTerritories,
                    territoryIds,
                  }),
                ),
              },
            )
          : await client.request<unknown>('/v1/subscriptionPlanAvailabilities', {
              method: 'POST',
              body: JSON.stringify(
                buildSubscriptionPlanAvailabilityCreateBody({
                  subscriptionId,
                  planType: STANDARD_PLAN_TYPE,
                  availableInNewTerritories,
                  territoryIds,
                }),
              ),
            });
        return {
          content: [
            {
              type: 'text',
              text: `Replaced availability on subscription ${subscriptionId} (${territoryIds.length} territories, availableInNewTerritories=${availableInNewTerritories}) via the UPFRONT plan availability (${standard ? `PATCH ${standard.id}` : 'new record'}).\n\n${JSON.stringify(data, null, 2)}`,
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
          'Plan type this availability applies to: UPFRONT (the standard plan — the customer pays the full period price up front; every subscription has one, and asc_post_subscription_availability writes it) or MONTHLY (monthly billing with a 12-month commitment). Immutable after creation.',
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
