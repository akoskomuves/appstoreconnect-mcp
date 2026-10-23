import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestAssetLibraryImages,
  digestAssetLibraryPlacements,
  digestAssetLibraryRefData,
  digestAssetLibraryVideos,
} from '../digest.js';
import { ASCError } from '../errors.js';
import { type JSONAPIResource, paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AssetLibraryAssetCategorySchema,
  AssetLibraryAssetStateSchema,
  AssetLibraryIdSchema,
  AssetLibraryImageIdSchema,
  AssetLibraryPlacementGroupSchema,
  AssetLibraryPlacementIdSchema,
  AssetLibraryPlacementTypeSchema,
  AssetLibraryVideoIdSchema,
  AssetPlacementOrderingParentTypeSchema,
  AssetPlacementParentTypeSchema,
  FileNameSchema,
  FileSizeSchema,
  LocalFilePathSchema,
} from '../schemas.js';
import {
  type AssetReserveResponse,
  executeAllUploadOperations,
  expandHomePath,
  readFileSizeBytes,
  summarizeUpload,
} from './asset-upload.js';

// App Asset Library (App Store Connect API 4.5.1) — replaces the screenshot
// sets, preview sets and in-app event screenshots / video clips.
//
// The model: upload an image or video ONCE to the app's library, then put it
// on the store with a placement (one asset × one localization × one
// placementType + placementGroup slot). The same asset can be placed on many
// localizations, CPPs, experiment treatments and events.
//
//   * Library id == app id (live 2026-10-23). GET /v1/apps/{id}/assetLibrary
//     returns { type: appAssetLibraries, id: <app id> }. The composite upload
//     still resolves it through that GET rather than assume it.
//
//   * Image/Video create: required attrs = { fileName, fileSize, category };
//     required relationship = assetLibrary. Reserve returns uploadOperations[]
//     like the legacy AppScreenshot. Optional `placements` relationship is not
//     exposed — placements are created against an asset, not the other way.
//
//   * Image/Video update: { archived, referenceName, uploaded } (+ video
//     previewFrameTimeCode). There is NO sourceFileChecksum — the commit is
//     uploaded=true alone, unlike the legacy flow.
//
//   * Placement create is an anyOf of (image | video) × (appEventLocalization
//     | appStoreVersionLocalization | appCustomProductPageLocalization |
//     appStoreVersionExperimentTreatmentLocalization) — exactly one of each.
//     Attributes: placementType (required) + placementGroup.
//
//   * Ordering request: placementGroup (required) + orderedPlacements[] + one
//     of three parents (no event localization).
//
//   * appAssetLibraryRefData rejects `limit` (400 PARAMETER_ERROR.ILLEGAL,
//     live 2026-10-23) and returns one row. Never paginate it.
//
//   * Placement state: live rows carry `ACTIVE` and `INACTIVE`, which the
//     4.5.1 spec enum (ASSET_PROCESSING, FAILED, PARENT_*) does not list.
//     Filters take free strings for that reason.

const IMAGE_FIELDS =
  'category,createdDate,lastModifiedDate,fileName,fileSize,imageAsset,referenceName,specId,state,stateDetails,placements';
const VIDEO_FIELDS =
  'category,createdDate,lastModifiedDate,fileName,fileSize,previewFrameImage,previewFrameTimeCode,referenceName,specId,state,stateDetails,videoAsset,placements';
const PLACEMENT_FIELDS =
  'mediaType,placementType,placementGroup,createdDate,lastModifiedDate,state,stateDetails,image,video';
const PLACED_IMAGE_FIELDS = 'fileName,referenceName,state';
const PLACED_VIDEO_FIELDS = 'fileName,referenceName,state';

const ASSET_SORTS = [
  'createdDate',
  '-createdDate',
  'lastModifiedDate',
  '-lastModifiedDate',
  'referenceName',
  '-referenceName',
] as const;

const PLACEMENT_SORTS = [
  'createdDate',
  '-createdDate',
  'lastModifiedDate',
  '-lastModifiedDate',
  'placementGroupPosition',
  '-placementGroupPosition',
] as const;

const REF_DATA_SECTIONS = [
  'features',
  'placementProfileGroups',
  'imageSpecs',
  'videoSpecs',
  'placementTypes',
  'displayClasses',
] as const;

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

type MediaKind = 'image' | 'video';

const MEDIA = {
  image: { type: 'appAssetLibraryImages', path: '/v1/appAssetLibraryImages', label: 'image' },
  video: { type: 'appAssetLibraryVideos', path: '/v1/appAssetLibraryVideos', label: 'video' },
} as const;

