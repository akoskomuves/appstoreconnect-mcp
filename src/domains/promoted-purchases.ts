import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestPromotedPurchases } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  InAppPurchaseIdSchema,
  PromotedPurchaseEnabledSchema,
  PromotedPurchaseIdSchema,
  PromotedPurchaseVisibleForAllUsersSchema,
  SubscriptionIdSchema,
} from '../schemas.js';

// PromotedPurchase wire shape:
//
//   * PromotedPurchaseCreateRequest: required attrs = { isVisibleForAllUsers }.
//     Optional attrs = { isEnabled }. Required relationship = app.
//     Optional one-of: inAppPurchaseV2 OR subscription (the IAP / sub being
//     promoted). WIRE-KEY GOTCHAS — same is-prefix-strip family as v0.13
//     AppCustomProductPage.isVisible:
//       - Swift `isVisibleForAllUsers` → wire `visibleForAllUsers`
//       - Swift `isEnabled` → wire `enabled`
//
//   * PromotedPurchaseUpdateRequest: optional attrs = { isVisibleForAllUsers,
//     isEnabled } (same wire-key strips). Refuses empty PATCH.
//
//   * AppPromotedPurchasesLinkagesRequest: per-app ORDERING surface.
//     PATCH /v1/apps/{id}/relationships/promotedPurchases with
//     { data: [{ type: "promotedPurchases", id }] }. Apple uses the ARRAY
//     ORDER to set the storefront display order — the order in the array IS
//     the displayed order. Send the full ordered list, not deltas.
//
//   * State machine on PromotedPurchase: PREPARE_FOR_SUBMISSION / IN_REVIEW /
//     APPROVED / REJECTED (4 values, shorter than CPP / AppEvent / AppInfo).
//     State is server-managed; no client mutation. Apple may reject writes
//     while IN_REVIEW.

const PROMOTED_PURCHASE_FIELDS = 'visibleForAllUsers,enabled,state';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface PromotedPurchaseCreateInput {
  appId: string;
  visibleForAllUsers: boolean;
  enabled?: boolean | undefined;
  inAppPurchaseV2Id?: string | undefined;
  subscriptionId?: string | undefined;
}

export function buildPromotedPurchaseCreateBody(input: PromotedPurchaseCreateInput): JSONAPIBody {
  // Wire-key gotcha: Swift `isVisibleForAllUsers` / `isEnabled` → wire
  // `visibleForAllUsers` / `enabled`. Emit the short forms only.
  const attributes: Record<string, unknown> = {
    visibleForAllUsers: input.visibleForAllUsers,
  };
  if (input.enabled !== undefined) attributes.enabled = input.enabled;
  const relationships: Record<string, unknown> = {
    app: { data: { type: 'apps', id: input.appId } },
  };
  if (input.inAppPurchaseV2Id !== undefined) {
    relationships.inAppPurchaseV2 = {
      data: { type: 'inAppPurchases', id: input.inAppPurchaseV2Id },
    };
  }
  if (input.subscriptionId !== undefined) {
    relationships.subscription = {
      data: { type: 'subscriptions', id: input.subscriptionId },
    };
  }
  return {
    data: {
      type: 'promotedPurchases',
      attributes,
      relationships,
    },
  };
}

export interface PromotedPurchasePatchInput {
  promotedPurchaseId: string;
  visibleForAllUsers?: boolean | undefined;
  enabled?: boolean | undefined;
}

export function buildPromotedPurchasePatchBody(input: PromotedPurchasePatchInput): JSONAPIBody {
  // Same wire-key strips as create.
  const attributes: Record<string, unknown> = {};
  if (input.visibleForAllUsers !== undefined) {
    attributes.visibleForAllUsers = input.visibleForAllUsers;
  }
  if (input.enabled !== undefined) attributes.enabled = input.enabled;
  return {
    data: {
      type: 'promotedPurchases',
      id: input.promotedPurchaseId,
      attributes,
    },
  };
}

export interface PromotedPurchasesOrderInput {
  promotedPurchaseIds: string[];
}

