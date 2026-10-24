import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import {
  buildIncludedIndex,
  type CollectedPages,
  type Column,
  formatTable,
  type JSONAPIResource,
  lookupIncluded,
  paginate,
} from '../jsonapi.js';
import { AppIdSchema, FileNameSchema, LocalFilePathSchema } from '../schemas.js';
import {
  computeFileMd5Hex,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
  type UploadOperation,
} from './asset-upload.js';

// Background Assets — Apple-hosted asset packs (App Store Connect API 4.5.1).
//
// Hierarchy:
//   app → backgroundAssets (one per asset pack; assetPackIdentifier is fixed)
//     → versions (backgroundAssetVersions; numbered by Apple, no attributes at
//       create — POST is relationships-only)
//         → backgroundAssetUploadFiles (the ASSET archive and its MANIFEST,
//           three-step upload: reserve → PUT chunks → commit)
//         → internalBetaRelease / externalBetaRelease / appStoreRelease (read
//           only; the state of that version on each distribution track)
//   A backgroundAsset points at the version live on each track
//   (internalBetaVersion / externalBetaVersion / appStoreVersion).
//
// Wire notes pinned by tests/background-assets-body.test.ts:
//   * The version create body has NO attributes block.
//   * Upload files are reserved with assetType (ASSET | MANIFEST) + fileName +
//     fileSize. Their uploadOperations are DeliveryFileUploadOperations (adds
//     partNumber / expiration / entityTag) but carry the same method, url,
//     offset, length and requestHeaders, so the shared chunk PUT works.
//   * The commit uses `sourceFileChecksums` (plural, an object:
//     { file: { hash, algorithm: MD5 | SHA_256 } }) — the singular
//     `sourceFileChecksum` string is deprecated on this resource. The
//     composite sends the file's hex MD5.
//   * PATCH backgroundAssets takes only `archived`.

const PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] as const;
const VERSION_STATES = ['AWAITING_UPLOAD', 'PROCESSING', 'FAILED', 'COMPLETE'] as const;
const INTERNAL_RELEASE_STATES = ['READY_FOR_TESTING', 'SUPERSEDED'] as const;
const EXTERNAL_RELEASE_STATES = [
  'READY_FOR_BETA_SUBMISSION',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'REJECTED',
  'PROCESSING_FOR_TESTING',
  'READY_FOR_TESTING',
  'SUPERSEDED',
] as const;
const APP_STORE_RELEASE_STATES = [
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'ACCEPTED',
  'REJECTED',
  'PROCESSING_FOR_DISTRIBUTION',
  'READY_FOR_DISTRIBUTION',
  'SUPERSEDED',
] as const;
const ASSET_TYPES = ['ASSET', 'MANIFEST'] as const;
const CHECKSUM_ALGORITHMS = ['MD5', 'SHA_256'] as const;

const RELEASE = {
  internalBeta: {
    type: 'backgroundAssetVersionInternalBetaReleases',
    rel: 'internalBetaRelease',
  },
  externalBeta: {
    type: 'backgroundAssetVersionExternalBetaReleases',
    rel: 'externalBetaRelease',
  },
  appStore: { type: 'backgroundAssetVersionAppStoreReleases', rel: 'appStoreRelease' },
} as const;

type ReleaseTrack = keyof typeof RELEASE;

// ----- Schemas -----

const BackgroundAssetIdSchema = z
  .string()
  .min(1)
  .describe('BackgroundAsset ID from asc_list_background_assets (one per asset pack).');
const BackgroundAssetVersionIdSchema = z
  .string()
  .min(1)
  .describe('BackgroundAssetVersion ID from asc_list_background_asset_versions.');
const UploadFileIdSchema = z
  .string()
  .min(1)
  .describe('BackgroundAssetUploadFile ID from asc_list_background_asset_upload_files.');
const AssetTypeSchema = z
  .enum(ASSET_TYPES)
  .describe('ASSET (the asset pack archive) or MANIFEST (its manifest file).');
const FileSizeSchema = z.number().int().positive().describe('File size in bytes.');

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export function buildBackgroundAssetCreateBody(input: {
  appId: string;
  assetPackIdentifier: string;
}): JSONAPIBody {
  return {
    data: {
      type: 'backgroundAssets',
      attributes: { assetPackIdentifier: input.assetPackIdentifier },
      relationships: { app: { data: { type: 'apps', id: input.appId } } },
    },
  };
}

