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
import {
  CreateVersionIfNeededInput,
  evaluateVersionLockGate,
  fetchLocalizationVersionState,
  formatVersionLockRefusal,
  resolveVersionForRead,
  resolveVersionForWrite,
  VersionIdInput,
  VersionResolutionError,
  WRITE_VERSION_NOTE,
} from './product-version-resolve.js';

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
//
// VERSION-SCOPED since 1.17: Apple removes /v1/subscriptionGroupLocalizations
// beginning in early 2027. The tools keep their names and inputs but use the
// /v2 resource, whose parent is a subscriptionGroupVersion (relationship key
// `version`). A localization keeps the same id in v1 and v2 (live-verified
// 2026-11-13), so get / patch / delete only change path; create and list
// resolve the group's version (product-version-resolve.ts). The v2 resource
// has no `state`: review status lives on the version.

// v2 localizations 400 on `state` in the fieldset.
const GROUP_LOCALIZATION_FIELDS = 'name,customAppName,locale';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface SubscriptionGroupLocalizationCreateInput {
  /** The subscriptionGroupVersion the localization belongs to. */
  versionId: string;
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
        version: { data: { type: 'subscriptionGroupVersions', id: input.versionId } },
      },
    },
  };
}

export interface SubscriptionGroupLocalizationPatchInput {
  subscriptionGroupLocalizationId: string;
  name?: string | undefined;
  // null is meaningful here, not an absence: Apple marks customAppName
  // nullable, so an explicit null is how an override gets CLEARED and the
  // locale goes back to inheriting the real app name. Omitted leaves it alone.
  customAppName?: string | null | undefined;
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
  if (err instanceof VersionResolutionError) return `Refused: ${err.message}`;
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
        "List the customer-facing GROUP display names of a subscription group's latest version (or versionId), one row per locale. Review status lives on the version (asc_list_subscription_group_versions). Use to see which locales already have a group heading before adding more. Not to be confused with asc_list_subscription_localizations, which is the copy for one product inside the group.",
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
        versionId: VersionIdInput,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ groupId, versionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptionGroupLocalizations]', GROUP_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      try {
        const vid = await resolveVersionForRead(client, 'subscriptionGroup', groupId, versionId);
        const path = `/v1/subscriptionGroupVersions/${encodeURIComponent(vid)}/localizations?${params.toString()}`;
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
        'Fetch a single SubscriptionGroupLocalization by ID. Returns name + customAppName + locale.',
      inputSchema: z.object({
        subscriptionGroupLocalizationId: SubscriptionGroupLocalizationIdSchema,
      }),
    },
    async ({ subscriptionGroupLocalizationId }) => {
      try {
        const data = await client.request<unknown>(
          `/v2/subscriptionGroupLocalizations/${encodeURIComponent(
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
        "The (version, locale) pair must be unique, and locale is immutable afterwards. A group with no localization at all cannot be submitted for review. Lands on the group's latest editable version. " +
        WRITE_VERSION_NOTE,
      inputSchema: z.object({
        groupId: SubscriptionGroupIdSchema,
        versionId: VersionIdInput,
        createVersionIfNeeded: CreateVersionIfNeededInput,
        name: SubscriptionGroupLocalizationNameSchema,
        locale: LocaleSchema,
        customAppName: SubscriptionCustomAppNameSchema.optional(),
      }),
    },
    async (input) => {
      try {
        const v = await resolveVersionForWrite(client, 'subscriptionGroup', input.groupId, input);
        const body = buildSubscriptionGroupLocalizationCreateBody({
          versionId: v.versionId,
          name: input.name,
          locale: input.locale,
          ...(input.customAppName !== undefined ? { customAppName: input.customAppName } : {}),
        });
        const data = await client.request<unknown>('/v2/subscriptionGroupLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `${v.note ? `${v.note}\n` : ''}Created SubscriptionGroupLocalization (group ${input.groupId}, locale ${input.locale}, name "${input.name}").\n\n${JSON.stringify(data, null, 2)}`,
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
        'Update name and/or customAppName on an existing SubscriptionGroupLocalization. Both optional; the tool refuses an empty PATCH. Pass customAppName: null to CLEAR an existing override (Apple marks the attribute nullable) — omitting it leaves the current value alone. Locale is immutable and state is server-managed. ' +
        "** VERSION LOCK: ** Apple locks copy on an APPROVED version. The tool reads the localization's version state first and refuses with the way forward (create a new group version, edit its copy, submit it). Pass force:true to skip the pre-check and let Apple judge.",
      inputSchema: z.object({
        subscriptionGroupLocalizationId: SubscriptionGroupLocalizationIdSchema,
        name: SubscriptionGroupLocalizationNameSchema.optional(),
        customAppName: SubscriptionCustomAppNameSchema.nullable()
          .optional()
          .describe(
            'Per-locale app-name override. Pass null to clear it and go back to inheriting the real App Store app name.',
          ),
        force: z
          .boolean()
          .default(false)
          .describe('Skip the version-state pre-check and let Apple decide.'),
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
      if (!input.force) {
        const gate = evaluateVersionLockGate(
          'subscriptionGroup',
          await fetchLocalizationVersionState(
            client,
            'subscriptionGroup',
            'subscriptionGroupLocalizations',
            input.subscriptionGroupLocalizationId,
          ),
        );
        if (!gate.allow) {
          return {
            content: [{ type: 'text', text: formatVersionLockRefusal(gate) }],
            isError: true,
          };
        }
      }
      const body = buildSubscriptionGroupLocalizationPatchBody({
        subscriptionGroupLocalizationId: input.subscriptionGroupLocalizationId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.customAppName !== undefined ? { customAppName: input.customAppName } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v2/subscriptionGroupLocalizations/${encodeURIComponent(
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
                  'Apple refused the PATCH: this group heading is locked because its version is approved or in review. ' +
                  'Create a new group version (asc_post_subscription_group_version, or createVersionIfNeeded: true on asc_post_subscription_group_localization), edit the heading there, then submit it.\n\n' +
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
          `/v2/subscriptionGroupLocalizations/${encodeURIComponent(
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
