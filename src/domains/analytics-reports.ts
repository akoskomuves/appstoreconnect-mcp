import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestAnalyticsReportInstances,
  digestAnalyticsReportRequests,
  digestAnalyticsReportSegments,
  digestAnalyticsReports,
} from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  AnalyticsAccessTypeSchema,
  AnalyticsGranularitySchema,
  AnalyticsReportCategorySchema,
  AnalyticsReportIdSchema,
  AnalyticsReportInstanceIdSchema,
  AnalyticsReportRequestIdSchema,
  AppIdSchema,
} from '../schemas.js';

// The Analytics Reports surface is a FOUR-LEVEL chain, all JSON:API until
// the final download:
//
//   1. AnalyticsReportRequest — per (app, accessType). ONGOING keeps
//      producing new instances; ONE_TIME_SNAPSHOT backfills history.
//      Create / list / get / delete. One per (app, accessType) — Apple
//      rejects duplicates.
//   2. AnalyticsReport — the report catalog under a request, grouped by
//      category (APP_USAGE / APP_STORE_ENGAGEMENT / COMMERCE /
//      FRAMEWORK_USAGE / PERFORMANCE) and addressed by human name
//      (e.g. "App Store Installation and Deletion Standard").
//   3. AnalyticsReportInstance — a dated materialization (granularity ×
//      processingDate).
//   4. AnalyticsReportSegment — the downloadable chunk(s): checksum,
//      sizeInBytes, and a PRE-SIGNED TIME-LIMITED url (plain fetch, no ASC
//      auth header — the signature is in the URL). Content is gzip CSV.
//
// Wire-key gotchas (verified against AvdLee Swift SDK):
//   - Swift `isStoppedDueToInactivity` → wire `stoppedDueToInactivity`
//     (is-prefix strip; read-only). ONGOING requests that auto-paused show
//     true — delete + recreate to resume data generation.
//   - The request list supports a NESTED limit param `limit[reports]`
//     (unused here — we list reports per-request instead).
//   - New instances take up to ~48h after a request is created; an empty
//     instances list right after creation is normal, not a bug.

const ANALYTICS_REQUEST_FIELDS = 'accessType,stoppedDueToInactivity,reports';
const ANALYTICS_REPORT_FIELDS = 'name,category,instances';
const ANALYTICS_INSTANCE_FIELDS = 'granularity,processingDate,segments';
const ANALYTICS_SEGMENT_FIELDS = 'checksum,sizeInBytes,url';