export function buildBackgroundAssetPatchBody(id: string, archived: boolean): JSONAPIBody {
  return { data: { type: 'backgroundAssets', id, attributes: { archived } } };
}

export function buildBackgroundAssetVersionCreateBody(backgroundAssetId: string): JSONAPIBody {
  // Relationships only: Apple numbers the version itself.
  return {
    data: {
      type: 'backgroundAssetVersions',
      relationships: {
        backgroundAsset: { data: { type: 'backgroundAssets', id: backgroundAssetId } },
      },
    },
  };
}

export function buildUploadFileReserveBody(input: {
  versionId: string;
  assetType: (typeof ASSET_TYPES)[number];
  fileName: string;
  fileSize: number;
}): JSONAPIBody {
  return {
    data: {
      type: 'backgroundAssetUploadFiles',
      attributes: {
        assetType: input.assetType,
        fileName: input.fileName,
        fileSize: input.fileSize,
      },
      relationships: {
        backgroundAssetVersion: { data: { type: 'backgroundAssetVersions', id: input.versionId } },
      },
    },
  };
}

export interface UploadFileCommitInput {
  id: string;
  checksum?: string | undefined;
  checksumAlgorithm?: (typeof CHECKSUM_ALGORITHMS)[number] | undefined;
  uploaded?: boolean | undefined;
}

export function buildUploadFileCommitBody(input: UploadFileCommitInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.checksum !== undefined) {
    attributes.sourceFileChecksums = {
      file: { hash: input.checksum, algorithm: input.checksumAlgorithm ?? 'MD5' },
    };
  } else if (input.checksumAlgorithm !== undefined) {
    throw new Error('checksumAlgorithm needs checksum');
  }
  if (input.uploaded !== undefined) attributes.uploaded = input.uploaded;
  if (Object.keys(attributes).length === 0) {
    throw new Error('Nothing to update: pass checksum and/or uploaded');
  }
  return { data: { type: 'backgroundAssetUploadFiles', id: input.id, attributes } };
}

// ----- Query builders -----

export interface BackgroundAssetListQueryInput {
  archived?: boolean | undefined;
  assetPackIdentifier?: string[] | undefined;
  locale?: string[] | undefined;
  platforms?: Array<(typeof PLATFORMS)[number]> | undefined;
  sort?: string | undefined;
}

export function buildBackgroundAssetListQuery(input: BackgroundAssetListQueryInput) {
  const params = new URLSearchParams();
  if (input.archived !== undefined) params.set('filter[archived]', String(input.archived));
  if (input.assetPackIdentifier?.length) {
    params.set('filter[assetPackIdentifier]', input.assetPackIdentifier.join(','));
  }
  if (input.locale?.length) params.set('filter[versions.locale]', input.locale.join(','));
  if (input.platforms?.length) {
    params.set('filter[versions.platforms]', input.platforms.join(','));
  }
  if (input.sort) params.set('sort', input.sort);
  params.set('include', 'appStoreVersion,internalBetaVersion,externalBetaVersion');
  params.set('fields[backgroundAssetVersions]', 'version,state');
  params.set('limit', '200');
  return params;
}

export interface VersionListQueryInput {
  locale?: string[] | undefined;
  platforms?: Array<(typeof PLATFORMS)[number]> | undefined;
  state?: Array<(typeof VERSION_STATES)[number]> | undefined;
  version?: string[] | undefined;
  internalBetaReleaseState?: Array<(typeof INTERNAL_RELEASE_STATES)[number]> | undefined;
  externalBetaReleaseState?: Array<(typeof EXTERNAL_RELEASE_STATES)[number]> | undefined;
  appStoreReleaseState?: Array<(typeof APP_STORE_RELEASE_STATES)[number]> | undefined;
  sort?: string | undefined;
}

