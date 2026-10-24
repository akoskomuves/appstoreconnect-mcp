import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestIdentifierRecords, digestLinkedCertificates } from '../digest-users-access.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import { CertificateTypeSchema } from '../schemas.js';

// Pass Type IDs (Apple Wallet) and Merchant IDs (Apple Pay) — two more
// Developer-portal identifiers, next to the bundle IDs in provisioning.ts and
// following its conventions: Admin-role key, the same 403 hint, no extra
// write gates beyond clear warnings.
//
// Both resources have the same shape: { name, identifier }. The reverse-DNS
// identifier (pass.com.example.x / merchant.com.example.x) is IMMUTABLE after
// creation; only `name` can be PATCHed. Each has a read-only `certificates`
// relationship — the Pass Type ID / Apple Pay certificates are created through
// POST /v1/certificates (certificate types PASS_TYPE_ID*, APPLE_PAY*).
//
// DELETE consequences:
//   * Pass Type ID — its certificates are revoked; passes already in users'
//     wallets stay but can no longer be updated or pushed to.
//   * Merchant ID — Apple Pay stops working for every app and website that
//     processes payments through it.

const RECORD_FIELDS = 'name,identifier,certificates';
const CERT_FIELDS =
  'name,certificateType,displayName,serialNumber,platform,expirationDate,activated';

const maxItemsSchema = z.number().int().positive().max(2000).default(500);

interface JSONAPIBody {
  data: { type: string; id?: string; attributes?: Record<string, unknown> };
}

type Kind = 'passTypeIds' | 'merchantIds';

// ----- Body builders -----

export function buildIdentifierCreateBody(
  kind: Kind,
  input: { name: string; identifier: string },
): JSONAPIBody {
  return { data: { type: kind, attributes: { name: input.name, identifier: input.identifier } } };
}

export function buildIdentifierPatchBody(kind: Kind, id: string, name: string): JSONAPIBody {
  // Only `name` is mutable; Apple wants the id in the body as well as the URL.
  return { data: { type: kind, id, attributes: { name } } };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function explain403(err: unknown): string | undefined {
  if (!(err instanceof ASCError) || err.status !== 403) return undefined;
  return `403 FORBIDDEN — Pass Type IDs and Merchant IDs, like the rest of the provisioning surface, require an API key with the ADMIN (or Account Holder) role. Generate an Admin key in App Store Connect → Users and Access → Integrations, or perform this step in the developer portal UI.\n\n${formatASCError(err)}`;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function fail(err: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: explain403(err) ?? formatASCError(err) }],
    isError: true,
  };
}

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

interface KindSpec {
  kind: Kind;
  /** snake_case for tool names, e.g. pass_type_id */
  slug: string;
  label: string;
  example: string;
  deleteWarning: string;
}

const SPECS: KindSpec[] = [
  {
    kind: 'passTypeIds',
    slug: 'pass_type_id',
    label: 'Pass Type ID',
    example: 'pass.com.example.membership',
    deleteWarning:
      '⚠️ Deleting a Pass Type ID revokes its certificates: passes already in users’ wallets stay, but can no longer be updated or receive push updates.',
  },
  {
    kind: 'merchantIds',
    slug: 'merchant_id',
    label: 'Merchant ID',
    example: 'merchant.com.example.store',
    deleteWarning:
      '⚠️ Deleting a Merchant ID breaks Apple Pay for every app and website that processes payments through it, immediately.',
  },
];

