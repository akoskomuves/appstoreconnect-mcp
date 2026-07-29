import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestDiagnosticSignatures } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AppIdSchema,
  BuildIdSchema,
  DiagnosticSignatureIdSchema,
  DiagnosticTypeSchema,
  PerfMetricTypeSchema,
} from '../schemas.js';

// Per-build runtime health surfaces — all READ-ONLY (Apple aggregates this
// from opted-in devices; there is nothing to write).
//
//   - DiagnosticSignature: aggregated problem hotspots per build
//     (DISK_WRITES / HANGS / LAUNCHES), weighted by impact. JSON:API.
//   - DiagnosticSignature logs: the anonymized call stacks behind one
//     signature. NOT JSON:API — content type
//     application/vnd.apple.diagnostic-logs+json (a custom document with
//     callStackTree nodes). Fetched via requestText with an Accept override.
//   - PerfPowerMetric: Xcode-metrics percentile curves (launch time, memory,
//     battery, …) per device class. NOT JSON:API either — content type
//     application/vnd.apple.xcode-metrics+json. Same Accept-override path.
//     Available at both /v1/apps/{id}/perfPowerMetrics (rolling across
//     versions) and /v1/builds/{id}/perfPowerMetrics (one build).
//
// Data availability: these populate only for apps with enough opted-in
// usage — 404/empty on small apps is the normal case, not a bug.

const DIAGNOSTIC_SIGNATURE_FIELDS = 'diagnosticType,signature,weight,insight';

const XCODE_METRICS_ACCEPT = 'application/vnd.apple.xcode-metrics+json';
const DIAGNOSTIC_LOGS_ACCEPT = 'application/vnd.apple.diagnostic-logs+json';

export function buildPerfPowerMetricsQuery(filters: {
  platform?: string | undefined;
  metricType?: string | undefined;
  deviceType?: string | undefined;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.platform !== undefined) params.set('filter[platform]', filters.platform);
  if (filters.metricType !== undefined) params.set('filter[metricType]', filters.metricType);
  if (filters.deviceType !== undefined) params.set('filter[deviceType]', filters.deviceType);
  return params;
}

function truncateJson(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} of ${text.length} chars — re-run with a higher maxChars]`;
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerDiagnostics(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_list_diagnostic_signatures',
    {
      title: 'List diagnostic signatures of a build',
      description:
        "GET /v1/builds/{id}/diagnosticSignatures — Apple's aggregated problem hotspots for one build (DISK_WRITES / HANGS / LAUNCHES), weighted by impact (weight sums to ~1 per type). Drill a signature's anonymized call stacks with asc_get_diagnostic_logs. Populates only with enough opted-in usage — empty on small apps is normal.",
      inputSchema: z.object({
        buildId: BuildIdSchema,
        diagnosticType: DiagnosticTypeSchema.optional(),
        maxItems: z.number().int().positive().max(500).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildId, diagnosticType, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[diagnosticSignatures]', DIAGNOSTIC_SIGNATURE_FIELDS);
      if (diagnosticType) params.set('filter[diagnosticType]', diagnosticType);
      params.set('limit', '200');
      const path = `/v1/builds/${encodeURIComponent(buildId)}/diagnosticSignatures?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestDiagnosticSignatures(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_diagnostic_logs',
    {
      title: 'Get the call-stack logs of a diagnostic signature',
      description:
        'GET /v1/diagnosticSignatures/{id}/logs — the anonymized call-stack documents behind one signature. NOT JSON:API: content type application/vnd.apple.diagnostic-logs+json with callStackTree nodes. Returned as raw JSON (capped at maxChars).',
      inputSchema: z.object({
        signatureId: DiagnosticSignatureIdSchema,
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .default(50)
          .describe('Max log documents Apple returns.'),
        maxChars: z.number().int().positive().max(1_000_000).default(200_000),
      }),
    },
    async ({ signatureId, limit, maxChars }) => {
      const path = `/v1/diagnosticSignatures/${encodeURIComponent(signatureId)}/logs?limit=${limit}`;
      try {
        const text = await client.requestText(path, {
          headers: { accept: DIAGNOSTIC_LOGS_ACCEPT },
        });
        return { content: [{ type: 'text', text: truncateJson(text, maxChars) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_app_perf_power_metrics',
    {
      title: 'Get perf/power metrics of an app',
      description:
        'GET /v1/apps/{id}/perfPowerMetrics — Xcode-metrics percentile curves (LAUNCH, MEMORY, BATTERY, HANG, DISK, ANIMATION, TERMINATION, STORAGE) per device class, rolling across recent versions. NOT JSON:API: content type application/vnd.apple.xcode-metrics+json, returned as raw JSON (capped at maxChars). Narrow with metricType/deviceType (e.g. deviceType "iPhone15,2") — the full document is large.',
      inputSchema: z.object({
        appId: AppIdSchema,
        metricType: PerfMetricTypeSchema.optional(),
        deviceType: z
          .string()
          .optional()
          .describe('Device identifier filter, e.g. "iPhone15,2" or "all_iphones".'),
        maxChars: z.number().int().positive().max(1_000_000).default(150_000),
      }),
    },
    async ({ appId, metricType, deviceType, maxChars }) => {
      const params = buildPerfPowerMetricsQuery({
        ...(metricType !== undefined ? { metricType } : {}),
        ...(deviceType !== undefined ? { deviceType } : {}),
      });
      const qs = params.toString();
      const path = `/v1/apps/${encodeURIComponent(appId)}/perfPowerMetrics${qs ? `?${qs}` : ''}`;
      try {
        const text = await client.requestText(path, { headers: { accept: XCODE_METRICS_ACCEPT } });
        return { content: [{ type: 'text', text: truncateJson(text, maxChars) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_build_perf_power_metrics',
    {
      title: 'Get perf/power metrics of a build',
      description:
        'GET /v1/builds/{id}/perfPowerMetrics — same Xcode-metrics document as the app-level tool but scoped to ONE build (compare a new build against the app-level rolling baseline). Same filters and raw-JSON output.',
      inputSchema: z.object({
        buildId: BuildIdSchema,
        metricType: PerfMetricTypeSchema.optional(),
        deviceType: z.string().optional(),
        maxChars: z.number().int().positive().max(1_000_000).default(150_000),
      }),
    },
    async ({ buildId, metricType, deviceType, maxChars }) => {
      const params = buildPerfPowerMetricsQuery({
        ...(metricType !== undefined ? { metricType } : {}),
        ...(deviceType !== undefined ? { deviceType } : {}),
      });
      const qs = params.toString();
      const path = `/v1/builds/${encodeURIComponent(buildId)}/perfPowerMetrics${qs ? `?${qs}` : ''}`;
      try {
        const text = await client.requestText(path, { headers: { accept: XCODE_METRICS_ACCEPT } });
        return { content: [{ type: 'text', text: truncateJson(text, maxChars) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
