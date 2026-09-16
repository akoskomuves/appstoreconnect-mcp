import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestSubscriptionGroups,
  digestSubscriptionPricePoints,
  digestSubscriptionPrices,
  digestSubscriptions,
} from '../digest.js';
import { ASCError } from '../errors.js';
import {
  FULL_TERRITORY_SCAN,
  filterPagesByNearAmount,
  filterPagesByTerritory,
  paginate,
  territoryFilterNote,
} from '../jsonapi.js';
import {
  AppIdSchema,
  ProductIdSchema,
  SubscriptionFamilySharableSchema,
  SubscriptionGroupIdSchema,
  SubscriptionGroupLevelSchema,
  SubscriptionGroupReferenceNameSchema,
  SubscriptionIdSchema,
  SubscriptionNameSchema,
  SubscriptionPeriodSchema,
  SubscriptionReviewNoteSchema,
  TerritoryIdSchema,
} from '../schemas.js';

const GROUP_FIELDS = 'referenceName';
const SUB_FIELDS = 'name,productId,subscriptionPeriod,state,groupLevel';
// SubscriptionPrice has only `startDate` as an attribute; `preserveCurrentPrice`
// is a write-only field on the POST body, not a queryable resource attribute.
// We don't apply fields[subscriptionPrices] at all — Apple rejects unknown names.
const PRICE_POINT_FIELDS = 'customerPrice,proceeds,proceedsYear2';
const TERRITORY_FIELDS = 'currency';

// ----- Product creation (v1.12.0) -----
//
// Everything else in this file — and in subscription-localizations,
// intro/promo/win-back offers, prices, availabilities — operates on a
// Subscription or SubscriptionGroup that already exists. Until v1.12.0
// nothing here could CREATE one, so an agent had to stop and hand the user
// back to the App Store Connect web UI at the very first step of monetizing
// an app. Apple exposes both creates (POST /v1/subscriptionGroups and
// POST /v1/subscriptions, OpenAPI spec 4.4.1); the gap was ours.
//
// Shape of the hierarchy, because the naming is genuinely confusing:
//
//   SubscriptionGroup                 referenceName        -> internal only
//    +- SubscriptionGroupLocalization name, customAppName  -> CUSTOMER-FACING
//    +- Subscription                  name, productId      -> internal only
//        +- SubscriptionLocalization  name, description    -> CUSTOMER-FACING
//
// Both `name` attributes are internal reference names. The customer never
// sees either one; the App Store renders the *Localization* records. Getting
// this backwards produces a store listing that reads like a Jira ticket, so
// the tool descriptions below say it at every opportunity.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface SubscriptionGroupCreateInput {
  appId: string;
  referenceName: string;
}

