import { basename, extname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import { type CollectedPages, type Column, formatTable, paginate } from '../jsonapi.js';
import { AppIdSchema, BuildIdSchema, LocalFilePathSchema } from '../schemas.js';
import {
  computeFileMd5Hex,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
  type UploadOperation,
} from './asset-upload.js';

// Build uploads (App Store Connect API 4.1) — upload an .ipa / .pkg through
// the REST API instead of Transporter / altool.
//
//   1. POST /v1/buildUploads — the upload "slot": app + cfBundleShortVersionString
//      + cfBundleVersion + platform. state starts at AWAITING_UPLOAD.
//   2. POST /v1/buildUploadFiles — reserve one file in that slot: fileName,
//      fileSize, uti (com.apple.ipa / com.apple.pkg / …) and assetType (ASSET
//      = the binary; ASSET_DESCRIPTION / ASSET_SPI = Apple's optional sidecar
//      files). Returns uploadOperations[] like the screenshot reserve.
//   3. PUT each chunk to Apple storage — same as asset-upload.ts. The build
//      operations also carry partNumber / entityTag / expiration; none of them
//      needs sending back.
//   4. PATCH /v1/buildUploadFiles/{id} with uploaded=true and
//      sourceFileChecksums { file: { hash, algorithm: MD5 | SHA_256 } }. Note
//      the plural nested object, unlike the flat sourceFileChecksum string of
//      screenshots and IAP images.
//   5. Apple processes: the buildUpload moves PROCESSING → COMPLETE (with a
//      `build` relationship) or FAILED, with errors / warnings / infos in its
//      `state` object.
//
//   Live 2026-10-24: a COMPLETE upload's build id EQUALS the upload id, and a
//   slot abandoned before step 4 stays AWAITING_UPLOAD indefinitely (with a
//   null uploadedDate, so it sorts first under -uploadedDate).
//
// asc_upload_build wraps 1–4. DELETE exists only on buildUploads (to drop a
// slot), not on files.
//
// Build bundles: a processed build has one buildBundle per bundle inside it
// (the app, App Clips, extensions). There is no /v1/builds/{id}/buildBundles
// path — the bundles come from GET /v1/builds/{id}?include=buildBundles.

const UTIS = [
  'com.apple.ipa',
  'com.apple.pkg',
  'com.pkware.zip-archive',
  'com.apple.binary-property-list',
  'com.apple.xml-property-list',
] as const;

const ASSET_TYPES = ['ASSET', 'ASSET_DESCRIPTION', 'ASSET_SPI'] as const;

// Build uploads are the binary platforms only; no WATCH_OS (watch apps ride
// inside their iOS app).
export const BuildUploadPlatformSchema = z
  .enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'])
  .describe('Platform of the build. Watch apps upload inside their iOS app.');

export const BuildUploadIdSchema = z
  .string()
  .min(1)
  .describe('Build upload ID from asc_list_build_uploads or asc_post_build_upload.');

export const BuildUploadFileIdSchema = z
  .string()
  .min(1)
  .describe('Build upload file ID from asc_post_build_upload_file or asc_list_build_upload_files.');

export const BuildBundleIdSchema = z
  .string()
  .min(1)
  .describe(
    'Build bundle ID from asc_list_build_bundles (one per bundle inside a processed build).',
  );

const BUILD_UPLOAD_FIELDS =
  'cfBundleShortVersionString,cfBundleVersion,createdDate,state,platform,uploadedDate,build,assetFile';
const BUILD_UPLOAD_FILE_FIELDS =
  'assetDeliveryState,assetToken,assetType,fileName,fileSize,sourceFileChecksums,uploadOperations,uti';
const BUILD_BUNDLE_FIELDS =
  'bundleId,bundleType,fileName,minimumOsVersion,sdkBuild,platformBuild,supportedArchitectures,includesSymbols,appClipDomainCacheStatus,appClipDomainDebugStatus';

const SORTS = ['uploadedDate', '-uploadedDate', 'cfBundleVersion', '-cfBundleVersion'] as const;

// ----- Body + query builders -----

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface BuildUploadCreateInput {
  appId: string;
  cfBundleShortVersionString: string;
  cfBundleVersion: string;
  platform: z.infer<typeof BuildUploadPlatformSchema>;
}

export function buildBuildUploadBody(input: BuildUploadCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'buildUploads',
      attributes: {
        cfBundleShortVersionString: input.cfBundleShortVersionString,
        cfBundleVersion: input.cfBundleVersion,
        platform: input.platform,
      },
      relationships: { app: { data: { type: 'apps', id: input.appId } } },
    },
  };
}

