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
import {
  CreateVersionIfNeededInput,
  resolveVersionForRead,
  resolveVersionForWrite,
  VersionIdInput,
  VersionResolutionError,
  WRITE_VERSION_NOTE,
} from './product-version-resolve.js';

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
// VERSION-SCOPED since 1.17: Apple removes /v1/inAppPurchaseLocalizations
// beginning in early 2027. The tools keep their names and inputs but use the
// /v2 resource, whose parent is an inAppPurchaseVersion (relationship key
// `version`). A localization keeps the same id in v1 and v2 (live-verified
// 2026-11-13), so get / patch / delete only change path. Create and list
// resolve the IAP's version (product-version-resolve.ts). The v2 resource has
// no `state`: review status lives on the version.

// v2 localizations 400 on `state` in the fieldset.
const IAP_LOCALIZATION_FIELDS = 'name,locale,description';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface IapLocalizationCreateInput {
  /** The inAppPurchaseVersion the localization belongs to. */
  versionId: string;
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
        version: { data: { type: 'inAppPurchaseVersions', id: input.versionId } },
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
  if (err instanceof VersionResolutionError) return `Refused: ${err.message}`;
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
        "List the localizations (locale + name + description) of an IAP's latest version, or of versionId. Review status lives on the version (asc_list_iap_versions), not on each localization. Use asc_list_iaps to find an IAP ID first.",
      inputSchema: z.object({
        iapId: InAppPurchaseIdSchema,
        versionId: VersionIdInput,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ iapId, versionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[inAppPurchaseLocalizations]', IAP_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      try {
        const vid = await resolveVersionForRead(client, 'iap', iapId, versionId);
        const path = `/v1/inAppPurchaseVersions/${encodeURIComponent(vid)}/localizations?${params.toString()}`;
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
        'Fetch a single InAppPurchaseLocalization by ID. Returns name + description + locale.',
      inputSchema: z.object({
        iapLocalizationId: InAppPurchaseLocalizationIdSchema,
      }),
    },
    async ({ iapLocalizationId }) => {
      const path = `/v2/inAppPurchaseLocalizations/${encodeURIComponent(iapLocalizationId)}`;
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
        "Create an InAppPurchaseLocalization for ONE IAP + ONE locale, on the IAP's latest editable version. Required: iapId + name (30 chars) + locale. Optional: description (45 chars). (version, locale) must be unique; locale immutable post-create. " +
        WRITE_VERSION_NOTE,
      inputSchema: z.object({
        iapId: InAppPurchaseIdSchema,
        versionId: VersionIdInput,
        createVersionIfNeeded: CreateVersionIfNeededInput,
        name: IapLocalizationNameSchema,
        locale: LocaleSchema,
        description: IapLocalizationDescriptionSchema.optional(),
      }),
    },
    async (input) => {
      try {
        const v = await resolveVersionForWrite(client, 'iap', input.iapId, input);
        const body = buildIapLocalizationCreateBody({
          versionId: v.versionId,
          name: input.name,
          locale: input.locale,
          ...(input.description !== undefined ? { description: input.description } : {}),
        });
        const data = await client.request<unknown>('/v2/inAppPurchaseLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `${v.note ? `${v.note}\n` : ''}Created InAppPurchaseLocalization (iap ${input.iapId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
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
        '** PARENT-STATE GATE (likely): ** Same structural pattern as SubscriptionLocalization, where the gate is now CONFIRMED (409 ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE, "Cannot edit ... when it is in ACTIVE state", observed live 2026-09-13 on APPROVED copy under a live parent). Expect Apple to lock name/description here the same way once the IAP is live or in review. Not yet observed on this resource, so it is not pre-checked client-side — Apple\'s error is the authoritative gate. If it fires, the App Store Connect web UI can still make the edit.',
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
          `/v2/inAppPurchaseLocalizations/${encodeURIComponent(input.iapLocalizationId)}`,
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
          `/v2/inAppPurchaseLocalizations/${encodeURIComponent(iapLocalizationId)}`,
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
