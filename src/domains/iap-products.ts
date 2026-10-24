import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ascErrorText } from '../errors.js';
import { AppIdSchema, InAppPurchaseIdSchema } from '../schemas.js';

// In-app purchase CREATE / PATCH / DELETE (POST /v2/inAppPurchases,
// PATCH + DELETE /v2/inAppPurchases/{id}). ppp could read, price, localize and
// submit an IAP, but every one of those tools assumed the product already
// existed — the same gap subscriptions had before 1.12.
//
// Contract (spec 4.5.1):
//   * Create requires productId + name + inAppPurchaseType and the `app`
//     relationship; reviewNote + familySharable are optional.
//   * productId and inAppPurchaseType are absent from InAppPurchaseV2UpdateRequest
//     — both are fixed for the life of the product. productId can never be
//     reused on the account, even after a delete.
//   * name, reviewNote and familySharable are `nullable: true` on PATCH.
//
// The delete gate mirrors the subscription one: Apple refuses a delete once a
// product is under review or has ever been approved, and the refusal is a bare
// 409, so the tool says why and what to do instead.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export const InAppPurchaseTypeSchema = z
  .enum(['CONSUMABLE', 'NON_CONSUMABLE', 'NON_RENEWING_SUBSCRIPTION'])
  .describe(
    'IAP type, fixed at create: CONSUMABLE (can be bought again, e.g. coins), NON_CONSUMABLE (bought once, e.g. unlock), NON_RENEWING_SUBSCRIPTION (time-limited access you manage yourself). Auto-renewable subscriptions are NOT IAPs here — use asc_post_subscription.',
  );

const IapProductIdSchema = z
  .string()
  .min(1)
  .describe(
    'StoreKit product identifier (reverse-DNS, e.g. "com.example.app.coins100"). PERMANENT: it cannot be changed after create and cannot be reused on this account even after the IAP is deleted.',
  );

const IapNameSchema = z
  .string()
  .min(1)
  .describe(
    'Internal reference name — not shown to customers (the customer-facing name is the IAP localization).',
  );

const IapReviewNoteSchema = z.string().min(1).describe('Notes for App Review about this IAP.');

const IapFamilySharableSchema = z
  .boolean()
  .describe('Allow Family Sharing. Apple lets you turn it ON for a live product but not back OFF.');

export interface IapCreateInput {
  appId: string;
  productId: string;
  name: string;
  inAppPurchaseType: 'CONSUMABLE' | 'NON_CONSUMABLE' | 'NON_RENEWING_SUBSCRIPTION';
  reviewNote?: string | undefined;
  familySharable?: boolean | undefined;
}

export function buildIapCreateBody(input: IapCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    name: input.name,
    productId: input.productId,
    inAppPurchaseType: input.inAppPurchaseType,
  };
  if (input.reviewNote !== undefined) attributes.reviewNote = input.reviewNote;
  if (input.familySharable !== undefined) attributes.familySharable = input.familySharable;
  return {
    data: {
      type: 'inAppPurchases',
      attributes,
      relationships: { app: { data: { type: 'apps', id: input.appId } } },
    },
  };
}

export interface IapPatchInput {
  iapId: string;
  name?: string | null | undefined;
  reviewNote?: string | null | undefined;
  familySharable?: boolean | null | undefined;
}

export function buildIapPatchBody(input: IapPatchInput): JSONAPIBody {
  // productId / inAppPurchaseType are not in the update contract; there is no
  // codepath that sends them. null is passed through: it clears the field.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.reviewNote !== undefined) attributes.reviewNote = input.reviewNote;
  if (input.familySharable !== undefined) attributes.familySharable = input.familySharable;
  return { data: { type: 'inAppPurchases', id: input.iapId, attributes } };
}

// InAppPurchaseState (spec 4.5.1) adds WAITING_FOR_UPLOAD / PROCESSING_CONTENT
// (hosted content) to the subscription states; those are still drafts.
const IAP_UNDER_REVIEW_STATES = new Set([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_BINARY_APPROVAL',
]);
const IAP_SHIPPED_STATES = new Set([
  'APPROVED',
  'DEVELOPER_REMOVED_FROM_SALE',
  'REMOVED_FROM_SALE',
]);

export interface IapDeleteGateResult {
  allow: boolean;
  state: string | undefined;
  reason?: string;
  next?: string;
}

export function evaluateIapDeleteGate(state: string | undefined): IapDeleteGateResult {
  // Unknown state passes through — a failed pre-check never blocks a delete
  // Apple would accept.
  if (!state) return { allow: true, state };
  if (IAP_UNDER_REVIEW_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `the in-app purchase is in ${state} — Apple holds the record while a review is open`,
      next: 'Wait for review to finish, or remove it from the review submission, then retry.',
    };
  }
  if (IAP_SHIPPED_STATES.has(state)) {
    return {
      allow: false,
      state,
      reason: `the in-app purchase is in ${state} — it has been approved, so customers may own it`,
      next: 'An approved IAP cannot be deleted and its productId can never be reused. To stop selling it, reduce its territories with asc_post_iap_availability.',
    };
  }
  return { allow: true, state };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: ascErrorText(err) }],
  isError: true,
});

