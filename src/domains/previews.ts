import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppPreviewSets, digestAppPreviews } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppPreviewIdSchema,
  AppPreviewSetIdSchema,
  FileNameSchema,
  FileSizeSchema,
  LocalFilePathSchema,
  PreviewFrameTimeCodeSchema,
  PreviewMimeTypeSchema,
  PreviewTypeSchema,
  ScreenshotSetParentTypeSchema,
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

// AppPreview / AppPreviewSet wire shape:
//
//   * AppPreviewSetCreateRequest: required attrs = { previewType }.
//     Same three-way OPTIONAL parent slots as AppScreenshotSet — exactly
//     one required by Apple at runtime. Distinct enum from
//     ScreenshotDisplayType: PreviewType strips the `APP_` prefix
//     (IPHONE_67, not APP_IPHONE_67) and has no IMESSAGE_* variants.
//
//   * AppPreviewCreateRequest: required attrs = { fileSize, fileName }.
//     Optional attrs = { previewFrameTimeCode, mimeType }. Required
//     relationship = appPreviewSet.
//
//   * AppPreviewUpdateRequest: optional attrs only — { sourceFileChecksum,
//     previewFrameTimeCode, isUploaded }. WIRE-KEY GOTCHA: Swift `isUploaded`
//     → wire `uploaded` (same strip as AppScreenshot). Tool refuses empty.
//
//   * AppPreview.videoURL (read-only) → wire key `videoUrl` (we never
//     write this, but flag it in case the digest/get formatters look at it).
//
// No state machine on AppPreview / AppPreviewSet — Apple gates writes via
// the parent localization's lifecycle.

const PREVIEW_SET_FIELDS = 'previewType';
const PREVIEW_FIELDS =
  'fileName,fileSize,sourceFileChecksum,previewFrameTimeCode,mimeType,videoUrl,assetDeliveryState,videoDeliveryState,uploadOperations';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface AppPreviewSetCreateInput {
  previewType: string;
  parentType:
    | 'appStoreVersionLocalizations'
    | 'appCustomProductPageLocalizations'
    | 'appStoreVersionExperimentTreatmentLocalizations';
  parentLocalizationId: string;
}

export function buildAppPreviewSetCreateBody(input: AppPreviewSetCreateInput): JSONAPIBody {
  const relKey =
    input.parentType === 'appStoreVersionLocalizations'
      ? 'appStoreVersionLocalization'
      : input.parentType === 'appCustomProductPageLocalizations'
        ? 'appCustomProductPageLocalization'
        : 'appStoreVersionExperimentTreatmentLocalization';
  return {
    data: {
      type: 'appPreviewSets',
      attributes: {
        previewType: input.previewType,
      },
      relationships: {
        [relKey]: {
          data: { type: input.parentType, id: input.parentLocalizationId },
        },
      },
    },
  };
}

export interface AppPreviewCreateInput {
  appPreviewSetId: string;
  fileName: string;
  fileSize: number;
  previewFrameTimeCode?: string | undefined;
  mimeType?: string | undefined;
}

export function buildAppPreviewCreateBody(input: AppPreviewCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    fileName: input.fileName,
    fileSize: input.fileSize,
  };
  if (input.previewFrameTimeCode !== undefined) {
    attributes.previewFrameTimeCode = input.previewFrameTimeCode;
  }
  if (input.mimeType !== undefined) {
    attributes.mimeType = input.mimeType;
  }
  return {
    data: {
      type: 'appPreviews',
      attributes,
      relationships: {
        appPreviewSet: {
          data: { type: 'appPreviewSets', id: input.appPreviewSetId },
        },
      },
    },
  };
}

export interface AppPreviewPatchInput {
  appPreviewId: string;
  sourceFileChecksum?: string | undefined;
  previewFrameTimeCode?: string | undefined;
  uploaded?: boolean | undefined;
}

