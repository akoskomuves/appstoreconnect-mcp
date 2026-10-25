import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ascErrorText } from '../errors.js';
import { AppStoreVersionIdSchema } from '../schemas.js';

// Relationship linkage writes — /v1/{parent}/{id}/relationships/{rel} — that
// spec 4.5.1 has and ppp did not call (section E, part 2), plus the one
// create with no attributes at all (POST /v1/appStoreVersionPromotions).
//
// Every linkage body is the same flat to-many shape, {data:[{type,id}]}, so the
// tools come from one table:
//
//   POST   = add the listed ids to the relationship (re-adding is a no-op)
//   DELETE = remove ONLY the listed ids (never "clear all")
//   PATCH  = REPLACE the relationship with exactly the listed ids, in order.
//            Used here for the screenshot / preview sets, where the order of
//            the list is the display order on the App Store.
//
// Contract notes (spec 4.5.1):
//   * DELETE /v1/apps/{id}/relationships/betaTesters and
//     DELETE /v1/betaTesters/{id}/relationships/apps answer 202 Accepted with
//     an empty body (Apple removes the tester from every group / build of the
//     app asynchronously), not 204. The client's JSON path would choke on the
//     empty 202 body, so writes go through requestText.
//   * searchKeywords linkages take type `appKeywords` — the same ids
//     asc_list_search_keywords returns.

export interface LinkageConfig {
  parent: string; // URL collection segment
  relationship: string; // URL relationship segment
  targetType: string; // data[].type
  toolBase: string; // asc_<add|remove|set>_<toolBase>
  parentLabel: string;
  targetLabel: string; // plural, e.g. 'beta groups'
  verbs: ReadonlyArray<'add' | 'remove' | 'set'>;
  note?: string;
}

export const LINKAGES: readonly LinkageConfig[] = [
  {
    parent: 'appStoreVersionLocalizations',
    relationship: 'searchKeywords',
    targetType: 'appKeywords',
    toolBase: 'app_store_version_localization_search_keywords',
    parentLabel: 'App Store version localization',
    targetLabel: 'search keywords',
    verbs: ['add', 'remove'],
    note: 'Keyword ids are appKeywords ids from asc_list_search_keywords. Read the current set with asc_get_related appStoreVersionLocalizations.searchKeywords.',
  },
  {
    parent: 'appCustomProductPageLocalizations',
    relationship: 'searchKeywords',
    targetType: 'appKeywords',
    toolBase: 'app_custom_product_page_localization_search_keywords',
    parentLabel: 'custom product page localization',
    targetLabel: 'search keywords',
    verbs: ['add', 'remove'],
    note: 'Assigns keywords to a custom product page so it can show in search for them. Keyword ids are appKeywords ids from asc_list_search_keywords.',
  },
  {
    parent: 'appScreenshotSets',
    relationship: 'appScreenshots',
    targetType: 'appScreenshots',
    toolBase: 'app_screenshot_set_order',
    parentLabel: 'screenshot set',
    targetLabel: 'screenshots',
    verbs: ['set'],
    note: 'Pass EVERY screenshot id of the set, in the new display order. Ids come from asc_list_app_screenshots.',
  },
  {
    parent: 'appPreviewSets',
    relationship: 'appPreviews',
    targetType: 'appPreviews',
    toolBase: 'app_preview_set_order',
    parentLabel: 'preview set',
    targetLabel: 'app previews',
    verbs: ['set'],
    note: 'Pass EVERY preview id of the set, in the new display order. Ids come from asc_list_app_previews.',
  },
  {
    parent: 'apps',
    relationship: 'betaTesters',
    targetType: 'betaTesters',
    toolBase: 'app_beta_testers',
    parentLabel: 'app',
    targetLabel: 'beta testers',
    verbs: ['remove'],
    note: "Removes the testers from ALL of this app's beta groups and builds at once (202, applied asynchronously). The tester records stay; use asc_delete_beta_tester to delete one everywhere.",
  },
  {
    parent: 'betaTesters',
    relationship: 'apps',
    targetType: 'apps',
    toolBase: 'beta_tester_apps',
    parentLabel: 'beta tester',
    targetLabel: 'apps',
    verbs: ['remove'],
    note: "Takes the tester out of every group and build of each listed app (202, applied asynchronously). There is no 'add' — testers join an app through a group or a build.",
  },
  {
    parent: 'betaTesters',
    relationship: 'betaGroups',
    targetType: 'betaGroups',
    toolBase: 'beta_tester_beta_groups',
    parentLabel: 'beta tester',
    targetLabel: 'beta groups',
    verbs: ['add', 'remove'],
    note: 'The tester-side mirror of asc_add_beta_group_testers: one tester into many groups.',
  },
  {
    parent: 'betaTesters',
    relationship: 'builds',
    targetType: 'builds',
    toolBase: 'beta_tester_builds',
    parentLabel: 'beta tester',
    targetLabel: 'builds',
    verbs: ['add', 'remove'],
    note: 'Gives one tester individual access to builds, outside any group. The build must be VALID; external testers also need it approved by beta review.',
  },
  {
    parent: 'builds',
    relationship: 'betaGroups',
    targetType: 'betaGroups',
    toolBase: 'build_beta_groups',
    parentLabel: 'build',
    targetLabel: 'beta groups',
    verbs: ['add', 'remove'],
    note: 'The build-side mirror of asc_add_beta_group_builds: one build into many groups. Apple rejects builds still PROCESSING.',
  },
  {
    parent: 'builds',
    relationship: 'individualTesters',
    targetType: 'betaTesters',
    toolBase: 'build_individual_testers',
    parentLabel: 'build',
    targetLabel: 'individual testers',
    verbs: ['add', 'remove'],
    note: 'Testers who get this build directly, not through a group. Read the current list with asc_get_related builds.individualTesters.',
  },
  {
    parent: 'subscriptions',
    relationship: 'introductoryOffers',
    targetType: 'subscriptionIntroductoryOffers',
    toolBase: 'subscription_introductory_offers',
    parentLabel: 'subscription',
    targetLabel: 'introductory offers',
    verbs: ['remove'],
    note: 'Bulk counterpart of asc_delete_subscription_introductory_offer: removes many per-territory intro offers in one call. Ids come from asc_list_subscription_introductory_offers.',
  },
  {
    parent: 'subscriptions',
    relationship: 'prices',
    targetType: 'subscriptionPrices',
    toolBase: 'subscription_prices',
    parentLabel: 'subscription',
    targetLabel: 'prices',
    verbs: ['remove'],
    note: 'Bulk counterpart of asc_delete_subscription_price: rolls back scheduled price changes that have not activated yet. Ids come from asc_list_subscription_prices.',
  },
];

