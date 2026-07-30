import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppScreenshotSets, digestAppScreenshots } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppScreenshotIdSchema,
  AppScreenshotSetIdSchema,
  FileNameSchema,
  FileSizeSchema,
  LocalFilePathSchema,
  ScreenshotDisplayTypeSchema,
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

// AppScreenshot / AppScreenshotSet wire shape:
//
//   * AppScreenshotSetCreateRequest: required attrs = { screenshotDisplayType }.
//     Relationships block has three OPTIONAL one-of slots
//     (appStoreVersionLocalization | appCustomProductPageLocalization |
//     appStoreVersionExperimentTreatmentLocalization). The Swift contract
//     marks the relationships block optional, but Apple rejects creates
//     that omit all three — exactly one parent is required.
//
//   * AppScreenshotCreateRequest: required attrs = { fileSize, fileName }.
//     Required relationship = appScreenshotSet. Reserve returns the
//     resource with uploadOperations[] populated.
//
//   * AppScreenshotUpdateRequest: optional attrs only. WIRE-KEY GOTCHA:
//     Swift `isUploaded` → wire `uploaded`. Body builder must emit the
//     short form. When neither sourceFileChecksum nor uploaded is passed,
//     the body has nothing to send — tool refuses empty PATCHes upstream.
//
//   * ScreenshotDisplayType has 33 values, including the IMESSAGE_* variants.
//
// No state machine on AppScreenshot / AppScreenshotSet — Apple gates writes
// via the parent localization's lifecycle.

const SCREENSHOT_SET_FIELDS = 'screenshotDisplayType';
const SCREENSHOT_FIELDS =
  'fileName,fileSize,sourceFileChecksum,assetDeliveryState,uploadOperations,assetToken,assetType';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface AppScreenshotSetCreateInput {
  screenshotDisplayType: string;
  parentType:
    | 'appStoreVersionLocalizations'
    | 'appCustomProductPageLocalizations'
    | 'appStoreVersionExperimentTreatmentLocalizations';
  parentLocalizationId: string;
}

export function buildAppScreenshotSetCreateBody(input: AppScreenshotSetCreateInput): JSONAPIBody {
  // The three parent types map to camelCase relationship keys via a simple
  // strip of the trailing `s`. Hand-rolling the table avoids a runtime
  // pluralize util just for three entries.
  const relKey =
    input.parentType === 'appStoreVersionLocalizations'
      ? 'appStoreVersionLocalization'
      : input.parentType === 'appCustomProductPageLocalizations'
        ? 'appCustomProductPageLocalization'
        : 'appStoreVersionExperimentTreatmentLocalization';
  return {
    data: {
      type: 'appScreenshotSets',
      attributes: {
        screenshotDisplayType: input.screenshotDisplayType,
      },
      relationships: {
        [relKey]: {
          data: { type: input.parentType, id: input.parentLocalizationId },
        },
      },
    },
  };
}

export interface AppScreenshotCreateInput {
  appScreenshotSetId: string;
  fileName: string;
  fileSize: number;
}

export function buildAppScreenshotCreateBody(input: AppScreenshotCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'appScreenshots',
      attributes: {
        fileName: input.fileName,
        fileSize: input.fileSize,
      },
      relationships: {
        appScreenshotSet: {
          data: { type: 'appScreenshotSets', id: input.appScreenshotSetId },
        },
      },
    },
  };
}

export interface AppScreenshotPatchInput {
  appScreenshotId: string;
  sourceFileChecksum?: string | undefined;
  uploaded?: boolean | undefined;
}

