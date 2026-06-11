import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestWebhookDeliveries, digestWebhooks } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  WebhookDeliveryIdSchema,
  WebhookDeliveryStateSchema,
  WebhookEventTypeSchema,
  WebhookIdSchema,
  WebhookSecretSchema,
} from '../schemas.js';

// Webhooks are per-APP push notifications from App Store Connect: one
// webhook = one HTTPS endpoint + a set of event types. Apple signs every
// delivery with the webhook's secret (HMAC-SHA256 in the X-Apple-Signature
// header) so the receiver can verify authenticity.
//
// Surface map:
//   - CRUD: GET /v1/apps/{id}/webhooks (list) · POST /v1/webhooks ·
//     GET/PATCH/DELETE /v1/webhooks/{id}. DELETE is in the Swift SDK this
//     time (unlike the v0.16 feedback/criteria DELETEs).
//   - Deliveries: GET /v1/webhooks/{id}/deliveries — per-attempt records
//     (SUCCEEDED / FAILED / PENDING) with request URL + response status/body.
//   - Redelivery: POST /v1/webhookDeliveries with a `template` relationship
//     pointing at an EXISTING delivery id (self-referential type
//     webhookDeliveries). Relationships-only body.
//   - Test ping: POST /v1/webhookPings with a `webhook` relationship.
//     Relationships-only body; the response resource is id-only (no attrs).
//     The ping lands at the endpoint as an event with ping=true.
//
// Wire-key gotchas (verified against AvdLee Swift SDK):
//   - Swift `isEnabled` → wire `enabled` (Webhook attrs + create/update) —
//     the recurring is-prefix strip.
//   - Swift `isRedelivery` → wire `redelivery` (WebhookDelivery, read-only).
//   - Swift `isPing` → wire `ping` (WebhookEvent, read-only).
//   - WebhookCreateRequest attrs are ALL FIVE REQUIRED (enabled, eventTypes,
//     name, secret, url) — no partial create.
//   - `secret` is WRITE-ONLY: it is not in the readable fields enum and is
//     never echoed back by any GET. It can be rotated via PATCH.
//   - Delivery date filters use VERBOSE key names:
//     filter[createdDateGreaterThanOrEqualTo] / filter[createdDateLessThan]
//     (not a bare filter[createdDate] range syntax).

const WEBHOOK_FIELDS = 'enabled,eventTypes,name,url,app';
const WEBHOOK_DELIVERY_FIELDS =
  'createdDate,deliveryState,errorMessage,redelivery,sentDate,request,response,event';
const WEBHOOK_EVENT_FIELDS = 'eventType,payload,ping,createdDate';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

export interface WebhookCreateInput {
  appId: string;
  name: string;
  url: string;
  secret: string;
  eventTypes: string[];
  enabled: boolean;
}