// Plural resource type → singular relationship key on the placement /
// ordering-request bodies.
const PARENT_REL_KEY = {
  appStoreVersionLocalizations: 'appStoreVersionLocalization',
  appCustomProductPageLocalizations: 'appCustomProductPageLocalization',
  appStoreVersionExperimentTreatmentLocalizations: 'appStoreVersionExperimentTreatmentLocalization',
  appEventLocalizations: 'appEventLocalization',
} as const;

export type AssetPlacementParentType = keyof typeof PARENT_REL_KEY;
export type AssetPlacementOrderingParentType = Exclude<
  AssetPlacementParentType,
  'appEventLocalizations'
>;

// ----- Body builders -----

export interface AssetLibraryAssetCreateInput {
  kind: MediaKind;
  assetLibraryId: string;
  fileName: string;
  fileSize: number;
  category: 'APP_SCREENSHOTS_AND_PREVIEWS' | 'CREATIVE_ASSETS';
  referenceName?: string | undefined;
  previewFrameTimeCode?: string | undefined;
}

export function buildAssetLibraryAssetCreateBody(input: AssetLibraryAssetCreateInput): JSONAPIBody {
  if (input.kind === 'image' && input.previewFrameTimeCode !== undefined) {
    throw new Error('previewFrameTimeCode applies to videos only');
  }
  const attributes: Record<string, unknown> = {
    fileName: input.fileName,
    fileSize: input.fileSize,
    category: input.category,
  };
  if (input.referenceName !== undefined) attributes.referenceName = input.referenceName;
  if (input.previewFrameTimeCode !== undefined) {
    attributes.previewFrameTimeCode = input.previewFrameTimeCode;
  }
  return {
    data: {
      type: MEDIA[input.kind].type,
      attributes,
      relationships: {
        assetLibrary: { data: { type: 'appAssetLibraries', id: input.assetLibraryId } },
      },
    },
  };
}

export interface AssetLibraryAssetPatchInput {
  kind: MediaKind;
  id: string;
  uploaded?: boolean | undefined;
  archived?: boolean | undefined;
  referenceName?: string | undefined;
  previewFrameTimeCode?: string | undefined;
}

export function buildAssetLibraryAssetPatchBody(input: AssetLibraryAssetPatchInput): JSONAPIBody {
  if (input.kind === 'image' && input.previewFrameTimeCode !== undefined) {
    throw new Error('previewFrameTimeCode applies to videos only');
  }
  const attributes: Record<string, unknown> = {};
  if (input.uploaded !== undefined) attributes.uploaded = input.uploaded;
  if (input.archived !== undefined) attributes.archived = input.archived;
  if (input.referenceName !== undefined) attributes.referenceName = input.referenceName;
  if (input.previewFrameTimeCode !== undefined) {
    attributes.previewFrameTimeCode = input.previewFrameTimeCode;
  }
  if (Object.keys(attributes).length === 0) {
    throw new Error(
      'Nothing to update: pass at least one of uploaded, archived, referenceName or previewFrameTimeCode',
    );
  }
  return { data: { type: MEDIA[input.kind].type, id: input.id, attributes } };
}

export interface AssetLibraryPlacementCreateInput {
  placementType: string;
  placementGroup?: string | undefined;
  imageId?: string | undefined;
  videoId?: string | undefined;
  parentType: AssetPlacementParentType;
  parentLocalizationId: string;
}

export function buildAssetLibraryPlacementCreateBody(
  input: AssetLibraryPlacementCreateInput,
): JSONAPIBody {
  if ((input.imageId === undefined) === (input.videoId === undefined)) {
    throw new Error('Pass exactly one of imageId or videoId');
  }
  const attributes: Record<string, unknown> = { placementType: input.placementType };
  if (input.placementGroup !== undefined) attributes.placementGroup = input.placementGroup;
  const media =
    input.imageId !== undefined
      ? { image: { data: { type: MEDIA.image.type, id: input.imageId } } }
      : { video: { data: { type: MEDIA.video.type, id: input.videoId } } };
  return {
    data: {
      type: 'appAssetLibraryPlacements',
      attributes,
      relationships: {
        ...media,
        [PARENT_REL_KEY[input.parentType]]: {
          data: { type: input.parentType, id: input.parentLocalizationId },
        },
      },
    },
  };
}

export interface AssetLibraryPlacementOrderingInput {
  placementGroup: string;
  orderedPlacementIds: string[];
  parentType: AssetPlacementOrderingParentType;
  parentLocalizationId: string;
}

