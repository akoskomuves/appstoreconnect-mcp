import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import {
  FinanceRegionCodeSchema,
  ReportFrequencySchema,
  SalesReportSubTypeSchema,
  SalesReportTypeSchema,
  VendorNumberSchema,
} from '../schemas.js';

// Sales + finance reports are NOT JSON:API resources. GET /v1/salesReports
// and GET /v1/financeReports return a GZIPPED TSV file (content-type
// application/a-gzip) selected entirely by filter params — there is no id,
// no attributes, no pagination. This domain gunzips, parses, and digests.
//
// Param rules (from the Swift contract — all four/four are REQUIRED arrays):
//   salesReports: filter[vendorNumber] + filter[reportType] +
//     filter[reportSubType] + filter[frequency], optional filter[reportDate]
//     + filter[version].
//   financeReports: filter[vendorNumber] + filter[reportType]
//     (FINANCIAL | FINANCE_DETAIL) + filter[regionCode] + filter[reportDate]
//     — ALL required, no optional params.
//
// The vendor number is ACCOUNT-level (App Store Connect → Payments and
// Financial Reports → top-left vendor selector, a numeric string like
// "85123456"). Tools take it as a param with an ASC_VENDOR_NUMBER env
// fallback so day-to-day calls don't need to repeat it.
//
// reportDate granularity follows frequency: DAILY/WEEKLY → YYYY-MM-DD,
// MONTHLY → YYYY-MM, YEARLY → YYYY. Apple 404s ("There were no sales")
// when no report exists for the requested date — that is data absence,
// not an error in the request shape.

export interface SalesReportParams {
  vendorNumber: string;
  reportType: string;
  reportSubType: string;
  frequency: string;
  reportDate?: string | undefined;
  version?: string | undefined;
}

export function buildSalesReportQuery(params: SalesReportParams): URLSearchParams {
  const q = new URLSearchParams();
  q.set('filter[vendorNumber]', params.vendorNumber);
  q.set('filter[reportType]', params.reportType);
  q.set('filter[reportSubType]', params.reportSubType);
  q.set('filter[frequency]', params.frequency);
  if (params.reportDate !== undefined) q.set('filter[reportDate]', params.reportDate);
  if (params.version !== undefined) q.set('filter[version]', params.version);
  return q;
}

export interface FinanceReportParams {
  vendorNumber: string;
  reportType: string;
  regionCode: string;
  reportDate: string;
}

export function buildFinanceReportQuery(params: FinanceReportParams): URLSearchParams {
  const q = new URLSearchParams();
  q.set('filter[vendorNumber]', params.vendorNumber);
  q.set('filter[reportType]', params.reportType);
  q.set('filter[regionCode]', params.regionCode);
  q.set('filter[reportDate]', params.reportDate);
  return q;
}

// Gunzip if the payload is gzip (magic bytes 1f 8b); some error paths and
// hypothetical future plain responses come through as-is.
export function decodeReportPayload(payload: Buffer): string {
  if (payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
    return gunzipSync(payload).toString('utf-8');
  }
  return payload.toString('utf-8');
}