export type BuildUploadUti = (typeof UTIS)[number];
export type BuildUploadAssetType = (typeof ASSET_TYPES)[number];

export interface BuildUploadFileCreateInput {
  buildUploadId: string;
  fileName: string;
  fileSize: number;
  uti: BuildUploadUti;
  assetType: BuildUploadAssetType;
}

export function buildBuildUploadFileBody(input: BuildUploadFileCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'buildUploadFiles',
      attributes: {
        assetType: input.assetType,
        fileName: input.fileName,
        fileSize: input.fileSize,
        uti: input.uti,
      },
      relationships: {
        buildUpload: { data: { type: 'buildUploads', id: input.buildUploadId } },
      },
    },
  };
}

export interface BuildUploadFileCommitInput {
  buildUploadFileId: string;
  uploaded?: boolean | undefined;
  checksum?: string | undefined;
  checksumAlgorithm?: 'MD5' | 'SHA_256' | undefined;
}

export function buildBuildUploadFileCommitBody(input: BuildUploadFileCommitInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.uploaded !== undefined) attributes.uploaded = input.uploaded;
  if (input.checksum !== undefined) {
    attributes.sourceFileChecksums = {
      file: { hash: input.checksum, algorithm: input.checksumAlgorithm ?? 'MD5' },
    };
  }
  if (Object.keys(attributes).length === 0) {
    throw new Error('Nothing to update: pass uploaded and/or checksum');
  }
  return { data: { type: 'buildUploadFiles', id: input.buildUploadFileId, attributes } };
}

/** UTI from the file extension; undefined when it can't be guessed. */
export function utiForFileName(fileName: string): BuildUploadUti | undefined {
  switch (extname(fileName).toLowerCase()) {
    case '.ipa':
      return 'com.apple.ipa';
    case '.pkg':
      return 'com.apple.pkg';
    case '.zip':
      return 'com.pkware.zip-archive';
    default:
      return undefined;
  }
}

export interface BuildUploadListQueryInput {
  cfBundleShortVersionString?: string[] | undefined;
  cfBundleVersion?: string[] | undefined;
  platform?: string[] | undefined;
  state?: string[] | undefined;
  sort?: string | undefined;
}

export function buildBuildUploadListQuery(input: BuildUploadListQueryInput): URLSearchParams {
  const params = new URLSearchParams();
  params.set('fields[buildUploads]', BUILD_UPLOAD_FIELDS);
  if (input.cfBundleShortVersionString?.length) {
    params.set('filter[cfBundleShortVersionString]', input.cfBundleShortVersionString.join(','));
  }
  if (input.cfBundleVersion?.length) {
    params.set('filter[cfBundleVersion]', input.cfBundleVersion.join(','));
  }
  if (input.platform?.length) params.set('filter[platform]', input.platform.join(','));
  if (input.state?.length) params.set('filter[state]', input.state.join(','));
  // The `build` linkage is only returned when included (live 2026-10-24:
  // BUILD_ID was blank on COMPLETE rows without it). Keep the payload small.
  params.set('include', 'build');
  params.set('fields[builds]', 'version');
  params.set('sort', input.sort ?? '-uploadedDate');
  params.set('limit', '200');
  return params;
}

// ----- Digests -----

function attr(r: { attributes?: Record<string, unknown> }, key: string): string {
  const v = r.attributes?.[key];
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function footer(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ' (truncated — pass maxItems to fetch more)' : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

interface UploadStateObject {
  state?: string;
  errors?: Array<{ code?: string; description?: string }>;
  warnings?: unknown[];
}

/** Flatten buildUpload.state ({ state, errors[], warnings[], infos[] }). */
export function buildUploadStateCell(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return typeof raw === 'string' ? raw : '';
  const s = raw as UploadStateObject;
  const parts = [s.state ?? ''];
  if (s.errors?.length) parts.push(`${s.errors.length} err: ${s.errors[0]?.code ?? ''}`);
  if (s.warnings?.length) parts.push(`${s.warnings.length} warn`);
  return parts.filter(Boolean).join(' · ');
}

export function digestBuildUploads(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'VERSION' },
    { header: 'BUILD' },
    { header: 'PLATFORM' },
    { header: 'STATE' },
    { header: 'UPLOADED' },
    { header: 'BUILD_ID' },
    { header: 'UPLOAD_ID' },
  ];
  const rows = pages.data.map((u) => {
    const build = u.relationships?.['build']?.data;
    return [
      attr(u, 'cfBundleShortVersionString'),
      attr(u, 'cfBundleVersion'),
      attr(u, 'platform'),
      buildUploadStateCell(u.attributes?.['state']),
      attr(u, 'uploadedDate') || attr(u, 'createdDate'),
      build && !Array.isArray(build) ? build.id : '',
      u.id,
    ];
  });
  return `${footer(pages, 'build uploads')}\n\n${formatTable(columns, rows)}`;
}