export function buildWebhookCreateBody(input: WebhookCreateInput): JSONAPIBody {
  // All five attributes are REQUIRED by the contract. Wire key is `enabled`
  // (NOT Swift's `isEnabled`).
  return {
    data: {
      type: 'webhooks',
      attributes: {
        name: input.name,
        url: input.url,
        secret: input.secret,
        eventTypes: input.eventTypes,
        enabled: input.enabled,
      },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export interface WebhookPatchInput {
  webhookId: string;
  name?: string | undefined;
  url?: string | undefined;
  secret?: string | undefined;
  eventTypes?: string[] | undefined;
  enabled?: boolean | undefined;
}

export function buildWebhookPatchBody(input: WebhookPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.url !== undefined) attributes.url = input.url;
  if (input.secret !== undefined) attributes.secret = input.secret;
  if (input.eventTypes !== undefined) attributes.eventTypes = input.eventTypes;
  if (input.enabled !== undefined) attributes.enabled = input.enabled;
  return {
    data: {
      type: 'webhooks',
      id: input.webhookId,
      attributes,
    },
  };
}

export function buildWebhookRedeliveryBody(templateDeliveryId: string): JSONAPIBody {
  // Relationships-only create (no attributes block, same family as v0.16
  // BuildBetaNotification). The `template` relationship is SELF-REFERENTIAL:
  // type webhookDeliveries, pointing at the existing (typically FAILED)
  // delivery to retry.
  return {
    data: {
      type: 'webhookDeliveries',
      relationships: {
        template: { data: { type: 'webhookDeliveries', id: templateDeliveryId } },
      },
    },
  };
}

export function buildWebhookPingBody(webhookId: string): JSONAPIBody {
  // Relationships-only create (no attributes block).
  return {
    data: {
      type: 'webhookPings',
      relationships: {
        webhook: { data: { type: 'webhooks', id: webhookId } },
      },
    },
  };
}

export interface WebhookDeliveryListFilters {
  deliveryStates?: string[] | undefined;
  createdAfterOrAt?: string | undefined;
  createdBefore?: string | undefined;
}

export function buildWebhookDeliveryListQuery(
  filters: WebhookDeliveryListFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('fields[webhookDeliveries]', WEBHOOK_DELIVERY_FIELDS);
  params.set('fields[webhookEvents]', WEBHOOK_EVENT_FIELDS);
  // include=event so the digest can resolve each delivery's event type —
  // same lesson as the v0.16 live-smoke finding (relationship objects don't
  // materialize without include).
  params.set('include', 'event');
  if (filters.deliveryStates?.length) {
    params.set('filter[deliveryState]', filters.deliveryStates.join(','));
  }
  // Verbose date-filter keys per the contract — NOT a bare filter[createdDate].
  if (filters.createdAfterOrAt !== undefined) {
    params.set('filter[createdDateGreaterThanOrEqualTo]', filters.createdAfterOrAt);
  }
  if (filters.createdBefore !== undefined) {
    params.set('filter[createdDateLessThan]', filters.createdBefore);
  }
  params.set('limit', '200');
  return params;
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerWebhooks(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_webhooks',
    {
      title: 'List webhooks of an app',
      description:
        'GET /v1/apps/{id}/webhooks — every webhook configured on the app: name, enabled state, endpoint URL, subscribed event types, and ID. The secret is write-only and never appears. Webhooks are per-app; list each app separately.',
      inputSchema: {
        appId: AppIdSchema,
        maxItems: z.number().int().positive().max(500).default(200),
        raw: z.boolean().default(false),
      },
    },
    async ({ appId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[webhooks]', WEBHOOK_FIELDS);
      params.set('limit', '200');
      const path = `/v1/apps/${encodeURIComponent(appId)}/webhooks?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestWebhooks(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_webhook',
    {
      title: 'Get a webhook',
      description:
        'GET /v1/webhooks/{id} — one webhook with its app relationship. The secret is write-only and never returned. For delivery history use asc_list_webhook_deliveries.',
      inputSchema: {
        webhookId: WebhookIdSchema,
      },
    },
    async ({ webhookId }) => {
      const path = `/v1/webhooks/${encodeURIComponent(webhookId)}?include=app`;
      try {
        const data = await client.request<unknown>(path, { method: 'GET' });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_webhook',
    {
      title: 'Create a webhook',
      description:
        'POST /v1/webhooks — register an HTTPS endpoint to receive App Store Connect event notifications for ONE app. ALL FIVE attributes are required: name, url (HTTPS), secret (HMAC-SHA256 signing key — store it on the receiving side first; it is write-only and never readable back), eventTypes (at least one of the 12), enabled. After creating, verify the endpoint with asc_post_webhook_ping. Useful pairing: BETA_FEEDBACK_*_CREATED events + the v0.16 asc_list_beta_feedback_* read tools.',
      inputSchema: {
        appId: AppIdSchema,
        name: z.string().min(1).describe('Display name for the webhook in App Store Connect.'),
        url: z
          .string()
          .url()
          .describe('HTTPS endpoint Apple POSTs event payloads to. Plain http is rejected.'),
        secret: WebhookSecretSchema,
        eventTypes: z
          .array(WebhookEventTypeSchema)
          .min(1)
          .describe('Event types to subscribe to (at least one).'),
        enabled: z
          .boolean()
          .default(true)
          .describe('false: create the webhook paused (no deliveries until enabled via PATCH).'),
      },
    },
    async (input) => {
      const body = buildWebhookCreateBody({
        appId: input.appId,
        name: input.name,
        url: input.url,
        secret: input.secret,
        eventTypes: input.eventTypes,
        enabled: input.enabled,
      });
      try {
        const data = await client.request<unknown>('/v1/webhooks', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created webhook "${input.name}" on app ${input.appId}. Send a test ping with asc_post_webhook_ping to verify the endpoint.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_webhook',
    {
      title: 'Patch a webhook',
      description:
        'PATCH /v1/webhooks/{id} — mutate name, url, secret (rotation), eventTypes (whole-array replace), or enabled (pause/resume deliveries). All attributes optional; pass at least one. Rotating the secret: update the receiving side FIRST, then PATCH — deliveries signed with the new secret start immediately.',
      inputSchema: {
        webhookId: WebhookIdSchema,
        name: z.string().min(1).optional(),
        url: z.string().url().optional(),
        secret: WebhookSecretSchema.optional(),
        eventTypes: z
          .array(WebhookEventTypeSchema)
          .min(1)
          .optional()
          .describe('REPLACES the whole subscribed set — include every type you want to keep.'),
        enabled: z.boolean().optional().describe('false pauses deliveries; true resumes.'),
      },
    },
    async (input) => {
      const anyField = [input.name, input.url, input.secret, input.eventTypes, input.enabled].some(
        (v) => v !== undefined,
      );
      if (!anyField) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one attribute to mutate (name, url, secret, eventTypes, enabled).',
            },
          ],
          isError: true,
        };
      }
      const body = buildWebhookPatchBody({
        webhookId: input.webhookId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.secret !== undefined ? { secret: input.secret } : {}),
        ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });
      try {
        const data = await client.request<unknown>(
          `/v1/webhooks/${encodeURIComponent(input.webhookId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched webhook ${input.webhookId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_webhook',
    {
      title: 'Delete a webhook',
      description:
        'DELETE /v1/webhooks/{id} — permanently remove the webhook and stop all deliveries. Delivery history is gone with it. To pause instead of delete, PATCH enabled=false.',
      inputSchema: {
        webhookId: WebhookIdSchema,
      },
    },
    async ({ webhookId }) => {
      try {
        await client.request<unknown>(`/v1/webhooks/${encodeURIComponent(webhookId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Deleted webhook ${webhookId}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_webhook_deliveries',
    {
      title: 'List webhook deliveries',
      description:
        "GET /v1/webhooks/{id}/deliveries — per-attempt delivery records: state (SUCCEEDED / FAILED / PENDING), event type, sent date, response HTTP status, error message, and whether the attempt was a redelivery. Filter by state and createdDate window to find failures ('list FAILED deliveries since yesterday'), then retry them with asc_post_webhook_redelivery.",
      inputSchema: {
        webhookId: WebhookIdSchema,
        deliveryStates: z.array(WebhookDeliveryStateSchema).optional(),
        createdAfterOrAt: z
          .string()
          .optional()
          .describe(
            'ISO 8601 instant (e.g. "2026-06-09T00:00:00Z"). Wire key filter[createdDateGreaterThanOrEqualTo].',
          ),
        createdBefore: z
          .string()
          .optional()
          .describe('ISO 8601 instant. Wire key filter[createdDateLessThan].'),
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      },
    },
    async (input) => {
      const params = buildWebhookDeliveryListQuery({
        ...(input.deliveryStates?.length ? { deliveryStates: input.deliveryStates } : {}),
        ...(input.createdAfterOrAt !== undefined
          ? { createdAfterOrAt: input.createdAfterOrAt }
          : {}),
        ...(input.createdBefore !== undefined ? { createdBefore: input.createdBefore } : {}),
      });
      const path = `/v1/webhooks/${encodeURIComponent(input.webhookId)}/deliveries?${params.toString()}`;
      try {
        const pages = await paginate(client, path, input.maxItems);
        const text = input.raw ? JSON.stringify(pages, null, 2) : digestWebhookDeliveries(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_webhook_redelivery',
    {
      title: 'Retry a webhook delivery',
      description:
        'POST /v1/webhookDeliveries — re-send a previous delivery (typically a FAILED one from asc_list_webhook_deliveries). The body carries only a `template` relationship pointing at the existing delivery; Apple creates a NEW delivery attempt with redelivery=true. The original record is untouched.',
      inputSchema: {
        templateDeliveryId: WebhookDeliveryIdSchema.describe(
          'The existing delivery to re-send (its ID from asc_list_webhook_deliveries).',
        ),
      },
    },
    async ({ templateDeliveryId }) => {
      const body = buildWebhookRedeliveryBody(templateDeliveryId);
      try {
        const data = await client.request<unknown>('/v1/webhookDeliveries', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Requested redelivery from template ${templateDeliveryId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_webhook_ping',
    {
      title: 'Send a test ping to a webhook',
      description:
        'POST /v1/webhookPings — have Apple send a test event to the webhook endpoint NOW (arrives with ping=true in the payload). The response resource is id-only; check the result via asc_list_webhook_deliveries (the ping shows up as a delivery). Use right after create/patch to verify the endpoint + signature handling.',
      inputSchema: {
        webhookId: WebhookIdSchema,
      },
    },
    async ({ webhookId }) => {
      const body = buildWebhookPingBody(webhookId);
      try {
        const data = await client.request<unknown>('/v1/webhookPings', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Sent test ping to webhook ${webhookId}. Check asc_list_webhook_deliveries for the result.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