// TSV → preview digest. Reports can run to hundreds of thousands of rows —
// the digest shows the header + first maxRows rows + a row count so the
// model can decide what to do next (aggregate via saveTo + local tooling,
// or re-pull with a narrower report).
export function digestTsvReport(tsv: string, maxRows: number): string {
  const lines = tsv.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return '(empty report)';
  const header = lines[0] ?? '';
  const dataRows = lines.slice(1);
  const preview = dataRows.slice(0, maxRows);
  const truncNote =
    dataRows.length > maxRows
      ? `\n… ${dataRows.length - maxRows} more rows — use saveTo to write the full TSV to disk, or raw:true (large!)`
      : '';
  return `${dataRows.length} data rows · ${header.split('\t').length} columns\n\n${header}\n${preview.join('\n')}${truncNote}`;
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function resolveVendorNumber(param: string | undefined): string | undefined {
  return param ?? process.env.ASC_VENDOR_NUMBER;
}

const NO_VENDOR_MSG =
  'No vendor number: pass vendorNumber or set ASC_VENDOR_NUMBER in the MCP server env. Find it in App Store Connect → Payments and Financial Reports (numeric string in the vendor selector, e.g. "85123456").';

export function registerSalesReports(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_get_sales_report',
    {
      title: 'Download a sales report',
      description:
        'GET /v1/salesReports — gzipped TSV download, NOT a JSON:API list. Pick reportType (SALES = units by day/week/month; SUBSCRIPTION = active sub counts; SUBSCRIPTION_EVENT = renew/cancel events; SUBSCRIBER = per-subscriber detail; INSTALLS, PRE_ORDER, …), reportSubType, frequency, and reportDate matching the frequency granularity (DAILY/WEEKLY → YYYY-MM-DD, MONTHLY → YYYY-MM, YEARLY → YYYY; omit for the latest available). Returns a header + row preview; use saveTo for the full file. Apple 404s with "there were no sales" when no data exists for that date — absence, not a malformed request.',
      inputSchema: {
        vendorNumber: VendorNumberSchema.optional(),
        reportType: SalesReportTypeSchema,
        reportSubType: SalesReportSubTypeSchema.default('SUMMARY'),
        frequency: ReportFrequencySchema.default('DAILY'),
        reportDate: z
          .string()
          .optional()
          .describe(
            'YYYY-MM-DD (DAILY/WEEKLY), YYYY-MM (MONTHLY), or YYYY (YEARLY). Omit for the most recent report Apple has.',
          ),
        version: z
          .string()
          .optional()
          .describe(
            'Report-format version (e.g. "1_4"). Omit for Apple\'s default. Only some reportTypes are versioned — surface Apple\'s error verbatim if rejected.',
          ),
        maxRows: z.number().int().positive().max(500).default(50),
        raw: z.boolean().default(false).describe('Return the full decoded TSV (can be huge).'),
        saveTo: z
          .string()
          .optional()
          .describe('Absolute file path — write the full decoded TSV there instead of inlining.'),
      },
    },
    async (input) => {
      const vendorNumber = resolveVendorNumber(input.vendorNumber);
      if (!vendorNumber) {
        return { content: [{ type: 'text', text: NO_VENDOR_MSG }], isError: true };
      }
      const q = buildSalesReportQuery({
        vendorNumber,
        reportType: input.reportType,
        reportSubType: input.reportSubType,
        frequency: input.frequency,
        ...(input.reportDate !== undefined ? { reportDate: input.reportDate } : {}),
        ...(input.version !== undefined ? { version: input.version } : {}),
      });
      try {
        const payload = await client.requestBinary(`/v1/salesReports?${q.toString()}`);
        const tsv = decodeReportPayload(payload);
        if (input.saveTo) {
          writeFileSync(input.saveTo, tsv);
          const rows = tsv.split('\n').filter((l) => l.length > 0).length;
          return {
            content: [
              {
                type: 'text',
                text: `Saved ${rows} lines (${tsv.length} bytes decoded) to ${input.saveTo}.\n\n${digestTsvReport(tsv, 5)}`,
              },
            ],
          };
        }
        const text = input.raw ? tsv : digestTsvReport(tsv, input.maxRows);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_finance_report',
    {
      title: 'Download a finance report',
      description:
        'GET /v1/financeReports — gzipped TSV download of Apple\'s monthly financial report (what Apple actually pays out, post-commission, in payout currency). ALL params required by Apple: regionCode (a currency/region like "US", "EU", "JP" — or "ZZ" for the consolidated all-regions FINANCIAL report), reportDate (YYYY-MM, Apple\'s FISCAL months — Apple\'s fiscal calendar is offset from calendar months), reportType FINANCIAL or FINANCE_DETAIL (FINANCE_DETAIL only supports regionCode Z1). Returns header + row preview; saveTo for the full file.',
      inputSchema: {
        vendorNumber: VendorNumberSchema.optional(),
        regionCode: FinanceRegionCodeSchema,
        reportDate: z
          .string()
          .regex(/^\d{4}-\d{2}$/, 'Must be YYYY-MM')
          .describe("Fiscal-period month, YYYY-MM (Apple's fiscal calendar, not calendar months)."),
        reportType: z
          .enum(['FINANCIAL', 'FINANCE_DETAIL'])
          .default('FINANCIAL')
          .describe(
            'FINANCIAL: per-region earned amounts. FINANCE_DETAIL: transaction-level detail (only valid with regionCode Z1).',
          ),
        maxRows: z.number().int().positive().max(500).default(50),
        raw: z.boolean().default(false),
        saveTo: z.string().optional(),
      },
    },
    async (input) => {
      const vendorNumber = resolveVendorNumber(input.vendorNumber);
      if (!vendorNumber) {
        return { content: [{ type: 'text', text: NO_VENDOR_MSG }], isError: true };
      }
      const q = buildFinanceReportQuery({
        vendorNumber,
        reportType: input.reportType,
        regionCode: input.regionCode,
        reportDate: input.reportDate,
      });
      try {
        const payload = await client.requestBinary(`/v1/financeReports?${q.toString()}`);
        const tsv = decodeReportPayload(payload);
        if (input.saveTo) {
          writeFileSync(input.saveTo, tsv);
          const rows = tsv.split('\n').filter((l) => l.length > 0).length;
          return {
            content: [
              {
                type: 'text',
                text: `Saved ${rows} lines (${tsv.length} bytes decoded) to ${input.saveTo}.\n\n${digestTsvReport(tsv, 5)}`,
              },
            ],
          };
        }
        const text = input.raw ? tsv : digestTsvReport(tsv, input.maxRows);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
