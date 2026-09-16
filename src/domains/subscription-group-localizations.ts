import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestSubscriptionGroupLocalizations } from '../digest.js';
import { ASCError, ascErrorText } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  LocaleSchema,
  SubscriptionCustomAppNameSchema,
  SubscriptionGroupIdSchema,
  SubscriptionGroupLocalizationIdSchema,
  SubscriptionGroupLocalizationNameSchema,
} from '../schemas.js';

// SubscriptionGroupLocalization is the CUSTOMER-FACING name of a subscription
// group — the heading Apple renders above the plan choices in the App Store
// subscription sheet and in Settings -> Subscriptions. One record per
// (subscriptionGroup, locale).
//
// It is routinely confused with SubscriptionLocalization, so, explicitly:
//
//   SubscriptionGroup.referenceName        internal    "MV Premium (grp)"
//   SubscriptionGroupLocalization.name     CUSTOMER    "MeritValue Premium"
//   Subscription.name                      internal    "MV Analyst Monthly"
//   SubscriptionLocalization.name          CUSTOMER    "Analyst"
//
// A group with no localization in the customer's locale falls back to another
// locale's record; a group with NO localizations at all cannot be submitted.
//
// `customAppName` overrides how the APP's name reads inside that sheet. It is
// optional and almost always left unset — Apple inherits the App Store name.
//
// Attributes at create: name + locale required, customAppName optional.
// At patch: name + customAppName mutable; locale is the immutable lookup key.
// `state` (PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED)
// is server-managed and rejected from write bodies.

const GROUP_LOCALIZATION_FIELDS = 'name,customAppName,locale,state';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface SubscriptionGroupLocalizationCreateInput {
  groupId: string;
  name: string;
  locale: string;
  customAppName?: string | undefined;
}

export function buildSubscriptionGroupLocalizationCreateBody(
  input: SubscriptionGroupLocalizationCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    name: input.name,
    locale: input.locale,
  };
  if (input.customAppName !== undefined) attributes.customAppName = input.customAppName;
  return {
    data: {
      type: 'subscriptionGroupLocalizations',
      attributes,
      relationships: {
        subscriptionGroup: {
          data: { type: 'subscriptionGroups', id: input.groupId },
        },
      },
    },
  };
}

export interface SubscriptionGroupLocalizationPatchInput {
  subscriptionGroupLocalizationId: string;
  name?: string | undefined;
  customAppName?: string | undefined;
}

