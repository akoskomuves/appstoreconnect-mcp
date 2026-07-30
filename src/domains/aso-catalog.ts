import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAppCategories, digestAppTags, digestSearchKeywords } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  AppTagIdSchema,
  LocaleSchema,
  PlatformSchema,
  VisibleInAppStoreSchema,
} from '../schemas.js';

// Apple's structured-ASO catalog surfaces (v0.12.0 read + minimal write):
//
//   AppCategory       — Apple's category catalog. Read-only. Each category
//                       carries `platforms` and a parent → subcategories
//                       relationship tree. Use to resolve human-readable
//                       category names → category IDs for asc_patch_app_info.
//
//   AppTag            — Apple's structured tag catalog applied per app per
//                       territory. List per app (existing tag membership)
//                       and PATCH `isVisibleInAppStore` (toggle whether the
//                       tag shows in the App Store search/product page UI
//                       without removing it from the app). Tag membership
//                       management (add/remove from an app via the App.
//                       appTags linkage) is deferred to v0.12.1.
//
//   SearchKeywords    — Apple's aggregated search-keyword surface
//                       (/v1/apps/{id}/searchKeywords). Read-only; surfaces
//                       AppKeyword IDs across all locales × platforms.
//                       Actual keyword writes still happen via the per-
//                       version keywords field on AppStoreVersionLocalization
//                       (v0.10).
//
// Wire-key gotcha (verified against AvdLee Swift SDK):
//   - AppTag: Swift `isVisibleInAppStore` → wire `visibleInAppStore`
//     (is-prefix stripped — same pattern as autoRenewEnabled,
//     demoAccountRequired, etc.)

const APP_CATEGORY_FIELDS = 'platforms';
const APP_TAG_FIELDS = 'name,visibleInAppStore';
// AppKeyword has NO attributes per Apple's contract — only id + links.
// Verified live: passing `fields[appKeywords]=keyword` returns 400
// PARAMETER_ERROR.INVALID "'keyword' is not a valid field name". Don't
// emit a sparse fieldset for this resource at all — the ID is the
// keyword content.

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
  };
}

// ----- AppTag PATCH body -----

export interface AppTagPatchInput {
  appTagId: string;
  visibleInAppStore: boolean;
}

export function buildAppTagPatchBody(input: AppTagPatchInput): JSONAPIBody {
  // Apple's AppTagUpdateRequest accepts ONLY visibleInAppStore (the
  // stripped wire key). Body builder hard-codes the field name to the
  // wire form; tests assert the all-camel (NOT Swift's isVisibleInAppStore)
  // is what gets emitted.
  return {
    data: {
      type: 'appTags',
      id: input.appTagId,
      attributes: { visibleInAppStore: input.visibleInAppStore },
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

export function registerAsoCatalog(server: McpServer, client: ASCClient): void {
  // ----- AppCategory (1 tool) -----

  server.registerTool(
    'asc_list_app_categories',
    {
      title: 'List App Store category catalog',
      description:
        "List Apple's App Store category catalog with subcategories included. Read-only. Each category carries the platforms it applies to (IOS/MAC_OS/TV_OS/VISION_OS); subcategories are returned in `included[]` via the parent → subcategories relationship. Use to resolve human-readable category names to category IDs before calling asc_patch_app_info to set primary/secondary categories. " +
        'Categories are app-scope, not app-store-version-scope — changing them mutates the AppInfo record.',
      inputSchema: z.object({
        platform: PlatformSchema.optional().describe(
          'Optional filter — narrow to categories applicable to one platform.',
        ),
        maxItems: z.number().int().positive().max(1000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ platform, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appCategories]', APP_CATEGORY_FIELDS);
      params.set('include', 'subcategories');
      params.set('limit', '200');
      if (platform) params.set('filter[platforms]', platform);
      const path = `/v1/appCategories?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppCategories(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- AppTag (2 tools) -----

  server.registerTool(
    'asc_list_app_tags',
    {
      title: 'List structured-ASO tags on an app',
      description:
        "List the AppTag membership for an app — Apple's structured-ASO tag surface. Each row shows the tag name and isVisibleInAppStore flag. " +
        'Tag membership management (adding/removing tags) is via the App.appTags linkage, which v0.12 does not yet wrap — coming in v0.12.1.',
      inputSchema: z.object({
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appTags]', APP_TAG_FIELDS);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/appTags?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAppTags(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_app_tag',
    {
      title: 'Toggle App Store visibility on an AppTag',
      description:
        "Toggle whether an AppTag is shown in the App Store search/product page UI. Wire key `visibleInAppStore` (stripped from Swift `isVisibleInAppStore`). Setting false hides the tag without removing it from the app's tag list — flip true to re-show. " +
        'This is the ONLY mutable attribute on AppTag; categories/territories management lives on other linkage endpoints (v0.12.1).',
      inputSchema: z.object({
        appTagId: AppTagIdSchema,
        visibleInAppStore: VisibleInAppStoreSchema,
      }),
    },
    async ({ appTagId, visibleInAppStore }) => {
      const body = buildAppTagPatchBody({ appTagId, visibleInAppStore });
      try {
        const data = await client.request<unknown>(`/v1/appTags/${encodeURIComponent(appTagId)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Set visibleInAppStore=${visibleInAppStore} on AppTag ${appTagId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- SearchKeywords (1 tool) -----

  server.registerTool(
    'asc_list_search_keywords',
    {
      title: 'List indexed search keywords for an app',
      description:
        "List Apple's aggregated AppKeyword records for an app — every keyword Apple has indexed across the app's localizations. Optional filter[platform] + filter[locale] to narrow. Read-only at this surface; actual keyword writes still happen via the per-version `keywords` field on AppStoreVersionLocalization (v0.10's asc_patch_app_store_version_localization). " +
        "Use this to inspect what Apple is actually indexing — useful for diagnosing ASO underperformance when your version-level keywords seemingly aren't surfacing in search.",
      inputSchema: z.object({
        appId: AppIdSchema,
        platform: PlatformSchema.optional().describe(
          'Optional filter[platform]. Narrow to one platform (IOS/MAC_OS/TV_OS/VISION_OS).',
        ),
        locale: LocaleSchema.optional().describe(
          'Optional filter[locale]. Narrow to one BCP-47 locale (e.g. en-US).',
        ),
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, platform, locale, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('limit', '200');
      // No fields[appKeywords] — AppKeyword has no attributes.
      if (platform) params.set('filter[platform]', platform);
      if (locale) params.set('filter[locale]', locale);
      const path = `/v1/apps/${encodeURIComponent(appId)}/searchKeywords?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestSearchKeywords(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
