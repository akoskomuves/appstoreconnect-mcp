import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestExperimentTreatments,
  digestTreatmentLocalizations,
  digestVersionExperiments,
} from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  ExperimentTreatmentIdSchema,
  LocaleSchema,
  PlatformSchema,
  TrafficProportionSchema,
  TreatmentLocalizationIdSchema,
  VersionExperimentIdSchema,
} from '../schemas.js';

// App Store Version Experiments (product-page A/B tests), V2 surface only.
// V1 experiments (attached to a single AppStoreVersion) are DEPRECATED and
// not exposed; V2 experiments attach to the APP and roll across versions.
//
// URL-version QUIRK: the app-scoped list is GET
// /v1/apps/{id}/appStoreVersionExperimentsV2 (a /v1 path with a V2 suffix),
// while the resource itself lives at /v2/appStoreVersionExperiments/{id}.
// Same IDs across both. (Same /v1-vs-/v2 trap as the v0.15
// appAvailabilities discovery — pinned by tests this time.)
//
// Lifecycle (state machine, 9 states):
//   1. POST the experiment (PREPARE_FOR_SUBMISSION) — name + platform +
//      trafficProportion all REQUIRED, app relationship.
//   2. POST treatments (the variants; name required, appIconName optional),
//      POST treatment localizations per locale, then hang screenshot /
//      preview sets off each localization with the v0.13 asset tools
//      (parentType appStoreVersionExperimentTreatmentLocalizations —
//      already supported there).
//   3. Submit for review via the V2 review submission flow (v0.11 tools) —
//      experiments ride review submissions like other items.
//   4. Once APPROVED: PATCH started=true to begin the test. Wire-key
//      gotcha: Swift `isStarted` → wire `started` (is-prefix strip).
//   5. COMPLETED / STOPPED are terminal; promoting a winning treatment
//      stamps its promotedDate.
//
// Treatment create relationship: appStoreVersionExperimentV2 (the v1
// sibling relationship exists in the contract for the deprecated path —
// never emitted here).

const EXPERIMENT_FIELDS =
  'name,platform,trafficProportion,state,reviewRequired,startDate,endDate,appStoreVersionExperimentTreatments';
const TREATMENT_FIELDS = 'name,appIcon,appIconName,promotedDate';
const TREATMENT_LOCALIZATION_FIELDS = 'locale,appScreenshotSets,appPreviewSets';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export function buildExperimentCreateBody(input: {
  appId: string;
  name: string;
  platform: string;
  trafficProportion: number;
}): JSONAPIBody {
  // All three attributes REQUIRED by the contract.
  return {
    data: {
      type: 'appStoreVersionExperiments',
      attributes: {
        name: input.name,
        platform: input.platform,
        trafficProportion: input.trafficProportion,
      },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export function buildExperimentPatchBody(input: {
  experimentId: string;
  name?: string | undefined;
  trafficProportion?: number | undefined;
  started?: boolean | undefined;
}): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.trafficProportion !== undefined) {
    attributes.trafficProportion = input.trafficProportion;
  }
  // Wire key `started` — NOT Swift's `isStarted`.
  if (input.started !== undefined) attributes.started = input.started;
  return {
    data: {
      type: 'appStoreVersionExperiments',
      id: input.experimentId,
      attributes,
    },
  };
}

export function buildTreatmentCreateBody(input: {
  experimentId: string;
  name: string;
  appIconName?: string | undefined;
}): JSONAPIBody {
  return {
    data: {
      type: 'appStoreVersionExperimentTreatments',
      attributes: {
        name: input.name,
        ...(input.appIconName !== undefined ? { appIconName: input.appIconName } : {}),
      },
      relationships: {
        // V2 relationship — the deprecated v1 `appStoreVersionExperiment`
        // relationship is never emitted.
        appStoreVersionExperimentV2: {
          data: { type: 'appStoreVersionExperiments', id: input.experimentId },
        },
      },
    },
  };
}

export function buildTreatmentPatchBody(input: {
  treatmentId: string;
  name?: string | undefined;
  appIconName?: string | undefined;
}): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.appIconName !== undefined) attributes.appIconName = input.appIconName;
  return {
    data: {
      type: 'appStoreVersionExperimentTreatments',
      id: input.treatmentId,
      attributes,
    },
  };
}