export function buildAppPreviewPatchBody(input: AppPreviewPatchInput): JSONAPIBody {
  // Wire-key gotcha: Swift `isUploaded` → wire `uploaded` (same strip as
  // AppScreenshot). Caller has already guarded empty input.
  const attributes: Record<string, unknown> = {};
  if (input.sourceFileChecksum !== undefined) {
    attributes.sourceFileChecksum = input.sourceFileChecksum;
  }
  if (input.previewFrameTimeCode !== undefined) {
    attributes.previewFrameTimeCode = input.previewFrameTimeCode;
  }
  if (input.uploaded !== undefined) {
    attributes.uploaded = input.uploaded;
  }
  return {
    data: {
      type: 'appPreviews',
      id: input.appPreviewId,
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

function parentBasePath(
  parentType: AppPreviewSetCreateInput['parentType'],
  parentLocalizationId: string,
): string {
  return `/v1/${parentType}/${encodeURIComponent(parentLocalizationId)}/appPreviewSets`;
}

export function registerPreviews(server: McpServer, client: ASCClient): void {
  // ----- AppPreviewSet -----

  server.registerTool(
    'asc_list_app_preview_sets',
    {
      title: 'List preview sets under a parent localization',
      description:
        'List AppPreviewSet records under a parent localization (an AppStoreVersionLocalization, an AppCustomProductPageLocalization, or an AppStoreVersionExperimentTreatmentLocalization). Each row carries the previewType (IPHONE_67, IPAD_PRO_129, …) and the set ID. Note: PreviewType values are distinct from ScreenshotDisplayType — no `APP_` prefix.',
      inputSchema: z.object({
        parentType: ScreenshotSetParentTypeSchema,
        parentLocalizationId: z.string().min(1),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ parentType, parentLocalizationId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appPreviewSets]', PREVIEW_SET_FIELDS);
      params.set('limit', '200');
      const path = `${parentBasePath(parentType, parentLocalizationId)}?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppPreviewSets(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_preview_set',
    {
      title: 'Get an AppPreviewSet',
      description:
        'Fetch a single AppPreviewSet by ID with its previews expanded. The included AppPreview resources carry fileName, fileSize, previewFrameTimeCode, mimeType, and the video delivery state.',
      inputSchema: z.object({
        appPreviewSetId: AppPreviewSetIdSchema,
      }),
    },
    async ({ appPreviewSetId }) => {
      const path = `/v1/appPreviewSets/${encodeURIComponent(appPreviewSetId)}?include=appPreviews`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_preview_set',
    {
      title: 'Create an AppPreviewSet',
      description:
        'Create an AppPreviewSet for ONE (parent localization, previewType) pair. Required: parentType + parentLocalizationId + previewType. Apple enforces uniqueness — a duplicate (parent, previewType) is rejected.',
      inputSchema: z.object({
        parentType: ScreenshotSetParentTypeSchema,
        parentLocalizationId: z.string().min(1),
        previewType: PreviewTypeSchema,
      }),
    },
    async ({ parentType, parentLocalizationId, previewType }) => {
      const body = buildAppPreviewSetCreateBody({
        parentType,
        parentLocalizationId,
        previewType,
      });
      try {
        const data = await client.request<unknown>('/v1/appPreviewSets', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppPreviewSet (${previewType} under ${parentType}/${parentLocalizationId}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_preview_set',
    {
      title: 'Delete an AppPreviewSet',
      description:
        'DELETE an AppPreviewSet. All AppPreview resources under the set are removed as well.',
      inputSchema: z.object({
        appPreviewSetId: AppPreviewSetIdSchema,
      }),
    },
    async ({ appPreviewSetId }) => {
      try {
        await client.request<unknown>(`/v1/appPreviewSets/${encodeURIComponent(appPreviewSetId)}`, {
          method: 'DELETE',
        });
        return {
          content: [{ type: 'text', text: `Deleted AppPreviewSet ${appPreviewSetId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- AppPreview (raw three-step + composite) -----

  server.registerTool(
    'asc_list_app_previews',
    {
      title: 'List previews under a set',
      description:
        'List AppPreview records under an AppPreviewSet. Each row carries fileName + fileSize + previewFrameTimeCode + the two delivery states (assetDeliveryState for the source file, videoDeliveryState for Apple-side transcode).',
      inputSchema: z.object({
        appPreviewSetId: AppPreviewSetIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appPreviewSetId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appPreviews]', PREVIEW_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appPreviewSets/${encodeURIComponent(appPreviewSetId)}/appPreviews?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppPreviews(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_preview',
    {
      title: 'Get an AppPreview',
      description:
        'Fetch a single AppPreview by ID. Returns the upload metadata + previewFrameTimeCode + (post-ingest) videoUrl and previewImage. Wire-key gotcha: Apple emits `videoUrl` (camelCase) where Swift names it `videoURL`.',
      inputSchema: z.object({
        appPreviewId: AppPreviewIdSchema,
      }),
    },
    async ({ appPreviewId }) => {
      const path = `/v1/appPreviews/${encodeURIComponent(appPreviewId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_preview',
    {
      title: 'Reserve an AppPreview upload (raw step 1)',
      description:
        'RAW step 1 of the three-step upload flow for previews. Reserves an AppPreview under a set with fileName + fileSize (+ optional previewFrameTimeCode + mimeType), and returns the resource with uploadOperations[] populated. Most callers should use the composite asc_upload_app_preview instead — this exists for manual control.',
      inputSchema: z.object({
        appPreviewSetId: AppPreviewSetIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
        previewFrameTimeCode: PreviewFrameTimeCodeSchema.optional(),
        mimeType: PreviewMimeTypeSchema.optional(),
      }),
    },
    async (input) => {
      const body = buildAppPreviewCreateBody({
        appPreviewSetId: input.appPreviewSetId,
        fileName: input.fileName,
        fileSize: input.fileSize,
        ...(input.previewFrameTimeCode !== undefined
          ? { previewFrameTimeCode: input.previewFrameTimeCode }
          : {}),
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appPreviews', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Reserved AppPreview under set ${input.appPreviewSetId} for ${input.fileName} (${input.fileSize} bytes). Next: PUT each uploadOperation, then PATCH to commit.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_preview',
    {
      title: 'Patch / commit an AppPreview (raw step 3)',
      description:
        'RAW step 3 of the three-step upload flow + the only way to tweak previewFrameTimeCode on an existing preview. PATCH with sourceFileChecksum + uploaded=true to commit a reservation, or with previewFrameTimeCode alone to change the poster frame without re-uploading the video. Wire-key gotcha: Swift `isUploaded` → wire `uploaded`. Tool refuses empty PATCHes.',
      inputSchema: z.object({
        appPreviewId: AppPreviewIdSchema,
        sourceFileChecksum: SourceFileChecksumSchema.optional(),
        previewFrameTimeCode: PreviewFrameTimeCodeSchema.optional(),
        uploaded: z.boolean().optional(),
      }),
    },
    async (input) => {
      const anyAttr =
        input.sourceFileChecksum !== undefined ||
        input.previewFrameTimeCode !== undefined ||
        input.uploaded !== undefined;
      if (!anyAttr) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of sourceFileChecksum, previewFrameTimeCode, or uploaded. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildAppPreviewPatchBody({
        appPreviewId: input.appPreviewId,
        ...(input.sourceFileChecksum !== undefined
          ? { sourceFileChecksum: input.sourceFileChecksum }
          : {}),
        ...(input.previewFrameTimeCode !== undefined
          ? { previewFrameTimeCode: input.previewFrameTimeCode }
          : {}),
        ...(input.uploaded !== undefined ? { uploaded: input.uploaded } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appPreviews/${encodeURIComponent(input.appPreviewId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppPreview ${input.appPreviewId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_preview',
    {
      title: 'Delete an AppPreview',
      description:
        'DELETE an AppPreview. Removes the video asset + its slot in the set; if all previews are removed the parent localization may need a new upload before submission.',
      inputSchema: z.object({
        appPreviewId: AppPreviewIdSchema,
      }),
    },
    async ({ appPreviewId }) => {
      try {
        await client.request<unknown>(`/v1/appPreviews/${encodeURIComponent(appPreviewId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Deleted AppPreview ${appPreviewId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_upload_app_preview',
    {
      title: 'Upload an app preview video from a local file (composite)',
      description:
        "Composite tool. Reads localFilePath from disk (Apple's recommended: .mov H.264/HEVC, ≤500 MB, 15–30s), reserves an AppPreview under the given set, PUTs every uploadOperation chunk to Apple storage in sequence, then commits with sourceFileChecksum + uploaded=true. Optionally sets previewFrameTimeCode (poster frame) at reserve. Returns the committed resource + per-chunk summary. Tilde paths (~/...) are expanded.",
      inputSchema: z.object({
        appPreviewSetId: AppPreviewSetIdSchema,
        localFilePath: LocalFilePathSchema,
        fileName: FileNameSchema.optional().describe(
          'Override the file name sent to Apple. Defaults to basename(localFilePath).',
        ),
        previewFrameTimeCode: PreviewFrameTimeCodeSchema.optional(),
        mimeType: PreviewMimeTypeSchema.optional(),
      }),
    },
    async (input) => {
      const resolvedPath = expandHomePath(input.localFilePath);
      try {
        const fileSize = await readFileSizeBytes(resolvedPath);
        const fileName = input.fileName ?? resolvedPath.split('/').pop() ?? 'preview.mov';

        const reserveBody = buildAppPreviewCreateBody({
          appPreviewSetId: input.appPreviewSetId,
          fileName,
          fileSize,
          ...(input.previewFrameTimeCode !== undefined
            ? { previewFrameTimeCode: input.previewFrameTimeCode }
            : {}),
          ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        });
        const reserveResponse = await client.request<AssetReserveResponse>('/v1/appPreviews', {
          method: 'POST',
          body: JSON.stringify(reserveBody),
        });
        const previewId = reserveResponse.data?.id;
        const operations = reserveResponse.data?.attributes?.uploadOperations ?? [];
        if (!previewId) {
          throw new Error('Reserve response missing preview id');
        }
        if (operations.length === 0) {
          throw new Error('Reserve response missing uploadOperations[] — cannot upload');
        }

        const executed = await executeAllUploadOperations(operations, resolvedPath);
        const checksum = await computeFileMd5Hex(resolvedPath);

        const commitBody = buildAppPreviewPatchBody({
          appPreviewId: previewId,
          sourceFileChecksum: checksum,
          uploaded: true,
        });
        const commitResponse = await client.request<unknown>(
          `/v1/appPreviews/${encodeURIComponent(previewId)}`,
          { method: 'PATCH', body: JSON.stringify(commitBody) },
        );

        return {
          content: [
            {
              type: 'text',
              text: `Uploaded preview ${fileName} → AppPreview ${previewId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(commitResponse, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
