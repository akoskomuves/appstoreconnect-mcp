import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestSubscriptionLocalizations } from '../digest.js';
import { ASCError, ascErrorText } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  LocaleSchema,
  SubscriptionIdSchema,
  SubscriptionLocalizationDescriptionSchema,
  SubscriptionLocalizationIdSchema,
  SubscriptionLocalizationNameSchema,
} from '../schemas.js';

// SubscriptionLocalization carries the customer-facing name + description
// Apple shows in the App Store under a subscription product, per locale.
// One record per (subscription, locale).
//
// Apple's caps (from public docs, not the Swift SDK):
//   - name: 30 characters per locale (capped tighter than app-version
//     description because it sits next to a price in tight UI)
//   - description: 45 characters per locale (one-sentence value prop)
//
// The resource has a server-side `state` attribute:
//   PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED
// — read-only, set by Apple as the localization moves through review with
// the parent subscription. Cannot be patched.
//
// Mutability:
//   - At CREATE: name + locale required; description optional.
//   - At PATCH: name + description mutable; locale immutable (lookup key).
//
// Same wire shape as InAppPurchaseLocalization — only the parent rel
// differs (`subscription` vs `inAppPurchaseV2`).

const SUBSCRIPTION_LOCALIZATION_FIELDS = 'name,locale,description,state';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface SubscriptionLocalizationCreateInput {
  subscriptionId: string;
  name: string;
  locale: string;
  description?: string | undefined;
}

export function buildSubscriptionLocalizationCreateBody(
  input: SubscriptionLocalizationCreateInput,
): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    name: input.name,
    locale: input.locale,
  };
  if (input.description !== undefined) attributes.description = input.description;
  return {
    data: {
      type: 'subscriptionLocalizations',
      attributes,
      relationships: {
        subscription: {
          data: { type: 'subscriptions', id: input.subscriptionId },
        },
      },
    },
  };
}

export interface SubscriptionLocalizationPatchInput {
  subscriptionLocalizationId: string;
  name?: string | undefined;
  description?: string | undefined;
}

export function buildSubscriptionLocalizationPatchBody(
  input: SubscriptionLocalizationPatchInput,
): JSONAPIBody {
  // Apple's SubscriptionLocalizationUpdateRequest accepts only name +
  // description. Locale is immutable; state is server-managed.
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.description !== undefined) attributes.description = input.description;
  return {
    data: {
      type: 'subscriptionLocalizations',
      id: input.subscriptionLocalizationId,
      attributes,
    },
  };
}

// ----- Parent-state gate (CONFIRMED live 2026-09-13) -----
//
// Apple locks a SubscriptionLocalization's name/description once the copy is
// live. The 409 it returns names a state that appears in NEITHER public enum:
//
//   HTTP 409 on PATCH /v1/subscriptionLocalizations/{id}
//   code:   ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE
//   title:  "The provided entity contains a field that can not be modified
//            in the current state"
//   detail: "Cannot edit SubscriptionLocalization when it is in ACTIVE state"
//   source.pointer: /data/attributes/state
//
// ACTIVE is not in SubscriptionLocalizationState (PREPARE_FOR_SUBMISSION /
// WAITING_FOR_REVIEW / APPROVED / REJECTED) and not in Subscription.state
// either — and the list endpoint reported all three affected locales as
// APPROVED moments before the PATCH. So the resource's own reported state
// cannot be used as the gate; Apple is checking something it doesn't expose.
//
// What the observation DOES support: the copy was APPROVED and the parent
// subscription was live. The gate below therefore requires BOTH — an APPROVED
// localization AND a parent subscription in a locked state. A localization
// still in PREPARE_FOR_SUBMISSION under a live subscription is new copy that
// has never shipped, and is deliberately allowed through rather than guessed
// at. Apple's server-side error stays the authoritative gate in every case
// this doesn't cover.

// Subscription.state values that lock already-approved localization copy.
// APPROVED is the confirmed one. The three review states follow Apple's
// established pattern across every other localization resource in this server
// (see evaluateStateGate in appstore-version-localizations.ts): Apple holds
// the whole record while a review cycle is open.
const LOCALIZATION_LOCKED_SUBSCRIPTION_STATES = new Set<string>([
  'APPROVED',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_BINARY_APPROVAL',
]);

