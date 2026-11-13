import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestSubscriptionLocalizations } from '../digest.js';
import { ASCError, ascErrorText } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  LocaleSchema,
  SubscriptionIdSchema,
  SubscriptionLocalizationDescriptionSchema,
  SubscriptionLocalizationIdSchema,
  SubscriptionLocalizationNameSchema,
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

// SubscriptionLocalization carries the customer-facing name + description
// Apple shows in the App Store under a subscription product, per locale.
// One record per (subscription, locale).
//
// Apple's caps (from public docs, not the Swift SDK):
//   - name: 30 characters per locale (capped tighter than app-version
//     description because it sits next to a price in tight UI)
//   - description: 45 characters per locale (one-sentence value prop)
//
// VERSION-SCOPED since 1.17: Apple removes /v1/subscriptionLocalizations
// beginning in early 2027. The tools keep their names and inputs but use the
// /v2 resource, whose parent is a subscriptionVersion (relationship key
// `version`). A localization keeps the same id in v1 and v2 (live-verified
// 2026-11-13), so get / patch / delete only change path; create and list
// resolve the subscription's version (product-version-resolve.ts). The v2
// resource has no `state`: review status lives on the version.
//
// Mutability:
//   - At CREATE: name + locale required; description optional.
//   - At PATCH: name + description mutable; locale immutable (lookup key).
//
// Same wire shape as InAppPurchaseLocalization; both parent on a version.

// v2 localizations 400 on `state` in the fieldset.
const SUBSCRIPTION_LOCALIZATION_FIELDS = 'name,locale,description';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface SubscriptionLocalizationCreateInput {
  /** The subscriptionVersion the localization belongs to. */
  versionId: string;
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
        version: { data: { type: 'subscriptionVersions', id: input.versionId } },
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
  if (err instanceof VersionResolutionError) return `Refused: ${err.message}`;
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
        "List the localizations (locale + name + description) of a subscription's latest version, or of versionId. Review status lives on the version (asc_list_subscription_versions). Use to see which locales already have copy before adding more.",
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        versionId: VersionIdInput,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, versionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptionLocalizations]', SUBSCRIPTION_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      try {
        const vid = await resolveVersionForRead(client, 'subscription', subscriptionId, versionId);
        const path = `/v1/subscriptionVersions/${encodeURIComponent(vid)}/localizations?${params.toString()}`;
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
        'Fetch a single SubscriptionLocalization by ID. Returns name + description + locale.',
      inputSchema: z.object({
        subscriptionLocalizationId: SubscriptionLocalizationIdSchema,
      }),
    },
    async ({ subscriptionLocalizationId }) => {
      const path = `/v2/subscriptionLocalizations/${encodeURIComponent(
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
        "Create a SubscriptionLocalization for ONE subscription + ONE locale, on the subscription's latest editable version. Required: subscriptionId + name (30 chars max) + locale. Optional: description (45 chars max). (version, locale) must be unique; locale is immutable post-create. " +
        WRITE_VERSION_NOTE,
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        versionId: VersionIdInput,
        createVersionIfNeeded: CreateVersionIfNeededInput,
        name: SubscriptionLocalizationNameSchema,
        locale: LocaleSchema,
        description: SubscriptionLocalizationDescriptionSchema.optional(),
      }),
    },
    async (input) => {
      try {
        const v = await resolveVersionForWrite(client, 'subscription', input.subscriptionId, input);
        const body = buildSubscriptionLocalizationCreateBody({
          versionId: v.versionId,
          name: input.name,
          locale: input.locale,
          ...(input.description !== undefined ? { description: input.description } : {}),
        });
        const data = await client.request<unknown>('/v2/subscriptionLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `${v.note ? `${v.note}\n` : ''}Created SubscriptionLocalization (subscription ${input.subscriptionId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
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
        'Update name and/or description on an existing SubscriptionLocalization. Both optional; locale is immutable. Tool refuses an empty PATCH. ' +
        "** VERSION LOCK: ** Apple refuses edits to copy on an APPROVED version (409 UNMODIFIABLE, live-confirmed 2026-09-13). The tool reads the localization's version state first and refuses with the way forward: create a new version, edit its copy, submit it. " +
        'Pass force:true to skip the pre-check and let Apple judge.',
      inputSchema: z.object({
        subscriptionLocalizationId: SubscriptionLocalizationIdSchema,
        name: SubscriptionLocalizationNameSchema.optional(),
        description: SubscriptionLocalizationDescriptionSchema.optional(),
        force: z
          .boolean()
          .default(false)
          .describe(
            'Skip the client-side state pre-check and send the PATCH anyway, letting Apple be the judge. ' +
              'Use when the pre-check refuses an edit you believe Apple would accept — the gate models an undocumented constraint, so it can be wrong.',
          ),
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
      if (!input.force) {
        const gate = evaluateVersionLockGate(
          'subscription',
          await fetchLocalizationVersionState(
            client,
            'subscription',
            'subscriptionLocalizations',
            input.subscriptionLocalizationId,
          ),
        );
        if (!gate.allow) {
          return {
            content: [{ type: 'text', text: formatVersionLockRefusal(gate) }],
            isError: true,
          };
        }
      }
      const body = buildSubscriptionLocalizationPatchBody({
        subscriptionLocalizationId: input.subscriptionLocalizationId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v2/subscriptionLocalizations/${encodeURIComponent(input.subscriptionLocalizationId)}`,
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
        const text = ascErrorText(err);
        if (
          text.includes('UNMODIFIABLE') ||
          text.includes('Cannot edit SubscriptionLocalization')
        ) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Apple refused the PATCH: this copy is locked because its version is approved or in review. Create a new subscription version (asc_post_subscription_version, or createVersionIfNeeded: true on asc_post_subscription_localization), edit the copy there, then submit it.\n\n' +
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
          `/v2/subscriptionLocalizations/${encodeURIComponent(subscriptionLocalizationId)}`,
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