export function buildTreatmentLocalizationCreateBody(input: {
  treatmentId: string;
  locale: string;
}): JSONAPIBody {
  return {
    data: {
      type: 'appStoreVersionExperimentTreatmentLocalizations',
      attributes: { locale: input.locale },
      relationships: {
        appStoreVersionExperimentTreatment: {
          data: { type: 'appStoreVersionExperimentTreatments', id: input.treatmentId },
        },
      },
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

export function registerVersionExperiments(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_version_experiments',
    {
      title: 'List product-page experiments of an app',
      description:
        'GET /v1/apps/{id}/appStoreVersionExperimentsV2 (note: a /v1 path listing the V2, app-attached experiments — the modern surface). Each row shows name, state (9-state lifecycle), platform, traffic %, review-required flag, and start/end dates. Filter client-side by state from the digest.',
      inputSchema: {
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(500).default(200),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appStoreVersionExperiments]', EXPERIMENT_FIELDS);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/appStoreVersionExperimentsV2?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestVersionExperiments(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_version_experiment',
    {
      title: 'Get a product-page experiment',
      description:
        'GET /v2/appStoreVersionExperiments/{id} with treatments + latestControlVersion included — the full experiment record for inspecting state before submitting, starting, or stopping.',
      inputSchema: {
        experimentId: VersionExperimentIdSchema,
      },
    },
    async ({ experimentId }) => {
      const path = `/v2/appStoreVersionExperiments/${encodeURIComponent(
        experimentId,
      )}?include=appStoreVersionExperimentTreatments,latestControlVersion`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_version_experiment',
    {
      title: 'Create a product-page experiment',
      description:
        'POST /v2/appStoreVersionExperiments — create an A/B test on the product page. ALL THREE attributes required: name, platform, trafficProportion (1–99% of page traffic, split across treatments). Created in PREPARE_FOR_SUBMISSION; it shows nothing publicly until submitted (V2 review submission flow, v0.11 tools) AND explicitly started (asc_patch_version_experiment started=true after APPROVED). Build flow: create → add treatments → add treatment localizations → attach variant screenshots via the v0.13 asset tools → submit → start.',
      inputSchema: {
        appId: AppIdSchema,
        name: z.string().min(1).describe('Internal experiment name (not customer-visible).'),
        platform: PlatformSchema,
        trafficProportion: TrafficProportionSchema,
      },
    },
    async ({ appId, name, platform, trafficProportion }) => {
      const body = buildExperimentCreateBody({ appId, name, platform, trafficProportion });
      try {
        const data = await client.request<unknown>('/v2/appStoreVersionExperiments', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created experiment "${name}" (${platform}, ${trafficProportion}% traffic) on app ${appId} in PREPARE_FOR_SUBMISSION. Next: asc_post_experiment_treatment.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_version_experiment',
    {
      title: 'Patch / start a product-page experiment',
      description:
        '⚠️ started=true is CUSTOMER-FACING: PATCH /v2/appStoreVersionExperiments/{id} with started=true begins serving treatment pages to real App Store traffic (requires state APPROVED). Also mutates name and trafficProportion while still in PREPARE_FOR_SUBMISSION. Wire-key gotcha pinned by tests: the start flag is `started` (Swift isStarted). There is no started=false — stopping is its own semantics via Apple (STOPPED is terminal); confirm intent before starting.',
      inputSchema: {
        experimentId: VersionExperimentIdSchema,
        name: z.string().min(1).optional(),
        trafficProportion: TrafficProportionSchema.optional(),
        started: z
          .boolean()
          .optional()
          .describe(
            'true: START the experiment (APPROVED state required; goes live to customers). Get explicit human approval first.',
          ),
      },
    },
    async (input) => {
      const anyField = [input.name, input.trafficProportion, input.started].some(
        (v) => v !== undefined,
      );
      if (!anyField) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of name, trafficProportion, started.',
            },
          ],
          isError: true,
        };
      }
      const body = buildExperimentPatchBody({
        experimentId: input.experimentId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.trafficProportion !== undefined
          ? { trafficProportion: input.trafficProportion }
          : {}),
        ...(input.started !== undefined ? { started: input.started } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v2/appStoreVersionExperiments/${encodeURIComponent(input.experimentId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched experiment ${input.experimentId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_version_experiment',
    {
      title: 'Delete a product-page experiment',
      description:
        'DELETE /v2/appStoreVersionExperiments/{id} — removes the experiment and its treatments/localizations. Works on un-started experiments; running experiments should be stopped through App Store Connect first.',
      inputSchema: {
        experimentId: VersionExperimentIdSchema,
      },
    },
    async ({ experimentId }) => {
      try {
        await client.request<unknown>(
          `/v2/appStoreVersionExperiments/${encodeURIComponent(experimentId)}`,
          { method: 'DELETE' },
        );
        return { content: [{ type: 'text', text: `Deleted experiment ${experimentId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_experiment_treatments',
    {
      title: 'List treatments of an experiment',
      description:
        'GET /v2/appStoreVersionExperiments/{id}/appStoreVersionExperimentTreatments — the variants under test. PROMOTED column shows when a winning treatment was promoted to the real product page.',
      inputSchema: {
        experimentId: VersionExperimentIdSchema,
        raw: z.boolean().default(false),
      },
    },
    async ({ experimentId, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[appStoreVersionExperimentTreatments]', TREATMENT_FIELDS);
      params.set('limit', '200');
      const path = `/v2/appStoreVersionExperiments/${encodeURIComponent(
        experimentId,
      )}/appStoreVersionExperimentTreatments?${params.toString()}`;
      try {
        const pages = await paginate(client, path, 200);
        const text = raw ? JSON.stringify(pages, null, 2) : digestExperimentTreatments(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_experiment_treatment',
    {
      title: 'Create an experiment treatment',
      description:
        'POST /v1/appStoreVersionExperimentTreatments — add a variant to an experiment (PREPARE_FOR_SUBMISSION only). name required; appIconName optional (tests an alternate icon — the icon must ship in the app binary as an alternate icon). Relationship emitted is appStoreVersionExperimentV2 (the modern surface). After creating: asc_post_treatment_localization per locale, then v0.13 asset tools for variant screenshots.',
      inputSchema: {
        experimentId: VersionExperimentIdSchema,
        name: z.string().min(1).describe('Treatment name (internal).'),
        appIconName: z
          .string()
          .optional()
          .describe('Optional alternate-icon name to test (must exist in the binary).'),
      },
    },
    async ({ experimentId, name, appIconName }) => {
      const body = buildTreatmentCreateBody({
        experimentId,
        name,
        ...(appIconName !== undefined ? { appIconName } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/appStoreVersionExperimentTreatments', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created treatment "${name}" on experiment ${experimentId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_experiment_treatment',
    {
      title: 'Patch an experiment treatment',
      description:
        'PATCH /v1/appStoreVersionExperimentTreatments/{id} — mutate name and/or appIconName (pre-submission). Pass at least one.',
      inputSchema: {
        treatmentId: ExperimentTreatmentIdSchema,
        name: z.string().min(1).optional(),
        appIconName: z.string().optional(),
      },
    },
    async ({ treatmentId, name, appIconName }) => {
      if (name === undefined && appIconName === undefined) {
        return {
          content: [{ type: 'text', text: 'Refused: pass at least one of name, appIconName.' }],
          isError: true,
        };
      }
      const body = buildTreatmentPatchBody({
        treatmentId,
        ...(name !== undefined ? { name } : {}),
        ...(appIconName !== undefined ? { appIconName } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/appStoreVersionExperimentTreatments/${encodeURIComponent(treatmentId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched treatment ${treatmentId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_experiment_treatment',
    {
      title: 'Delete an experiment treatment',
      description:
        'DELETE /v1/appStoreVersionExperimentTreatments/{id} — remove a variant (and its localizations/assets) from a pre-submission experiment.',
      inputSchema: {
        treatmentId: ExperimentTreatmentIdSchema,
      },
    },
    async ({ treatmentId }) => {
      try {
        await client.request<unknown>(
          `/v1/appStoreVersionExperimentTreatments/${encodeURIComponent(treatmentId)}`,
          { method: 'DELETE' },
        );
        return { content: [{ type: 'text', text: `Deleted treatment ${treatmentId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_treatment_localizations',
    {
      title: 'List localizations of a treatment',
      description:
        'GET /v1/appStoreVersionExperimentTreatments/{id}/appStoreVersionExperimentTreatmentLocalizations — the per-locale containers for variant assets. Hang screenshot/preview sets off each with the v0.13 asset tools (parentType appStoreVersionExperimentTreatmentLocalizations).',
      inputSchema: {
        treatmentId: ExperimentTreatmentIdSchema,
        raw: z.boolean().default(false),
      },
    },
    async ({ treatmentId, raw }) => {
      const params = new URLSearchParams();
      params.set(
        'fields[appStoreVersionExperimentTreatmentLocalizations]',
        TREATMENT_LOCALIZATION_FIELDS,
      );
      params.set('limit', '200');
      const path = `/v1/appStoreVersionExperimentTreatments/${encodeURIComponent(
        treatmentId,
      )}/appStoreVersionExperimentTreatmentLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, 200);
        const text = raw ? JSON.stringify(pages, null, 2) : digestTreatmentLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_treatment_localization',
    {
      title: 'Create a treatment localization',
      description:
        'POST /v1/appStoreVersionExperimentTreatmentLocalizations — add a locale to a treatment (locale required, e.g. "en-US"). Then create variant screenshot/preview sets against it with asc_post_app_screenshot_set / asc_post_app_preview_set (parentType appStoreVersionExperimentTreatmentLocalizations) and upload with the v0.13 composite tools.',
      inputSchema: {
        treatmentId: ExperimentTreatmentIdSchema,
        locale: LocaleSchema,
      },
    },
    async ({ treatmentId, locale }) => {
      const body = buildTreatmentLocalizationCreateBody({ treatmentId, locale });
      try {
        const data = await client.request<unknown>(
          '/v1/appStoreVersionExperimentTreatmentLocalizations',
          { method: 'POST', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Created ${locale} localization on treatment ${treatmentId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_treatment_localization',
    {
      title: 'Delete a treatment localization',
      description:
        'DELETE /v1/appStoreVersionExperimentTreatmentLocalizations/{id} — remove a locale (and its variant assets) from a treatment.',
      inputSchema: {
        treatmentLocalizationId: TreatmentLocalizationIdSchema,
      },
    },
    async ({ treatmentLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/appStoreVersionExperimentTreatmentLocalizations/${encodeURIComponent(treatmentLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            { type: 'text', text: `Deleted treatment localization ${treatmentLocalizationId}.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
