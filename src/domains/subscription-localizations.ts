import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestSubscriptionLocalizations } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  LocaleSchema,
  SubscriptionIdSchema,
  SubscriptionLocalizationDescriptionSchema,
  SubscriptionLocalizationIdSchema,
  SubscriptionLocalizationNameSchema,
} from '../schemas.js';

// SubscriptionLocalization carries the customer-facing name + description
// Apple shows in the App Store under a subscription product, per locale.
// One record per (subscription, locale).
//
// Apple's caps (from public docs, not the Swift SDK):
//   - name: 30 characters per locale (capped tighter than app-version
//     description because it sits next to a price in tight UI)
//   - description: 45 characters per locale (one-sentence value prop)
//
// The resource has a server-side `state` attribute:
//   PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED
// — read-only, set by Apple as the localization moves through review with
// the parent subscription. Cannot be patched.
//
// Mutability:
//   - At CREATE: name + locale required; description optional.
//   - At PATCH: name + description mutable; locale immutable (lookup key).
//
// Same wire shape as InAppPurchaseLocalization — only the parent rel
// differs (`subscription` vs `inAppPurchaseV2`).

const SUBSCRIPTION_LOCALIZATION_FIELDS = 'name,locale,description,state';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface SubscriptionLocalizationCreateInput {
  subscriptionId: string;
  name: string;
  locale: string;
  description?: string | undefined;
}

export function buildSubscriptionLocalizationCreateBody(
  input: SubscriptionLocalizationCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    name: input.name,
    locale: input.locale,
  };
  if (input.description !== undefined) attributes.description = input.description;
  return {
    data: {
      type: 'subscriptionLocalizations',
      attributes,
      relationships: {
        subscription: {
          data: { type: 'subscriptions', id: input.subscriptionId },
        },
      },
    },
  };
}

export interface SubscriptionLocalizationPatchInput {
  subscriptionLocalizationId: string;
  name?: string | undefined;
  description?: string | undefined;
}

export function buildSubscriptionLocalizationPatchBody(
  input: SubscriptionLocalizationPatchInput,
): JSONAPIBody {
  // Apple's SubscriptionLocalizationUpdateRequest accepts only name +
  // description. Locale is immutable; state is server-managed.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.description !== undefined) attributes.description = input.description;
  return {
    data: {
      type: 'subscriptionLocalizations',
      id: input.subscriptionLocalizationId,
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

export function registerSubscriptionLocalizations(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_localizations',
    {
      title: 'List subscription localizations',
      description:
        'List SubscriptionLocalizations under a subscription. Each row carries locale + name + description + state (PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED). Use to see which locales already have copy before adding more.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptionLocalizations]', SUBSCRIPTION_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/subscriptionLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestSubscriptionLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_subscription_localization',
    {
      title: 'Get a subscription localization',
      description:
        'Fetch a single SubscriptionLocalization by ID. Returns name + description + locale + state.',
      inputSchema: z.object({
        subscriptionLocalizationId: SubscriptionLocalizationIdSchema,
      }),
    },
    async ({ subscriptionLocalizationId }) => {
      const path = `/v1/subscriptionLocalizations/${encodeURIComponent(
        subscriptionLocalizationId,
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
    'asc_post_subscription_localization',
    {
      title: 'Create a subscription localization',
      description:
        'Create a SubscriptionLocalization for ONE subscription + ONE locale. Required: subscriptionId + name (30 chars max) + locale. Optional: description (45 chars max). The (subscription, locale) pair must be unique. Locale is immutable post-create.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        name: SubscriptionLocalizationNameSchema,
        locale: LocaleSchema,
        description: SubscriptionLocalizationDescriptionSchema.optional(),
      }),
    },
    async (input) => {
      const body = buildSubscriptionLocalizationCreateBody({
        subscriptionId: input.subscriptionId,
        name: input.name,
        locale: input.locale,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/subscriptionLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created SubscriptionLocalization (subscription ${input.subscriptionId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription_localization',
    {
      title: 'Patch a subscription localization',
      description:
        'Update name and/or description on an existing SubscriptionLocalization. Both optional (encodeIfPresent). Locale is immutable; state is server-managed and rejected from PATCH bodies. Tool refuses empty PATCH. ' +
        '** PARENT-STATE GATE (likely): ** SubscriptionLocalization\'s state attribute walks PREPARE_FOR_SUBMISSION → WAITING_FOR_REVIEW → APPROVED. Apple\'s pattern across localization resources is to lock name/description while the parent subscription is in review. If Apple returns a STATE_ERROR "cannot be edited at this time", the subscription is in WAITING_FOR_REVIEW or APPROVED — the constraint is undocumented and not yet pre-checked client-side (deferred to a future patch once verified live).',
      inputSchema: z.object({
        subscriptionLocalizationId: SubscriptionLocalizationIdSchema,
        name: SubscriptionLocalizationNameSchema.optional(),
        description: SubscriptionLocalizationDescriptionSchema.optional(),
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
      const body = buildSubscriptionLocalizationPatchBody({
        subscriptionLocalizationId: input.subscriptionLocalizationId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionLocalizations/${encodeURIComponent(input.subscriptionLocalizationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched SubscriptionLocalization ${input.subscriptionLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_subscription_localization',
    {
      title: 'Delete a subscription localization',
      description:
        'DELETE a SubscriptionLocalization. The locale-specific copy is removed; subscribers in that locale fall back to the default locale. Apple may reject if the subscription is in a state that locks localizations.',
      inputSchema: z.object({
        subscriptionLocalizationId: SubscriptionLocalizationIdSchema,
      }),
    },
    async ({ subscriptionLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/subscriptionLocalizations/${encodeURIComponent(subscriptionLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Deleted SubscriptionLocalization ${subscriptionLocalizationId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