interface JSONAPIBody {
  data: {
    type: string;
    attributes: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
}

export function buildAnalyticsReportRequestCreateBody(input: {
  appId: string;
  accessType: string;
}): JSONAPIBody {
  return {
    data: {
      type: 'analyticsReportRequests',
      attributes: { accessType: input.accessType },
      relationships: {
        app: { data: { type: 'apps', id: input.appId } },
      },
    },
  };
}

export function decodeSegmentPayload(payload: Buffer): string {
  if (payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
    return gunzipSync(payload).toString('utf-8');
  }
  return payload.toString('utf-8');
}

export function digestCsvPreview(csv: string, maxRows: number): string {
  const lines = csv.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return '(empty segment)';
  const header = lines[0] ?? '';
  const dataRows = lines.slice(1);
  const preview = dataRows.slice(0, maxRows);
  const truncNote =
    dataRows.length > maxRows
      ? `\n… ${dataRows.length - maxRows} more rows — use saveTo to write the full CSV to disk, or raw:true (large!)`
      : '';
  return `${dataRows.length} data rows · ${header.split(',').length} columns\n\n${header}\n${preview.join('\n')}${truncNote}`;
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerAnalyticsReports(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_post_analytics_report_request',
    {
      title: 'Create an analytics report request',
      description:
        'POST /v1/analyticsReportRequests — turn on analytics report generation for an app. accessType ONGOING (Apple keeps producing daily/weekly/monthly instances; may auto-pause after inactivity — stoppedDueToInactivity=true — delete + recreate to resume) or ONE_TIME_SNAPSHOT (single historical backfill). One request per (app, accessType); duplicates are rejected. Instances appear up to ~48h later — an empty chain right after creation is normal.',
      inputSchema: z.object({
        appId: AppIdSchema,
        accessType: AnalyticsAccessTypeSchema,
      }),
    },
    async ({ appId, accessType }) => {
      const body = buildAnalyticsReportRequestCreateBody({ appId, accessType });
      try {
        const data = await client.request<unknown>('/v1/analyticsReportRequests', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created ${accessType} analytics report request on app ${appId}. Reports list will populate; instances can take up to ~48h.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_analytics_report_requests',
    {
      title: 'List analytics report requests of an app',
      description:
        'GET /v1/apps/{id}/analyticsReportRequests — the existing requests (at most one ONGOING + one ONE_TIME_SNAPSHOT). stoppedDueToInactivity=true on an ONGOING request means Apple auto-paused it; delete + recreate to resume.',
      inputSchema: z.object({
        appId: AppIdSchema,
        accessType: AnalyticsAccessTypeSchema.optional().describe('Optional filter.'),
        raw: z.boolean().default(false),
      }),
    },
    async ({ appId, accessType, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[analyticsReportRequests]', ANALYTICS_REQUEST_FIELDS);
      if (accessType) params.set('filter[accessType]', accessType);
      params.set('limit', '50');
      const path = `/v1/apps/${encodeURIComponent(appId)}/analyticsReportRequests?${params.toString()}`;
      try {
        const pages = await paginate(client, path, 50);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAnalyticsReportRequests(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_analytics_report_request',
    {
      title: 'Delete an analytics report request',
      description:
        'DELETE /v1/analyticsReportRequests/{id} — stop report generation for this request and drop access to its report chain. Recreating later starts fresh (ONGOING resumes from creation; ONE_TIME_SNAPSHOT re-backfills).',
      inputSchema: z.object({
        requestId: AnalyticsReportRequestIdSchema,
      }),
    },
    async ({ requestId }) => {
      try {
        await client.request<unknown>(
          `/v1/analyticsReportRequests/${encodeURIComponent(requestId)}`,
          { method: 'DELETE' },
        );
        return {
          content: [{ type: 'text', text: `Deleted analytics report request ${requestId}.` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_analytics_reports',
    {
      title: 'List reports under an analytics report request',
      description:
        'GET /v1/analyticsReportRequests/{id}/reports — the report catalog: one row per report name (e.g. "App Store Installation and Deletion Standard") within a category. Filter by category (COMMERCE for downloads/proceeds, APP_USAGE for sessions/crashes, APP_STORE_ENGAGEMENT for impressions/page views) or exact name. Take a report ID into asc_list_analytics_report_instances.',
      inputSchema: z.object({
        requestId: AnalyticsReportRequestIdSchema,
        category: AnalyticsReportCategorySchema.optional(),
        name: z
          .string()
          .optional()
          .describe('Exact report name filter (e.g. "App Downloads Standard").'),
        maxItems: z.number().int().positive().max(500).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ requestId, category, name, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[analyticsReports]', ANALYTICS_REPORT_FIELDS);
      if (category) params.set('filter[category]', category);
      if (name) params.set('filter[name]', name);
      params.set('limit', '200');
      const path = `/v1/analyticsReportRequests/${encodeURIComponent(requestId)}/reports?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAnalyticsReports(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_analytics_report_instances',
    {
      title: 'List instances of an analytics report',
      description:
        'GET /v1/analyticsReports/{id}/instances — the dated materializations of one report, one row per (granularity, processingDate). Filter granularity DAILY/WEEKLY/MONTHLY and/or processingDate (YYYY-MM-DD). Take an instance ID into asc_list_analytics_report_segments. Empty within ~48h of creating the request is normal.',
      inputSchema: z.object({
        reportId: AnalyticsReportIdSchema,
        granularity: AnalyticsGranularitySchema.optional(),
        processingDate: z
          .string()
          .optional()
          .describe('YYYY-MM-DD — the date the instance covers/was processed.'),
        maxItems: z.number().int().positive().max(2000).default(200),
        raw: z.boolean().default(false),
      }),
    },
    async ({ reportId, granularity, processingDate, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[analyticsReportInstances]', ANALYTICS_INSTANCE_FIELDS);
      if (granularity) params.set('filter[granularity]', granularity);
      if (processingDate) params.set('filter[processingDate]', processingDate);
      params.set('limit', '200');
      const path = `/v1/analyticsReports/${encodeURIComponent(reportId)}/instances?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAnalyticsReportInstances(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_analytics_report_segments',
    {
      title: 'List segments of an analytics report instance',
      description:
        'GET /v1/analyticsReportInstances/{id}/segments — the downloadable chunks of one instance: checksum, sizeInBytes, and a PRE-SIGNED TIME-LIMITED url. Download promptly with asc_download_analytics_report_segment (pass the URL through verbatim); if a URL expires, re-list segments for fresh ones.',
      inputSchema: z.object({
        instanceId: AnalyticsReportInstanceIdSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ instanceId, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[analyticsReportSegments]', ANALYTICS_SEGMENT_FIELDS);
      params.set('limit', '200');
      const path = `/v1/analyticsReportInstances/${encodeURIComponent(instanceId)}/segments?${params.toString()}`;
      try {
        const pages = await paginate(client, path, 200);
        const text = raw ? JSON.stringify(pages, null, 2) : digestAnalyticsReportSegments(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_download_analytics_report_segment',
    {
      title: 'Download an analytics report segment',
      description:
        'Fetch a segment URL from asc_list_analytics_report_segments (pre-signed — fetched WITHOUT the ASC auth header; the signature lives in the URL) and gunzip the CSV. Returns header + row preview; saveTo writes the full decoded CSV to disk. Expired URL → re-list segments for a fresh one.',
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe('The segment url verbatim from asc_list_analytics_report_segments.'),
        maxRows: z.number().int().positive().max(500).default(50),
        raw: z.boolean().default(false),
        saveTo: z
          .string()
          .optional()
          .describe('Absolute file path — write the full decoded CSV there instead of inlining.'),
      }),
    },
    async ({ url, maxRows, raw, saveTo }) => {
      try {
        // Pre-signed URL: plain fetch, NO Authorization header — sending the
        // ASC bearer to a non-Apple-API host would leak it and Apple's signed
        // S3-style URLs reject extra auth anyway.
        const response = await fetch(url);
        if (!response.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Segment download failed: HTTP ${response.status}. Pre-signed URLs are time-limited — re-run asc_list_analytics_report_segments for a fresh one.`,
              },
            ],
            isError: true,
          };
        }
        const payload = Buffer.from(await response.arrayBuffer());
        const csv = decodeSegmentPayload(payload);
        if (saveTo) {
          writeFileSync(saveTo, csv);
          const rows = csv.split('\n').filter((l) => l.length > 0).length;
          return {
            content: [
              {
                type: 'text',
                text: `Saved ${rows} lines (${csv.length} bytes decoded) to ${saveTo}.\n\n${digestCsvPreview(csv, 5)}`,
              },
            ],
          };
        }
        const text = raw ? csv : digestCsvPreview(csv, maxRows);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
