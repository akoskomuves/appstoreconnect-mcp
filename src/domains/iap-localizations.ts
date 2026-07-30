import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestIapLocalizations } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  IapLocalizationDescriptionSchema,
  IapLocalizationNameSchema,
  InAppPurchaseIdSchema,
  InAppPurchaseLocalizationIdSchema,
  LocaleSchema,
} from '../schemas.js';

// InAppPurchaseLocalization carries the customer-facing name + description
// Apple shows in the App Store under an IAP product, per locale. Same
// structural shape as SubscriptionLocalization — only the parent
// relationship differs: this resource hangs off the v2 IAP surface via
// `inAppPurchaseV2`, not the legacy v1 IAP surface (which this project does
// not support — see iap.ts).
//
// Apple's caps (from public docs):
//   - name: 30 characters per locale
//   - description: 45 characters per locale
//
// Server-side `state` attribute: PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW
// / APPROVED / REJECTED. Read-only; reflects Apple-side review status.
//
// Wire-key relationship note: the parent rel is named `inAppPurchaseV2` on
// the wire (not `inAppPurchase` or `iap`) and points at the v2 IAP resource
// type `inAppPurchases` — the resource type does NOT carry the V2 suffix
// even though the relationship key does.

const IAP_LOCALIZATION_FIELDS = 'name,locale,description,state';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface IapLocalizationCreateInput {
  iapId: string;
  name: string;
  locale: string;
  description?: string | undefined;
}

export function buildIapLocalizationCreateBody(input: IapLocalizationCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    name: input.name,
    locale: input.locale,
  };
  if (input.description !== undefined) attributes.description = input.description;
  return {
    data: {
      type: 'inAppPurchaseLocalizations',
      attributes,
      relationships: {
        // Wire-key gotcha: the relationship name is `inAppPurchaseV2`
        // (with V2 suffix), but the resource type it points at is
        // `inAppPurchases` (no V2). Don't conflate them.
        inAppPurchaseV2: {
          data: { type: 'inAppPurchases', id: input.iapId },
        },
      },
    },
  };
}

export interface IapLocalizationPatchInput {
  iapLocalizationId: string;
  name?: string | undefined;
  description?: string | undefined;
}

export function buildIapLocalizationPatchBody(input: IapLocalizationPatchInput): JSONAPIBody {
  // Apple's InAppPurchaseLocalizationUpdateRequest accepts only name +
  // description. Locale is immutable; state is server-managed.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.description !== undefined) attributes.description = input.description;
  return {
    data: {
      type: 'inAppPurchaseLocalizations',
      id: input.iapLocalizationId,
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

export function registerIapLocalizations(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_iap_localizations',
    {
      title: 'List IAP localizations',
      description:
        "List InAppPurchaseLocalizations under an IAP. Each row carries locale + name + description + state. v2 IAPs only — legacy v1 IAPs aren't supported on this surface. Use asc_list_iaps to find an IAP ID first.",
      inputSchema: z.object({
        iapId: InAppPurchaseIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ iapId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[inAppPurchaseLocalizations]', IAP_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      // The list path comes off the v2 IAP resource at
      // /v2/inAppPurchases/{id}/inAppPurchaseLocalizations.
      const path = `/v2/inAppPurchases/${encodeURIComponent(
        iapId,
      )}/inAppPurchaseLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestIapLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_iap_localization',
    {
      title: 'Get an IAP localization',
      description:
        'Fetch a single InAppPurchaseLocalization by ID. Returns name + description + locale + state.',
      inputSchema: z.object({
        iapLocalizationId: InAppPurchaseLocalizationIdSchema,
      }),
    },
    async ({ iapLocalizationId }) => {
      const path = `/v1/inAppPurchaseLocalizations/${encodeURIComponent(iapLocalizationId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_iap_localization',
    {
      title: 'Create an IAP localization',
      description:
        'Create an InAppPurchaseLocalization for ONE v2 IAP + ONE locale. Required: iapId (v2 IAP only — legacy v1 not supported) + name (30 chars) + locale. Optional: description (45 chars). (IAP, locale) must be unique. Locale immutable post-create.',
      inputSchema: z.object({
        iapId: InAppPurchaseIdSchema,
        name: IapLocalizationNameSchema,
        locale: LocaleSchema,
        description: IapLocalizationDescriptionSchema.optional(),
      }),
    },
    async (input) => {
      const body = buildIapLocalizationCreateBody({
        iapId: input.iapId,
        name: input.name,
        locale: input.locale,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/inAppPurchaseLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created InAppPurchaseLocalization (iap ${input.iapId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_iap_localization',
    {
      title: 'Patch an IAP localization',
      description:
        'Update name and/or description on an existing InAppPurchaseLocalization. Both optional (encodeIfPresent). Locale immutable; state server-managed. Tool refuses empty PATCH. ' +
        '** PARENT-STATE GATE (likely): ** Same structural pattern as SubscriptionLocalization — Apple likely locks name/description while the parent IAP is WAITING_FOR_REVIEW or APPROVED. If Apple returns STATE_ERROR "cannot be edited at this time", that\'s the cause. Constraint not yet pre-checked client-side (deferred to a future patch once verified live).',
      inputSchema: z.object({
        iapLocalizationId: InAppPurchaseLocalizationIdSchema,
        name: IapLocalizationNameSchema.optional(),
        description: IapLocalizationDescriptionSchema.optional(),
      }),
    },
    async (input) => {
      if (input.name === undefined && input.description === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of name / description. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildIapLocalizationPatchBody({
        iapLocalizationId: input.iapLocalizationId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/inAppPurchaseLocalizations/${encodeURIComponent(input.iapLocalizationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched InAppPurchaseLocalization ${input.iapLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_iap_localization',
    {
      title: 'Delete an IAP localization',
      description:
        'DELETE an InAppPurchaseLocalization. The locale-specific copy is removed; customers in that locale fall back to the default. Apple may reject if the IAP is in a state that locks localizations.',
      inputSchema: z.object({
        iapLocalizationId: InAppPurchaseLocalizationIdSchema,
      }),
    },
    async ({ iapLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/inAppPurchaseLocalizations/${encodeURIComponent(iapLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted InAppPurchaseLocalization ${iapLocalizationId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