export function buildVersionListQuery(input: VersionListQueryInput) {
  const params = new URLSearchParams();
  if (input.locale?.length) params.set('filter[locale]', input.locale.join(','));
  if (input.platforms?.length) params.set('filter[platforms]', input.platforms.join(','));
  if (input.state?.length) params.set('filter[state]', input.state.join(','));
  if (input.version?.length) params.set('filter[version]', input.version.join(','));
  if (input.internalBetaReleaseState?.length) {
    params.set('filter[internalBetaRelease.state]', input.internalBetaReleaseState.join(','));
  }
  if (input.externalBetaReleaseState?.length) {
    params.set('filter[externalBetaRelease.state]', input.externalBetaReleaseState.join(','));
  }
  if (input.appStoreReleaseState?.length) {
    params.set('filter[appStoreRelease.state]', input.appStoreReleaseState.join(','));
  }
  if (input.sort) params.set('sort', input.sort);
  params.set('include', 'internalBetaRelease,externalBetaRelease,appStoreRelease');
  params.set('limit', '200');
  return params;
}

// ----- Digests -----

function attr<T>(r: JSONAPIResource, key: string): T | undefined {
  return r.attributes?.[key] as T | undefined;
}

function relId(r: JSONAPIResource, key: string): string | undefined {
  const d = r.relationships?.[key]?.data;
  if (!d || Array.isArray(d)) return undefined;
  return d.id;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function footer(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ' (truncated — set raw:true or raise maxItems)' : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

function table(pages: CollectedPages, label: string, columns: Column[], rows: string[][]): string {
  if (pages.data.length === 0) return `0 ${label}`;
  return `${footer(pages, label)}\n\n${formatTable(columns, rows)}`;
}

export function digestBackgroundAssets(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const versionOf = (asset: JSONAPIResource, key: string): string => {
    const id = relId(asset, key);
    const v = lookupIncluded(index, 'backgroundAssetVersions', id);
    return v ? str(attr(v, 'version')) : str(id);
  };
  const rows = pages.data.map((a) => [
    str(attr(a, 'assetPackIdentifier')),
    attr(a, 'archived') ? 'yes' : '',
    str(attr(a, 'usedBytes')),
    versionOf(a, 'internalBetaVersion'),
    versionOf(a, 'externalBetaVersion'),
    versionOf(a, 'appStoreVersion'),
    str(attr(a, 'createdDate')).slice(0, 10),
    a.id,
  ]);
  return table(
    pages,
    'background assets',
    [
      { header: 'ASSET_PACK' },
      { header: 'ARCHIVED' },
      { header: 'USED_BYTES', align: 'right' },
      { header: 'INTERNAL' },
      { header: 'EXTERNAL' },
      { header: 'APP_STORE' },
      { header: 'CREATED' },
      { header: 'ID' },
    ],
    rows,
  );
}

export function digestBackgroundAssetVersions(pages: CollectedPages): string {
  const index = buildIncludedIndex(pages.included);
  const releaseState = (v: JSONAPIResource, track: ReleaseTrack): string => {
    const id = relId(v, RELEASE[track].rel);
    const r = lookupIncluded(index, RELEASE[track].type, id);
    return r ? str(attr(r, 'state')) : '';
  };
  const rows = pages.data.map((v) => [
    str(attr(v, 'version')),
    str(attr(v, 'state')),
    str(attr<string[]>(v, 'platforms')?.join(',')),
    str(attr(v, 'locale')),
    releaseState(v, 'internalBeta'),
    releaseState(v, 'externalBeta'),
    releaseState(v, 'appStore'),
    str(attr(v, 'createdDate')).slice(0, 10),
    v.id,
  ]);
  return table(
    pages,
    'background asset versions',
    [
      { header: 'VERSION' },
      { header: 'STATE' },
      { header: 'PLATFORMS' },
      { header: 'LOCALE' },
      { header: 'INTERNAL' },
      { header: 'EXTERNAL' },
      { header: 'APP_STORE' },
      { header: 'CREATED' },
      { header: 'ID' },
    ],
    rows,
  );
}

export function digestBackgroundAssetUploadFiles(pages: CollectedPages): string {
  const rows = pages.data.map((f) => [
    str(attr(f, 'assetType')),
    str(attr(f, 'fileName')),
    str(attr(f, 'fileSize')),
    str(attr<{ state?: string }>(f, 'assetDeliveryState')?.state),
    f.id,
  ]);
  return table(
    pages,
    'upload files',
    [
      { header: 'TYPE' },
      { header: 'FILE' },
      { header: 'BYTES', align: 'right' },
      { header: 'DELIVERY' },
      { header: 'ID' },
    ],
    rows,
  );
}

// ----- Tool plumbing -----

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

const MaxItemsSchema = z.number().int().positive().max(2000).default(200);

interface UploadFileReserveResponse {
  data?: { id?: string; attributes?: { uploadOperations?: UploadOperation[] } };
}

export function registerBackgroundAssets(server: McpServer, client: ASCClient): void {
  async function getJson(path: string) {
    try {
      const data = await client.request<unknown>(path, { method: 'GET' });
      return textResult(JSON.stringify(data, null, 2));
    } catch (err) {
      return errorResult(err);
    }
  }

  async function send(method: 'POST' | 'PATCH', path: string, body: unknown, done: string) {
    try {
      const data = await client.request<unknown>(path, { method, body: JSON.stringify(body) });
      return textResult(`${done}\n\n${JSON.stringify(data ?? null, null, 2)}`);
    } catch (err) {
      return errorResult(err);
    }
  }

  // ----- Asset packs -----

  server.registerTool(
    'asc_list_background_assets',
    {
      title: "List an app's background assets (asset packs)",
      description:
        "List an app's Apple-hosted background asset packs. Each row: assetPackIdentifier, archived, storage used, and the version number live on each track (internal TestFlight, external TestFlight, App Store). Filters: archived, assetPackIdentifier, and the locale / platforms of the pack's versions.",
      inputSchema: z.object({
        appId: AppIdSchema,
        archived: z.boolean().optional(),
        assetPackIdentifier: z.array(z.string().min(1)).min(1).optional(),
        locale: z.array(z.string().min(1)).min(1).optional(),
        platforms: z.array(z.enum(PLATFORMS)).min(1).optional(),
        sort: z
          .enum(['assetPackIdentifier', '-assetPackIdentifier', 'createdDate', '-createdDate'])
          .optional(),
        maxItems: MaxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw, ...filters }) => {
      const params = buildBackgroundAssetListQuery(filters);
      try {
        const pages = await paginate(
          client,
          `/v1/apps/${encodeURIComponent(appId)}/backgroundAssets?${params.toString()}`,
          maxItems,
        );
        return textResult(raw ? JSON.stringify(pages, null, 2) : digestBackgroundAssets(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_background_asset',
    {
      title: 'Get a background asset (asset pack)',
      description:
        'Fetch one asset pack with the versions live on each track (internal beta, external beta, App Store) included.',
      inputSchema: z.object({ backgroundAssetId: BackgroundAssetIdSchema }),
    },
    async ({ backgroundAssetId }) =>
      getJson(
        `/v1/backgroundAssets/${encodeURIComponent(backgroundAssetId)}?include=appStoreVersion,internalBetaVersion,externalBetaVersion`,
      ),
  );

  server.registerTool(
    'asc_post_background_asset',
    {
      title: 'Create a background asset (asset pack)',
      description:
        "Register an Apple-hosted asset pack for an app. assetPackIdentifier must match the ID in the pack's manifest and cannot change later. Then create a version (asc_post_background_asset_version) and upload its files (asc_upload_background_asset_file).",
      inputSchema: z.object({
        appId: AppIdSchema,
        assetPackIdentifier: z.string().min(1),
      }),
    },
    async (input) =>
      send(
        'POST',
        '/v1/backgroundAssets',
        buildBackgroundAssetCreateBody(input),
        `Created asset pack ${input.assetPackIdentifier}.`,
      ),
  );

  server.registerTool(
    'asc_patch_background_asset',
    {
      title: 'Archive or restore a background asset',
      description:
        'Archive (archived=true) or restore (archived=false) an asset pack. archived is the only mutable field. ⚠️ Archiving stops serving the pack to new installs.',
      inputSchema: z.object({ backgroundAssetId: BackgroundAssetIdSchema, archived: z.boolean() }),
    },
    async ({ backgroundAssetId, archived }) =>
      send(
        'PATCH',
        `/v1/backgroundAssets/${encodeURIComponent(backgroundAssetId)}`,
        buildBackgroundAssetPatchBody(backgroundAssetId, archived),
        `${archived ? 'Archived' : 'Restored'} asset pack ${backgroundAssetId}.`,
      ),
  );

  // ----- Versions -----

  server.registerTool(
    'asc_list_background_asset_versions',
    {
      title: 'List background asset versions',
      description:
        "List an asset pack's versions: version number, processing state (AWAITING_UPLOAD → PROCESSING → COMPLETE / FAILED), platforms, locale, and the release state on each track (internal beta, external beta, App Store). Filters on each of those.",
      inputSchema: z.object({
        backgroundAssetId: BackgroundAssetIdSchema,
        state: z.array(z.enum(VERSION_STATES)).min(1).optional(),
        platforms: z.array(z.enum(PLATFORMS)).min(1).optional(),
        locale: z.array(z.string().min(1)).min(1).optional(),
        version: z.array(z.string().min(1)).min(1).optional(),
        internalBetaReleaseState: z.array(z.enum(INTERNAL_RELEASE_STATES)).min(1).optional(),
        externalBetaReleaseState: z.array(z.enum(EXTERNAL_RELEASE_STATES)).min(1).optional(),
        appStoreReleaseState: z.array(z.enum(APP_STORE_RELEASE_STATES)).min(1).optional(),
        sort: z.enum(['version', '-version']).default('-version'),
        maxItems: MaxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ backgroundAssetId, maxItems, raw, ...filters }) => {
      const params = buildVersionListQuery(filters);
      try {
        const pages = await paginate(
          client,
          `/v1/backgroundAssets/${encodeURIComponent(backgroundAssetId)}/versions?${params.toString()}`,
          maxItems,
        );
        return textResult(
          raw ? JSON.stringify(pages, null, 2) : digestBackgroundAssetVersions(pages),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_background_asset_version',
    {
      title: 'Get a background asset version',
      description:
        'Fetch one asset pack version with its release states, asset file and manifest file included. stateDetails explains a FAILED version.',
      inputSchema: z.object({ versionId: BackgroundAssetVersionIdSchema }),
    },
    async ({ versionId }) =>
      getJson(
        `/v1/backgroundAssetVersions/${encodeURIComponent(versionId)}?include=backgroundAsset,internalBetaRelease,externalBetaRelease,appStoreRelease,assetFile,manifestFile`,
      ),
  );

  server.registerTool(
    'asc_post_background_asset_version',
    {
      title: 'Create a background asset version',
      description:
        'Start a new version of an asset pack. Apple assigns the version number. The version waits in AWAITING_UPLOAD until its files are uploaded with asc_upload_background_asset_file (the ASSET archive, and the MANIFEST if your pack has one).',
      inputSchema: z.object({ backgroundAssetId: BackgroundAssetIdSchema }),
    },
    async ({ backgroundAssetId }) =>
      send(
        'POST',
        '/v1/backgroundAssetVersions',
        buildBackgroundAssetVersionCreateBody(backgroundAssetId),
        `Created a version of asset pack ${backgroundAssetId}.`,
      ),
  );

  server.registerTool(
    'asc_get_background_asset_version_release',
    {
      title: 'Get a background asset version release',
      description:
        "Fetch the release record of an asset pack version on one track: internalBeta (READY_FOR_TESTING / SUPERSEDED), externalBeta (READY_FOR_BETA_SUBMISSION → … → READY_FOR_TESTING) or appStore (PREPARE_FOR_SUBMISSION → … → READY_FOR_DISTRIBUTION). The release ID is in the version's internalBetaRelease / externalBetaRelease / appStoreRelease relationship (asc_get_background_asset_version).",
      inputSchema: z.object({
        track: z.enum(['internalBeta', 'externalBeta', 'appStore']),
        releaseId: z.string().min(1),
      }),
    },
    async ({ track, releaseId }) =>
      getJson(
        `/v1/${RELEASE[track].type}/${encodeURIComponent(releaseId)}?include=backgroundAssetVersion`,
      ),
  );

  // ----- Upload files -----

  server.registerTool(
    'asc_list_background_asset_upload_files',
    {
      title: 'List background asset upload files',
      description:
        'List the files of an asset pack version: assetType (ASSET / MANIFEST), file name, size and delivery state (AWAITING_UPLOAD → UPLOAD_COMPLETE → COMPLETE / FAILED).',
      inputSchema: z.object({
        versionId: BackgroundAssetVersionIdSchema,
        maxItems: MaxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ versionId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/backgroundAssetVersions/${encodeURIComponent(versionId)}/backgroundAssetUploadFiles?limit=200`,
          maxItems,
        );
        return textResult(
          raw ? JSON.stringify(pages, null, 2) : digestBackgroundAssetUploadFiles(pages),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_background_asset_upload_file',
    {
      title: 'Get a background asset upload file',
      description:
        'Fetch one upload file: assetType, fileName, fileSize, assetDeliveryState (with errors), and uploadOperations[] while AWAITING_UPLOAD.',
      inputSchema: z.object({ uploadFileId: UploadFileIdSchema }),
    },
    async ({ uploadFileId }) =>
      getJson(`/v1/backgroundAssetUploadFiles/${encodeURIComponent(uploadFileId)}`),
  );

  server.registerTool(
    'asc_post_background_asset_upload_file',
    {
      title: 'Reserve a background asset file upload (raw step 1)',
      description:
        'RAW step 1 of the asset pack file upload: reserves assetType (ASSET / MANIFEST) + fileName + fileSize on a version and returns uploadOperations[]. PUT each with asc_upload_asset_chunk, then commit with asc_patch_background_asset_upload_file. Most callers should use asc_upload_background_asset_file.',
      inputSchema: z.object({
        versionId: BackgroundAssetVersionIdSchema,
        assetType: AssetTypeSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
      }),
    },
    async (input) =>
      send(
        'POST',
        '/v1/backgroundAssetUploadFiles',
        buildUploadFileReserveBody(input),
        `Reserved ${input.assetType} ${input.fileName} (${input.fileSize} bytes). Next: PUT each uploadOperation, then PATCH checksum + uploaded=true.`,
      ),
  );

  server.registerTool(
    'asc_patch_background_asset_upload_file',
    {
      title: 'Commit a background asset file upload (raw step 3)',
      description:
        "RAW step 3: commit an upload file with the whole file's checksum (sent as sourceFileChecksums.file — hex MD5 by default, or SHA_256) and uploaded=true. Pass at least one.",
      inputSchema: z.object({
        uploadFileId: UploadFileIdSchema,
        checksum: z.string().min(1).optional().describe('Lowercase hex digest of the whole file.'),
        checksumAlgorithm: z.enum(CHECKSUM_ALGORITHMS).optional().describe('Default MD5.'),
        uploaded: z.boolean().optional(),
      }),
    },
    async ({ uploadFileId, ...rest }) => {
      try {
        return send(
          'PATCH',
          `/v1/backgroundAssetUploadFiles/${encodeURIComponent(uploadFileId)}`,
          buildUploadFileCommitBody({ id: uploadFileId, ...rest }),
          `Patched upload file ${uploadFileId}.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_upload_background_asset_file',
    {
      title: 'Upload a background asset file (composite)',
      description:
        "Composite tool. Reads localFilePath, reserves it on an asset pack version as assetType ASSET (the pack archive) or MANIFEST, PUTs every chunk to Apple storage, then commits with the file's MD5 + uploaded=true. Apple then processes the version (asc_get_background_asset_version shows state and any errors).",
      inputSchema: z.object({
        versionId: BackgroundAssetVersionIdSchema,
        assetType: AssetTypeSchema,
        localFilePath: LocalFilePathSchema,
        fileName: FileNameSchema.optional().describe('Defaults to basename(localFilePath).'),
      }),
    },
    async ({ versionId, assetType, localFilePath, fileName }) => {
      const resolvedPath = expandHomePath(localFilePath);
      try {
        const fileSize = await readFileSizeBytes(resolvedPath);
        const name = fileName ?? resolvedPath.split('/').pop() ?? 'asset-pack';
        const reserved = await client.request<UploadFileReserveResponse>(
          '/v1/backgroundAssetUploadFiles',
          {
            method: 'POST',
            body: JSON.stringify(
              buildUploadFileReserveBody({ versionId, assetType, fileName: name, fileSize }),
            ),
          },
        );
        const fileId = reserved.data?.id;
        const operations = reserved.data?.attributes?.uploadOperations ?? [];
        if (!fileId) throw new Error('Reserve response missing upload file id');
        if (operations.length === 0) {
          throw new Error('Reserve response missing uploadOperations[] — cannot upload');
        }
        const executed = await executeAllUploadOperations(operations, resolvedPath);
        const checksum = await computeFileMd5Hex(resolvedPath);
        const committed = await client.request<unknown>(
          `/v1/backgroundAssetUploadFiles/${encodeURIComponent(fileId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(
              buildUploadFileCommitBody({ id: fileId, checksum, uploaded: true }),
            ),
          },
        );
        return textResult(
          `Uploaded ${name} → ${assetType} upload file ${fileId} on version ${versionId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(committed, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