export function buildSubscriptionGroupCreateBody(input: SubscriptionGroupCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'subscriptionGroups',
      attributes: { referenceName: input.referenceName },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export interface SubscriptionGroupPatchInput {
  groupId: string;
  referenceName: string;
}

export function buildSubscriptionGroupPatchBody(input: SubscriptionGroupPatchInput): JSONAPIBody {
  // SubscriptionGroupUpdateRequest carries exactly one mutable attribute.
  // The app relationship is fixed at create; a group cannot move between apps.
  return {
    data: {
      type: 'subscriptionGroups',
      id: input.groupId,
      attributes: { referenceName: input.referenceName },
    },
  };
}

export interface SubscriptionCreateInput {
  groupId: string;
  name: string;
  productId: string;
  subscriptionPeriod?: string | undefined;
  familySharable?: boolean | undefined;
  reviewNote?: string | undefined;
  groupLevel?: number | undefined;
}

export function buildSubscriptionCreateBody(input: SubscriptionCreateInput): JSONAPIBody {
  // Apple marks only name + productId + the group rel as required. The rest
  // are encodeIfPresent — omitted keys are not the same as null keys, and a
  // null subscriptionPeriod is rejected outright, so every optional attribute
  // is added only when the caller supplied it.
  const attributes: Record<string, unknown> = {
    name: input.name,
    productId: input.productId,
  };
  if (input.subscriptionPeriod !== undefined) {
    attributes.subscriptionPeriod = input.subscriptionPeriod;
  }
  if (input.familySharable !== undefined) attributes.familySharable = input.familySharable;
  if (input.reviewNote !== undefined) attributes.reviewNote = input.reviewNote;
  if (input.groupLevel !== undefined) attributes.groupLevel = input.groupLevel;
  return {
    data: {
      type: 'subscriptions',
      attributes,
      relationships: {
        group: { data: { type: 'subscriptionGroups', id: input.groupId } },
      },
    },
  };
}

export interface SubscriptionPatchInput {
  subscriptionId: string;
  name?: string | undefined;
  subscriptionPeriod?: string | undefined;
  familySharable?: boolean | undefined;
  reviewNote?: string | undefined;
  groupLevel?: number | undefined;
}

export function buildSubscriptionPatchBody(input: SubscriptionPatchInput): JSONAPIBody {
  // productId is ABSENT from SubscriptionUpdateRequest — the product
  // identifier is immutable for the life of the subscription, because
  // StoreKit receipts and every existing subscriber's entitlement key off it.
  // There is no codepath here that can send it.
  //
  // DELIBERATELY UNSUPPORTED: SubscriptionUpdateRequest also accepts nested
  // `subscriptionIntroductoryOffers` / `subscriptionPromotionalOffers` /
  // `prices` relationship arrays, letting one PATCH rewrite a subscription's
  // offers inline. scripts/audit-required-attributes.py reports those nested
  // required attributes as MISSING here; that is expected, not drift. Offers
  // and prices have dedicated, validated tools (asc_post_subscription_*_offer,
  // asc_post_subscription_price) that pre-flight Apple's caps, offer-code
  // collisions and price-point lookups. Accepting a second, unvalidated path
  // to the same state would bypass all of it, and the wire semantic for those
  // arrays is REPLACE — a caller passing one offer would silently delete the
  // rest. Keep this builder to plain attributes.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.subscriptionPeriod !== undefined) {
    attributes.subscriptionPeriod = input.subscriptionPeriod;
  }
  if (input.familySharable !== undefined) attributes.familySharable = input.familySharable;
  if (input.reviewNote !== undefined) attributes.reviewNote = input.reviewNote;
  if (input.groupLevel !== undefined) attributes.groupLevel = input.groupLevel;
  return {
    data: {
      type: 'subscriptions',
      id: input.subscriptionId,
      attributes,
    },
  };
}

// ----- DELETE pre-checks (state gates) -----
//
// Deleting a subscription is not like deleting a draft localization: if the
// product has ever been APPROVED, live subscribers hold an entitlement keyed
// to its productId, and that productId can never be reused on the account.
// Apple refuses the DELETE server-side, but the refusal is a bare 409 — so
// these gates turn it into a sentence that says what to do instead.
//
// Subscription.state (spec 4.4.1):
//   MISSING_METADATA / READY_TO_SUBMIT      -> draft, never submitted
//   WAITING_FOR_REVIEW / IN_REVIEW /
//     PENDING_BINARY_APPROVAL               -> Apple holds the record
//   DEVELOPER_ACTION_NEEDED / REJECTED      -> back in the developer's court
//   APPROVED                                -> live (or ready to go live)
//   DEVELOPER_REMOVED_FROM_SALE /
//     REMOVED_FROM_SALE                     -> shipped, then withdrawn
//
// The two shipped-then-withdrawn states matter: "removed from sale" does not
// undo the purchases that already happened, so the record is still load-
// bearing and Apple keeps refusing the delete.

const SUBSCRIPTION_UNDER_REVIEW_STATES = new Set<string>([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_BINARY_APPROVAL',
]);

const SUBSCRIPTION_SHIPPED_STATES = new Set<string>([
  'APPROVED',
  'DEVELOPER_REMOVED_FROM_SALE',
  'REMOVED_FROM_SALE',
]);

export interface SubscriptionDeleteGateResult {
  allow: boolean;
  state: string | undefined;
  reason?: string;
  next?: string;
}

export function evaluateSubscriptionDeleteGate(
  state: string | undefined,
): SubscriptionDeleteGateResult {
  // Unknown state -> pass through. A failed pre-check must never block a
  // DELETE that Apple would have accepted.
  if (!state) return { allow: true, state };
  if (SUBSCRIPTION_UNDER_REVIEW_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `the subscription is in ${state} — Apple holds the record while a review cycle is open`,
      next: 'Wait for review to finish, or cancel the review submission, then retry the delete.',
    };
  }
  if (SUBSCRIPTION_SHIPPED_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `the subscription is in ${state} — it has been approved at least once, so customers may hold an entitlement keyed to its productId`,
      next:
        'An approved subscription cannot be deleted, and its productId can never be reused on this account. ' +
        'To stop selling it, remove it from sale per territory with asc_post_subscription_availability (send the reduced territory list), ' +
        "or clear every territory to take it off sale worldwide. Existing subscribers keep renewing either way — that is Apple's behaviour, not a bug.",
    };
  }
  return { allow: true, state };
}