export function buildAppScreenshotPatchBody(input: AppScreenshotPatchInput): JSONAPIBody {
  // Wire-key gotcha: Swift `isUploaded` → wire `uploaded`. Emit the short
  // form on writes. Both attrs are optional; caller has already guarded
  // empty inputs at the tool layer.
  const attributes: Record<string, unknown> = {};
  if (input.sourceFileChecksum !== undefined) {
    attributes.sourceFileChecksum = input.sourceFileChecksum;
  }
  if (input.uploaded !== undefined) {
    attributes.uploaded = input.uploaded;
  }
  return {
    data: {
      type: 'appScreenshots',
      id: input.appScreenshotId,
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
  parentType: AppScreenshotSetCreateInput['parentType'],
  parentLocalizationId: string,
): string {
  return `/v1/${parentType}/${encodeURIComponent(parentLocalizationId)}/appScreenshotSets`;
}

export function registerScreenshots(server: McpServer, client: ASCClient): void {
  // ----- AppScreenshotSet -----

  server.registerTool(
    'asc_list_app_screenshot_sets',
    {
      title: 'List screenshot sets under a parent localization',
      description:
        'List AppScreenshotSet records under a parent localization (an AppStoreVersionLocalization, an AppCustomProductPageLocalization, or an AppStoreVersionExperimentTreatmentLocalization). Each row carries the screenshotDisplayType (APP_IPHONE_67, APP_IPAD_PRO_129, …) and the set ID. Use to find the set for a given (locale, device-class) pair before listing or uploading screenshots.',
      inputSchema: z.object({
        parentType: ScreenshotSetParentTypeSchema,
        parentLocalizationId: z.string().min(1),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ parentType, parentLocalizationId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appScreenshotSets]', SCREENSHOT_SET_FIELDS);
      params.set('limit', '200');
      const path = `${parentBasePath(parentType, parentLocalizationId)}?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppScreenshotSets(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_screenshot_set',
    {
      title: 'Get an AppScreenshotSet',
      description:
        'Fetch a single AppScreenshotSet by ID with its screenshots expanded. The included AppScreenshot resources carry fileName, fileSize, assetDeliveryState, and sourceFileChecksum for each captured screenshot.',
      inputSchema: z.object({
        appScreenshotSetId: AppScreenshotSetIdSchema,
      }),
    },
    async ({ appScreenshotSetId }) => {
      const path = `/v1/appScreenshotSets/${encodeURIComponent(appScreenshotSetId)}?include=appScreenshots`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_screenshot_set',
    {
      title: 'Create an AppScreenshotSet',
      description:
        'Create an AppScreenshotSet for ONE (parent localization, screenshotDisplayType) pair. Required: parentType + parentLocalizationId + screenshotDisplayType. The parent must be one of appStoreVersionLocalizations / appCustomProductPageLocalizations / appStoreVersionExperimentTreatmentLocalizations. Apple enforces uniqueness — a duplicate (parent, displayType) is rejected.',
      inputSchema: z.object({
        parentType: ScreenshotSetParentTypeSchema,
        parentLocalizationId: z.string().min(1),
        screenshotDisplayType: ScreenshotDisplayTypeSchema,
      }),
    },
    async ({ parentType, parentLocalizationId, screenshotDisplayType }) => {
      const body = buildAppScreenshotSetCreateBody({
        parentType,
        parentLocalizationId,
        screenshotDisplayType,
      });
      try {
        const data = await client.request<unknown>('/v1/appScreenshotSets', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created AppScreenshotSet (${screenshotDisplayType} under ${parentType}/${parentLocalizationId}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_screenshot_set',
    {
      title: 'Delete an AppScreenshotSet',
      description:
        'DELETE an AppScreenshotSet. All AppScreenshot resources under the set are removed as well. Use when retiring a device class for a locale or rebuilding a set from scratch.',
      inputSchema: z.object({
        appScreenshotSetId: AppScreenshotSetIdSchema,
      }),
    },
    async ({ appScreenshotSetId }) => {
      try {
        await client.request<unknown>(
          `/v1/appScreenshotSets/${encodeURIComponent(appScreenshotSetId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [{ type: 'text', text: `Deleted AppScreenshotSet ${appScreenshotSetId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- AppScreenshot (raw three-step + composite) -----

  server.registerTool(
    'asc_list_app_screenshots',
    {
      title: 'List screenshots under a set',
      description:
        'List AppScreenshot records under an AppScreenshotSet. Each row carries fileName + fileSize + assetDeliveryState (UPLOAD_COMPLETE / PROCESSING / COMPLETE / FAILED) + a short marker showing whether sourceFileChecksum has been committed. Use to inspect upload progress or to enumerate IDs for deletion.',
      inputSchema: z.object({
        appScreenshotSetId: AppScreenshotSetIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appScreenshotSetId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appScreenshots]', SCREENSHOT_FIELDS);
      params.set('limit', '200');
      const path = `/v1/appScreenshotSets/${encodeURIComponent(appScreenshotSetId)}/appScreenshots?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppScreenshots(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_screenshot',
    {
      title: 'Get an AppScreenshot',
      description:
        'Fetch a single AppScreenshot by ID. Returns the upload metadata (fileName, fileSize, sourceFileChecksum), assetDeliveryState, the imageAsset URLs once processed, and — if the reservation has not been committed yet — the uploadOperations[] needed to PUT chunks to Apple storage.',
      inputSchema: z.object({
        appScreenshotId: AppScreenshotIdSchema,
      }),
    },
    async ({ appScreenshotId }) => {
      const path = `/v1/appScreenshots/${encodeURIComponent(appScreenshotId)}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_app_screenshot',
    {
      title: 'Reserve an AppScreenshot upload (raw step 1)',
      description:
        'RAW step 1 of the three-step upload flow. Reserves an AppScreenshot under a set with fileName + fileSize, and returns the created resource with uploadOperations[] populated. Each uploadOperation has method=PUT + url + length + offset + requestHeaders for one chunk of the file. Use asc_upload_asset_chunk to PUT each, then asc_patch_app_screenshot to commit. Most callers should use the composite asc_upload_screenshot instead — this tool exists as an escape hatch for manual control.',
      inputSchema: z.object({
        appScreenshotSetId: AppScreenshotSetIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
      }),
    },
    async (input) => {
      const body = buildAppScreenshotCreateBody({
        appScreenshotSetId: input.appScreenshotSetId,
        fileName: input.fileName,
        fileSize: input.fileSize,
      });
      try {
        const data = await client.request<unknown>('/v1/appScreenshots', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Reserved AppScreenshot under set ${input.appScreenshotSetId} for ${input.fileName} (${input.fileSize} bytes). Next: PUT each uploadOperation, then PATCH to commit.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_screenshot',
    {
      title: 'Commit an AppScreenshot upload (raw step 3)',
      description:
        'RAW step 3 of the three-step upload flow. PATCH the AppScreenshot with sourceFileChecksum (lowercase hex MD5 of the full file) + uploaded=true to commit the reservation. Wire-key gotcha: Swift `isUploaded` → wire `uploaded`. Pass at least one of the two — empty PATCH is refused. The composite asc_upload_screenshot handles this automatically.',
      inputSchema: z.object({
        appScreenshotId: AppScreenshotIdSchema,
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
      const body = buildAppScreenshotPatchBody({
        appScreenshotId: input.appScreenshotId,
        ...(input.sourceFileChecksum !== undefined
          ? { sourceFileChecksum: input.sourceFileChecksum }
          : {}),
        ...(input.uploaded !== undefined ? { uploaded: input.uploaded } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appScreenshots/${encodeURIComponent(input.appScreenshotId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched AppScreenshot ${input.appScreenshotId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_app_screenshot',
    {
      title: 'Delete an AppScreenshot',
      description:
        'DELETE an AppScreenshot. Removes the asset + its slot in the set; if the set goes empty the parent localization will need a new upload before the App Store version can be submitted.',
      inputSchema: z.object({
        appScreenshotId: AppScreenshotIdSchema,
      }),
    },
    async ({ appScreenshotId }) => {
      try {
        await client.request<unknown>(`/v1/appScreenshots/${encodeURIComponent(appScreenshotId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Deleted AppScreenshot ${appScreenshotId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_upload_screenshot',
    {
      title: 'Upload a screenshot from a local file (composite)',
      description:
        'Composite tool. Reads localFilePath from disk, reserves an AppScreenshot under the given set with fileName + fileSize derived from the file, PUTs every uploadOperation chunk to Apple storage in sequence, then commits with sourceFileChecksum (md5 hex) + uploaded=true. Returns the final committed resource + a per-chunk summary. Tilde paths (~/...) are expanded. For manual control over each step, use the raw asc_post_app_screenshot + asc_upload_asset_chunk + asc_patch_app_screenshot tools instead.',
      inputSchema: z.object({
        appScreenshotSetId: AppScreenshotSetIdSchema,
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
        const fileName = input.fileName ?? resolvedPath.split('/').pop() ?? 'screenshot.png';

        const reserveBody = buildAppScreenshotCreateBody({
          appScreenshotSetId: input.appScreenshotSetId,
          fileName,
          fileSize,
        });
        const reserveResponse = await client.request<AssetReserveResponse>('/v1/appScreenshots', {
          method: 'POST',
          body: JSON.stringify(reserveBody),
        });
        const screenshotId = reserveResponse.data?.id;
        const operations = reserveResponse.data?.attributes?.uploadOperations ?? [];
        if (!screenshotId) {
          throw new Error('Reserve response missing screenshot id');
        }
        if (operations.length === 0) {
          throw new Error('Reserve response missing uploadOperations[] — cannot upload');
        }

        const executed = await executeAllUploadOperations(operations, resolvedPath);
        const checksum = await computeFileMd5Hex(resolvedPath);

        const commitBody = buildAppScreenshotPatchBody({
          appScreenshotId: screenshotId,
          sourceFileChecksum: checksum,
          uploaded: true,
        });
        const commitResponse = await client.request<unknown>(
          `/v1/appScreenshots/${encodeURIComponent(screenshotId)}`,
          { method: 'PATCH', body: JSON.stringify(commitBody) },
        );

        return {
          content: [
            {
              type: 'text',
              text: `Uploaded screenshot ${fileName} → AppScreenshot ${screenshotId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(commitResponse, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
