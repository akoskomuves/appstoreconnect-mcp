#!/usr/bin/env tsx
// Live smoke for the v0.18 surface. Not wired into the test suite.
//
// Usage:
//   npx tsx scripts/smoke-reports.ts <APP_ID>                       # analytics chain walk
//   npx tsx scripts/smoke-reports.ts <APP_ID> --vendor <VENDOR_NUM> # + sales/finance reads
//
// Analytics: lists existing report requests; if none exists, creates an
// ONGOING one and KEEPS it (instances take ~48h to materialize — deleting
// would restart the clock; the request is dev-side config, invisible to
// users, and useful for growth diagnostics). Walks as deep into the
// request → reports → instances → segments chain as live data allows.
//
// Sales/finance: read-only GETs. A 404 "there were no sales" for thin dates
// is expected behavior, not a failure.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestAnalyticsReportInstances,
  digestAnalyticsReportRequests,
  digestAnalyticsReportSegments,
  digestAnalyticsReports,
} from '../src/digest.js';
import {
  buildAnalyticsReportRequestCreateBody,
  decodeSegmentPayload,
  digestCsvPreview,
} from '../src/domains/analytics-reports.js';
import {
  buildSalesReportQuery,
  decodeReportPayload,
  digestTsvReport,
  requiredVersionFromError,
} from '../src/domains/sales-reports.js';
import { paginate } from '../src/jsonapi.js';

type Client = ReturnType<typeof createASCClient>;

async function analyticsChain(client: Client, appId: string): Promise<void> {
  console.log(`=== Analytics report requests on app ${appId} ===\n`);
  const reqParams = new URLSearchParams();
  reqParams.set('fields[analyticsReportRequests]', 'accessType,stoppedDueToInactivity,reports');
  reqParams.set('limit', '50');
  let requests = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/analyticsReportRequests?${reqParams.toString()}`,
    50,
  );
  console.log(digestAnalyticsReportRequests(requests));

  if (requests.data.length === 0) {
    console.log('\nNo requests — creating an ONGOING one (kept; instances take ~48h)…');
    const body = buildAnalyticsReportRequestCreateBody({ appId, accessType: 'ONGOING' });
    const created = await client.request<{ data: { id: string } }>('/v1/analyticsReportRequests', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    console.log(`Created ${created.data.id}`);
    requests = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(appId)}/analyticsReportRequests?${reqParams.toString()}`,
      50,
    );
    console.log(digestAnalyticsReportRequests(requests));
  }

  for (const req of requests.data) {
    console.log(`\n=== Reports under request ${req.id} (COMMERCE) ===\n`);
    const repParams = new URLSearchParams();
    repParams.set('fields[analyticsReports]', 'name,category,instances');
    repParams.set('filter[category]', 'COMMERCE');
    repParams.set('limit', '200');
    const reports = await paginate(
      client,
      `/v1/analyticsReportRequests/${encodeURIComponent(req.id)}/reports?${repParams.toString()}`,
      200,
    );
    console.log(digestAnalyticsReports(reports));

    const firstReport = reports.data[0];
    if (!firstReport) {
      console.log('(no reports yet — normal right after request creation)');
      continue;
    }

    console.log(`\n=== Instances of report ${firstReport.id} ===\n`);
    const instParams = new URLSearchParams();
    instParams.set('fields[analyticsReportInstances]', 'granularity,processingDate,segments');
    instParams.set('limit', '200');
    const instances = await paginate(
      client,
      `/v1/analyticsReports/${encodeURIComponent(firstReport.id)}/instances?${instParams.toString()}`,
      200,
    );
    console.log(digestAnalyticsReportInstances(instances));

    const firstInstance = instances.data[0];
    if (!firstInstance) {
      console.log('(no instances yet — they take up to ~48h after request creation)');
      continue;
    }

    console.log(`\n=== Segments of instance ${firstInstance.id} ===\n`);
    const segParams = new URLSearchParams();
    segParams.set('fields[analyticsReportSegments]', 'checksum,sizeInBytes,url');
    segParams.set('limit', '200');
    const segments = await paginate(
      client,
      `/v1/analyticsReportInstances/${encodeURIComponent(firstInstance.id)}/segments?${segParams.toString()}`,
      200,
    );
    console.log(digestAnalyticsReportSegments(segments));

    const url = segments.data[0]?.attributes?.url as string | undefined;
    if (url) {
      console.log('\n=== Downloading first segment (no ASC bearer) ===\n');
      const response = await fetch(url);
      if (!response.ok) {
        console.log(`Segment download HTTP ${response.status}`);
      } else {
        const csv = decodeSegmentPayload(Buffer.from(await response.arrayBuffer()));
        console.log(digestCsvPreview(csv, 5));
      }
    }
    break; // one full chain walk is enough
  }
}

async function salesReads(client: Client, vendorNumber: string): Promise<void> {
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`\n=== Sales report: SALES / SUMMARY / DAILY / ${yesterday} ===\n`);
  const q = buildSalesReportQuery({
    vendorNumber,
    reportType: 'SALES',
    reportSubType: 'SUMMARY',
    frequency: 'DAILY',
    reportDate: yesterday,
  });
  try {
    const payload = await client.requestBinary(`/v1/salesReports?${q.toString()}`);
    const tsv = decodeReportPayload(payload);
    console.log(digestTsvReport(tsv, 10));
  } catch (err) {
    console.log(`Sales report error: ${err instanceof Error ? err.message : String(err)}`);
    const details = (err as { details?: unknown }).details;
    if (details) console.log(JSON.stringify(details, null, 2));
  }

  console.log('\n=== Sales report: SUBSCRIPTION / SUMMARY / DAILY (latest) ===\n');
  const q2 = buildSalesReportQuery({
    vendorNumber,
    reportType: 'SUBSCRIPTION',
    reportSubType: 'SUMMARY',
    frequency: 'DAILY',
  });
  try {
    const payload = await client.requestBinary(`/v1/salesReports?${q2.toString()}`);
    const tsv = decodeReportPayload(payload);
    console.log(digestTsvReport(tsv, 10));
  } catch (err) {
    const required = requiredVersionFromError(err);
    if (required) {
      console.log(`(version required — retrying with ${required}, mirroring the tool's self-heal)`);
      const q3 = buildSalesReportQuery({
        vendorNumber,
        reportType: 'SUBSCRIPTION',
        reportSubType: 'SUMMARY',
        frequency: 'DAILY',
        version: required,
      });
      const payload = await client.requestBinary(`/v1/salesReports?${q3.toString()}`);
      console.log(digestTsvReport(decodeReportPayload(payload), 10));
    } else {
      console.log(`Subscription report error: ${err instanceof Error ? err.message : String(err)}`);
      const details = (err as { details?: unknown }).details;
      if (details) console.log(JSON.stringify(details, null, 2));
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const appId = args.find((a) => !a.startsWith('--'));
  if (!appId) {
    console.error('Usage: npx tsx scripts/smoke-reports.ts <APP_ID> [--vendor <VENDOR_NUMBER>]');
    process.exit(1);
  }
  const vendorIdx = args.indexOf('--vendor');
  const vendorNumber = vendorIdx >= 0 ? args[vendorIdx + 1] : process.env.ASC_VENDOR_NUMBER;

  const client = createASCClient(loadConfig());
  await analyticsChain(client, appId);
  if (vendorNumber) {
    await salesReads(client, vendorNumber);
  } else {
    console.log('\n(no --vendor / ASC_VENDOR_NUMBER — sales/finance reads skipped)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
