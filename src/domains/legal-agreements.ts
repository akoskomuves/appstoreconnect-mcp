import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestTerritories } from '../digest.js';
import { digestBetaLicenseAgreements } from '../digest-users-access.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import { AppIdSchema, TerritoryIdSchema } from '../schemas.js';

// Legal agreements — the custom End User License Agreement shown on the App
// Store product page, and the TestFlight beta license agreement.
//
//   * EULA: an app has AT MOST ONE custom EULA, scoped to a set of
//     territories. With none, the App Store shows Apple's standard EULA —
//     GET /v1/apps/{id}/endUserLicenseAgreement then answers 200 with
//     `data: null` (live 2026-10-24; a 404 is handled the same way). That is
//     the normal "no custom EULA" state, not an error. Create needs
//     the app, the text and at least one territory; PATCH can change the text
//     and REPLACE the territory set; DELETE reverts the app to Apple's
//     standard EULA. The text is customer-visible on the product page.
//   * Beta license agreement: exactly one per app, created by Apple. There is
//     no create or delete — only read and PATCH agreementText. An empty text
//     means Apple's standard beta terms apply.

const EULA_FIELDS = 'agreementText,app,territories';
const BETA_FIELDS = 'agreementText,app';

const EulaIdSchema = z
  .string()
  .min(1)
  .describe('End user license agreement id (from asc_get_app_end_user_license_agreement).');
const BetaLicenseAgreementIdSchema = z
  .string()
  .min(1)
  .describe('Beta license agreement id (from asc_list_beta_license_agreements).');

const maxItemsSchema = z.number().int().positive().max(2000).default(500);

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface EulaCreateInput {
  appId: string;
  agreementText: string;
  territoryIds: string[];
}

export function buildEulaCreateBody(input: EulaCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'endUserLicenseAgreements',
      attributes: { agreementText: input.agreementText },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
        territories: { data: input.territoryIds.map((id) => ({ type: 'territories', id })) },
      },
    },
  };
}

export interface EulaPatchInput {
  eulaId: string;
  agreementText?: string | undefined;
  territoryIds?: string[] | undefined;
}

export function buildEulaPatchBody(input: EulaPatchInput): JSONAPIBody {
  const body: JSONAPIBody = { data: { type: 'endUserLicenseAgreements', id: input.eulaId } };
  if (input.agreementText !== undefined) {
    body.data.attributes = { agreementText: input.agreementText };
  }
  if (input.territoryIds !== undefined) {
    body.data.relationships = {
      territories: { data: input.territoryIds.map((id) => ({ type: 'territories', id })) },
    };
  }
  return body;
}

