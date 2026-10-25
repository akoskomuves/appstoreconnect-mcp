import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ascErrorText } from '../errors.js';
import {
  AppCustomProductPageVersionIdSchema,
  AppIdSchema,
  CertificateIdSchema,
  CiProductIdSchema,
  CiWorkflowIdSchema,
  ReviewSubmissionItemIdSchema,
} from '../schemas.js';

// Single PATCH / DELETE endpoints on resources ppp already reads, which the
// first section-E gap list missed because it matched paths, not methods:
//
//   PATCH  /v1/apps/{id}                          app-level settings
//   PATCH  /v1/appCustomProductPageVersions/{id}  deepLink
//   PATCH  /v1/certificates/{id}                  activated
//   PATCH  /v1/reviewSubmissionItems/{id}         resolved / removed
//   DELETE /v1/ciWorkflows/{id}
//   DELETE /v1/ciProducts/{id}
//
// Every PATCH attribute is `nullable: true` in spec 4.5.1; null is passed
// through (it clears the field) and undefined is left out.

interface JSONAPIBody {
  data: { type: string; id: string; attributes: Record<string, unknown> };
}

export function buildAttributesPatchBody(
  type: string,
  id: string,
  attributes: Record<string, unknown>,
): JSONAPIBody {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attributes)) if (v !== undefined) attrs[k] = v;
  return { data: { type, id, attributes: attrs } };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: ascErrorText(err) }],
  isError: true,
});
const refuse = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

const UrlSchema = z.string().url();
const StatusUrlVersionSchema = z
  .enum(['V1', 'V2'])
  .describe('App Store Server Notifications version for that URL. V1 is deprecated; use V2.');

async function patch(
  client: ASCClient,
  path: string,
  body: JSONAPIBody,
  label: string,
): Promise<ToolResult> {
  if (Object.keys(body.data.attributes).length === 0) {
    return refuse('Refused: pass at least one attribute to change. Empty PATCH would no-op.');
  }
  try {
    const data = await client.request<unknown>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return ok(`Updated ${label}.\n\n${JSON.stringify(data, null, 2)}`);
  } catch (err) {
    return fail(err);
  }
}

