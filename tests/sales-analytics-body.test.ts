import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildAnalyticsReportRequestCreateBody } from '../src/domains/analytics-reports.js';
import {
  buildFinanceReportQuery,
  buildSalesReportQuery,
  decodeReportPayload,
  digestTsvReport,
} from '../src/domains/sales-reports.js';

// Pin the wire shapes for v0.18 sales/finance reports + analytics.
//
// Quirks driving these assertions:
//   1. salesReports/financeReports are NOT JSON:API — plain filter params
//      selecting a gzipped TSV. Sales requires vendorNumber + reportType +
//      reportSubType + frequency; finance requires vendorNumber +
//      reportType + regionCode + reportDate (ALL of them).
//   2. The gzip payload must be detected by magic bytes (1f 8b) — error
//      bodies come back as plain JSON and must pass through undamaged.
//   3. AnalyticsReportRequestCreateRequest: attributes REQUIRED
//      (accessType) + app relationship. (The is-strip on the read side —
//      isStoppedDueToInactivity → stoppedDueToInactivity — is pinned via
//      the fields constant in the domain file.)

describe('buildSalesReportQuery', () => {
  it('sets the four required filters and omits optional ones when absent', () => {
    const q = buildSalesReportQuery({
      vendorNumber: '85123456',
      reportType: 'SALES',
      reportSubType: 'SUMMARY',
      frequency: 'DAILY',
    });
    expect(q.get('filter[vendorNumber]')).toBe('85123456');
    expect(q.get('filter[reportType]')).toBe('SALES');
    expect(q.get('filter[reportSubType]')).toBe('SUMMARY');
    expect(q.get('filter[frequency]')).toBe('DAILY');
    expect(q.get('filter[reportDate]')).toBeNull();
    expect(q.get('filter[version]')).toBeNull();
  });

  it('passes reportDate and version through when provided', () => {
    const q = buildSalesReportQuery({
      vendorNumber: '85123456',
      reportType: 'SUBSCRIPTION_EVENT',
      reportSubType: 'DETAILED',
      frequency: 'MONTHLY',
      reportDate: '2026-05',
      version: '1_4',
    });
    expect(q.get('filter[reportDate]')).toBe('2026-05');
    expect(q.get('filter[version]')).toBe('1_4');
  });
});

describe('buildFinanceReportQuery', () => {
  it('sets all four required filters', () => {
    const q = buildFinanceReportQuery({
      vendorNumber: '85123456',
      reportType: 'FINANCIAL',
      regionCode: 'ZZ',
      reportDate: '2026-05',
    });
    expect(q.get('filter[vendorNumber]')).toBe('85123456');
    expect(q.get('filter[reportType]')).toBe('FINANCIAL');
    expect(q.get('filter[regionCode]')).toBe('ZZ');
    expect(q.get('filter[reportDate]')).toBe('2026-05');
  });
});

describe('decodeReportPayload', () => {
  it('gunzips payloads with the gzip magic bytes', () => {
    const tsv = 'Provider\tSKU\tUnits\nAPPLE\tcom.example\t3\n';
    expect(decodeReportPayload(gzipSync(Buffer.from(tsv)))).toBe(tsv);
  });

  it('passes non-gzip payloads through unchanged (e.g. JSON error bodies)', () => {
    const json = '{"errors":[{"status":"404"}]}';
    expect(decodeReportPayload(Buffer.from(json))).toBe(json);
  });
});

describe('digestTsvReport', () => {
  const tsv = ['H1\tH2', 'a\t1', 'b\t2', 'c\t3'].join('\n');

  it('reports row/column counts and previews rows', () => {
    const out = digestTsvReport(tsv, 50);
    expect(out).toContain('3 data rows · 2 columns');
    expect(out).toContain('a\t1');
    expect(out).toContain('c\t3');
    expect(out).not.toContain('more rows');
  });

  it('truncates beyond maxRows with a note', () => {
    const out = digestTsvReport(tsv, 2);
    expect(out).toContain('a\t1');
    expect(out).not.toContain('c\t3');
    expect(out).toContain('… 1 more rows');
  });

  it('handles an empty report', () => {
    expect(digestTsvReport('', 10)).toBe('(empty report)');
  });
});

describe('buildAnalyticsReportRequestCreateBody', () => {
  it('emits required accessType attribute + app relationship', () => {
    const body = buildAnalyticsReportRequestCreateBody({
      appId: 'APP-1',
      accessType: 'ONGOING',
    });
    expect(body.data.type).toBe('analyticsReportRequests');
    expect(body.data.attributes).toEqual({ accessType: 'ONGOING' });
    expect(body.data.relationships).toEqual({
      app: { data: { type: 'apps', id: 'APP-1' } },
    });
    expect('id' in body.data).toBe(false);
  });
});
