import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestSandboxTesters } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import { SandboxTesterIdSchema, SubscriptionRenewalRateSchema } from '../schemas.js';

// Sandbox testers — the StoreKit test accounts used to exercise IAP/subscription
// flows before release. Pairs with the monetization surface: set an accelerated
// subscriptionRenewalRate on a tester, run the purchase in sandbox, then clear
// the purchase history and run it again.
//
//   * The whole surface lives on /v2 (there is no v1). Testers are CREATED in
//     App Store Connect's UI (Users and Access → Sandbox Testers) — the API
//     exposes list + PATCH + clear-history, not create/delete.
//   * Wire keys keep their natural names — `interruptPurchases`,
//     `applePayCompatible` (no is-prefix in the spec, nothing to strip).
//   * Clear-purchase-history is a relationships-only POST carrying a to-many
//     sandboxTesters linkage; it wipes SANDBOX purchase records only (that is
//     the point — it never touches production data).

const SANDBOX_TESTER_FIELDS =
  'firstName,lastName,acAccountName,territory,applePayCompatible,interruptPurchases,subscriptionRenewalRate';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface SandboxTesterPatchInput {
  testerId: string;
  territory?: string | undefined;
  interruptPurchases?: boolean | undefined;
  subscriptionRenewalRate?: string | undefined;
}

export function buildSandboxTesterPatchBody(input: SandboxTesterPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.territory !== undefined) attributes.territory = input.territory;
  if (input.interruptPurchases !== undefined) {
    attributes.interruptPurchases = input.interruptPurchases;
  }
  if (input.subscriptionRenewalRate !== undefined) {
    attributes.subscriptionRenewalRate = input.subscriptionRenewalRate;
  }
  return {
    data: {
      type: 'sandboxTesters',
      // Apple requires the id in the body as well as the URL (409 otherwise).
      id: input.testerId,
      attributes,
    },
  };
}

export function buildClearPurchaseHistoryBody(testerIds: string[]): JSONAPIBody {
  // Relationships-only create — no attributes block.
  return {
    data: {
      type: 'sandboxTestersClearPurchaseHistoryRequest',
      relationships: {
        sandboxTesters: {
          data: testerIds.map((id) => ({ type: 'sandboxTesters', id })),
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

export function registerSandboxTesters(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_sandbox_testers',
    {
      title: 'List sandbox testers',
      description:
        'List the StoreKit sandbox test accounts of the team — name, Apple Account (acAccountName), territory, accelerated subscription renewal rate, interrupt-purchases flag. Testers are created in the ASC UI; the API manages their settings. Lives on /v2 (no v1 surface).',
      inputSchema: z.object({
        maxItems: z.number().int().positive().max(2000).default(500),
        raw: z.boolean().default(false),
      }),
    },
    async ({ maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[sandboxTesters]', SANDBOX_TESTER_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(client, `/v2/sandboxTesters?${params.toString()}`, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestSandboxTesters(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_sandbox_tester',
    {
      title: 'Update a sandbox tester',
      description:
        "Update a sandbox tester's settings: territory (3-letter ISO — changes the storefront the tester purchases against), interruptPurchases (forces the App Store 'ask to buy'-style interruption sheet on every purchase), subscriptionRenewalRate (accelerated renewals — e.g. a month renews every 5 minutes — for testing renewal/billing-retry/grace flows). Pass at least one. Sandbox-only; no production effect.",
      inputSchema: z.object({
        testerId: SandboxTesterIdSchema,
        territory: z
          .string()
          .length(3)
          .optional()
          .describe('3-letter ISO territory code (USA / DEU / JPN…).'),
        interruptPurchases: z.boolean().optional(),
        subscriptionRenewalRate: SubscriptionRenewalRateSchema.optional(),
      }),
    },
    async ({ testerId, territory, interruptPurchases, subscriptionRenewalRate }) => {
      if (
        territory === undefined &&
        interruptPurchases === undefined &&
        subscriptionRenewalRate === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of territory, interruptPurchases, subscriptionRenewalRate.',
            },
          ],
          isError: true,
        };
      }
      const body = buildSandboxTesterPatchBody({
        testerId,
        territory,
        interruptPurchases,
        subscriptionRenewalRate,
      });
      try {
        const data = await client.request<unknown>(
          `/v2/sandboxTesters/${encodeURIComponent(testerId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched sandbox tester ${testerId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_sandbox_testers_clear_purchase_history',
    {
      title: 'Clear the purchase history of sandbox testers',
      description:
        'Wipe the SANDBOX purchase records of the listed testers so IAP/subscription flows can be re-tested from scratch (intro-offer eligibility resets too). Sandbox-only — production purchases are never touched. Relationships-only POST to /v2/sandboxTestersClearPurchaseHistoryRequest.',
      inputSchema: z.object({
        testerIds: z
          .array(SandboxTesterIdSchema)
          .min(1)
          .describe('Sandbox tester ids from asc_list_sandbox_testers.'),
      }),
    },
    async ({ testerIds }) => {
      const body = buildClearPurchaseHistoryBody(testerIds);
      try {
        const data = await client.request<unknown>(
          '/v2/sandboxTestersClearPurchaseHistoryRequest',
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Cleared sandbox purchase history for ${testerIds.length} tester(s).\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
