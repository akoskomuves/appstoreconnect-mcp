import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ascErrorText } from '../errors.js';
import { paginate } from '../jsonapi.js';
import { AppIdSchema } from '../schemas.js';

// Android → iOS app mapping details (spec 4.5.1): tell Apple which Android app
// (Play package name + signing-certificate SHA-256 fingerprints) is the same
// product as this iOS app. Full CRUD:
//
//   GET    /v1/apps/{id}/androidToIosAppMappingDetails
//   POST   /v1/androidToIosAppMappingDetails           (packageName + fingerprints + app)
//   GET    /v1/androidToIosAppMappingDetails/{id}
//   PATCH  /v1/androidToIosAppMappingDetails/{id}      (both attributes nullable)
//   DELETE /v1/androidToIosAppMappingDetails/{id}
//
// Both attributes are REQUIRED on create. The fingerprint list is replaced as
// a whole on PATCH, not merged.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

const TYPE = 'androidToIosAppMappingDetails';

const MappingIdSchema = z
  .string()
  .min(1)
  .describe('androidToIosAppMappingDetails ID, from asc_list_android_to_ios_app_mappings.');

const PackageNameSchema = z
  .string()
  .min(1)
  .describe('Google Play package name of the Android app, e.g. "com.example.app".');

// SHA-256 of a signing certificate: 32 bytes, usually written as 64 hex chars,
// colon-separated in Play Console ("AB:CD:…"). Accept both spellings.
export const SHA256_FINGERPRINT = /^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{64}$/;

const FingerprintsSchema = z
  .array(
    z
      .string()
      .regex(
        SHA256_FINGERPRINT,
        'expected a SHA-256 fingerprint: 64 hex chars, with or without colons',
      ),
  )
  .min(1)
  .describe(
    'SHA-256 fingerprints of the Android app-signing key certificate(s), as shown in Play Console → App integrity → App signing (colon-separated hex is fine).',
  );

export interface MappingCreateInput {
  appId: string;
  packageName: string;
  fingerprints: string[];
}

export function buildMappingCreateBody(input: MappingCreateInput): JSONAPIBody {
  return {
    data: {
      type: TYPE,
      attributes: {
        packageName: input.packageName,
        appSigningKeyPublicCertificateSha256Fingerprints: input.fingerprints,
      },
      relationships: { app: { data: { type: 'apps', id: input.appId } } },
    },
  };
}

export interface MappingPatchInput {
  mappingId: string;
  packageName?: string | null | undefined;
  fingerprints?: string[] | null | undefined;
}

export function buildMappingPatchBody(input: MappingPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.packageName !== undefined) attributes.packageName = input.packageName;
  if (input.fingerprints !== undefined) {
    attributes.appSigningKeyPublicCertificateSha256Fingerprints = input.fingerprints;
  }
  return { data: { type: TYPE, id: input.mappingId, attributes } };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const json = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: ascErrorText(err) }],
  isError: true,
});
const itemPath = (id: string) => `/v1/${TYPE}/${encodeURIComponent(id)}`;

export function registerAndroidAppMappings(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_android_to_ios_app_mappings',
    {
      title: "List an app's Android → iOS app mappings",
      description:
        'GET /v1/apps/{id}/androidToIosAppMappingDetails — the Android apps (Play package name + signing-key SHA-256 fingerprints) declared as the same product as this iOS app.',
      inputSchema: z.object({ appId: AppIdSchema }),
    },
    async ({ appId }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/apps/${encodeURIComponent(appId)}/androidToIosAppMappingDetails?limit=200`,
          200,
        );
        if (pages.data.length === 0) return json({ note: `No Android mappings on app ${appId}.` });
        return json(
          pages.data.map((r) => ({
            id: r.id,
            packageName: r.attributes?.packageName,
            fingerprints: r.attributes?.appSigningKeyPublicCertificateSha256Fingerprints,
          })),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_android_to_ios_app_mapping',
    {
      title: 'Get an Android → iOS app mapping',
      description: 'GET /v1/androidToIosAppMappingDetails/{id}.',
      inputSchema: z.object({ mappingId: MappingIdSchema }),
    },
    async ({ mappingId }) => {
      try {
        return json(await client.request<unknown>(itemPath(mappingId)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_post_android_to_ios_app_mapping',
    {
      title: 'Map an Android app to an iOS app',
      description:
        'POST /v1/androidToIosAppMappingDetails — declare an Android app (Play package name + app-signing certificate SHA-256 fingerprints) as the same product as this iOS app. Both are required. Use the APP SIGNING key fingerprint from Play Console (App integrity → App signing), not the upload key.',
      inputSchema: z.object({
        appId: AppIdSchema,
        packageName: PackageNameSchema,
        fingerprints: FingerprintsSchema,
      }),
    },
    async (input) => {
      try {
        const data = await client.request<unknown>(`/v1/${TYPE}`, {
          method: 'POST',
          body: JSON.stringify(buildMappingCreateBody(input)),
        });
        return json(data);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_android_to_ios_app_mapping',
    {
      title: 'Update an Android → iOS app mapping',
      description:
        'PATCH /v1/androidToIosAppMappingDetails/{id} — change the package name and/or the fingerprint list. fingerprints REPLACES the whole list (pass the old ones too when adding a key after a key rotation). Pass at least one field.',
      inputSchema: z.object({
        mappingId: MappingIdSchema,
        packageName: PackageNameSchema.optional(),
        fingerprints: FingerprintsSchema.optional(),
      }),
    },
    async (input) => {
      if (input.packageName === undefined && input.fingerprints === undefined) {
        return {
          content: [{ type: 'text', text: 'Refused: pass packageName and/or fingerprints.' }],
          isError: true,
        };
      }
      try {
        const data = await client.request<unknown>(itemPath(input.mappingId), {
          method: 'PATCH',
          body: JSON.stringify(buildMappingPatchBody(input)),
        });
        return json(data);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_android_to_ios_app_mapping',
    {
      title: 'Delete an Android → iOS app mapping',
      description: 'DELETE /v1/androidToIosAppMappingDetails/{id} → 204.',
      inputSchema: z.object({ mappingId: MappingIdSchema }),
    },
    async ({ mappingId }) => {
      try {
        await client.request<void>(itemPath(mappingId), { method: 'DELETE' });
        return { content: [{ type: 'text', text: `Deleted Android mapping ${mappingId}.` }] };
      } catch (err) {
        return fail(err);
      }
    },
  );
}
