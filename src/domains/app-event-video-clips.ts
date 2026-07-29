import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppEventVideoClips } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppEventAssetTypeSchema,
  AppEventLocalizationIdSchema,
  AppEventVideoClipIdSchema,
  FileNameSchema,
  FileSizeSchema,
  LocalFilePathSchema,
  PreviewFrameTimeCodeSchema,
} from '../schemas.js';
import {
  type AssetReserveResponse,
  computeFileMd5Hex,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// AppEventVideoClip wire shape:
//
//   * AppEventVideoClipCreateRequest: required attrs = { fileSize, fileName,
//     appEventAssetType }. Optional attrs = { previewFrameTimeCode }.
//     Required relationship = appEventLocalization. Reserve returns
//     uploadOperations[] — SAME three-step protocol as v0.13 / event screenshots.
//
//   * AppEventVideoClipUpdateRequest: optional attrs = { previewFrameTimeCode,
//     isUploaded }. WIRE-KEY GOTCHA: Swift `isUploaded` → wire `uploaded`.
//     Refuses empty PATCH.
//
//   * AppEventVideoClip read attrs include videoURL — WIRE-KEY GOTCHA:
//     Swift `videoURL` → wire `videoUrl` (same camelCase strip as v0.13
//     AppPreview). Read-only; never written.
//
//   * appEventAssetType (required at create): EVENT_CARD | EVENT_DETAILS_PAGE.

const APP_EVENT_VIDEO_CLIP_FIELDS =
  'fileName,fileSize,previewFrameTimeCode,videoUrl,previewImage,previewFrameImage,appEventAssetType,assetDeliveryState,videoDeliveryState,uploadOperations';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface AppEventVideoClipCreateInput {
  appEventLocalizationId: string;
  fileName: string;
  fileSize: number;
  appEventAssetType: string;
  previewFrameTimeCode?: string | undefined;
}

export function buildAppEventVideoClipCreateBody(input: AppEventVideoClipCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    fileName: input.fileName,
    fileSize: input.fileSize,
    appEventAssetType: input.appEventAssetType,
  };
  if (input.previewFrameTimeCode !== undefined) {
    attributes.previewFrameTimeCode = input.previewFrameTimeCode;
  }
  return {
    data: {
      type: 'appEventVideoClips',
      attributes,
      relationships: {
        appEventLocalization: {
          data: { type: 'appEventLocalizations', id: input.appEventLocalizationId },
        },
      },
    },
  };
}

export interface AppEventVideoClipPatchInput {
  appEventVideoClipId: string;
  previewFrameTimeCode?: string | undefined;
  uploaded?: boolean | undefined;
}