export interface SubscriptionLocalizationGateResult {
  allow: boolean;
  parentState: string | undefined;
  localizationState: string | undefined;
  reason?: string;
  next?: string;
}

export function evaluateSubscriptionLocalizationGate(
  parentState: string | undefined,
  localizationState: string | undefined,
): SubscriptionLocalizationGateResult {
  // Either side unknown -> pass through. A failed pre-check must never block
  // a PATCH that Apple would have accepted.
  if (!parentState || !localizationState) {
    return { allow: true, parentState, localizationState };
  }
  // Only live (APPROVED) copy is known to be frozen.
  if (localizationState !== 'APPROVED') {
    return { allow: true, parentState, localizationState };
  }
  if (!LOCALIZATION_LOCKED_SUBSCRIPTION_STATES.has(parentState)) {
    return { allow: true, parentState, localizationState };
  }
  return {
    allow: false,
    parentState,
    localizationState,
    reason:
      `the localization is APPROVED and its parent subscription is in ${parentState} — ` +
      'Apple rejects the PATCH with ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE ' +
      '("Cannot edit SubscriptionLocalization when it is in ACTIVE state")',
    next:
      "App Store Connect's web UI can still edit this copy (the edit goes into the next review cycle) — the REST API cannot. " +
      'Edit it at App Store Connect -> your app -> Subscriptions -> the subscription -> App Store Localization. ' +
      'To add copy for a NEW locale instead, asc_post_subscription_localization still works while the parent is live.',
  };
}

function formatSubscriptionLocalizationGateRefusal(g: SubscriptionLocalizationGateResult): string {
  return [
    "Refused: SubscriptionLocalization PATCH blocked by Apple's state gate.",
    '',
    `Localization state:  ${g.localizationState ?? '(unknown)'}`,
    `Parent subscription: ${g.parentState ?? '(unknown)'}`,
    `Reason:  ${g.reason ?? ''}`,
    '',
    `Next:    ${g.next ?? ''}`,
  ].join('\n');
}

interface SubscriptionLocalizationWithParent {
  data?: { attributes?: { state?: string } };
  included?: Array<{ type?: string; attributes?: { state?: string } }>;
}