export function registerPassMerchantIds(server: McpServer, client: ASCClient): void {
  for (const spec of SPECS) {
    const base = `/v1/${spec.kind}`;
    const recordSchema = z
      .string()
      .min(1)
      .describe(
        `Opaque ${spec.label} resource id (the ID column of asc_list_${spec.slug}s) — not the reverse-DNS identifier.`,
      );

    server.registerTool(
      `asc_list_${spec.slug}s`,
      {
        title: `List ${spec.label}s`,
        description: `List the team's registered ${spec.label}s. The ID column is the opaque record id the other ${spec.label} tools take. Optional exact filters on identifier and name. Requires an Admin-role API key.`,
        inputSchema: z.object({
          identifier: z.string().optional().describe(`Exact identifier, e.g. ${spec.example}.`),
          name: z.string().optional(),
          maxItems: maxItemsSchema,
          raw: z.boolean().default(false),
        }),
      },
      async ({ identifier, name, maxItems, raw }) => {
        const params = new URLSearchParams();
        params.set(`fields[${spec.kind}]`, RECORD_FIELDS);
        params.set('limit', '200');
        if (identifier) params.set('filter[identifier]', identifier);
        if (name) params.set('filter[name]', name);
        try {
          const pages = await paginate(client, `${base}?${params.toString()}`, maxItems);
          return {
            content: [
              {
                type: 'text',
                text: raw
                  ? JSON.stringify(pages, null, 2)
                  : digestIdentifierRecords(pages, `${spec.label}s`),
              },
            ],
          };
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      `asc_get_${spec.slug}`,
      {
        title: `Get a ${spec.label}`,
        description: `Fetch one ${spec.label} with its certificates (without certificateContent — use asc_get_certificate for that).`,
        inputSchema: z.object({ recordId: recordSchema }),
      },
      async ({ recordId: id }) => {
        try {
          return json(
            await client.request<unknown>(
              `${base}/${encodeURIComponent(id)}?fields[${spec.kind}]=${RECORD_FIELDS}&include=certificates&fields[certificates]=${CERT_FIELDS}&limit[certificates]=50`,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      `asc_list_${spec.slug}_certificates`,
      {
        title: `List the certificates of a ${spec.label}`,
        description: `List the signing certificates attached to a ${spec.label}, with type, serial and expiry. Create new ones with asc_post_certificate.`,
        inputSchema: z.object({
          recordId: recordSchema,
          certificateType: CertificateTypeSchema.optional(),
          maxItems: maxItemsSchema,
          raw: z.boolean().default(false),
        }),
      },
      async ({ recordId, certificateType, maxItems, raw }) => {
        const params = new URLSearchParams();
        params.set('fields[certificates]', CERT_FIELDS);
        params.set('limit', '200');
        if (certificateType) params.set('filter[certificateType]', certificateType);
        try {
          const pages = await paginate(
            client,
            `${base}/${encodeURIComponent(recordId)}/certificates?${params.toString()}`,
            maxItems,
          );
          return {
            content: [
              {
                type: 'text',
                text: raw ? JSON.stringify(pages, null, 2) : digestLinkedCertificates(pages),
              },
            ],
          };
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      `asc_post_${spec.slug}`,
      {
        title: `Register a ${spec.label}`,
        description: `Register a new ${spec.label}. The reverse-DNS identifier (e.g. ${spec.example}) is IMMUTABLE after creation — only the name can change later.`,
        inputSchema: z.object({
          name: z.string().min(1).describe('Display name in the portal (mutable later).'),
          identifier: z
            .string()
            .min(1)
            .describe(`Reverse-DNS identifier, e.g. ${spec.example}. IMMUTABLE.`),
        }),
      },
      async ({ name, identifier }) => {
        try {
          return json(
            await client.request<unknown>(base, {
              method: 'POST',
              body: JSON.stringify(buildIdentifierCreateBody(spec.kind, { name, identifier })),
            }),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      `asc_patch_${spec.slug}`,
      {
        title: `Rename a ${spec.label}`,
        description: `Update a ${spec.label}'s display name — the only mutable attribute.`,
        inputSchema: z.object({ recordId: recordSchema, name: z.string().min(1) }),
      },
      async ({ recordId: id, name }) => {
        try {
          return json(
            await client.request<unknown>(`${base}/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              body: JSON.stringify(buildIdentifierPatchBody(spec.kind, id, name)),
            }),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      `asc_delete_${spec.slug}`,
      {
        title: `Delete a ${spec.label}`,
        description: `${spec.deleteWarning} Check asc_list_${spec.slug}_certificates first.`,
        inputSchema: z.object({ recordId: recordSchema }),
      },
      async ({ recordId: id }) => {
        try {
          await client.request<void>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
          return { content: [{ type: 'text', text: `Deleted ${spec.label} record ${id}.` }] };
        } catch (err) {
          return fail(err);
        }
      },
    );
  }
}
