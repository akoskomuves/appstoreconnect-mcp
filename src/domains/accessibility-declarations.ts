import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestAccessibilityDeclarations } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AccessibilityDeclarationIdSchema,
  AccessibilityDeclarationStateSchema,
  AppIdSchema,
  DeviceFamilySchema,
} from '../schemas.js';

// Accessibility declarations — the "Accessibility Nutrition Label" on the
// product page: per-(app, deviceFamily) flags for supported accessibility
// features. Lifecycle: DRAFT (editable, invisible) → PUBLISHED (live on the
// store) → REPLACED (superseded). One DRAFT per device family at a time.
//
// Wire-key gotcha — the LARGEST is-prefix strip family yet (10 members,
// all pinned by tests):
//   Swift `isSupportsAudioDescriptions` → wire `supportsAudioDescriptions`
//   … same for Captions / DarkInterface / DifferentiateWithoutColorAlone /
//   LargerText / ReducedMotion / SufficientContrast / VoiceControl /
//   Voiceover (9 flags), plus on PATCH:
//   Swift `isPublish` → wire `publish` — ⚠️ publish=true is CUSTOMER-FACING
//   (the label goes live on the App Store product page).
//
// Create: deviceFamily REQUIRED + any subset of the nine flags; app
// relationship. Omitted flags are OMITTED on the wire (not false).

export const SUPPORT_FLAG_KEYS = [
  'supportsAudioDescriptions',
  'supportsCaptions',
  'supportsDarkInterface',
  'supportsDifferentiateWithoutColorAlone',
  'supportsLargerText',
  'supportsReducedMotion',
  'supportsSufficientContrast',
  'supportsVoiceControl',
  'supportsVoiceover',
] as const;

export type SupportFlags = Partial<Record<(typeof SUPPORT_FLAG_KEYS)[number], boolean>>;

// Static literal (not a join over SUPPORT_FLAG_KEYS) so the fieldset audit
// script can validate it against Apple's OpenAPI spec.
const ACCESSIBILITY_FIELDS =
  'deviceFamily,state,supportsAudioDescriptions,supportsCaptions,supportsDarkInterface,supportsDifferentiateWithoutColorAlone,supportsLargerText,supportsReducedMotion,supportsSufficientContrast,supportsVoiceControl,supportsVoiceover';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