export function digestBuildUploadFiles(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'FILE' },
    { header: 'TYPE' },
    { header: 'UTI' },
    { header: 'BYTES', align: 'right' },
    { header: 'DELIVERY' },
    { header: 'FILE_ID' },
  ];
  const rows = pages.data.map((f) => [
    attr(f, 'fileName'),
    attr(f, 'assetType'),
    attr(f, 'uti'),
    attr(f, 'fileSize'),
    buildUploadStateCell(f.attributes?.['assetDeliveryState']),
    f.id,
  ]);
  return `${footer(pages, 'build upload files')}\n\n${formatTable(columns, rows)}`;
}

export function digestBuildBundleFileSizes(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'DEVICE' },
    { header: 'OS' },
    { header: 'DOWNLOAD_BYTES', align: 'right' },
    { header: 'INSTALL_BYTES', align: 'right' },
  ];
  const rows = pages.data.map((r) => [
    attr(r, 'deviceModel'),
    attr(r, 'osVersion'),
    attr(r, 'downloadBytes'),
    attr(r, 'installBytes'),
  ]);
  rows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return `${footer(pages, 'device size rows')}\n\n${formatTable(columns, rows)}`;
}

// ----- Helpers -----

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function errorResult(err: unknown) {
  return { content: [{ type: 'text' as const, text: formatASCError(err) }], isError: true };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

const StringListSchema = z.array(z.string().min(1)).min(1);

interface ReserveResponse {
  data?: { id?: string; attributes?: { uploadOperations?: UploadOperation[] } };
}

export function registerBuildUploads(server: McpServer, client: ASCClient): void {
  // ----- Build uploads -----

  server.registerTool(
    'asc_list_build_uploads',
    {
      title: 'List build uploads',
      description:
        "List an app's build uploads (binaries sent through the App Store Connect API, Xcode or Transporter), newest first: version, build number, platform, state (AWAITING_UPLOAD / PROCESSING / COMPLETE / FAILED, plus error and warning counts), upload date and the resulting build id once processed (it equals the upload id). Slots abandoned mid-upload stay AWAITING_UPLOAD and sort first; remove them with asc_delete_build_upload. Use it to watch a fresh upload finish processing or to read why one FAILED.",
      inputSchema: z.object({
        appId: AppIdSchema,
        cfBundleShortVersionString: StringListSchema.optional().describe(
          'Filter by marketing version, e.g. ["2.5"].',
        ),
        cfBundleVersion: StringListSchema.optional().describe(
          'Filter by build number, e.g. ["412"].',
        ),
        platform: z.array(BuildUploadPlatformSchema).min(1).optional(),
        state: z
          .array(z.enum(['AWAITING_UPLOAD', 'PROCESSING', 'FAILED', 'COMPLETE']))
          .min(1)
          .optional(),
        sort: z.enum(SORTS).optional().describe('Default -uploadedDate (newest first).'),
        maxItems: z.number().int().positive().max(2000).default(100),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw, ...filters }) => {
      const params = buildBuildUploadListQuery(filters);
      try {
        const pages = await paginate(
          client,
          `/v1/apps/${encodeURIComponent(appId)}/buildUploads?${params}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestBuildUploads(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_build_upload',
    {
      title: 'Get a build upload',
      description:
        'Fetch one build upload with its full state object (errors / warnings / infos with codes and descriptions), its files and, once processed, the build.',
      inputSchema: z.object({ buildUploadId: BuildUploadIdSchema }),
    },
    async ({ buildUploadId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/buildUploads/${encodeURIComponent(buildUploadId)}?include=build,assetFile,assetDescriptionFile,assetSpiFile`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_build_upload',
    {
      title: 'Create a build upload (raw step 1)',
      description:
        'RAW step 1 of a build upload: create the upload slot for an app + version + build number + platform. The version and build number must match the binary’s Info.plist (CFBundleShortVersionString / CFBundleVersion) and the build number must be new for that version. Next: asc_post_build_upload_file. asc_upload_build does all steps from a local file.',
      inputSchema: z.object({
        appId: AppIdSchema,
        cfBundleShortVersionString: z.string().min(1).describe('Marketing version, e.g. "2.5".'),
        cfBundleVersion: z.string().min(1).describe('Build number, e.g. "412".'),
        platform: BuildUploadPlatformSchema,
      }),
    },
    async (input) => {
      try {
        const data = await client.request<unknown>('/v1/buildUploads', {
          method: 'POST',
          body: JSON.stringify(buildBuildUploadBody(input)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_build_upload',
    {
      title: 'Delete a build upload',
      description:
        'Delete a build upload slot — e.g. one stuck in AWAITING_UPLOAD after an interrupted upload. It does not delete a processed build; expire builds with asc_patch_build.',
      inputSchema: z.object({ buildUploadId: BuildUploadIdSchema }),
    },
    async ({ buildUploadId }) => {
      try {
        await client.request<unknown>(`/v1/buildUploads/${encodeURIComponent(buildUploadId)}`, {
          method: 'DELETE',
        });
        return textResult(`Deleted build upload ${buildUploadId}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ----- Build upload files -----

  server.registerTool(
    'asc_list_build_upload_files',
    {
      title: 'List the files of a build upload',
      description:
        'List the files reserved in a build upload: name, asset type (ASSET = the binary), UTI, size and delivery state.',
      inputSchema: z.object({
        buildUploadId: BuildUploadIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildUploadId, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/buildUploads/${encodeURIComponent(buildUploadId)}/buildUploadFiles?fields[buildUploadFiles]=${BUILD_UPLOAD_FILE_FIELDS}&limit=200`,
          200,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestBuildUploadFiles(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_build_upload_file',
    {
      title: 'Get a build upload file',
      description:
        'Fetch one build upload file, including its uploadOperations (while awaiting upload) and assetDeliveryState.',
      inputSchema: z.object({ buildUploadFileId: BuildUploadFileIdSchema }),
    },
    async ({ buildUploadFileId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/buildUploadFiles/${encodeURIComponent(buildUploadFileId)}`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_build_upload_file',
    {
      title: 'Reserve a build upload file (raw step 2)',
      description:
        'RAW step 2: reserve one file in a build upload. Returns uploadOperations[] — PUT each chunk with asc_upload_asset_chunk, then commit with asc_patch_build_upload_file. assetType ASSET is the .ipa / .pkg itself.',
      inputSchema: z.object({
        buildUploadId: BuildUploadIdSchema,
        fileName: z.string().min(1),
        fileSize: z.number().int().positive(),
        uti: z
          .enum(UTIS)
          .describe('com.apple.ipa for iOS/tvOS/visionOS apps, com.apple.pkg for macOS.'),
        assetType: z.enum(ASSET_TYPES).default('ASSET'),
      }),
    },
    async (input) => {
      try {
        const data = await client.request<unknown>('/v1/buildUploadFiles', {
          method: 'POST',
          body: JSON.stringify(buildBuildUploadFileBody(input)),
        });
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_build_upload_file',
    {
      title: 'Commit a build upload file (raw step 4)',
      description:
        'RAW last step: mark a build upload file uploaded, with the whole file’s checksum (hex MD5 by default, or SHA_256). Apple then processes the build; follow it with asc_get_build_upload.',
      inputSchema: z.object({
        buildUploadFileId: BuildUploadFileIdSchema,
        uploaded: z.boolean().optional(),
        checksum: z.string().min(1).optional().describe('Hex digest of the full file.'),
        checksumAlgorithm: z.enum(['MD5', 'SHA_256']).optional().describe('Default MD5.'),
      }),
    },
    async (input) => {
      try {
        const body = buildBuildUploadFileCommitBody(input);
        const data = await client.request<unknown>(
          `/v1/buildUploadFiles/${encodeURIComponent(input.buildUploadFileId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_upload_build',
    {
      title: 'Upload a build from a local file',
      description:
        'Upload an .ipa or .pkg through the App Store Connect API in one call: create the build upload → reserve the file → PUT every chunk to Apple storage → commit with the file’s MD5. Version and build number must match the binary’s Info.plist and the build number must be new. Returns the upload id; Apple then processes it (minutes) — poll asc_get_build_upload or asc_list_build_uploads, which show the build id when COMPLETE or the error codes when FAILED. If a step fails after the slot exists, the slot id is reported so you can retry or asc_delete_build_upload it. dryRun checks the file and prints both request bodies without writing.',
      inputSchema: z.object({
        appId: AppIdSchema,
        localFilePath: LocalFilePathSchema,
        cfBundleShortVersionString: z.string().min(1).describe('Marketing version, e.g. "2.5".'),
        cfBundleVersion: z.string().min(1).describe('Build number, e.g. "412".'),
        platform: BuildUploadPlatformSchema,
        uti: z
          .enum(UTIS)
          .optional()
          .describe('Default from the extension: .ipa → com.apple.ipa, .pkg → com.apple.pkg.'),
        dryRun: z.boolean().default(false),
      }),
    },
    async ({
      appId,
      localFilePath,
      cfBundleShortVersionString,
      cfBundleVersion,
      platform,
      uti,
      dryRun,
    }) => {
      const filePath = expandHomePath(localFilePath);
      const fileName = basename(filePath);
      const resolvedUti = uti ?? utiForFileName(fileName);
      if (!resolvedUti) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Refused: cannot infer the UTI from "${fileName}". Pass uti (com.apple.ipa or com.apple.pkg).`,
            },
          ],
          isError: true,
        };
      }
      let fileSize: number;
      try {
        fileSize = await readFileSizeBytes(filePath);
      } catch (err) {
        return errorResult(err);
      }
      const uploadBody = buildBuildUploadBody({
        appId,
        cfBundleShortVersionString,
        cfBundleVersion,
        platform,
      });
      if (dryRun) {
        const fileBody = buildBuildUploadFileBody({
          buildUploadId: '<new build upload id>',
          fileName,
          fileSize,
          uti: resolvedUti,
          assetType: 'ASSET',
        });
        return textResult(
          `Dry run — ${filePath} (${fileSize} bytes).\n\nPOST /v1/buildUploads\n${JSON.stringify(uploadBody, null, 2)}\n\nPOST /v1/buildUploadFiles\n${JSON.stringify(fileBody, null, 2)}\n\nThen PUT the chunks and PATCH uploaded=true + MD5.`,
        );
      }
      let uploadId: string | undefined;
      try {
        const created = await client.request<{ data?: { id?: string } }>('/v1/buildUploads', {
          method: 'POST',
          body: JSON.stringify(uploadBody),
        });
        uploadId = created.data?.id;
        if (!uploadId) throw new Error('Apple returned no build upload id');
        const reserved = await client.request<ReserveResponse>('/v1/buildUploadFiles', {
          method: 'POST',
          body: JSON.stringify(
            buildBuildUploadFileBody({
              buildUploadId: uploadId,
              fileName,
              fileSize,
              uti: resolvedUti,
              assetType: 'ASSET',
            }),
          ),
        });
        const fileId = reserved.data?.id;
        const operations = reserved.data?.attributes?.uploadOperations ?? [];
        if (!fileId) throw new Error('Apple returned no build upload file id');
        if (operations.length === 0) throw new Error('Apple returned no uploadOperations');
        const executed = await executeAllUploadOperations(operations, filePath);
        const md5 = await computeFileMd5Hex(filePath);
        await client.request<unknown>(`/v1/buildUploadFiles/${encodeURIComponent(fileId)}`, {
          method: 'PATCH',
          body: JSON.stringify(
            buildBuildUploadFileCommitBody({
              buildUploadFileId: fileId,
              uploaded: true,
              checksum: md5,
              checksumAlgorithm: 'MD5',
            }),
          ),
        });
        return textResult(
          `${summarizeUpload(filePath, executed)}\nMD5: ${md5}\n\nBuild upload ${uploadId} (file ${fileId}) committed. Apple is processing it — check asc_get_build_upload ${uploadId}.`,
        );
      } catch (err) {
        const where = uploadId
          ? `\n\nBuild upload ${uploadId} was created; retry the remaining steps with the raw tools or remove it with asc_delete_build_upload.`
          : '';
        return {
          content: [{ type: 'text' as const, text: `${formatASCError(err)}${where}` }],
          isError: true,
        };
      }
    },
  );

  // ----- Build bundles -----

  server.registerTool(
    'asc_list_build_bundles',
    {
      title: 'List the bundles of a build',
      description:
        'List the bundles inside a processed build (the app, App Clips, extensions): bundle id, type, file name, minimum OS, SDK, architectures. The ids feed asc_list_build_bundle_file_sizes and the App Clip domain-status tools.',
      inputSchema: z.object({ buildId: BuildIdSchema }),
    },
    async ({ buildId }) => {
      try {
        const res = await client.request<{
          included?: Array<{ type: string; id: string; attributes?: Record<string, unknown> }>;
        }>(
          `/v1/builds/${encodeURIComponent(buildId)}?include=buildBundles&fields[builds]=buildBundles&fields[buildBundles]=${BUILD_BUNDLE_FIELDS}&limit[buildBundles]=50`,
          { method: 'GET' },
        );
        const bundles = (res.included ?? []).filter((r) => r.type === 'buildBundles');
        const columns: Column[] = [
          { header: 'BUNDLE_ID' },
          { header: 'TYPE' },
          { header: 'FILE' },
          { header: 'MIN_OS' },
          { header: 'SDK' },
          { header: 'BUILD_BUNDLE_ID' },
        ];
        const rows = bundles.map((b) => [
          attr(b, 'bundleId'),
          attr(b, 'bundleType'),
          attr(b, 'fileName'),
          attr(b, 'minimumOsVersion'),
          attr(b, 'sdkBuild'),
          b.id,
        ]);
        return textResult(`${bundles.length} build bundles\n\n${formatTable(columns, rows)}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_list_build_bundle_file_sizes',
    {
      title: 'List download and install sizes of a build bundle',
      description:
        "Per-device download and install sizes of a build bundle (App Thinning variants) — the numbers behind App Store Connect's App File Sizes page and the 200 MB cellular-download limit.",
      inputSchema: z.object({
        buildBundleId: BuildBundleIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildBundleId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/buildBundles/${encodeURIComponent(buildBundleId)}/buildBundleFileSizes?limit=200`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestBuildBundleFileSizes(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_build_bundle_app_clip_domain_status',
    {
      title: 'Get App Clip domain status of a build bundle',
      description:
        "Validation status of an App Clip bundle's associated domains (per domain: valid or the error, e.g. CANNOT_REACH_AASA_FILE, BAD_JSON_CONTENT). kind=cache reads Apple's CDN-cached result (what devices see); kind=debug reads the live developer-mode check. Only App Clip bundles have this.",
      inputSchema: z.object({
        buildBundleId: BuildBundleIdSchema,
        kind: z.enum(['cache', 'debug']).default('cache'),
      }),
    },
    async ({ buildBundleId, kind }) => {
      const rel = kind === 'cache' ? 'appClipDomainCacheStatus' : 'appClipDomainDebugStatus';
      try {
        const data = await client.request<unknown>(
          `/v1/buildBundles/${encodeURIComponent(buildBundleId)}/${rel}`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_list_build_bundle_beta_app_clip_invocations',
    {
      title: 'List TestFlight App Clip invocations of a build bundle',
      description:
        'List the TestFlight App Clip invocations (URL + localized titles) configured on an App Clip build bundle — the entries testers tap to launch the clip.',
      inputSchema: z.object({
        buildBundleId: BuildBundleIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildBundleId, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/buildBundles/${encodeURIComponent(buildBundleId)}/betaAppClipInvocations?include=betaAppClipInvocationLocalizations&limit=200`,
          200,
        );
        if (raw) return textResult(JSON.stringify(pages, null, 2));
        const titles = new Map(pages.included.map((r) => [r.id, r]));
        const columns: Column[] = [
          { header: 'URL' },
          { header: 'TITLES' },
          { header: 'INVOCATION_ID' },
        ];
        const rows = pages.data.map((inv) => {
          const locs = inv.relationships?.['betaAppClipInvocationLocalizations']?.data;
          const t = (Array.isArray(locs) ? locs : [])
            .map((l) => titles.get(l.id))
            .filter((l) => l !== undefined)
            .map((l) => `${attr(l, 'locale')}: ${attr(l, 'title')}`)
            .join('; ');
          return [attr(inv, 'url'), t, inv.id];
        });
        return textResult(
          `${footer(pages, 'App Clip invocations')}\n\n${formatTable(columns, rows)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