export function buildAppEventVideoClipPatchBody(input: AppEventVideoClipPatchInput): JSONAPIBody {
  // Wire-key gotcha: Swift `isUploaded` → wire `uploaded`. Caller has
  // already guarded empty inputs.
  const attributes: Record<string, unknown> = {};
  if (input.previewFrameTimeCode !== undefined) {
    attributes.previewFrameTimeCode = input.previewFrameTimeCode;
  }
  if (input.uploaded !== undefined) attributes.uploaded = input.uploaded;
  return {
    data: {
      type: 'appEventVideoClips',
      id: input.appEventVideoClipId,
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

export function registerAppEventVideoClips(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_app_event_video_clips',
    {
      title: 'List event video clips under a localization',
      description:
        'List AppEventVideoClip records under an AppEventLocalization. Each row carries fileName + fileSize + previewFrameTimeCode + asset slot (EVENT_CARD / EVENT_DETAILS_PAGE) + the two delivery states (assetDeliveryState for the source file, videoDeliveryState for Apple-side transcode).',
      inputSchema: z.object({
        appEventLocalizationId: AppEventLocalizationIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appEventLocalizationId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appEventVideoClips]', APP_EVENT_VIDEO_CLIP_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appEventLocalizations/${encodeURIComponent(appEventLocalizationId)}/appEventVideoClips?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppEventVideoClips(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_event_video_clip',
    {
      title: 'Get an AppEventVideoClip',
      description:
        'Fetch a single AppEventVideoClip by ID. Returns the upload metadata + previewFrameTimeCode + (post-ingest) videoUrl + previewImage. Wire-key gotcha: Apple emits `videoUrl` (camelCase) where Swift names it `videoURL`.',
      inputSchema: z.object({
        appEventVideoClipId: AppEventVideoClipIdSchema,
      }),
    },
    async ({ appEventVideoClipId }) => {
      const path = `/v1/appEventVideoClips/${encodeURIComponent(appEventVideoClipId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_event_video_clip',
    {
      title: 'Reserve an AppEventVideoClip upload (raw step 1)',
      description:
        'RAW step 1 of the three-step upload flow (same shape as v0.13 AppPreview). Reserves an AppEventVideoClip under an event localization with fileName + fileSize + appEventAssetType (+ optional previewFrameTimeCode for the poster frame). Returns the resource with uploadOperations[] populated. Most callers should use the composite asc_upload_app_event_video_clip instead.',
      inputSchema: z.object({
        appEventLocalizationId: AppEventLocalizationIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
        appEventAssetType: AppEventAssetTypeSchema,
        previewFrameTimeCode: PreviewFrameTimeCodeSchema.optional(),
      }),
    },
    async (input) => {
      const body = buildAppEventVideoClipCreateBody({
        appEventLocalizationId: input.appEventLocalizationId,
        fileName: input.fileName,
        fileSize: input.fileSize,
        appEventAssetType: input.appEventAssetType,
        ...(input.previewFrameTimeCode !== undefined
          ? { previewFrameTimeCode: input.previewFrameTimeCode }
          : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appEventVideoClips', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Reserved AppEventVideoClip (${input.appEventAssetType}) under localization ${input.appEventLocalizationId} for ${input.fileName} (${input.fileSize} bytes). Next: PUT each uploadOperation, then PATCH to commit.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_event_video_clip',
    {
      title: 'Patch / commit an AppEventVideoClip (raw step 3)',
      description:
        'RAW step 3 of the three-step upload flow + the only way to tweak previewFrameTimeCode on an existing clip. PATCH with uploaded=true to commit a reservation, or with previewFrameTimeCode alone to change the poster frame without re-uploading. Wire-key gotcha: Swift `isUploaded` → wire `uploaded`. Refuses empty PATCH.',
      inputSchema: z.object({
        appEventVideoClipId: AppEventVideoClipIdSchema,
        previewFrameTimeCode: PreviewFrameTimeCodeSchema.optional(),
        uploaded: z.boolean().optional(),
      }),
    },
    async (input) => {
      if (input.previewFrameTimeCode === undefined && input.uploaded === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of previewFrameTimeCode or uploaded. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      const body = buildAppEventVideoClipPatchBody({
        appEventVideoClipId: input.appEventVideoClipId,
        ...(input.previewFrameTimeCode !== undefined
          ? { previewFrameTimeCode: input.previewFrameTimeCode }
          : {}),
        ...(input.uploaded !== undefined ? { uploaded: input.uploaded } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appEventVideoClips/${encodeURIComponent(input.appEventVideoClipId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppEventVideoClip ${input.appEventVideoClipId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_event_video_clip',
    {
      title: 'Delete an AppEventVideoClip',
      description:
        'DELETE an AppEventVideoClip. Removes the video asset; if both screenshot + video slot are emptied, Apple may reject the event for review with an asset-missing error.',
      inputSchema: z.object({
        appEventVideoClipId: AppEventVideoClipIdSchema,
      }),
    },
    async ({ appEventVideoClipId }) => {
      try {
        await client.request<unknown>(
          `/v1/appEventVideoClips/${encodeURIComponent(appEventVideoClipId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [{ type: 'text', text: `Deleted AppEventVideoClip ${appEventVideoClipId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_upload_app_event_video_clip',
    {
      title: 'Upload an event video clip from a local file (composite)',
      description:
        'Composite tool. Reads localFilePath from disk (.mov H.264/HEVC recommended), reserves an AppEventVideoClip under the given event localization for the given asset slot (EVENT_CARD / EVENT_DETAILS_PAGE), PUTs every uploadOperation chunk to Apple storage in sequence, then commits with uploaded=true. Optionally sets previewFrameTimeCode (poster frame) at reserve. Returns the committed resource + per-chunk summary. Tilde paths (~/...) are expanded.',
      inputSchema: z.object({
        appEventLocalizationId: AppEventLocalizationIdSchema,
        localFilePath: LocalFilePathSchema,
        appEventAssetType: AppEventAssetTypeSchema,
        fileName: FileNameSchema.optional().describe(
          'Override the file name sent to Apple. Defaults to basename(localFilePath).',
        ),
        previewFrameTimeCode: PreviewFrameTimeCodeSchema.optional(),
      }),
    },
    async (input) => {
      const resolvedPath = expandHomePath(input.localFilePath);
      try {
        const fileSize = await readFileSizeBytes(resolvedPath);
        const fileName = input.fileName ?? resolvedPath.split('/').pop() ?? 'event-clip.mov';

        const reserveBody = buildAppEventVideoClipCreateBody({
          appEventLocalizationId: input.appEventLocalizationId,
          fileName,
          fileSize,
          appEventAssetType: input.appEventAssetType,
          ...(input.previewFrameTimeCode !== undefined
            ? { previewFrameTimeCode: input.previewFrameTimeCode }
            : {}),
        });
        const reserveResponse = await client.request<AssetReserveResponse>(
          '/v1/appEventVideoClips',
          { method: 'POST', body: JSON.stringify(reserveBody) },
        );
        const clipId = reserveResponse.data?.id;
        const operations = reserveResponse.data?.attributes?.uploadOperations ?? [];
        if (!clipId) {
          throw new Error('Reserve response missing video clip id');
        }
        if (operations.length === 0) {
          throw new Error('Reserve response missing uploadOperations[] — cannot upload');
        }

        const executed = await executeAllUploadOperations(operations, resolvedPath);
        const md5 = await computeFileMd5Hex(resolvedPath);

        const commitBody = buildAppEventVideoClipPatchBody({
          appEventVideoClipId: clipId,
          uploaded: true,
        });
        const commitResponse = await client.request<unknown>(
          `/v1/appEventVideoClips/${encodeURIComponent(clipId)}`,
          { method: 'PATCH', body: JSON.stringify(commitBody) },
        );

        return {
          content: [
            {
              type: 'text',
              text: `Uploaded event clip ${fileName} (${input.appEventAssetType}) → AppEventVideoClip ${clipId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nSource MD5: ${md5}\n\nCommit response:\n${JSON.stringify(commitResponse, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