export function registerResourceUpdates(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_patch_app',
    {
      title: 'Update app-level settings',
      description:
        "PATCH /v1/apps/{id} — the settings that live on the app itself, not on a version or app info: App Store Server Notification URLs (production + sandbox, each with its V1/V2 version), contentRightsDeclaration, primaryLocale, accessibilityUrl, streamlinedPurchasingEnabled and bundleId. Pass null to clear a field. bundleId can only change before the first build is uploaded. The app's name and subtitle are per-locale on the app info localization, not here.",
      inputSchema: z.object({
        appId: AppIdSchema,
        subscriptionStatusUrl: UrlSchema.nullable()
          .optional()
          .describe('Production App Store Server Notifications URL.'),
        subscriptionStatusUrlVersion: StatusUrlVersionSchema.nullable().optional(),
        subscriptionStatusUrlForSandbox: UrlSchema.nullable()
          .optional()
          .describe('Sandbox App Store Server Notifications URL.'),
        subscriptionStatusUrlVersionForSandbox: StatusUrlVersionSchema.nullable().optional(),
        contentRightsDeclaration: z
          .enum(['DOES_NOT_USE_THIRD_PARTY_CONTENT', 'USES_THIRD_PARTY_CONTENT'])
          .nullable()
          .optional()
          .describe('Content rights answer. Apple asks for it before the first submission.'),
        primaryLocale: z
          .string()
          .min(2)
          .nullable()
          .optional()
          .describe(
            'Primary language, e.g. "en-US". Its localization is used where no better one exists.',
          ),
        accessibilityUrl: UrlSchema.nullable().optional(),
        streamlinedPurchasingEnabled: z
          .boolean()
          .nullable()
          .optional()
          .describe('Let customers buy in-app purchases with streamlined purchasing.'),
        bundleId: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe('Only changeable before the first build is uploaded.'),
      }),
    },
    async ({ appId, ...attributes }) =>
      patch(
        client,
        `/v1/apps/${encodeURIComponent(appId)}`,
        buildAttributesPatchBody('apps', appId, attributes),
        `app ${appId}`,
      ),
  );

  server.registerTool(
    'asc_patch_app_custom_product_page_version',
    {
      title: "Set a custom product page version's deep link",
      description:
        'PATCH /v1/appCustomProductPageVersions/{id} — deepLink is the only writable attribute: the URL the app opens when installed and launched from this custom product page. Pass null to clear it.',
      inputSchema: z.object({
        versionId: AppCustomProductPageVersionIdSchema,
        deepLink: UrlSchema.nullable().describe('Universal link or custom-scheme URL, or null.'),
      }),
    },
    async ({ versionId, deepLink }) =>
      patch(
        client,
        `/v1/appCustomProductPageVersions/${encodeURIComponent(versionId)}`,
        buildAttributesPatchBody('appCustomProductPageVersions', versionId, { deepLink }),
        `custom product page version ${versionId}`,
      ),
  );

  server.registerTool(
    'asc_patch_certificate',
    {
      title: 'Activate or deactivate a certificate',
      description:
        'PATCH /v1/certificates/{id} — activated is the only writable attribute. Deactivating keeps the certificate but stops it from being used to sign; to revoke it for good use asc_delete_certificate.',
      inputSchema: z.object({ certificateId: CertificateIdSchema, activated: z.boolean() }),
    },
    async ({ certificateId, activated }) =>
      patch(
        client,
        `/v1/certificates/${encodeURIComponent(certificateId)}`,
        buildAttributesPatchBody('certificates', certificateId, { activated }),
        `certificate ${certificateId}`,
      ),
  );

  server.registerTool(
    'asc_patch_review_submission_item',
    {
      title: 'Resolve or remove a review submission item',
      description:
        'PATCH /v1/reviewSubmissionItems/{id} — resolved=true marks an item that App Review flagged as fixed (after you changed what they asked for); removed=true takes the item out of the submission without deleting it. To delete an item from a not-yet-submitted submission use asc_delete_review_submission_item.',
      inputSchema: z.object({
        itemId: ReviewSubmissionItemIdSchema,
        resolved: z.boolean().optional(),
        removed: z.boolean().optional(),
      }),
    },
    async ({ itemId, resolved, removed }) =>
      patch(
        client,
        `/v1/reviewSubmissionItems/${encodeURIComponent(itemId)}`,
        buildAttributesPatchBody('reviewSubmissionItems', itemId, { resolved, removed }),
        `review submission item ${itemId}`,
      ),
  );

  server.registerTool(
    'asc_delete_ci_workflow',
    {
      title: 'Delete an Xcode Cloud workflow',
      description:
        'DELETE /v1/ciWorkflows/{id} → 204. Permanent. To stop it running without deleting it, use asc_patch_ci_workflow with isEnabled=false.',
      inputSchema: z.object({ workflowId: CiWorkflowIdSchema }),
    },
    async ({ workflowId }) => {
      try {
        await client.request<void>(`/v1/ciWorkflows/${encodeURIComponent(workflowId)}`, {
          method: 'DELETE',
        });
        return ok(`Deleted Xcode Cloud workflow ${workflowId}.`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_ci_product',
    {
      title: 'Remove an app from Xcode Cloud',
      description:
        'DELETE /v1/ciProducts/{id} → 204. Off-boards the app or framework from Xcode Cloud, including its workflows. Permanent. The app itself and its App Store Connect builds are not touched.',
      inputSchema: z.object({ productId: CiProductIdSchema }),
    },
    async ({ productId }) => {
      try {
        await client.request<void>(`/v1/ciProducts/${encodeURIComponent(productId)}`, {
          method: 'DELETE',
        });
        return ok(`Deleted Xcode Cloud product ${productId}.`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