export function buildAssetLibraryPlacementOrderingBody(
  input: AssetLibraryPlacementOrderingInput,
): JSONAPIBody {
  if (input.orderedPlacementIds.length === 0) {
    throw new Error('orderedPlacementIds must list at least one placement');
  }
  if (new Set(input.orderedPlacementIds).size !== input.orderedPlacementIds.length) {
    throw new Error('orderedPlacementIds contains duplicates');
  }
  return {
    data: {
      type: 'appAssetLibraryPlacementOrderingRequests',
      attributes: { placementGroup: input.placementGroup },
      relationships: {
        orderedPlacements: {
          data: input.orderedPlacementIds.map((id) => ({ type: 'appAssetLibraryPlacements', id })),
        },
        [PARENT_REL_KEY[input.parentType]]: {
          data: { type: input.parentType, id: input.parentLocalizationId },
        },
      },
    },
  };
}

// ----- Query builders -----

export interface AssetListQueryInput {
  kind: MediaKind;
  category?: string[] | undefined;
  state?: string[] | undefined;
  referenceName?: string[] | undefined;
  specId?: string[] | undefined;
  sort?: string | undefined;
  includePlacements?: boolean | undefined;
}

export function buildAssetListQuery(input: AssetListQueryInput): URLSearchParams {
  const params = new URLSearchParams();
  if (input.kind === 'image') {
    params.set('fields[appAssetLibraryImages]', IMAGE_FIELDS);
  } else {
    params.set('fields[appAssetLibraryVideos]', VIDEO_FIELDS);
  }
  if (input.category?.length) params.set('filter[category]', input.category.join(','));
  if (input.state?.length) params.set('filter[state]', input.state.join(','));
  if (input.referenceName?.length) {
    params.set('filter[referenceName]', input.referenceName.join(','));
  }
  if (input.specId?.length) params.set('filter[specId]', input.specId.join(','));
  if (input.sort) params.set('sort', input.sort);
  if (input.includePlacements) {
    // Only the relationship linkage + paging total are needed for the PLACED
    // column; keep the included placement payload small.
    params.set('include', 'placements');
    params.set('fields[appAssetLibraryPlacements]', 'placementType');
    params.set('limit[placements]', '50');
  }
  params.set('limit', '200');
  return params;
}

export interface PlacementListQueryInput {
  placementType?: string[] | undefined;
  placementGroup?: string[] | undefined;
  state?: string[] | undefined;
  sort?: string | undefined;
}

export function buildPlacementListQuery(input: PlacementListQueryInput): URLSearchParams {
  const params = new URLSearchParams();
  params.set('fields[appAssetLibraryPlacements]', PLACEMENT_FIELDS);
  params.set('include', 'image,video');
  params.set('fields[appAssetLibraryImages]', PLACED_IMAGE_FIELDS);
  params.set('fields[appAssetLibraryVideos]', PLACED_VIDEO_FIELDS);
  if (input.placementType?.length) {
    params.set('filter[placementType]', input.placementType.join(','));
  }
  if (input.placementGroup?.length) {
    params.set('filter[placementGroup]', input.placementGroup.join(','));
  }
  if (input.state?.length) params.set('filter[state]', input.state.join(','));
  if (input.sort) params.set('sort', input.sort);
  params.set('limit', '200');
  return params;
}

export interface RefDataQueryInput {
  sections?: string[] | undefined;
  placementTypes?: string[] | undefined;
  placementProfileGroups?: string[] | undefined;
  features?: string[] | undefined;
  specs?: string[] | undefined;
}

