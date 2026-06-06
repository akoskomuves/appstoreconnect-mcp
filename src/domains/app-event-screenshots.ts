import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppEventScreenshots } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppEventAssetTypeSchema,
  AppEventLocalizationIdSchema,
  AppEventScreenshotIdSchema,
  FileNameSchema,
  FileSizeSchema,
  LocalFilePathSchema,
} from '../schemas.js';
import {
  type AssetReserveResponse,
  computeFileMd5Hex,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// AppEventScreenshot wire shape:
//
//   * AppEventScreenshotCreateRequest: required attrs = { fileSize,
//     fileName, appEventAssetType }. Required relationship =
//     appEventLocalization. Reserve returns the resource with
//     uploadOperations[] populated — SAME three-step protocol as v0.13.
//
//   * AppEventScreenshotUpdateRequest: only attr is { isUploaded }.
//     WIRE-KEY GOTCHA: Swift `isUploaded` → wire `uploaded` (same strip as
//     v0.13 AppScreenshot.isUploaded). Tool refuses empty PATCH.
//
//   * appEventAssetType (required at create): EVENT_CARD | EVENT_DETAILS_PAGE.
//     The slot determines whether this asset shows on the small tile or the
//     full event details view.
//
// No state machine on AppEventScreenshot — Apple gates writes via the parent
// AppEventLocalization's parent AppEvent's lifecycle.

const APP_EVENT_SCREENSHOT_FIELDS =
  'fileName,fileSize,assetToken,appEventAssetType,assetDeliveryState,uploadOperations,imageAsset';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface AppEventScreenshotCreateInput {
  appEventLocalizationId: string;
  fileName: string;
  fileSize: number;
  appEventAssetType: string;
}

export function buildAppEventScreenshotCreateBody(
  input: AppEventScreenshotCreateInput,
): JSONAPIBody {
  return {
    data: {
      type: 'appEventScreenshots',
      attributes: {
        fileName: input.fileName,
        fileSize: input.fileSize,
        appEventAssetType: input.appEventAssetType,
      },
      relationships: {
        appEventLocalization: {
          data: { type: 'appEventLocalizations', id: input.appEventLocalizationId },
        },
      },
    },
  };
}

export interface AppEventScreenshotPatchInput {
  appEventScreenshotId: string;
  uploaded: boolean;
}

export function buildAppEventScreenshotPatchBody(input: AppEventScreenshotPatchInput): JSONAPIBody {
  // Wire-key gotcha: Swift `isUploaded` → wire `uploaded`. Only mutable
  // attr on this resource; caller has already guarded that uploaded is set.
  return {
    data: {
      type: 'appEventScreenshots',
      id: input.appEventScreenshotId,
      attributes: { uploaded: input.uploaded },
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

export function registerAppEventScreenshots(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_app_event_screenshots',
    {
      title: 'List event screenshots under a localization',
      description:
        'List AppEventScreenshot records under an AppEventLocalization. Each row carries fileName + fileSize + the asset slot (EVENT_CARD / EVENT_DETAILS_PAGE) + assetDeliveryState (UPLOAD_COMPLETE / PROCESSING / COMPLETE / FAILED). Use to inspect upload progress or to enumerate IDs.',
      inputSchema: {
        appEventLocalizationId: AppEventLocalizationIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      },
    },
    async ({ appEventLocalizationId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appEventScreenshots]', APP_EVENT_SCREENSHOT_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appEventLocalizations/${encodeURIComponent(appEventLocalizationId)}/appEventScreenshots?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppEventScreenshots(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_event_screenshot',
    {
      title: 'Get an AppEventScreenshot',
      description:
        'Fetch a single AppEventScreenshot by ID. Returns fileName / fileSize / appEventAssetType / assetDeliveryState / the imageAsset URLs once processed / the uploadOperations[] before commit.',
      inputSchema: {
        appEventScreenshotId: AppEventScreenshotIdSchema,
      },
    },
    async ({ appEventScreenshotId }) => {
      const path = `/v1/appEventScreenshots/${encodeURIComponent(appEventScreenshotId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_event_screenshot',
    {
      title: 'Reserve an AppEventScreenshot upload (raw step 1)',
      description:
        'RAW step 1 of the three-step upload flow (same shape as v0.13 AppScreenshot). Reserves an AppEventScreenshot under an event localization with fileName + fileSize + appEventAssetType (EVENT_CARD / EVENT_DETAILS_PAGE). Returns the resource with uploadOperations[] populated. Use asc_upload_asset_chunk to PUT each, then asc_patch_app_event_screenshot to commit. Most callers should use the composite asc_upload_app_event_screenshot instead.',
      inputSchema: {
        appEventLocalizationId: AppEventLocalizationIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
        appEventAssetType: AppEventAssetTypeSchema,
      },
    },
    async (input) => {
      const body = buildAppEventScreenshotCreateBody({
        appEventLocalizationId: input.appEventLocalizationId,
        fileName: input.fileName,
        fileSize: input.fileSize,
        appEventAssetType: input.appEventAssetType,
      });
      try {
        const data = await client.request<unknown>('/v1/appEventScreenshots', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Reserved AppEventScreenshot (${input.appEventAssetType}) under localization ${input.appEventLocalizationId} for ${input.fileName} (${input.fileSize} bytes). Next: PUT each uploadOperation, then PATCH to commit.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_event_screenshot',
    {
      title: 'Commit an AppEventScreenshot upload (raw step 3)',
      description:
        'RAW step 3 of the three-step upload flow. PATCH with uploaded=true to commit the reservation. Wire-key gotcha: Swift `isUploaded` → wire `uploaded` (same strip as v0.13 AppScreenshot). The composite asc_upload_app_event_screenshot handles this automatically.',
      inputSchema: {
        appEventScreenshotId: AppEventScreenshotIdSchema,
        uploaded: z.boolean(),
      },
    },
    async (input) => {
      const body = buildAppEventScreenshotPatchBody({
        appEventScreenshotId: input.appEventScreenshotId,
        uploaded: input.uploaded,
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appEventScreenshots/${encodeURIComponent(input.appEventScreenshotId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppEventScreenshot ${input.appEventScreenshotId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_event_screenshot',
    {
      title: 'Delete an AppEventScreenshot',
      description:
        'DELETE an AppEventScreenshot. Removes the asset under its slot; if the slot goes empty Apple may reject the event for review with an asset-missing error.',
      inputSchema: {
        appEventScreenshotId: AppEventScreenshotIdSchema,
      },
    },
    async ({ appEventScreenshotId }) => {
      try {
        await client.request<unknown>(
          `/v1/appEventScreenshots/${encodeURIComponent(appEventScreenshotId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [{ type: 'text', text: `Deleted AppEventScreenshot ${appEventScreenshotId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_upload_app_event_screenshot',
    {
      title: 'Upload an event screenshot from a local file (composite)',
      description:
        'Composite tool. Reads localFilePath from disk, reserves an AppEventScreenshot under the given event localization for the given asset slot (EVENT_CARD / EVENT_DETAILS_PAGE), PUTs every uploadOperation chunk to Apple storage in sequence, then commits with uploaded=true. Returns the committed resource + per-chunk summary. Tilde paths (~/...) are expanded. Note: this resource has NO sourceFileChecksum on the commit step — Apple does not require an MD5 here (unlike v0.13 AppScreenshot).',
      inputSchema: {
        appEventLocalizationId: AppEventLocalizationIdSchema,
        localFilePath: LocalFilePathSchema,
        appEventAssetType: AppEventAssetTypeSchema,
        fileName: FileNameSchema.optional().describe(
          'Override the file name sent to Apple. Defaults to basename(localFilePath).',
        ),
      },
    },
    async (input) => {
      const resolvedPath = expandHomePath(input.localFilePath);
      try {
        const fileSize = await readFileSizeBytes(resolvedPath);
        const fileName = input.fileName ?? resolvedPath.split('/').pop() ?? 'event-screenshot.png';

        const reserveBody = buildAppEventScreenshotCreateBody({
          appEventLocalizationId: input.appEventLocalizationId,
          fileName,
          fileSize,
          appEventAssetType: input.appEventAssetType,
        });
        const reserveResponse = await client.request<AssetReserveResponse>(
          '/v1/appEventScreenshots',
          { method: 'POST', body: JSON.stringify(reserveBody) },
        );
        const screenshotId = reserveResponse.data?.id;
        const operations = reserveResponse.data?.attributes?.uploadOperations ?? [];
        if (!screenshotId) {
          throw new Error('Reserve response missing screenshot id');
        }
        if (operations.length === 0) {
          throw new Error('Reserve response missing uploadOperations[] — cannot upload');
        }

        const executed = await executeAllUploadOperations(operations, resolvedPath);
        // Touch the checksum helper to keep parity with v0.13 callers
        // expecting an md5 in the response. Apple's AppEventScreenshot
        // UpdateRequest accepts only `uploaded` — no sourceFileChecksum
        // slot — so we do not send it on commit.
        const md5 = await computeFileMd5Hex(resolvedPath);

        const commitBody = buildAppEventScreenshotPatchBody({
          appEventScreenshotId: screenshotId,
          uploaded: true,
        });
        const commitResponse = await client.request<unknown>(
          `/v1/appEventScreenshots/${encodeURIComponent(screenshotId)}`,
          { method: 'PATCH', body: JSON.stringify(commitBody) },
        );

        return {
          content: [
            {
              type: 'text',
              text: `Uploaded event screenshot ${fileName} (${input.appEventAssetType}) → AppEventScreenshot ${screenshotId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nSource MD5: ${md5}\n\nCommit response:\n${JSON.stringify(commitResponse, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
