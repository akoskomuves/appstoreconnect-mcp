import { TokenProvider } from './auth.js';
import type { Config } from './config.js';
import { ASCError } from './errors.js';

const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com';
const MAX_RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_FALLBACK_MS = 2000;
const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

export interface ASCClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  // Variant for endpoints that return a non-JSON body (e.g. the offer-code
  // /values endpoint, which serves text/csv). Same auth + 401 + 429 retry
  // semantics as request; default Accept is text/csv, override via init.headers.
  requestText(path: string, init?: RequestInit): Promise<string>;
  // Variant for endpoints that return a binary body (the sales/finance
  // report endpoints serve gzipped TSV with content-type application/a-gzip).
  // Same auth + 401 + 429 retry semantics; default Accept is
  // application/a-gzip, override via init.headers.
  requestBinary(path: string, init?: RequestInit): Promise<Buffer>;
}

/**
 * Parse a Retry-After header value. Apple sometimes returns seconds, sometimes
 * an HTTP-date. Returns the wait in milliseconds, or undefined if the header
 * is missing/unparseable.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function exponentialBackoff(attempt: number): number {
  return Math.min(RATE_LIMIT_MAX_BACKOFF_MS, RATE_LIMIT_FALLBACK_MS * 2 ** attempt);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createASCClient(config: Config): ASCClient {
  const tokens = new TokenProvider(config);

  async function send(url: string, init: RequestInit): Promise<Response> {
    const token = await tokens.getToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    // Don't stomp an Accept supplied by the caller — `requestText` overrides
    // to text/csv, and a future binary-download endpoint could need its own.
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(url, { ...init, headers });
  }

  // Shared request envelope: URL resolution, one-shot 401 refresh, 429
  // Retry-After / exponential-backoff, and error wrapping. Returns the raw
  // Response so each caller can decode the body in its preferred shape
  // (JSON, text, future binary).
  async function sendWithRetries(path: string, init: RequestInit): Promise<Response> {
    const url = path.startsWith('http') ? path : `${ASC_BASE_URL}${path}`;

    let response = await send(url, init);

    // Auth refresh on 401 (one-shot — no token loop).
    if (response.status === 401) {
      tokens.invalidate();
      response = await send(url, init);
    }

    // Apple's POST endpoints have a global per-minute throttle and 429s are
    // common when applying many subscription prices at once. Honour Retry-After
    // when present, otherwise fall back to exponential backoff.
    let attempt = 0;
    while (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const waitMs = retryAfter ?? exponentialBackoff(attempt);
      await sleep(waitMs);
      response = await send(url, init);
      attempt += 1;
    }

    if (!response.ok) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text().catch(() => undefined);
      }
      throw new ASCError(
        response.status,
        `App Store Connect API ${response.status} on ${init.method ?? 'GET'} ${path}`,
        details,
      );
    }

    return response;
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await sendWithRetries(path, init);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async function requestText(path: string, init: RequestInit = {}): Promise<string> {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'text/csv');
    const response = await sendWithRetries(path, { ...init, headers });
    if (response.status === 204) return '';
    return response.text();
  }

  async function requestBinary(path: string, init: RequestInit = {}): Promise<Buffer> {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/a-gzip');
    const response = await sendWithRetries(path, { ...init, headers });
    if (response.status === 204) return Buffer.alloc(0);
    return Buffer.from(await response.arrayBuffer());
  }

  return { request, requestText, requestBinary };
}