export function buildRefDataQuery(input: RefDataQueryInput): URLSearchParams {
  // No `limit` — Apple rejects it on this endpoint (400 PARAMETER_ERROR.ILLEGAL).
  const params = new URLSearchParams();
  if (input.sections?.length)
    params.set('fields[appAssetLibraryRefData]', input.sections.join(','));
  if (input.placementTypes?.length) {
    params.set('filter[placementTypes]', input.placementTypes.join(','));
  }
  if (input.placementProfileGroups?.length) {
    params.set('filter[placementProfileGroups]', input.placementProfileGroups.join(','));
  }
  if (input.features?.length) params.set('filter[features]', input.features.join(','));
  if (input.specs?.length) params.set('filter[specs]', input.specs.join(','));
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

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

export function registerAssetLibrary(server: McpServer, client: ASCClient): void {
  // ----- Library + ref data -----

  server.registerTool(
    'asc_get_app_asset_library',
    {
      title: "Get an app's App Asset Library",
      description:
        'Fetch the App Asset Library of an app (App Store Connect API 4.5.1). Every app has exactly one; its id is the app id. The library holds uploaded images and videos; they reach the store only through placements. Next: asc_list_asset_library_images / asc_list_asset_library_videos, or asc_get_asset_library_ref_data for what sizes and counts each device slot accepts.',
      inputSchema: z.object({ appId: AppIdSchema }),
    },
    async ({ appId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/apps/${encodeURIComponent(appId)}/assetLibrary`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_asset_library_ref_data',
    {
      title: 'Get App Asset Library reference data',
      description:
        "Apple's catalog of what the App Asset Library accepts, as data: placement groups per device (IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE, IPAD_13_PROFILE, IPHONE_DUO_PROFILE, …), the max number of assets per (feature, placementType, group) — e.g. 10 screenshots per iPhone group — and the image/video specs (pixel sizes, aspect, formats, fps, duration) each group takes. One row; not paginated. The full document is ~130 KB, so narrow it: `sections` picks parts, the filters pick placement types / groups / features / spec ids. Example: placementProfileGroups=['IPHONE_DUO_PROFILE'] shows the iPhone Duo slot (sizes 1398x2034 and 2853x2007, portrait or landscape, shared 10-screenshot limit). Pass refDataId to fetch one row by id instead.",
      inputSchema: z.object({
        sections: z
          .array(z.enum(REF_DATA_SECTIONS))
          .min(1)
          .optional()
          .describe('Which parts to return (fields[appAssetLibraryRefData]). Default: all.'),
        placementTypes: StringListSchema.optional().describe(
          'filter[placementTypes], e.g. APP_SCREENSHOT.',
        ),
        placementProfileGroups: StringListSchema.optional().describe(
          'filter[placementProfileGroups], e.g. IPHONE_DUO_PROFILE.',
        ),
        features: StringListSchema.optional().describe(
          'filter[features], e.g. APP_STORE_VERSIONS, CUSTOM_PRODUCT_PAGES, IN_APP_EVENTS.',
        ),
        specs: StringListSchema.optional().describe(
          'filter[specs] — spec ids from imageSpecs / videoSpecs.',
        ),
        refDataId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Fetch GET /v1/appAssetLibraryRefData/{id} instead of the collection. Filters are ignored.',
          ),
        raw: z.boolean().default(false),
      }),
    },
    async ({
      sections,
      placementTypes,
      placementProfileGroups,
      features,
      specs,
      refDataId,
      raw,
    }) => {
      const sectionParams = buildRefDataQuery({ sections });
      const path = refDataId
        ? withQuery(`/v1/appAssetLibraryRefData/${encodeURIComponent(refDataId)}`, sectionParams)
        : withQuery(
            '/v1/appAssetLibraryRefData',
            buildRefDataQuery({
              sections,
              placementTypes,
              placementProfileGroups,
              features,
              specs,
            }),
          );
      try {
        const doc = await client.request<{ data?: JSONAPIResource | JSONAPIResource[] }>(path, {
          method: 'GET',
        });
        if (raw) return textResult(JSON.stringify(doc, null, 2));
        const rows = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
        if (rows.length === 0) return textResult('No ref data returned.');
        return textResult(rows.map((r) => digestAssetLibraryRefData(r)).join('\n\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ----- Images + videos (reads) -----

  for (const kind of ['image', 'video'] as const) {
    const m = MEDIA[kind];
    const plural = `${m.label}s`;
    const IdSchema = kind === 'image' ? AssetLibraryImageIdSchema : AssetLibraryVideoIdSchema;

    server.registerTool(
      `asc_list_asset_library_${plural}`,
      {
        title: `List App Asset Library ${plural}`,
        description: `List the ${plural} in an app's App Asset Library (API 4.5.1). Each row: reference name, category, ${kind === 'image' ? 'pixel size' : 'poster frame time code + size'}, state (AWAITING_UPLOAD → UPLOAD_COMPLETE → COMPLETE, then the review states; ARCHIVED for retired assets) and how many placements use it (with includePlacements). Assets migrated from the legacy ${kind === 'image' ? 'screenshot sets' : 'preview sets'} appear here too. Filters: category, state, referenceName, specId. Default excludes nothing — pass state to hide ARCHIVED.`,
        inputSchema: z.object({
          assetLibraryId: AssetLibraryIdSchema,
          category: z.array(AssetLibraryAssetCategorySchema).min(1).optional(),
          state: z.array(AssetLibraryAssetStateSchema).min(1).optional(),
          referenceName: StringListSchema.optional(),
          specId: StringListSchema.optional(),
          sort: z.enum(ASSET_SORTS).default('-createdDate'),
          includePlacements: z
            .boolean()
            .default(true)
            .describe('Include the placement count per asset (PLACED column).'),
          maxItems: z.number().int().positive().max(2000).default(200),
          raw: z.boolean().default(false),
        }),
      },
      async (input) => {
        const params = buildAssetListQuery({ kind, ...input });
        const path = `/v1/appAssetLibraries/${encodeURIComponent(input.assetLibraryId)}/${plural}?${params.toString()}`;
        try {
          const pages = await paginate(client, path, input.maxItems);
          if (input.raw) return textResult(JSON.stringify(pages, null, 2));
          return textResult(
            kind === 'image' ? digestAssetLibraryImages(pages) : digestAssetLibraryVideos(pages),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_get_asset_library_${m.label}`,
      {
        title: `Get an App Asset Library ${m.label}`,
        description: `Fetch one App Asset Library ${m.label} with its placements included. Shows state + stateDetails (why processing or review failed), the spec it matched (specId), ${kind === 'image' ? 'the imageAsset template URL' : 'the videoAsset URL and poster frame'}, and — while AWAITING_UPLOAD — the uploadOperations[] still to PUT.`,
        inputSchema: z.object({ id: IdSchema }),
      },
      async ({ id }) => {
        const params = new URLSearchParams();
        params.set('include', 'placements');
        params.set('fields[appAssetLibraryPlacements]', PLACEMENT_FIELDS);
        params.set('limit[placements]', '50');
        try {
          const data = await client.request<unknown>(
            `${m.path}/${encodeURIComponent(id)}?${params.toString()}`,
            { method: 'GET' },
          );
          return textResult(JSON.stringify(data, null, 2));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      `asc_list_asset_library_${m.label}_placements`,
      {
        title: `List where a library ${m.label} is placed`,
        description: `List every placement of one App Asset Library ${m.label}: which placementType + group slot, its state, and its position in that group. Use before archiving or deleting an asset to see what still shows it.`,
        inputSchema: z.object({
          id: IdSchema,
          maxItems: z.number().int().positive().max(2000).default(200),
          raw: z.boolean().default(false),
        }),
      },
      async ({ id, maxItems, raw }) => {
        const params = buildPlacementListQuery({});
        const path = `${m.path}/${encodeURIComponent(id)}/placements?${params.toString()}`;
        try {
          const pages = await paginate(client, path, maxItems);
          if (raw) return textResult(JSON.stringify(pages, null, 2));
          return textResult(digestAssetLibraryPlacements(pages));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  // ----- Images + videos (writes) -----

  server.registerTool(
    'asc_post_asset_library_image',
    {
      title: 'Reserve an App Asset Library image upload (raw step 1)',
      description:
        "RAW step 1 of the library upload. Reserves an image in the app's library (fileName + fileSize + category) and returns it with uploadOperations[]. PUT each with asc_upload_asset_chunk, then commit with asc_patch_asset_library_image uploaded=true (no checksum in this API). Most callers should use the composite asc_upload_asset_library_image.",
      inputSchema: z.object({
        assetLibraryId: AssetLibraryIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
        category: AssetLibraryAssetCategorySchema.default('APP_SCREENSHOTS_AND_PREVIEWS'),
        referenceName: z
          .string()
          .min(1)
          .optional()
          .describe("Name shown in the library. Defaults to fileName on Apple's side."),
      }),
    },
    async (input) => {
      try {
        const body = buildAssetLibraryAssetCreateBody({ kind: 'image', ...input });
        const data = await client.request<unknown>(MEDIA.image.path, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return textResult(
          `Reserved library image ${input.fileName} (${input.fileSize} bytes). Next: PUT each uploadOperation, then PATCH uploaded=true.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_asset_library_video',
    {
      title: 'Reserve an App Asset Library video upload (raw step 1)',
      description:
        'RAW step 1 of the library upload for a video (app preview or event video). Reserves it with fileName + fileSize + category (+ optional previewFrameTimeCode, the poster frame as HH:MM:SS:FF) and returns uploadOperations[]. PUT each with asc_upload_asset_chunk, then commit with asc_patch_asset_library_video uploaded=true. Most callers should use asc_upload_asset_library_video.',
      inputSchema: z.object({
        assetLibraryId: AssetLibraryIdSchema,
        fileName: FileNameSchema,
        fileSize: FileSizeSchema,
        category: AssetLibraryAssetCategorySchema.default('APP_SCREENSHOTS_AND_PREVIEWS'),
        referenceName: z.string().min(1).optional(),
        previewFrameTimeCode: z
          .string()
          .min(1)
          .optional()
          .describe('Poster frame, e.g. "00:00:05:01".'),
      }),
    },
    async (input) => {
      try {
        const body = buildAssetLibraryAssetCreateBody({ kind: 'video', ...input });
        const data = await client.request<unknown>(MEDIA.video.path, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return textResult(
          `Reserved library video ${input.fileName} (${input.fileSize} bytes). Next: PUT each uploadOperation, then PATCH uploaded=true.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_asset_library_image',
    {
      title: 'Update an App Asset Library image',
      description:
        'PATCH a library image: uploaded=true commits a reservation (raw step 3), archived=true retires it from the library without deleting it (archived=false restores), referenceName renames it. Pass at least one.',
      inputSchema: z.object({
        imageId: AssetLibraryImageIdSchema,
        uploaded: z.boolean().optional(),
        archived: z.boolean().optional(),
        referenceName: z.string().min(1).optional(),
      }),
    },
    async ({ imageId, ...rest }) => {
      try {
        const body = buildAssetLibraryAssetPatchBody({ kind: 'image', id: imageId, ...rest });
        const data = await client.request<unknown>(
          `${MEDIA.image.path}/${encodeURIComponent(imageId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return textResult(`Patched library image ${imageId}.\n\n${JSON.stringify(data, null, 2)}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_asset_library_video',
    {
      title: 'Update an App Asset Library video',
      description:
        'PATCH a library video: uploaded=true commits a reservation (raw step 3), archived=true retires it (archived=false restores), referenceName renames it, previewFrameTimeCode moves the poster frame. Pass at least one.',
      inputSchema: z.object({
        videoId: AssetLibraryVideoIdSchema,
        uploaded: z.boolean().optional(),
        archived: z.boolean().optional(),
        referenceName: z.string().min(1).optional(),
        previewFrameTimeCode: z.string().min(1).optional(),
      }),
    },
    async ({ videoId, ...rest }) => {
      try {
        const body = buildAssetLibraryAssetPatchBody({ kind: 'video', id: videoId, ...rest });
        const data = await client.request<unknown>(
          `${MEDIA.video.path}/${encodeURIComponent(videoId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return textResult(`Patched library video ${videoId}.\n\n${JSON.stringify(data, null, 2)}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  for (const kind of ['image', 'video'] as const) {
    const m = MEDIA[kind];
    const IdSchema = kind === 'image' ? AssetLibraryImageIdSchema : AssetLibraryVideoIdSchema;
    server.registerTool(
      `asc_delete_asset_library_${m.label}`,
      {
        title: `Delete an App Asset Library ${m.label}`,
        description: `DELETE a ${m.label} from the app's library. Check asc_list_asset_library_${m.label}_placements first: a placed asset is what the store shows. To retire an asset but keep it, PATCH archived=true instead.`,
        inputSchema: z.object({ id: IdSchema }),
      },
      async ({ id }) => {
        try {
          await client.request<unknown>(`${m.path}/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          });
          return textResult(`Deleted library ${m.label} ${id}.`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  // ----- Composite uploads -----

  interface UploadInput {
    appId: string;
    localFilePath: string;
    category: 'APP_SCREENSHOTS_AND_PREVIEWS' | 'CREATIVE_ASSETS';
    fileName?: string | undefined;
    referenceName?: string | undefined;
    previewFrameTimeCode?: string | undefined;
  }

  async function uploadAsset(kind: MediaKind, input: UploadInput) {
    const m = MEDIA[kind];
    const resolvedPath = expandHomePath(input.localFilePath);
    try {
      const library = await client.request<{ data?: { id?: string } }>(
        `/v1/apps/${encodeURIComponent(input.appId)}/assetLibrary`,
        { method: 'GET' },
      );
      const assetLibraryId = library.data?.id;
      if (!assetLibraryId) throw new Error(`App ${input.appId} returned no asset library`);

      const fileSize = await readFileSizeBytes(resolvedPath);
      const fileName = input.fileName ?? resolvedPath.split('/').pop() ?? `asset.${kind}`;
      const reserveBody = buildAssetLibraryAssetCreateBody({
        kind,
        assetLibraryId,
        fileName,
        fileSize,
        category: input.category,
        referenceName: input.referenceName,
        previewFrameTimeCode: input.previewFrameTimeCode,
      });
      const reserved = await client.request<AssetReserveResponse>(m.path, {
        method: 'POST',
        body: JSON.stringify(reserveBody),
      });
      const assetId = reserved.data?.id;
      const operations = reserved.data?.attributes?.uploadOperations ?? [];
      if (!assetId) throw new Error(`Reserve response missing ${m.label} id`);
      if (operations.length === 0) {
        throw new Error('Reserve response missing uploadOperations[] — cannot upload');
      }

      const executed = await executeAllUploadOperations(operations, resolvedPath);
      const commitBody = buildAssetLibraryAssetPatchBody({ kind, id: assetId, uploaded: true });
      const committed = await client.request<unknown>(`${m.path}/${encodeURIComponent(assetId)}`, {
        method: 'PATCH',
        body: JSON.stringify(commitBody),
      });
      return textResult(
        `Uploaded ${fileName} → library ${m.label} ${assetId}. Next: asc_post_asset_library_placement with ${kind}Id=${assetId}.\n\n${summarizeUpload(resolvedPath, executed)}\n\nCommit response:\n${JSON.stringify(committed, null, 2)}`,
      );
    } catch (err) {
      return errorResult(err);
    }
  }

  const uploadBase = {
    appId: AppIdSchema.describe('App whose library receives the asset (library id == app id).'),
    localFilePath: LocalFilePathSchema,
    category: AssetLibraryAssetCategorySchema.default('APP_SCREENSHOTS_AND_PREVIEWS'),
    fileName: FileNameSchema.optional().describe('Defaults to basename(localFilePath).'),
    referenceName: z.string().min(1).optional(),
  };

  server.registerTool(
    'asc_upload_asset_library_image',
    {
      title: 'Upload an image to the App Asset Library (composite)',
      description:
        "Composite tool. Reads localFilePath, reserves a library image in the app's App Asset Library, PUTs every chunk to Apple storage, then commits with uploaded=true. Returns the committed image (UPLOAD_COMPLETE, then COMPLETE once Apple processes it and matches it to a spec). Uploading does not show it anywhere: follow with asc_post_asset_library_placement. Replaces asc_upload_screenshot / asc_upload_app_event_screenshot from the deprecated set-based API.",
      inputSchema: z.object(uploadBase),
    },
    async (input) => uploadAsset('image', input),
  );

  server.registerTool(
    'asc_upload_asset_library_video',
    {
      title: 'Upload a video to the App Asset Library (composite)',
      description:
        "Composite tool. Reads localFilePath, reserves a library video (app preview or event video) in the app's App Asset Library, PUTs every chunk to Apple storage, then commits with uploaded=true. Optional previewFrameTimeCode sets the poster frame. Uploading does not show it anywhere: follow with asc_post_asset_library_placement. Replaces asc_upload_app_preview / asc_upload_app_event_video_clip from the deprecated set-based API.",
      inputSchema: z.object({
        ...uploadBase,
        previewFrameTimeCode: z
          .string()
          .min(1)
          .optional()
          .describe('Poster frame, e.g. "00:00:05:01".'),
      }),
    },
    async (input) => uploadAsset('video', input),
  );

  // ----- Placements -----

  server.registerTool(
    'asc_list_localization_placements',
    {
      title: 'List the asset placements on a localization',
      description:
        "List the App Asset Library placements on one localization — what a version / Custom Product Page / experiment treatment / in-app event localization shows, per placementType and device group, in storefront order. The replacement for listing screenshot sets + screenshots (and event screenshots / video clips). Each row names the placed asset. Filter by placementType (APP_SCREENSHOT, APP_PREVIEW, EVENT_CARD_ASSET, …), placementGroup (IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE, …) or state. Live rows use ACTIVE / INACTIVE, which Apple's spec does not list.",
      inputSchema: z.object({
        parentType: AssetPlacementParentTypeSchema,
        parentLocalizationId: z.string().min(1),
        placementType: z.array(AssetLibraryPlacementTypeSchema).min(1).optional(),
        placementGroup: StringListSchema.optional(),
        state: StringListSchema.optional().describe(
          'ASSET_PROCESSING, FAILED, PARENT_PREPARE_FOR_SUBMISSION, PARENT_READY_FOR_REVIEW, PARENT_WAITING_FOR_REVIEW, PARENT_IN_REVIEW, PARENT_APPROVED, plus ACTIVE and INACTIVE (seen live, not in the spec).',
        ),
        sort: z.enum(PLACEMENT_SORTS).default('placementGroupPosition'),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ parentType, parentLocalizationId, maxItems, raw, ...filters }) => {
      const params = buildPlacementListQuery(filters);
      const path = `/v1/${parentType}/${encodeURIComponent(parentLocalizationId)}/placements?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        if (raw) return textResult(JSON.stringify(pages, null, 2));
        return textResult(digestAssetLibraryPlacements(pages));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_get_asset_library_placement',
    {
      title: 'Get an App Asset Library placement',
      description:
        'Fetch one placement with its asset and parent localization included: placementType, placementGroup, mediaType, state and stateDetails.',
      inputSchema: z.object({ placementId: AssetLibraryPlacementIdSchema }),
    },
    async ({ placementId }) => {
      const params = new URLSearchParams();
      params.set('fields[appAssetLibraryPlacements]', PLACEMENT_FIELDS);
      params.set('include', 'image,video');
      try {
        const data = await client.request<unknown>(
          `/v1/appAssetLibraryPlacements/${encodeURIComponent(placementId)}?${params.toString()}`,
          { method: 'GET' },
        );
        return textResult(JSON.stringify(data, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_asset_library_placement',
    {
      title: 'Place a library asset on a localization',
      description:
        'Put one App Asset Library image or video on one localization in a placementType + placementGroup slot — the replacement for creating a screenshot/preview set and uploading into it. Pass exactly one of imageId / videoId and the parent localization. The group is the device profile (IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE, IPAD_13_PROFILE, IPHONE_DUO_PROFILE, DEFAULT_PROFILE for event assets); asc_get_asset_library_ref_data lists the groups, their size specs and max counts. The asset must match a spec the group accepts. The new placement goes last in its group; reorder with asc_post_asset_library_placement_ordering_request. ⚠️ Changes what the store shows for that localization once its parent ships — only an editable (PREPARE_FOR_SUBMISSION-type) version, CPP version, treatment or event takes new placements.',
      inputSchema: z.object({
        placementType: AssetLibraryPlacementTypeSchema,
        placementGroup: AssetLibraryPlacementGroupSchema.optional(),
        imageId: AssetLibraryImageIdSchema.optional(),
        videoId: AssetLibraryVideoIdSchema.optional(),
        parentType: AssetPlacementParentTypeSchema,
        parentLocalizationId: z.string().min(1),
      }),
    },
    async (input) => {
      try {
        const body = buildAssetLibraryPlacementCreateBody(input);
        const data = await client.request<unknown>('/v1/appAssetLibraryPlacements', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return textResult(
          `Placed ${input.imageId ? `image ${input.imageId}` : `video ${input.videoId}`} as ${input.placementType}${input.placementGroup ? `/${input.placementGroup}` : ''} on ${input.parentType}/${input.parentLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_asset_library_placement',
    {
      title: 'Remove a placement',
      description:
        'DELETE a placement: takes the asset off that localization slot. The asset itself stays in the library (and on any other placements).',
      inputSchema: z.object({ placementId: AssetLibraryPlacementIdSchema }),
    },
    async ({ placementId }) => {
      try {
        await client.request<unknown>(
          `/v1/appAssetLibraryPlacements/${encodeURIComponent(placementId)}`,
          { method: 'DELETE' },
        );
        return textResult(`Deleted placement ${placementId}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'asc_post_asset_library_placement_ordering_request',
    {
      title: 'Reorder the placements in a group',
      description:
        'Set the display order of the placements in ONE placementGroup on one localization (version, Custom Product Page or experiment treatment — events have no ordering). orderedPlacementIds is the new order, first = first on the store; pass every placement in that group (get them from asc_list_localization_placements filtered to the group). Replaces reordering screenshots inside a set.',
      inputSchema: z.object({
        parentType: AssetPlacementOrderingParentTypeSchema,
        parentLocalizationId: z.string().min(1),
        placementGroup: AssetLibraryPlacementGroupSchema,
        orderedPlacementIds: z.array(AssetLibraryPlacementIdSchema).min(1),
      }),
    },
    async (input) => {
      try {
        const body = buildAssetLibraryPlacementOrderingBody(input);
        const params = new URLSearchParams();
        params.set('include', 'orderedPlacements');
        params.set('fields[appAssetLibraryPlacements]', PLACEMENT_FIELDS);
        const data = await client.request<unknown>(
          `/v1/appAssetLibraryPlacementOrderingRequests?${params.toString()}`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        return textResult(
          `Reordered ${input.orderedPlacementIds.length} placements in ${input.placementGroup} on ${input.parentType}/${input.parentLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