async function fetchLocalizationStates(
  client: ASCClient,
  subscriptionLocalizationId: string,
): Promise<{ parentState: string | undefined; localizationState: string | undefined }> {
  // One round-trip with sparse fieldsets: the localization's own state plus
  // the parent subscription's, which is the pair the gate needs.
  const path =
    `/v1/subscriptionLocalizations/${encodeURIComponent(subscriptionLocalizationId)}` +
    '?include=subscription' +
    '&fields[subscriptionLocalizations]=locale,state' +
    '&fields[subscriptions]=state';
  try {
    const res = await client.request<SubscriptionLocalizationWithParent>(path);
    const parent = (res.included ?? []).find((r) => r.type === 'subscriptions');
    return {
      parentState: parent?.attributes?.state,
      localizationState: res.data?.attributes?.state,
    };
  } catch {
    // Non-fatal: fall through to the PATCH and let Apple answer.
    return { parentState: undefined, localizationState: undefined };
  }
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerSubscriptionLocalizations(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_subscription_localizations',
    {
      title: 'List subscription localizations',
      description:
        'List SubscriptionLocalizations under a subscription. Each row carries locale + name + description + state (PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED). Use to see which locales already have copy before adding more.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ subscriptionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[subscriptionLocalizations]', SUBSCRIPTION_LOCALIZATION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/subscriptionLocalizations?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestSubscriptionLocalizations(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_subscription_localization',
    {
      title: 'Get a subscription localization',
      description:
        'Fetch a single SubscriptionLocalization by ID. Returns name + description + locale + state.',
      inputSchema: z.object({
        subscriptionLocalizationId: SubscriptionLocalizationIdSchema,
      }),
    },
    async ({ subscriptionLocalizationId }) => {
      const path = `/v1/subscriptionLocalizations/${encodeURIComponent(
        subscriptionLocalizationId,
      )}`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_subscription_localization',
    {
      title: 'Create a subscription localization',
      description:
        'Create a SubscriptionLocalization for ONE subscription + ONE locale. Required: subscriptionId + name (30 chars max) + locale. Optional: description (45 chars max). The (subscription, locale) pair must be unique. Locale is immutable post-create.',
      inputSchema: z.object({
        subscriptionId: SubscriptionIdSchema,
        name: SubscriptionLocalizationNameSchema,
        locale: LocaleSchema,
        description: SubscriptionLocalizationDescriptionSchema.optional(),
      }),
    },
    async (input) => {
      const body = buildSubscriptionLocalizationCreateBody({
        subscriptionId: input.subscriptionId,
        name: input.name,
        locale: input.locale,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      try {
        const data = await client.request<unknown>('/v1/subscriptionLocalizations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created SubscriptionLocalization (subscription ${input.subscriptionId}, locale ${input.locale}).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_subscription_localization',
    {
      title: 'Patch a subscription localization',
      description:
        'Update name and/or description on an existing SubscriptionLocalization. Both optional (encodeIfPresent). Locale is immutable; state is server-managed and rejected from PATCH bodies. Tool refuses empty PATCH. ' +
        '** PARENT-STATE GATE (CONFIRMED live 2026-09-13): ** once the copy is APPROVED and its parent subscription is live, Apple REFUSES the PATCH — 409 ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE, "Cannot edit SubscriptionLocalization when it is in ACTIVE state". Note ACTIVE is in neither public enum, and the list endpoint still reports the locale as APPROVED, so the resource\'s own state does not predict this. The tool pre-checks the localization state + parent subscription state in one round-trip and refuses client-side with the recovery path. ' +
        'The App Store Connect WEB UI can still make this edit (it goes into the next review cycle); the REST API cannot. Adding a NEW locale with asc_post_subscription_localization still works while the parent is live.',
      inputSchema: z.object({
        subscriptionLocalizationId: SubscriptionLocalizationIdSchema,
        name: SubscriptionLocalizationNameSchema.optional(),
        description: SubscriptionLocalizationDescriptionSchema.optional(),
      }),
    },
    async (input) => {
      if (input.name === undefined && input.description === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of name / description. Empty PATCH would no-op.',
            },
          ],
          isError: true,
        };
      }
      // State-aware pre-check: one round-trip for the localization's own state
      // plus the parent subscription's. See evaluateSubscriptionLocalizationGate
      // for the confirmed constraint and why both are needed.
      const states = await fetchLocalizationStates(client, input.subscriptionLocalizationId);
      const gate = evaluateSubscriptionLocalizationGate(
        states.parentState,
        states.localizationState,
      );
      if (!gate.allow) {
        return {
          content: [{ type: 'text', text: formatSubscriptionLocalizationGateRefusal(gate) }],
          isError: true,
        };
      }
      const body = buildSubscriptionLocalizationPatchBody({
        subscriptionLocalizationId: input.subscriptionLocalizationId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/subscriptionLocalizations/${encodeURIComponent(input.subscriptionLocalizationId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched SubscriptionLocalization ${input.subscriptionLocalizationId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        // Enrichment for the case the pre-check couldn't see: states unknown,
        // or Apple gating on something it doesn't expose at all. Match against
        // the flattened error — Apple's detail lives in `details`, never in
        // ASCError.message.
        const text = ascErrorText(err);
        if (
          text.includes('UNMODIFIABLE') ||
          text.includes('Cannot edit SubscriptionLocalization')
        ) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Apple refused the PATCH: this SubscriptionLocalization is locked in its current state ' +
                  `(pre-check saw localization=${gate.localizationState ?? 'unknown'}, parent subscription=${gate.parentState ?? 'unknown'}).\n\n` +
                  "App Store Connect's web UI can still edit this copy — the REST API cannot. " +
                  'Edit it at App Store Connect -> your app -> Subscriptions -> the subscription -> App Store Localization. ' +
                  'Adding a NEW locale with asc_post_subscription_localization still works.\n\n' +
                  formatASCError(err),
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_subscription_localization',
    {
      title: 'Delete a subscription localization',
      description:
        'DELETE a SubscriptionLocalization. The locale-specific copy is removed; subscribers in that locale fall back to the default locale. Apple may reject if the subscription is in a state that locks localizations.',
      inputSchema: z.object({
        subscriptionLocalizationId: SubscriptionLocalizationIdSchema,
      }),
    },
    async ({ subscriptionLocalizationId }) => {
      try {
        await client.request<unknown>(
          `/v1/subscriptionLocalizations/${encodeURIComponent(subscriptionLocalizationId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Deleted SubscriptionLocalization ${subscriptionLocalizationId}.`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