export interface SubscriptionGroupDeleteGateResult {
  allow: boolean;
  blockingSubscriptions: Array<{ id: string; name: string | undefined; state: string | undefined }>;
  reason?: string;
  next?: string;
}

export function evaluateSubscriptionGroupDeleteGate(
  subscriptions: Array<{ id: string; name?: string | undefined; state?: string | undefined }>,
): SubscriptionGroupDeleteGateResult {
  // A group is a container: Apple refuses to delete one while it still holds
  // a product that cannot itself be deleted. Checking the children client-side
  // turns "409 on the group" into "these two products are why".
  const blocking = subscriptions
    .filter(
      (sub) =>
        sub.state !== undefined &&
        (SUBSCRIPTION_UNDER_REVIEW_STATES.has(sub.state) ||
          SUBSCRIPTION_SHIPPED_STATES.has(sub.state)),
    )
    .map((sub) => ({ id: sub.id, name: sub.name, state: sub.state }));
  if (blocking.length === 0) return { allow: true, blockingSubscriptions: [] };
  return {
    allow: false,
    blockingSubscriptions: blocking,
    reason: `the group still contains ${blocking.length} subscription(s) that cannot be deleted`,
    next: 'Delete the draft subscriptions in the group first (asc_delete_subscription). Any subscription listed above as APPROVED / *REMOVED_FROM_SALE has shipped and can never be deleted — which means this group can never be deleted either. Leave it in place; an unused group costs nothing and is invisible to customers.',
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

export function registerSubscriptions(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_groups',
    {
      title: 'List subscription groups',
      description: 'List subscription groups for an app.',
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptionGroups]', GROUP_FIELDS);
      params.set('limit', '200');
      const pages = await paginate(
        client,
        `/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?${params.toString()}`,
        maxItems,
      );
      const text = raw ? JSON.stringify(pages, null, 2) : digestSubscriptionGroups(pages);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'asc_list_subscriptions',
    {
      title: 'List subscriptions',
      description: 'List auto-renewable subscriptions in a subscription group.',
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ groupId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptions]', SUB_FIELDS);
      params.set('limit', '200');
      const pages = await paginate(
        client,
        `/v1/subscriptionGroups/${encodeURIComponent(groupId)}/subscriptions?${params.toString()}`,
        maxItems,
      );
      const text = raw ? JSON.stringify(pages, null, 2) : digestSubscriptions(pages);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'asc_list_subscription_prices',
    {
      title: 'List subscription prices',
      description:
        'List the current price schedule for a subscription. Apple returns one row PER TERRITORY, so an unfiltered call on a worldwide subscription is ~175 rows — pass territoryId (e.g. "USA") whenever you care about a single market, or the response will be large enough to blow a tool-result token cap. Returns a compact table by default; pass raw:true for the full JSON:API payload (note: when territoryId is set the raw payload is narrowed too, though included[] still carries every territory).',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema.optional().describe(
          'Narrow the response to one territory (ISO-3 code, e.g. "USA"). Omit for every territory.',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, territoryId, maxItems, raw }) => {
      // Apple's /v1/subscriptions/{id}/prices is picky about extra query params:
      // adding fields[subscriptionPricePoints], fields[territories], or limit=200
      // produces a 400 with no detail. Stick to the include and let paginate()
      // walk links.next at the server's default page size.
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/prices?include=subscriptionPricePoint,territory`;
      // When narrowing to one territory, maxItems describes how much the
      // caller wants BACK, not how far to look. Apple returns territories in
      // its own order, so capping the fetch at a small maxItems can stop
      // before the requested territory is reached and report it as having no
      // price at all. Scan the whole schedule and let the filter narrow it.
      const fetchCeiling =
        territoryId === undefined ? maxItems : Math.max(maxItems, FULL_TERRITORY_SCAN);
      const fetched = await paginate(client, path, fetchCeiling);
      // Price rows always carry a concrete territory — no wildcard to preserve.
      const pages =
        territoryId === undefined ? fetched : filterPagesByTerritory(fetched, territoryId);
      const note =
        territoryId === undefined
          ? ''
          : territoryFilterNote(
              territoryId,
              pages.data.length,
              fetched.data.length,
              fetched.truncated,
            );
      // The note rides along in raw mode too: the payload IS narrowed there,
      // so dropping it would hand back a filtered document with no sign of it.
      const text = raw
        ? `${note}${JSON.stringify(pages, null, 2)}`
        : `${note}${digestSubscriptionPrices(pages)}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'asc_list_subscription_price_points',
    {
      title: 'List subscription price points',
      description:
        'List the valid price points a subscription can be set to in a given territory. Apple rotates these IDs; cache only within a single run. ' +
        'Pass nearAmount when you already know the target price — the response is narrowed to the nearest candidates client-side (Apple does not support a near-amount filter server-side, so the full list is still paginated but only the nearest tiers are surfaced).',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        territoryId: TerritoryIdSchema,
        maxItems: z.number().int().positive().max(5000).default(1000),
        nearAmount: z
          .number()
          .positive()
          .optional()
          .describe(
            'Target customer price (in the territory currency). The response is filtered to the nearest tiers.',
          ),
        nearCount: z
          .number()
          .int()
          .positive()
          .max(100)
          .default(10)
          .describe('Max tiers to return when nearAmount is set.'),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, territoryId, maxItems, nearAmount, nearCount, raw }) => {
      const params = new URLSearchParams();
      params.set('filter[territory]', territoryId);
      params.set('include', 'territory');
      params.set('fields[subscriptionPricePoints]', PRICE_POINT_FIELDS);
      params.set('fields[territories]', TERRITORY_FIELDS);
      params.set('limit', '200');
      const fetched = await paginate(
        client,
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/pricePoints?${params.toString()}`,
        maxItems,
      );
      const pages =
        nearAmount !== undefined
          ? filterPagesByNearAmount(fetched, nearAmount, nearCount)
          : fetched;
      const text = raw ? JSON.stringify(pages, null, 2) : digestSubscriptionPricePoints(pages);
      return { content: [{ type: 'text', text }] };
    },
  );

  // ----- Subscription groups: get / create / patch / delete -----

  server.registerTool(
    'asc_get_subscription_group',
    {
      title: 'Get a subscription group',
      description:
        'Fetch a single SubscriptionGroup by ID. Returns its internal referenceName. The customer-facing group heading is NOT here — it lives on the group localizations (asc_list_subscription_group_localizations).',
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
      }),
    },
    async ({ groupId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionGroups/${encodeURIComponent(groupId)}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_group',
    {
      title: 'Create a subscription group',
      description:
        'Create a SubscriptionGroup on an app — the container every auto-renewable subscription must live in. This is step 1 of monetizing an app with subscriptions; nothing else in the subscription surface works until a group exists. ' +
        'referenceName is INTERNAL ONLY (App Store Connect + sales reports); customers never see it. Give the group a customer-facing heading with asc_post_subscription_group_localization afterwards. ' +
        'An app may have several groups, but a customer can hold only ONE active subscription per group — so products that should be mutually exclusive (Monthly vs Yearly of the same plan) belong in the SAME group, and products a customer could reasonably hold at once belong in different ones.',
      inputSchema: z.object({
        appId: AppIdSchema,
        referenceName: SubscriptionGroupReferenceNameSchema,
      }),
    },
    async (input) => {
      const body = buildSubscriptionGroupCreateBody(input);
      try {
        const data = await client.request<{ data?: { id?: string } }>('/v1/subscriptionGroups', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const newId = data?.data?.id;
        return {
          content: [
            {
              type: 'text',
              text:
                `Created SubscriptionGroup "${input.referenceName}" on app ${input.appId}${newId ? ` (id ${newId})` : ''}.\n\n` +
                'Next: asc_post_subscription_group_localization (customer-facing group heading, per locale), then asc_post_subscription to add the first product.\n\n' +
                `${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription_group',
    {
      title: 'Rename a subscription group',
      description:
        "Update a SubscriptionGroup's internal referenceName. This is the only mutable attribute on the resource — a group cannot be moved between apps. Renaming is safe at any point in the lifecycle: the value is invisible to customers and changing it does not trigger review.",
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
        referenceName: SubscriptionGroupReferenceNameSchema,
      }),
    },
    async (input) => {
      const body = buildSubscriptionGroupPatchBody(input);
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionGroups/${encodeURIComponent(input.groupId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Renamed SubscriptionGroup ${input.groupId} to "${input.referenceName}".\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_subscription_group',
    {
      title: 'Delete a subscription group',
      description:
        "DELETE a SubscriptionGroup. Only possible while every subscription inside it is still a draft. The tool lists the group's subscriptions first and refuses client-side, naming the specific products that block the delete, rather than letting Apple return a bare 409. " +
        'A group that has ever held an approved subscription can never be deleted — leave it; an unused group is invisible to customers and costs nothing.',
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
      }),
    },
    async ({ groupId }) => {
      let children: Array<{ id: string; name?: string; state?: string }> = [];
      try {
        const res = await client.request<{
          data?: Array<{ id: string; attributes?: { name?: string; state?: string } }>;
        }>(
          `/v1/subscriptionGroups/${encodeURIComponent(groupId)}/subscriptions?fields[subscriptions]=name,state&limit=200`,
        );
        children = (res.data ?? []).map((sub) => ({
          id: sub.id,
          ...(sub.attributes?.name !== undefined ? { name: sub.attributes.name } : {}),
          ...(sub.attributes?.state !== undefined ? { state: sub.attributes.state } : {}),
        }));
      } catch {
        // Non-fatal: if the child listing fails the gate can't run, so fall
        // through and let Apple answer. Never block on a failed pre-check.
        children = [];
      }
      const gate = evaluateSubscriptionGroupDeleteGate(children);
      if (!gate.allow) {
        const rows = gate.blockingSubscriptions
          .map((sub) => `  - ${sub.name ?? '(unnamed)'} [${sub.state ?? '?'}] id=${sub.id}`)
          .join('\n');
        return {
          content: [
            {
              type: 'text',
              text: [
                'Refused: SubscriptionGroup DELETE blocked by its contents.',
                '',
                `Reason: ${gate.reason ?? ''}`,
                '',
                'Blocking subscriptions:',
                rows,
                '',
                `Next:   ${gate.next ?? ''}`,
              ].join('\n'),
            },
          ],
          isError: true,
        };
      }
      try {
        await client.request<unknown>(`/v1/subscriptionGroups/${encodeURIComponent(groupId)}`, {
          method: 'DELETE',
        });
        return {
          content: [{ type: 'text', text: `Deleted SubscriptionGroup ${groupId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Subscriptions: get / create / patch / delete -----

  server.registerTool(
    'asc_get_subscription',
    {
      title: 'Get a subscription',
      description:
        'Fetch a single auto-renewable Subscription by ID. Returns name (internal), productId, subscriptionPeriod, state, groupLevel, familySharable. The customer-facing name and description live on the subscription localizations (asc_list_subscription_localizations).',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
      }),
    },
    async ({ subscriptionId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription',
    {
      title: 'Create a subscription',
      description:
        'Create an auto-renewable Subscription inside an existing group. Required: groupId + name + productId. ' +
        '** productId is PERMANENT. ** It is the StoreKit product identifier the app requests and every receipt keys off it; it cannot be changed later and cannot be reused on this account even after the subscription is deleted. Pick the final reverse-DNS string now (e.g. "com.example.app.pro.monthly"). ' +
        'name is INTERNAL ONLY — customers see the per-locale copy from asc_post_subscription_localization instead. ' +
        "subscriptionPeriod is optional at create (Apple allows setting it later) but required before the product can be submitted for review. groupLevel defaults to Apple's own choice when omitted; 1 is the highest service tier. " +
        'A newly created subscription is in MISSING_METADATA and is NOT purchasable. To finish it: asc_post_subscription_localization (name + description per locale) -> asc_post_subscription_price (per territory) -> asc_post_subscription_availability (territories) -> asc_upload_subscription_review_screenshot -> asc_post_subscription_submission.',
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
        name: SubscriptionNameSchema,
        productId: ProductIdSchema,
        subscriptionPeriod: SubscriptionPeriodSchema.optional(),
        familySharable: SubscriptionFamilySharableSchema.optional(),
        reviewNote: SubscriptionReviewNoteSchema.optional(),
        groupLevel: SubscriptionGroupLevelSchema.optional(),
      }),
    },
    async (input) => {
      const body = buildSubscriptionCreateBody({
        groupId: input.groupId,
        name: input.name,
        productId: input.productId,
        ...(input.subscriptionPeriod !== undefined
          ? { subscriptionPeriod: input.subscriptionPeriod }
          : {}),
        ...(input.familySharable !== undefined ? { familySharable: input.familySharable } : {}),
        ...(input.reviewNote !== undefined ? { reviewNote: input.reviewNote } : {}),
        ...(input.groupLevel !== undefined ? { groupLevel: input.groupLevel } : {}),
      });
      try {
        const data = await client.request<{ data?: { id?: string } }>('/v1/subscriptions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const newId = data?.data?.id;
        return {
          content: [
            {
              type: 'text',
              text:
                `Created Subscription "${input.name}" (productId ${input.productId}) in group ${input.groupId}${newId ? ` (id ${newId})` : ''}.\n\n` +
                'It starts in MISSING_METADATA and is not purchasable yet. Remaining steps: subscription localization (customer-facing copy), price per territory, availability, review screenshot, then submission.\n\n' +
                `${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription',
    {
      title: 'Patch a subscription',
      description:
        'Update the mutable attributes of a Subscription: name (internal), subscriptionPeriod, familySharable, reviewNote, groupLevel. Pass only what changes; the tool refuses an empty PATCH. ' +
        '** productId is NOT patchable ** and the tool has no codepath that sends it — the identifier is fixed for the life of the product. ' +
        'Apple locks most of these once the subscription has been approved: expect a 409 when changing the period or turning familySharable OFF on a live product (turning it ON is allowed). Errors surface verbatim.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        name: SubscriptionNameSchema.optional(),
        subscriptionPeriod: SubscriptionPeriodSchema.optional(),
        familySharable: SubscriptionFamilySharableSchema.optional(),
        reviewNote: SubscriptionReviewNoteSchema.optional(),
        groupLevel: SubscriptionGroupLevelSchema.optional(),
      }),
    },
    async (input) => {
      if (
        input.name === undefined &&
        input.subscriptionPeriod === undefined &&
        input.familySharable === undefined &&
        input.reviewNote === undefined &&
        input.groupLevel === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of name / subscriptionPeriod / familySharable / reviewNote / groupLevel. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildSubscriptionPatchBody({
        subscriptionId: input.subscriptionId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.subscriptionPeriod !== undefined
          ? { subscriptionPeriod: input.subscriptionPeriod }
          : {}),
        ...(input.familySharable !== undefined ? { familySharable: input.familySharable } : {}),
        ...(input.reviewNote !== undefined ? { reviewNote: input.reviewNote } : {}),
        ...(input.groupLevel !== undefined ? { groupLevel: input.groupLevel } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched Subscription ${input.subscriptionId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_subscription',
    {
      title: 'Delete a subscription',
      description:
        'DELETE an auto-renewable Subscription. Only draft products can be deleted (MISSING_METADATA / READY_TO_SUBMIT / DEVELOPER_ACTION_NEEDED / REJECTED). The tool pre-checks the state with one GET and refuses client-side for products under review or already approved. ' +
        '** Deleting does not free the productId ** — Apple never allows a product identifier to be reused on an account, even for a deleted draft. ' +
        'To stop selling an APPROVED subscription, reduce its territories with asc_post_subscription_availability instead; existing subscribers continue to renew regardless.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
      }),
    },
    async ({ subscriptionId }) => {
      let state: string | undefined;
      try {
        const res = await client.request<{ data?: { attributes?: { state?: string } } }>(
          `/v1/subscriptions/${encodeURIComponent(subscriptionId)}?fields[subscriptions]=state`,
        );
        state = res.data?.attributes?.state;
      } catch {
        // Non-fatal: unknown state falls through to Apple's own judgement.
        state = undefined;
      }
      const gate = evaluateSubscriptionDeleteGate(state);
      if (!gate.allow) {
        return {
          content: [
            {
              type: 'text',
              text: [
                'Refused: Subscription DELETE blocked by current state.',
                '',
                `State:  ${gate.state ?? '(unknown)'}`,
                `Reason: ${gate.reason ?? ''}`,
                '',
                `Next:   ${gate.next ?? ''}`,
              ].join('\n'),
            },
          ],
          isError: true,
        };
      }
      try {
        await client.request<unknown>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
          method: 'DELETE',
        });
        return {
          content: [
            {
              type: 'text',
              text: `Deleted Subscription ${subscriptionId}. Note: its productId remains permanently reserved on this account and cannot be reused.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