export function registerIapProducts(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_post_iap',
    {
      title: 'Create an in-app purchase',
      description:
        'POST /v2/inAppPurchases — create a consumable, non-consumable or non-renewing-subscription IAP on an app. Required: appId + productId + name + inAppPurchaseType. ** productId is PERMANENT ** and can never be reused on the account, even after a delete. name is internal only. A new IAP starts in MISSING_METADATA and is not purchasable. To finish it: asc_post_iap_localization → asc_post_iap_price_schedule → asc_post_iap_availability → asc_upload_iap_review_screenshot → asc_post_iap_submission.',
      inputSchema: z.object({
        appId: AppIdSchema,
        productId: IapProductIdSchema,
        name: IapNameSchema,
        inAppPurchaseType: InAppPurchaseTypeSchema,
        reviewNote: IapReviewNoteSchema.optional(),
        familySharable: IapFamilySharableSchema.optional(),
      }),
    },
    async (input) => {
      try {
        const data = await client.request<{ data?: { id?: string } }>('/v2/inAppPurchases', {
          method: 'POST',
          body: JSON.stringify(buildIapCreateBody(input)),
        });
        const id = data?.data?.id;
        return {
          content: [
            {
              type: 'text',
              text: `Created ${input.inAppPurchaseType} IAP "${input.name}" (productId ${input.productId})${id ? ` — id ${id}` : ''}. It starts in MISSING_METADATA: add a localization, price, availability and review screenshot before submitting.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_iap',
    {
      title: 'Update an in-app purchase',
      description:
        'PATCH /v2/inAppPurchases/{id} — name (internal), reviewNote, familySharable. Pass null to clear a field. productId and inAppPurchaseType are immutable and never sent. Apple refuses turning familySharable OFF on a live product.',
      inputSchema: z.object({
        iapId: InAppPurchaseIdSchema,
        name: IapNameSchema.nullable().optional(),
        reviewNote: IapReviewNoteSchema.nullable().optional(),
        familySharable: IapFamilySharableSchema.nullable().optional(),
      }),
    },
    async (input) => {
      if (
        input.name === undefined &&
        input.reviewNote === undefined &&
        input.familySharable === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of name, reviewNote, familySharable.',
            },
          ],
          isError: true,
        };
      }
      try {
        const data = await client.request<unknown>(
          `/v2/inAppPurchases/${encodeURIComponent(input.iapId)}`,
          { method: 'PATCH', body: JSON.stringify(buildIapPatchBody(input)) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Updated IAP ${input.iapId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_iap',
    {
      title: 'Delete an in-app purchase',
      description:
        "DELETE /v2/inAppPurchases/{id}. Only drafts can be deleted; the tool reads the state first and refuses for IAPs under review or ever approved. Deleting does NOT free the productId. To stop selling an approved IAP use asc_post_iap_availability. force:true skips the pre-check and lets Apple decide (the shipped-state gate is inferred from Apple's documented states).",
      inputSchema: z.object({
        iapId: InAppPurchaseIdSchema,
        force: z
          .boolean()
          .default(false)
          .describe('Skip the state pre-check and send the DELETE anyway.'),
      }),
    },
    async ({ iapId, force }) => {
      let state: string | undefined;
      let precheckFailed = false;
      if (!force) {
        try {
          const res = await client.request<{ data?: { attributes?: { state?: string } } }>(
            `/v2/inAppPurchases/${encodeURIComponent(iapId)}?fields[inAppPurchases]=state`,
          );
          state = res.data?.attributes?.state;
        } catch {
          precheckFailed = true;
        }
      }
      const gate = force ? { allow: true, state: undefined } : evaluateIapDeleteGate(state);
      if (!gate.allow) {
        return {
          content: [
            {
              type: 'text',
              text: [
                'Refused: IAP DELETE blocked by current state.',
                '',
                `State:  ${gate.state ?? '(unknown)'}`,
                `Reason: ${'reason' in gate ? gate.reason : ''}`,
                '',
                `Next:   ${'next' in gate ? gate.next : ''}`,
                '',
                'If you believe Apple would accept this delete, retry with force:true.',
              ].join('\n'),
            },
          ],
          isError: true,
        };
      }
      try {
        await client.request<unknown>(`/v2/inAppPurchases/${encodeURIComponent(iapId)}`, {
          method: 'DELETE',
        });
        const note = precheckFailed
          ? 'Note: the state pre-check could not run, so this DELETE went out unguarded.\n\n'
          : '';
        return { content: [{ type: 'text', text: `${note}Deleted IAP ${iapId}.` }] };
      } catch (err) {
        return fail(err);
      }
    },
  );
}