export function buildPromotedPurchasesOrderBody(input: PromotedPurchasesOrderInput): {
  data: Array<{ type: string; id: string }>;
} {
  // Linkages PATCH body: bare array under `data`, no envelope wrapper.
  // The order in the array IS the storefront display order.
  return {
    data: input.promotedPurchaseIds.map((id) => ({ type: 'promotedPurchases', id })),
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

export function registerPromotedPurchases(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_promoted_purchases',
    {
      title: 'List Promoted Purchases for an app',
      description:
        'List PromotedPurchase records under an app. Each row carries the visibleForAllUsers flag, enabled flag, current state (PREPARE_FOR_SUBMISSION / IN_REVIEW / APPROVED / REJECTED), the linked IAP / subscription ID, and the promoted-purchase ID. Use to inspect which promotions exist before patching, reordering, or deleting.',
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[promotedPurchases]', PROMOTED_PURCHASE_FIELDS);
      params.set('limit', '200');
      params.set('include', 'inAppPurchaseV2,subscription');
      const path = `/v1/apps/${encodeURIComponent(appId)}/promotedPurchases?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestPromotedPurchases(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_promoted_purchase',
    {
      title: 'Get a PromotedPurchase',
      description:
        'Fetch a single PromotedPurchase by ID with its linked IAP / subscription expanded. Returns visibleForAllUsers + enabled + state + the relationship info for the promoted item.',
      inputSchema: z.object({
        promotedPurchaseId: PromotedPurchaseIdSchema,
      }),
    },
    async ({ promotedPurchaseId }) => {
      const path = `/v1/promotedPurchases/${encodeURIComponent(promotedPurchaseId)}?include=inAppPurchaseV2,subscription`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_promoted_purchase',
    {
      title: 'Create a PromotedPurchase',
      description:
        'Create a PromotedPurchase on an app, linking it to ONE IAP (inAppPurchaseV2Id) OR ONE subscription (subscriptionId) — pass exactly one. Required: appId + visibleForAllUsers. Optional: enabled. Wire-key gotchas: Swift `isVisibleForAllUsers` / `isEnabled` → wire `visibleForAllUsers` / `enabled` (same is-prefix-strip family as v0.13 AppCustomProductPage.isVisible). New promoted purchases land in PREPARE_FOR_SUBMISSION.',
      inputSchema: z.object({
        appId: AppIdSchema,
        visibleForAllUsers: PromotedPurchaseVisibleForAllUsersSchema,
        enabled: PromotedPurchaseEnabledSchema.optional(),
        inAppPurchaseV2Id: InAppPurchaseIdSchema.optional(),
        subscriptionId: SubscriptionIdSchema.optional(),
      }),
    },
    async (input) => {
      if (input.inAppPurchaseV2Id === undefined && input.subscriptionId === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass exactly one of inAppPurchaseV2Id or subscriptionId — a PromotedPurchase must link to one IAP / subscription.',
            },
          ],
          isError: true,
        };
      }
      if (input.inAppPurchaseV2Id !== undefined && input.subscriptionId !== undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass ONLY ONE of inAppPurchaseV2Id or subscriptionId — Apple rejects PromotedPurchase create with both relationships set.',
            },
          ],
          isError: true,
        };
      }
      const body = buildPromotedPurchaseCreateBody({
        appId: input.appId,
        visibleForAllUsers: input.visibleForAllUsers,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.inAppPurchaseV2Id !== undefined
          ? { inAppPurchaseV2Id: input.inAppPurchaseV2Id }
          : {}),
        ...(input.subscriptionId !== undefined ? { subscriptionId: input.subscriptionId } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/promotedPurchases', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created PromotedPurchase on app ${input.appId} (visibleForAllUsers=${input.visibleForAllUsers}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_promoted_purchase',
    {
      title: 'Patch a PromotedPurchase (visibility / enabled)',
      description:
        'Update visibleForAllUsers and/or enabled on an existing PromotedPurchase. Wire-key gotchas: Swift `isVisibleForAllUsers` / `isEnabled` → wire `visibleForAllUsers` / `enabled`. Toggle enabled=false to retire a promotion without deleting the linkage. Tool refuses empty PATCH.',
      inputSchema: z.object({
        promotedPurchaseId: PromotedPurchaseIdSchema,
        visibleForAllUsers: PromotedPurchaseVisibleForAllUsersSchema.optional(),
        enabled: PromotedPurchaseEnabledSchema.optional(),
      }),
    },
    async (input) => {
      if (input.visibleForAllUsers === undefined && input.enabled === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of visibleForAllUsers or enabled. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildPromotedPurchasePatchBody({
        promotedPurchaseId: input.promotedPurchaseId,
        ...(input.visibleForAllUsers !== undefined
          ? { visibleForAllUsers: input.visibleForAllUsers }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/promotedPurchases/${encodeURIComponent(input.promotedPurchaseId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched PromotedPurchase ${input.promotedPurchaseId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_promoted_purchase',
    {
      title: 'Delete a PromotedPurchase',
      description:
        'DELETE a PromotedPurchase. Removes the IAP / subscription from the promoted slots on the storefront. The underlying IAP / subscription is NOT deleted — only the promotion linkage.',
      inputSchema: z.object({
        promotedPurchaseId: PromotedPurchaseIdSchema,
      }),
    },
    async ({ promotedPurchaseId }) => {
      try {
        await client.request<unknown>(
          `/v1/promotedPurchases/${encodeURIComponent(promotedPurchaseId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [{ type: 'text', text: `Deleted PromotedPurchase ${promotedPurchaseId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_promoted_purchases_order',
    {
      title: "Set the storefront display order of an app's Promoted Purchases",
      description:
        'PATCH /v1/apps/{id}/relationships/promotedPurchases with the ordered list of promoted-purchase IDs. The order in the array IS the storefront display order — slot 1 is the first ID, slot 2 the second, etc. Send the FULL ordered list; Apple replaces the entire ordering. Use asc_list_promoted_purchases to enumerate current IDs first.',
      inputSchema: z.object({
        appId: AppIdSchema,
        promotedPurchaseIds: z
          .array(PromotedPurchaseIdSchema)
          .min(1)
          .describe(
            'Full ordered list of PromotedPurchase IDs. Position 0 is storefront slot 1, position 1 is slot 2, and so on. Apple replaces the entire ordering on this call — partial / delta updates are not supported by this endpoint.',
          ),
      }),
    },
    async ({ appId, promotedPurchaseIds }) => {
      const body = buildPromotedPurchasesOrderBody({ promotedPurchaseIds });
      try {
        const data = await client.request<unknown>(
          `/v1/apps/${encodeURIComponent(appId)}/relationships/promotedPurchases`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Set PromotedPurchases display order on app ${appId} (${promotedPurchaseIds.length} positions).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