export function buildSubscriptionGroupLocalizationPatchBody(
  input: SubscriptionGroupLocalizationPatchInput,
): JSONAPIBody {
  // SubscriptionGroupLocalizationUpdateRequest accepts name + customAppName
  // only. Locale is immutable (it is the lookup key for the record) and
  // state is server-managed — neither has a codepath here.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.customAppName !== undefined) attributes.customAppName = input.customAppName;
  return {
    data: {
      type: 'subscriptionGroupLocalizations',
      id: input.subscriptionGroupLocalizationId,
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

export function registerSubscriptionGroupLocalizations(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_group_localizations',
    {
      title: 'List subscription group localizations',
      description:
        'List the customer-facing GROUP display names configured for a subscription group, one row per locale, with state (PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED). Use to see which locales already have a group heading before adding more. Not to be confused with asc_list_subscription_localizations, which is the copy for one product inside the group.',
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ groupId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptionGroupLocalizations]', GROUP_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/subscriptionGroups/${encodeURIComponent(
        groupId,
      )}/subscriptionGroupLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw
          ? JSON.stringify(pages, null, 2)
          : digestSubscriptionGroupLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_subscription_group_localization',
    {
      title: 'Get a subscription group localization',
      description:
        'Fetch a single SubscriptionGroupLocalization by ID. Returns name + customAppName + locale + state.',
      inputSchema: z.object({
        subscriptionGroupLocalizationId: SubscriptionGroupLocalizationIdSchema,
      }),
    },
    async ({ subscriptionGroupLocalizationId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionGroupLocalizations/${encodeURIComponent(
            subscriptionGroupLocalizationId,
          )}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_group_localization',
    {
      title: 'Create a subscription group localization',
      description:
        'Give a subscription group its CUSTOMER-FACING heading for ONE locale. Required: groupId + name + locale. Optional: customAppName (overrides how the app name reads inside the subscription sheet — usually omit it). ' +
        'This is the name customers see above the plan choices in the App Store subscription sheet and in Settings -> Subscriptions, so it should read as a product ("MeritValue Premium"), not as an internal label. ' +
        'The (group, locale) pair must be unique, and locale is immutable afterwards. A group with no localization at all cannot be submitted for review.',
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
        name: SubscriptionGroupLocalizationNameSchema,
        locale: LocaleSchema,
        customAppName: SubscriptionCustomAppNameSchema.optional(),
      }),
    },
    async (input) => {
      const body = buildSubscriptionGroupLocalizationCreateBody({
        groupId: input.groupId,
        name: input.name,
        locale: input.locale,
        ...(input.customAppName !== undefined ? { customAppName: input.customAppName } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/subscriptionGroupLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created SubscriptionGroupLocalization (group ${input.groupId}, locale ${input.locale}, name "${input.name}").\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription_group_localization',
    {
      title: 'Patch a subscription group localization',
      description:
        'Update name and/or customAppName on an existing SubscriptionGroupLocalization. Both optional; the tool refuses an empty PATCH. Locale is immutable and state is server-managed. ' +
        'Apple locks this copy once it is live, the same way it locks SubscriptionLocalization: expect 409 ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE on an approved group whose app is shipping. Unlike the subscription-localization tool there is NO client-side pre-check here, because the constraint has not been confirmed live for this resource — Apple is the authority and its refusal is surfaced with the recovery path.',
      inputSchema: z.object({
        subscriptionGroupLocalizationId: SubscriptionGroupLocalizationIdSchema,
        name: SubscriptionGroupLocalizationNameSchema.optional(),
        customAppName: SubscriptionCustomAppNameSchema.optional(),
      }),
    },
    async (input) => {
      if (input.name === undefined && input.customAppName === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of name / customAppName. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildSubscriptionGroupLocalizationPatchBody({
        subscriptionGroupLocalizationId: input.subscriptionGroupLocalizationId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.customAppName !== undefined ? { customAppName: input.customAppName } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionGroupLocalizations/${encodeURIComponent(
            input.subscriptionGroupLocalizationId,
          )}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched SubscriptionGroupLocalization ${input.subscriptionGroupLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        // Match the flattened error text: Apple's `detail` lives in `details`,
        // never in ASCError.message (the bug fixed in 1.10.0 next door).
        const text = ascErrorText(err);
        if (text.includes('UNMODIFIABLE') || text.includes('can not be modified')) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Apple refused the PATCH: this group heading is locked in its current state.\n\n' +
                  "App Store Connect's web UI can still edit it (the change rides along with the next review cycle); the REST API cannot. " +
                  'Edit it at App Store Connect -> your app -> Subscriptions -> the group -> Localizations. ' +
                  'Adding a NEW locale with asc_post_subscription_group_localization still works while the group is live.\n\n' +
                  formatASCError(err),
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_subscription_group_localization',
    {
      title: 'Delete a subscription group localization',
      description:
        "DELETE a SubscriptionGroupLocalization. Customers in that locale fall back to another locale's group heading. Apple rejects the delete if it would leave the group with no localizations while the group is live.",
      inputSchema: z.object({
        subscriptionGroupLocalizationId: SubscriptionGroupLocalizationIdSchema,
      }),
    },
    async ({ subscriptionGroupLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/subscriptionGroupLocalizations/${encodeURIComponent(
            subscriptionGroupLocalizationId,
          )}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Deleted SubscriptionGroupLocalization ${subscriptionGroupLocalizationId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