export function buildBetaLicenseAgreementPatchBody(id: string, agreementText: string): JSONAPIBody {
  return { data: { type: 'betaLicenseAgreements', id, attributes: { agreementText } } };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function fail(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
}

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function registerLegalAgreements(server: McpServer, client: ASCClient): void {
  // ----- End user license agreements -----

  server.registerTool(
    'asc_get_app_end_user_license_agreement',
    {
      title: "Get an app's custom EULA",
      description:
        "Fetch the app's custom End User License Agreement (text + territories). An empty answer (data: null) means the app has no custom EULA and the App Store shows Apple's standard one — the tool reports that instead of an error.",
      inputSchema: z.object({ appId: AppIdSchema }),
    },
    async ({ appId }) => {
      const none = {
        content: [
          {
            type: 'text' as const,
            text: `App ${appId} has no custom EULA — the App Store shows Apple's standard EULA. Create one with asc_post_end_user_license_agreement.`,
          },
        ],
      };
      try {
        const res = await client.request<{ data?: unknown }>(
          `/v1/apps/${encodeURIComponent(appId)}/endUserLicenseAgreement?fields[endUserLicenseAgreements]=${EULA_FIELDS}`,
        );
        return res?.data ? json(res) : none;
      } catch (err) {
        if (err instanceof ASCError && err.status === 404) return none;
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_end_user_license_agreement',
    {
      title: 'Get a EULA by id',
      description: 'Fetch one custom EULA by id, including its app and territories.',
      inputSchema: z.object({ eulaId: EulaIdSchema }),
    },
    async ({ eulaId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/endUserLicenseAgreements/${encodeURIComponent(eulaId)}?fields[endUserLicenseAgreements]=${EULA_FIELDS}&include=territories&limit[territories]=50`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_list_end_user_license_agreement_territories',
    {
      title: 'List the territories a EULA covers',
      description: 'List every territory the custom EULA applies to (all of them, paginated).',
      inputSchema: z.object({
        eulaId: EulaIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ eulaId, maxItems, raw }) => {
      try {
        const pages = await paginate(
          client,
          `/v1/endUserLicenseAgreements/${encodeURIComponent(eulaId)}/territories?fields[territories]=currency&limit=200`,
          maxItems,
        );
        return {
          content: [
            { type: 'text', text: raw ? JSON.stringify(pages, null, 2) : digestTerritories(pages) },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_post_end_user_license_agreement',
    {
      title: 'Create a custom EULA',
      description:
        "Create the app's custom EULA for the given territories. Customer-visible: it replaces Apple's standard EULA on the product page in those territories. An app can have only one — if it already has one, PATCH it instead.",
      inputSchema: z.object({
        appId: AppIdSchema,
        agreementText: z.string().min(1).describe('Full EULA text.'),
        territoryIds: z.array(TerritoryIdSchema).min(1),
      }),
    },
    async ({ appId, agreementText, territoryIds }) => {
      try {
        return json(
          await client.request<unknown>('/v1/endUserLicenseAgreements', {
            method: 'POST',
            body: JSON.stringify(buildEulaCreateBody({ appId, agreementText, territoryIds })),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_end_user_license_agreement',
    {
      title: 'Update a custom EULA',
      description:
        'Change the EULA text and/or REPLACE its territory set (territories not listed drop back to the standard EULA). Customer-visible. Pass at least one field.',
      inputSchema: z.object({
        eulaId: EulaIdSchema,
        agreementText: z.string().min(1).optional(),
        territoryIds: z
          .array(TerritoryIdSchema)
          .min(1)
          .optional()
          .describe('FULL new territory list.'),
      }),
    },
    async ({ eulaId, agreementText, territoryIds }) => {
      if (agreementText === undefined && territoryIds === undefined) {
        return {
          content: [
            { type: 'text', text: 'Refused: pass at least one of agreementText, territoryIds.' },
          ],
          isError: true,
        };
      }
      try {
        return json(
          await client.request<unknown>(
            `/v1/endUserLicenseAgreements/${encodeURIComponent(eulaId)}`,
            {
              method: 'PATCH',
              body: JSON.stringify(buildEulaPatchBody({ eulaId, agreementText, territoryIds })),
            },
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_delete_end_user_license_agreement',
    {
      title: 'Delete a custom EULA',
      description:
        "Delete the app's custom EULA. The product page falls back to Apple's standard EULA in every territory. Customer-visible.",
      inputSchema: z.object({ eulaId: EulaIdSchema }),
    },
    async ({ eulaId }) => {
      try {
        await client.request<void>(`/v1/endUserLicenseAgreements/${encodeURIComponent(eulaId)}`, {
          method: 'DELETE',
        });
        return {
          content: [
            {
              type: 'text',
              text: `Deleted EULA ${eulaId}; the app now shows Apple's standard EULA.`,
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----- Beta license agreements -----

  server.registerTool(
    'asc_list_beta_license_agreements',
    {
      title: 'List TestFlight beta license agreements',
      description:
        'List beta license agreements (one per app, created by Apple), optionally for given app ids. Empty text = Apple standard terms.',
      inputSchema: z.object({
        appIds: z.array(AppIdSchema).optional(),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ appIds, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[betaLicenseAgreements]', BETA_FIELDS);
      // Without include=app the relationship carries links only, no app id.
      params.set('include', 'app');
      params.set('fields[apps]', 'name');
      params.set('limit', '200');
      if (appIds && appIds.length > 0) params.set('filter[app]', appIds.join(','));
      try {
        const pages = await paginate(
          client,
          `/v1/betaLicenseAgreements?${params.toString()}`,
          maxItems,
        );
        return {
          content: [
            {
              type: 'text',
              text: raw ? JSON.stringify(pages, null, 2) : digestBetaLicenseAgreements(pages),
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_beta_license_agreement',
    {
      title: 'Get a beta license agreement',
      description: 'Fetch one beta license agreement by id, with its app.',
      inputSchema: z.object({ agreementId: BetaLicenseAgreementIdSchema }),
    },
    async ({ agreementId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/betaLicenseAgreements/${encodeURIComponent(agreementId)}?fields[betaLicenseAgreements]=${BETA_FIELDS}&include=app&fields[apps]=name,bundleId`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_app_beta_license_agreement',
    {
      title: "Get an app's beta license agreement",
      description:
        "Fetch the app's TestFlight beta license agreement (its id feeds asc_patch_beta_license_agreement).",
      inputSchema: z.object({ appId: AppIdSchema }),
    },
    async ({ appId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/apps/${encodeURIComponent(appId)}/betaLicenseAgreement?fields[betaLicenseAgreements]=${BETA_FIELDS}`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_get_beta_license_agreement_app',
    {
      title: 'Get the app of a beta license agreement',
      description: 'Resolve which app a beta license agreement belongs to.',
      inputSchema: z.object({ agreementId: BetaLicenseAgreementIdSchema }),
    },
    async ({ agreementId }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/betaLicenseAgreements/${encodeURIComponent(agreementId)}/app?fields[apps]=name,bundleId,sku`,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'asc_patch_beta_license_agreement',
    {
      title: 'Update the beta license agreement text',
      description:
        'Replace the TestFlight beta license agreement text. Testers accept it before installing a build. There is no create or delete — every app has exactly one.',
      inputSchema: z.object({
        agreementId: BetaLicenseAgreementIdSchema,
        agreementText: z.string().describe('Full new agreement text.'),
      }),
    },
    async ({ agreementId, agreementText }) => {
      try {
        return json(
          await client.request<unknown>(
            `/v1/betaLicenseAgreements/${encodeURIComponent(agreementId)}`,
            {
              method: 'PATCH',
              body: JSON.stringify(buildBetaLicenseAgreementPatchBody(agreementId, agreementText)),
            },
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
