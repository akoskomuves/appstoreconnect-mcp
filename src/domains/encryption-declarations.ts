import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppEncryptionDeclarations } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppEncryptionDeclarationDescriptionSchema,
  AppEncryptionDeclarationDocumentIdSchema,
  AppEncryptionDeclarationIdSchema,
  AppIdSchema,
  AvailableOnFrenchStoreSchema,
  BuildIdSchema,
  ContainsProprietaryCryptographySchema,
  ContainsThirdPartyCryptographySchema,
  FileNameSchema,
  FileSizeSchema,
  LocalFilePathSchema,
  SourceFileChecksumSchema,
} from '../schemas.js';
import {
  type AssetReserveResponse,
  computeFileMd5Hex,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// AppEncryptionDeclaration + Document wire shape:
//
//   * AppEncryptionDeclarationCreateRequest: required attrs =
//     { appDescription, containsProprietaryCryptography,
//       containsThirdPartyCryptography, isAvailableOnFrenchStore }.
//     Required relationship = app (marked deprecated in Swift but still
//     required by Apple's API at create time).
//     WIRE-KEY GOTCHA: Swift `isAvailableOnFrenchStore` → wire
//     `availableOnFrenchStore` (same is-prefix strip).
//     NOT included: `usesEncryption` (deprecated — Apple no longer reads
//     this on writes; only surfaces on reads of legacy declarations).
//
//   * No UpdateRequest for AppEncryptionDeclaration — declarations are
//     append-only. Create a new one to refresh.
//
//   * AppEncryptionDeclaration read attributes include 4 DEPRECATED
//     fields: usesEncryption, uploadedDate, documentURL, documentName,
//     documentType. Surface them on reads (so the model can see legacy
//     state) but don't accept them on writes.
//
//   * Build linkage: PATCH /v1/builds/{id}/relationships/
//     appEncryptionDeclaration with { data: { type, id } } sets the link,
//     { data: null } clears it. Each build has at most ONE declaration.
//     The inverse (AppEncryptionDeclarationBuildsLinkagesRequest) is
//     deprecated and not wrapped here.
//
//   * AppEncryptionDeclarationDocument: same three-step upload protocol
//     as v0.13 AppScreenshot. Reserve POST returns uploadOperations[],
//     PUT each chunk, PATCH commit with sourceFileChecksum +
//     uploaded=true. WIRE-KEY GOTCHA on Update: Swift `isUploaded` → wire
//     `uploaded`. Apple's Document type carries the asset metadata only
//     — no per-document attributes block to mutate beyond commit.

const ENCRYPTION_DECLARATION_FIELDS =
  'appDescription,createdDate,exempt,containsProprietaryCryptography,containsThirdPartyCryptography,availableOnFrenchStore,platform,documentName,documentType,documentUrl,appEncryptionDeclarationState,codeValue,usesEncryption,uploadedDate';
const ENCRYPTION_DOCUMENT_FIELDS =
  'fileName,fileSize,assetToken,downloadUrl,sourceFileChecksum,assetDeliveryState,uploadOperations';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

interface LinkageBody {
  data: { type: string; id: string } | null;
}

// ----- Body builders: declaration -----

export interface AppEncryptionDeclarationCreateInput {
  appId: string;
  appDescription: string;
  containsProprietaryCryptography: boolean;
  containsThirdPartyCryptography: boolean;
  availableOnFrenchStore: boolean;
}

export function buildAppEncryptionDeclarationCreateBody(
  input: AppEncryptionDeclarationCreateInput,
): JSONAPIBody {
  // Wire-key gotcha: Swift `isAvailableOnFrenchStore` → wire
  // `availableOnFrenchStore`. NOT included: usesEncryption (deprecated).
  return {
    data: {
      type: 'appEncryptionDeclarations',
      attributes: {
        appDescription: input.appDescription,
        containsProprietaryCryptography: input.containsProprietaryCryptography,
        containsThirdPartyCryptography: input.containsThirdPartyCryptography,
        availableOnFrenchStore: input.availableOnFrenchStore,
      },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

// ----- Body builders: build linkage -----

export interface BuildEncryptionLinkageInput {
  appEncryptionDeclarationId: string | null;
}

export function buildBuildEncryptionLinkageBody(input: BuildEncryptionLinkageInput): LinkageBody {
  // PATCH /v1/builds/{buildId}/relationships/appEncryptionDeclaration
  // shape: { data: { type, id } } to link, { data: null } to unlink.
  // The relationships block envelope is REMOVED — Apple expects the
  // bare linkage form on this endpoint.
  if (input.appEncryptionDeclarationId === null) {
    return { data: null };
  }
  return {
    data: {
      type: 'appEncryptionDeclarations',
      id: input.appEncryptionDeclarationId,
    },
  };
}

// ----- Body builders: document upload -----

export interface AppEncryptionDeclarationDocumentCreateInput {
  appEncryptionDeclarationId: string;
  fileName: string;
  fileSize: number;
}

export function buildAppEncryptionDeclarationDocumentCreateBody(
  input: AppEncryptionDeclarationDocumentCreateInput,
): JSONAPIBody {
  return {
    data: {
      type: 'appEncryptionDeclarationDocuments',
      attributes: {
        fileName: input.fileName,
        fileSize: input.fileSize,
      },
      relationships: {
        appEncryptionDeclaration: {
          data: { type: 'appEncryptionDeclarations', id: input.appEncryptionDeclarationId },
        },
      },
    },
  };
}

export interface AppEncryptionDeclarationDocumentPatchInput {
  appEncryptionDeclarationDocumentId: string;
  sourceFileChecksum?: string | undefined;
  uploaded?: boolean | undefined;
}

export function buildAppEncryptionDeclarationDocumentPatchBody(
  input: AppEncryptionDeclarationDocumentPatchInput,
): JSONAPIBody {
  // Wire-key gotcha: Swift `isUploaded` → wire `uploaded`. Same strip as
  // v0.13 AppScreenshot. Tool layer guards empty input.
  const attributes: Record<string, unknown> = {};
  if (input.sourceFileChecksum !== undefined) {
    attributes.sourceFileChecksum = input.sourceFileChecksum;
  }
  if (input.uploaded !== undefined) attributes.uploaded = input.uploaded;
  return {
    data: {
      type: 'appEncryptionDeclarationDocuments',
      id: input.appEncryptionDeclarationDocumentId,
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

export function registerEncryptionDeclarations(server: McpServer, client: ASCClient): void {
  // ----- AppEncryptionDeclaration -----

  server.registerTool(
    'asc_list_app_encryption_declarations',
    {
      title: 'List App Encryption Declarations for an app',
      description:
        'List AppEncryptionDeclaration records under an app. Each row carries the appDescription, current state (CREATED / IN_REVIEW / APPROVED / REJECTED / INVALID / EXPIRED), codeValue (ECCN export classification once Apple has reviewed), the exempt flag, and the three encryption flags (proprietary / thirdParty / availableOnFrenchStore). Used to find a declaration to link a build to.',
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appEncryptionDeclarations]', ENCRYPTION_DECLARATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appEncryptionDeclarations?filter[app]=${encodeURIComponent(appId)}&${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppEncryptionDeclarations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_encryption_declaration',
    {
      title: 'Get an AppEncryptionDeclaration',
      description:
        'Fetch a single AppEncryptionDeclaration by ID with its document relationship expanded. Returns the full attribute surface including the 4 deprecated read-only fields (usesEncryption, uploadedDate, documentURL, documentName, documentType) for legacy declarations.',
      inputSchema: z.object({
        appEncryptionDeclarationId: AppEncryptionDeclarationIdSchema,
      }),
    },
    async ({ appEncryptionDeclarationId }) => {
      const path = `/v1/appEncryptionDeclarations/${encodeURIComponent(appEncryptionDeclarationId)}?include=appEncryptionDeclarationDocument`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_encryption_declaration',
    {
      title: 'Create an AppEncryptionDeclaration',
      description:
        "Create an AppEncryptionDeclaration for an app. Required: appId + appDescription + containsProprietaryCryptography + containsThirdPartyCryptography + availableOnFrenchStore. Apple reviews the declaration server-side; state walks CREATED → IN_REVIEW → APPROVED / REJECTED. There is NO PATCH for declarations — create a new one to refresh the answers. Wire-key gotcha: Swift `isAvailableOnFrenchStore` → wire `availableOnFrenchStore`. NOTE: the deprecated `usesEncryption` attribute is not accepted on writes — Apple's modern path uses `exempt` (server-set) instead.",
      inputSchema: z.object({
        appId: AppIdSchema,
        appDescription: AppEncryptionDeclarationDescriptionSchema,
        containsProprietaryCryptography: ContainsProprietaryCryptographySchema,
        containsThirdPartyCryptography: ContainsThirdPartyCryptographySchema,
        availableOnFrenchStore: AvailableOnFrenchStoreSchema,
      }),
    },
    async (input) => {
      const body = buildAppEncryptionDeclarationCreateBody({
        appId: input.appId,
        appDescription: input.appDescription,
        containsProprietaryCryptography: input.containsProprietaryCryptography,
        containsThirdPartyCryptography: input.containsThirdPartyCryptography,
        availableOnFrenchStore: input.availableOnFrenchStore,
      });
      try {
        const data = await client.request<unknown>('/v1/appEncryptionDeclarations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppEncryptionDeclaration on app ${input.appId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Build → Declaration linkage -----

  server.registerTool(
    'asc_get_build_app_encryption_declaration',
    {
      title: 'Get the AppEncryptionDeclaration linked to a build',
      description:
        'Fetch the AppEncryptionDeclaration currently linked to a build. Each build has at most ONE declaration. Returns 404 if no declaration is linked.',
      inputSchema: z.object({
        buildId: BuildIdSchema,
      }),
    },
    async ({ buildId }) => {
      const path = `/v1/builds/${encodeURIComponent(buildId)}/appEncryptionDeclaration`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_build_app_encryption_declaration',
    {
      title: 'Link a build to an AppEncryptionDeclaration (or null to unlink)',
      description:
        "Set the AppEncryptionDeclaration for a build. PATCH /v1/builds/{id}/relationships/appEncryptionDeclaration. Pass `appEncryptionDeclarationId` to link, pass null to clear the linkage. Each build can have at most ONE declaration. Apple's inverse linkage (declaration → builds[]) is DEPRECATED and not wrapped here — manage the linkage from the build side.",
      inputSchema: z.object({
        buildId: BuildIdSchema,
        appEncryptionDeclarationId: AppEncryptionDeclarationIdSchema.nullable().describe(
          'Pass an AppEncryptionDeclaration ID to link; pass null to clear the linkage.',
        ),
      }),
    },
    async ({ buildId, appEncryptionDeclarationId }) => {
      const body = buildBuildEncryptionLinkageBody({
        appEncryptionDeclarationId,
      });
      try {
        const data = await client.request<unknown>(
          `/v1/builds/${encodeURIComponent(buildId)}/relationships/appEncryptionDeclaration`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text:
                appEncryptionDeclarationId === null
                  ? `Cleared the AppEncryptionDeclaration linkage on build ${buildId}.\n\n${JSON.stringify(data, null, 2)}`
                  : `Linked build ${buildId} to AppEncryptionDeclaration ${appEncryptionDeclarationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- AppEncryptionDeclarationDocument (raw three-step + composite) -----

  server.registerTool(
    'asc_get_app_encryption_declaration_document',
    {
      title: 'Get an AppEncryptionDeclarationDocument',
      description:
        'Fetch a single AppEncryptionDeclarationDocument by ID. Returns fileName / fileSize / sourceFileChecksum / assetDeliveryState / the downloadUrl once Apple has processed the upload (wire-key gotcha: Swift `downloadURL` → wire `downloadUrl`).',
      inputSchema: z.object({
        appEncryptionDeclarationDocumentId: AppEncryptionDeclarationDocumentIdSchema,
      }),
    },
    async ({ appEncryptionDeclarationDocumentId }) => {
      const path = `/v1/appEncryptionDeclarationDocuments/${encodeURIComponent(appEncryptionDeclarationDocumentId)}?fields[appEncryptionDeclarationDocuments]=${ENCRYPTION_DOCUMENT_FIELDS}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_encryption_declaration_document',
    {
      title: 'Reserve an AppEncryptionDeclarationDocument upload (raw step 1)',
      description:
        'RAW step 1 of the three-step upload flow (same shape as v0.13 AppScreenshot). Reserves an AppEncryptionDeclarationDocument under a declaration with fileName + fileSize. Returns the resource with uploadOperations[] populated. Use asc_upload_asset_chunk to PUT each, then asc_patch_app_encryption_declaration_document to commit. Most callers should use the composite asc_upload_app_encryption_declaration_document instead.',
      inputSchema: z.object({
        appEncryptionDeclarationId: AppEncryptionDeclarationIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
      }),
    },
    async (input) => {
      const body = buildAppEncryptionDeclarationDocumentCreateBody({
        appEncryptionDeclarationId: input.appEncryptionDeclarationId,
        fileName: input.fileName,
        fileSize: input.fileSize,
      });
      try {
        const data = await client.request<unknown>('/v1/appEncryptionDeclarationDocuments', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Reserved AppEncryptionDeclarationDocument under declaration ${input.appEncryptionDeclarationId} for ${input.fileName} (${input.fileSize} bytes). Next: PUT each uploadOperation, then PATCH to commit.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_encryption_declaration_document',
    {
      title: 'Commit an AppEncryptionDeclarationDocument upload (raw step 3)',
      description:
        'RAW step 3 of the three-step upload flow. PATCH with sourceFileChecksum (lowercase hex MD5 of the full file) + uploaded=true to commit. Wire-key gotcha: Swift `isUploaded` → wire `uploaded` (same strip as v0.13 / v0.14). Pass at least one of the two — empty PATCH refused. The composite asc_upload_app_encryption_declaration_document handles this automatically.',
      inputSchema: z.object({
        appEncryptionDeclarationDocumentId: AppEncryptionDeclarationDocumentIdSchema,
        sourceFileChecksum: SourceFileChecksumSchema.optional(),
        uploaded: z.boolean().optional(),
      }),
    },
    async (input) => {
      if (input.sourceFileChecksum === undefined && input.uploaded === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of sourceFileChecksum or uploaded. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildAppEncryptionDeclarationDocumentPatchBody({
        appEncryptionDeclarationDocumentId: input.appEncryptionDeclarationDocumentId,
        ...(input.sourceFileChecksum !== undefined
          ? { sourceFileChecksum: input.sourceFileChecksum }
          : {}),
        ...(input.uploaded !== undefined ? { uploaded: input.uploaded } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appEncryptionDeclarationDocuments/${encodeURIComponent(input.appEncryptionDeclarationDocumentId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppEncryptionDeclarationDocument ${input.appEncryptionDeclarationDocumentId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_upload_app_encryption_declaration_document',
    {
      title: 'Upload an encryption-declaration document from a local file (composite)',
      description:
        'Composite tool. Reads localFilePath from disk (typically a PDF questionnaire), reserves an AppEncryptionDeclarationDocument under the given declaration with fileName + fileSize derived from the file, PUTs every uploadOperation chunk to Apple storage in sequence, then commits with sourceFileChecksum (md5 hex) + uploaded=true. Returns the final committed resource + per-chunk summary. Tilde paths (~/...) are expanded. Same protocol as v0.13 asc_upload_screenshot.',
      inputSchema: z.object({
        appEncryptionDeclarationId: AppEncryptionDeclarationIdSchema,
        localFilePath: LocalFilePathSchema,
        fileName: FileNameSchema.optional().describe(
          'Override the file name sent to Apple. Defaults to basename(localFilePath).',
        ),
      }),
    },
    async (input) => {
      const resolvedPath = expandHomePath(input.localFilePath);
      try {
        const fileSize = await readFileSizeBytes(resolvedPath);
        const fileName = input.fileName ?? resolvedPath.split('/').pop() ?? 'encryption-doc.pdf';

        const reserveBody = buildAppEncryptionDeclarationDocumentCreateBody({
          appEncryptionDeclarationId: input.appEncryptionDeclarationId,
          fileName,
          fileSize,
        });
        const reserveResponse = await client.request<AssetReserveResponse>(
          '/v1/appEncryptionDeclarationDocuments',
          { method: 'POST', body: JSON.stringify(reserveBody) },
        );
        const documentId = reserveResponse.data?.id;
        const operations = reserveResponse.data?.attributes?.uploadOperations ?? [];
        if (!documentId) {
          throw new Error('Reserve response missing document id');
        }
        if (operations.length === 0) {
          throw new Error('Reserve response missing uploadOperations[] — cannot upload');
        }

        const executed = await executeAllUploadOperations(operations, resolvedPath);
        const checksum = await computeFileMd5Hex(resolvedPath);

        const commitBody = buildAppEncryptionDeclarationDocumentPatchBody({
          appEncryptionDeclarationDocumentId: documentId,
          sourceFileChecksum: checksum,
          uploaded: true,
        });
        const commitResponse = await client.request<unknown>(
          `/v1/appEncryptionDeclarationDocuments/${encodeURIComponent(documentId)}`,
          { method: 'PATCH', body: JSON.stringify(commitBody) },
        );

        return {
          content: [
            {
              type: 'text',
              text: `Uploaded encryption-declaration document ${fileName} → AppEncryptionDeclarationDocument ${documentId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(commitResponse, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