function pickFlags(flags: SupportFlags): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of SUPPORT_FLAG_KEYS) {
    const v = flags[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function buildAccessibilityDeclarationCreateBody(input: {
  appId: string;
  deviceFamily: string;
  flags: SupportFlags;
}): JSONAPIBody {
  return {
    data: {
      type: 'accessibilityDeclarations',
      attributes: {
        deviceFamily: input.deviceFamily,
        ...pickFlags(input.flags),
      },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export function buildAccessibilityDeclarationPatchBody(input: {
  declarationId: string;
  publish?: boolean | undefined;
  flags: SupportFlags;
}): JSONAPIBody {
  return {
    data: {
      type: 'accessibilityDeclarations',
      id: input.declarationId,
      attributes: {
        ...pickFlags(input.flags),
        // Wire key `publish` — NOT Swift's `isPublish`. true = goes live.
        ...(input.publish !== undefined ? { publish: input.publish } : {}),
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

const flagInputSchema = {
  supportsAudioDescriptions: z.boolean().optional(),
  supportsCaptions: z.boolean().optional(),
  supportsDarkInterface: z.boolean().optional(),
  supportsDifferentiateWithoutColorAlone: z.boolean().optional(),
  supportsLargerText: z.boolean().optional(),
  supportsReducedMotion: z.boolean().optional(),
  supportsSufficientContrast: z.boolean().optional(),
  supportsVoiceControl: z.boolean().optional(),
  supportsVoiceover: z.boolean().optional(),
};

function flagsFromInput(input: Record<string, unknown>): SupportFlags {
  const flags: SupportFlags = {};
  for (const key of SUPPORT_FLAG_KEYS) {
    if (typeof input[key] === 'boolean') flags[key] = input[key] as boolean;
  }
  return flags;
}

export function registerAccessibilityDeclarations(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_accessibility_declarations',
    {
      title: 'List accessibility declarations of an app',
      description:
        'GET /v1/apps/{id}/accessibilityDeclarations — the per-device-family accessibility feature declarations ("Accessibility Nutrition Labels"). Filter by deviceFamily and/or state (DRAFT / PUBLISHED / REPLACED). The digest shows one row per declaration with the supported-feature flags.',
      inputSchema: {
        appId: AppIdSchema,
        deviceFamily: DeviceFamilySchema.optional(),
        state: AccessibilityDeclarationStateSchema.optional(),
        maxItems: z.number().int().positive().max(500).default(200),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, deviceFamily, state, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[accessibilityDeclarations]', ACCESSIBILITY_FIELDS);
      if (deviceFamily) params.set('filter[deviceFamily]', deviceFamily);
      if (state) params.set('filter[state]', state);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/accessibilityDeclarations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAccessibilityDeclarations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_accessibility_declaration',
    {
      title: 'Create an accessibility declaration (DRAFT)',
      description:
        'POST /v1/accessibilityDeclarations — create a DRAFT declaration for one device family (required) with any subset of the nine supports* flags (omitted ≠ false: omitted flags are simply not declared). Drafts are invisible until published via asc_patch_accessibility_declaration publish=true. One DRAFT per device family at a time.',
      inputSchema: {
        appId: AppIdSchema,
        deviceFamily: DeviceFamilySchema,
        ...flagInputSchema,
      },
    },
    async (input) => {
      const body = buildAccessibilityDeclarationCreateBody({
        appId: input.appId,
        deviceFamily: input.deviceFamily,
        flags: flagsFromInput(input),
      });
      try {
        const data = await client.request<unknown>('/v1/accessibilityDeclarations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created DRAFT accessibility declaration for ${input.deviceFamily} on app ${input.appId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_accessibility_declaration',
    {
      title: 'Patch / publish an accessibility declaration',
      description:
        '⚠️ publish=true is CUSTOMER-FACING: PATCH /v1/accessibilityDeclarations/{id} with publish=true puts the accessibility label live on the App Store product page (state → PUBLISHED; a previously published declaration for the family becomes REPLACED). Without publish, mutates the supports* flags on a DRAFT. Wire-key gotchas pinned by tests: `publish` (Swift isPublish) and the nine `supports*` flags (Swift isSupports*). Get explicit human approval before publishing.',
      inputSchema: {
        declarationId: AccessibilityDeclarationIdSchema,
        publish: z
          .boolean()
          .optional()
          .describe('true: publish this DRAFT to the live product page. Requires human approval.'),
        ...flagInputSchema,
      },
    },
    async (input) => {
      const flags = flagsFromInput(input);
      if (input.publish === undefined && Object.keys(flags).length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one supports* flag to edit the draft, or publish=true to publish it.',
            },
          ],
          isError: true,
        };
      }
      const body = buildAccessibilityDeclarationPatchBody({
        declarationId: input.declarationId,
        ...(input.publish !== undefined ? { publish: input.publish } : {}),
        flags,
      });
      try {
        const data = await client.request<unknown>(
          `/v1/accessibilityDeclarations/${encodeURIComponent(input.declarationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched accessibility declaration ${input.declarationId}${input.publish ? ' (PUBLISH requested)' : ''}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_accessibility_declaration',
    {
      title: 'Delete an accessibility declaration',
      description:
        'DELETE /v1/accessibilityDeclarations/{id} — remove a DRAFT declaration. Published declarations are superseded by publishing a new draft (REPLACED), not deleted.',
      inputSchema: {
        declarationId: AccessibilityDeclarationIdSchema,
      },
    },
    async ({ declarationId }) => {
      try {
        await client.request<unknown>(
          `/v1/accessibilityDeclarations/${encodeURIComponent(declarationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [{ type: 'text', text: `Deleted accessibility declaration ${declarationId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