const METHOD = { add: 'POST', remove: 'DELETE', set: 'PATCH' } as const;

export function buildLinkagesBody(
  targetType: string,
  ids: string[],
): { data: Array<{ type: string; id: string }> } {
  return { data: ids.map((id) => ({ type: targetType, id })) };
}

export function linkagePath(cfg: LinkageConfig, parentId: string): string {
  return `/v1/${cfg.parent}/${encodeURIComponent(parentId)}/relationships/${cfg.relationship}`;
}

export function linkageToolName(cfg: LinkageConfig, verb: 'add' | 'remove' | 'set'): string {
  return `asc_${verb}_${cfg.toolBase}`;
}

export function buildVersionPromotionBody(input: {
  appStoreVersionId: string;
  treatmentId: string;
}): {
  data: { type: string; relationships: Record<string, unknown> };
} {
  return {
    data: {
      type: 'appStoreVersionPromotions',
      relationships: {
        appStoreVersion: { data: { type: 'appStoreVersions', id: input.appStoreVersionId } },
        appStoreVersionExperimentTreatment: {
          data: { type: 'appStoreVersionExperimentTreatments', id: input.treatmentId },
        },
      },
    },
  };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: ascErrorText(err) }],
  isError: true,
});

const PAST = { add: 'Added', remove: 'Removed', set: 'Set' } as const;

export function registerRelationshipLinkages(server: McpServer, client: ASCClient): void {
  for (const cfg of LINKAGES) {
    for (const verb of cfg.verbs) {
      const method = METHOD[verb];
      const lead =
        verb === 'add'
          ? `Add ${cfg.targetLabel} to a ${cfg.parentLabel}`
          : verb === 'remove'
            ? `Remove ${cfg.targetLabel} from a ${cfg.parentLabel}`
            : `Reorder the ${cfg.targetLabel} of a ${cfg.parentLabel}`;
      server.registerTool(
        linkageToolName(cfg, verb),
        {
          title: lead,
          description: `${method} /v1/${cfg.parent}/{id}/relationships/${cfg.relationship} — ${lead.toLowerCase()}. ${verb === 'remove' ? 'Only the listed ids are removed. ' : ''}${cfg.note ?? ''}`,
          inputSchema: z.object({
            parentId: z.string().min(1).describe(`${cfg.parentLabel} ID.`),
            ids: z
              .array(z.string().min(1))
              .min(1)
              .describe(
                verb === 'set'
                  ? `Every ${cfg.targetType} id of the ${cfg.parentLabel}, in the order you want.`
                  : `${cfg.targetType} ids.`,
              ),
          }),
        },
        async ({ parentId, ids }) => {
          try {
            await client.requestText(linkagePath(cfg, parentId), {
              method,
              headers: { accept: 'application/json' },
              body: JSON.stringify(buildLinkagesBody(cfg.targetType, ids)),
            });
            const n = `${ids.length} ${cfg.targetLabel}`;
            const where = verb === 'add' ? 'to' : verb === 'remove' ? 'from' : 'on';
            return {
              content: [
                {
                  type: 'text',
                  text: `${PAST[verb]} ${n} ${where} ${cfg.parentLabel} ${parentId}.`,
                },
              ],
            };
          } catch (err) {
            return fail(err);
          }
        },
      );
    }
  }

  server.registerTool(
    'asc_post_app_store_version_promotion',
    {
      title: 'Promote a product page optimization treatment',
      description:
        "POST /v1/appStoreVersionPromotions — apply a winning product page optimization treatment to an App Store version, so its screenshots / previews / icon become the version's default. Needs the version id and the treatment id (asc_list_experiment_treatments). The experiment should be stopped first; Apple refuses promoting a treatment of a running test.",
      inputSchema: z.object({
        appStoreVersionId: AppStoreVersionIdSchema,
        treatmentId: z
          .string()
          .min(1)
          .describe('appStoreVersionExperimentTreatments ID — the treatment to promote.'),
      }),
    },
    async (input) => {
      try {
        const data = await client.request<unknown>('/v1/appStoreVersionPromotions', {
          method: 'POST',
          body: JSON.stringify(buildVersionPromotionBody(input)),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Promoted treatment ${input.treatmentId} onto version ${input.appStoreVersionId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );
}
