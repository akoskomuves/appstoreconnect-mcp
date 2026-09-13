import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ASCError } from './errors.js';

// Opt-in, anonymous, aggressively scrubbed telemetry.
//
// WHY THE SCRUBBING IS NON-NEGOTIABLE: this server holds App Store Connect
// API credentials, and Apple's error bodies contain the caller's commercially
// sensitive data — app IDs, bundle IDs, subscription names, prices, review
// states. None of that belongs on someone else's server. So we transmit the
// SHAPE of a failure and nothing else:
//
//   sent:     tool name, HTTP status, Apple's error `code` (a fixed enum),
//             Apple's generic `title`, the JSON-pointer `source.pointer`
//             (a path into the request shape, never a value), plus package
//             version / node version / OS and a random install UUID.
//   NEVER:    Apple's `detail` string, request URLs or paths (they carry app
//             and resource IDs), request/response bodies, issuer ID, key ID,
//             any credential, any app or bundle name.
//
// That payload is still enough to spot "N installs hit
// asc_patch_subscription_localization -> 409 UNMODIFIABLE this week", which is
// exactly the class of report this module exists to automate.
//
// Three hard rules for the transport:
//   1. NEVER write to stdout. The MCP server speaks JSON-RPC over stdio, so a
//      stray stdout byte corrupts the protocol stream.
//   2. NEVER block or delay a tool call. Every send is fire-and-forget behind
//      a short timeout, and every failure is swallowed.
//   3. NEVER throw. A telemetry bug must not be able to break a tool call.

const CONFIG_DIR = join(homedir(), '.appstore');
const CONFIG_PATH = join(CONFIG_DIR, 'telemetry.json');

// PostHog project keys are write-only by design and are meant to ship inside
// client code — they cannot read data back out. Overridable so a fork (or a
// move to a dedicated project) needs no source patch.
// EU cloud. This is NOT cosmetic: PostHog's capture endpoint answers
// 200 {"status":"Ok"} on either region regardless of which one owns the
// project key, then silently drops the event if it guessed wrong. Verified by
// posting to both and querying back — only EU ingested. Never "fix" this by
// assuming US because the docs use it in examples.
const DEFAULT_HOST = 'https://eu.i.posthog.com';
const DEFAULT_PROJECT_KEY = 'phc_kCqHTxiLsNydTsZ4qo67s3dq2SGg8iy4hKGHtGj36C5r';

const EVENT_INSTALL_PING = 'ascmcp_install_ping';
const EVENT_TOOL_ERROR = 'ascmcp_tool_error';

// The ping is a liveness signal, not a usage counter — at most one per day per
// install, so an active user contributes exactly one event whether they make
// one call or a thousand.
const PING_INTERVAL_MS = 24 * 60 * 60 * 1000;
const POST_TIMEOUT_MS = 3000;

export interface TelemetryConfig {
  enabled: boolean;
  installId: string;
  createdAt: string;
  lastPingAt?: string;
}

export interface TelemetryRuntime {
  version: string;
  config: TelemetryConfig;
  host: string;
  projectKey: string;
}

let runtime: TelemetryRuntime | undefined;

// Per-call tool name. AsyncLocalStorage rather than a module-level variable
// because MCP handlers can be in flight concurrently — a plain variable would
// attribute one tool's failure to whichever call happened to start last.
const toolContext = new AsyncLocalStorage<string>();

export function runWithToolContext<T>(toolName: string, fn: () => T): T {
  return toolContext.run(toolName, fn);
}

export function currentToolName(): string | undefined {
  return toolContext.getStore();
}

/**
 * Honour the cross-vendor DO_NOT_TRACK convention and an explicit env
 * override, both of which beat whatever is on disk. `ASC_MCP_TELEMETRY=0`
 * exists so CI and locked-down enterprise installs can hard-disable without
 * touching a home directory they may not own.
 */
export function parseTelemetryEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  // DO_NOT_TRACK wins outright, including over an explicit opt-in — a user who
  // sets it machine-wide should not have to know this package exists.
  if (env.DO_NOT_TRACK === '1' || env.DO_NOT_TRACK === 'true') return false;
  const raw = env.ASC_MCP_TELEMETRY;
  if (raw === undefined || raw === '') return undefined;
  const v = raw.toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'on') return true;
  // An unrecognised value is NOT treated as consent.
  return undefined;
}

function envOverride(): boolean | undefined {
  return parseTelemetryEnv(process.env);
}

export function readTelemetryConfig(): TelemetryConfig | undefined {
  try {
    if (!existsSync(CONFIG_PATH)) return undefined;
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<TelemetryConfig>;
    if (typeof parsed.installId !== 'string' || typeof parsed.enabled !== 'boolean') {
      return undefined;
    }
    return {
      enabled: parsed.enabled,
      installId: parsed.installId,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      ...(parsed.lastPingAt !== undefined ? { lastPingAt: parsed.lastPingAt } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeTelemetryConfig(config: TelemetryConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A home directory we can't write to must not break the server.
  }
}

/**
 * Record an EXPLICIT choice. Only ever called from the `init` wizard prompt or
 * the `telemetry on|off` subcommand — never inferred. The install ID is
 * generated here and never derived from anything identifying (no hostname, no
 * username, no key ID): a random UUID whose only job is to let two events from
 * one machine be counted once.
 */
export function setTelemetryEnabled(enabled: boolean): TelemetryConfig {
  const existing = readTelemetryConfig();
  const config: TelemetryConfig = {
    enabled,
    installId: existing?.installId ?? randomUUID(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(existing?.lastPingAt !== undefined ? { lastPingAt: existing.lastPingAt } : {}),
  };
  writeTelemetryConfig(config);
  return config;
}

/**
 * Get a stable install ID WITHOUT recording consent.
 *
 * Needed because `ASC_MCP_TELEMETRY=1` enables collection for a run that may
 * have no config file, and that must not leave `enabled: true` on disk — an
 * env var is consent for this process, not a standing opt-in the user never
 * gave. So the persisted `enabled` keeps whatever the user actually chose
 * (false when they have chosen nothing) while the ID stays stable enough to
 * count one machine once.
 */
function ensureInstallId(): TelemetryConfig {
  const existing = readTelemetryConfig();
  if (existing) return existing;
  const config: TelemetryConfig = {
    enabled: false,
    installId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  writeTelemetryConfig(config);
  return config;
}

export interface TelemetryStatus {
  enabled: boolean;
  reason: string;
  installId?: string;
  configPath: string;
}

export function telemetryStatus(): TelemetryStatus {
  const override = envOverride();
  const config = readTelemetryConfig();
  if (override === false) {
    return {
      enabled: false,
      reason:
        process.env.DO_NOT_TRACK === '1' || process.env.DO_NOT_TRACK === 'true'
          ? 'disabled by DO_NOT_TRACK'
          : 'disabled by ASC_MCP_TELEMETRY',
      configPath: CONFIG_PATH,
    };
  }
  if (config === undefined) {
    return {
      enabled: override === true,
      reason:
        override === true
          ? 'enabled by ASC_MCP_TELEMETRY (no choice recorded on disk)'
          : 'no choice recorded — telemetry is off until you opt in',
      configPath: CONFIG_PATH,
    };
  }
  const enabled = override ?? config.enabled;
  return {
    enabled,
    reason: enabled ? 'opted in' : 'opted out',
    installId: config.installId,
    configPath: CONFIG_PATH,
  };
}

/**
 * Reduce an error to the parts that carry no caller data.
 *
 * Apple's error object is {id, status, code, title, detail, source}. `detail`
 * is the dangerous one — it interpolates resource names and values ("Cannot
 * edit SubscriptionLocalization when it is in ACTIVE state" is benign, but the
 * same field elsewhere carries app names and prices), so it is dropped
 * wholesale rather than pattern-matched. `id` is Apple's request trace, which
 * we have no use for. `source.pointer` is a path into the request shape
 * (`/data/attributes/state`) and never a value, so it is kept — it is the
 * single most useful field for telling two failures of the same code apart.
 */
export interface ScrubbedError {
  status?: number;
  code?: string;
  title?: string;
  pointer?: string;
}

export function scrubASCError(err: unknown): ScrubbedError {
  if (!(err instanceof ASCError)) return {};
  const out: ScrubbedError = { status: err.status };
  const details = err.details;
  if (details === null || typeof details !== 'object') return out;
  const errors = (details as { errors?: unknown }).errors;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  if (first === null || typeof first !== 'object') return out;
  const e = first as Record<string, unknown>;
  if (typeof e.code === 'string') out.code = e.code;
  if (typeof e.title === 'string') out.title = e.title;
  const source = e.source;
  if (source !== null && typeof source === 'object') {
    const pointer = (source as Record<string, unknown>).pointer;
    if (typeof pointer === 'string') out.pointer = pointer;
  }
  return out;
}

export function baseProperties(): Record<string, unknown> {
  return {
    package_version: runtime?.version ?? 'unknown',
    node_version: process.versions.node,
    // Platform + arch only. No hostname, no username, no cwd.
    os: process.platform,
    arch: process.arch,
    // Don't build a person profile — these are install-scoped counters, not
    // people.
    $process_person_profile: false,
    // CRITICAL, and NOT redundant with sending no location: the collector
    // derives geolocation from the request IP on its own and attaches city,
    // postal code and lat/long to every event. Verified live — an unguarded
    // event came back tagged with a postal code we never sent. Shipping that
    // would make the word "anonymous" in the consent prompt a lie.
    $geoip_disable: true,
    $ip: null,
  };
}

/**
 * Fire-and-forget POST. Deliberately not awaited by callers: a slow or
 * unreachable endpoint must never add latency to a tool call.
 */
function send(event: string, properties: Record<string, unknown>): void {
  const rt = runtime;
  if (!rt) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    // `void` the promise and attach a catch so an unreachable host can never
    // surface as an unhandled rejection and take the process down.
    void fetch(`${rt.host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: rt.projectKey,
        event,
        distinct_id: rt.config.installId,
        properties: { ...baseProperties(), ...properties },
        timestamp: new Date().toISOString(),
      }),
    })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  } catch {
    // Never let telemetry break a call.
  }
}

/**
 * Resolve consent once at startup and send the daily liveness ping if due.
 * Returns whether telemetry ended up active, for `doctor` to report.
 */
export function initTelemetry(version: string): boolean {
  const status = telemetryStatus();
  if (!status.enabled) {
    runtime = undefined;
    return false;
  }
  const config = ensureInstallId();
  runtime = {
    version,
    config,
    host: process.env.ASC_MCP_TELEMETRY_HOST ?? DEFAULT_HOST,
    projectKey: process.env.ASC_MCP_TELEMETRY_KEY ?? DEFAULT_PROJECT_KEY,
  };

  const last = config.lastPingAt ? Date.parse(config.lastPingAt) : 0;
  if (!Number.isFinite(last) || Date.now() - last >= PING_INTERVAL_MS) {
    send(EVENT_INSTALL_PING, {});
    writeTelemetryConfig({ ...config, lastPingAt: new Date().toISOString() });
  }
  return true;
}

/** Report a failed ASC call. No-op unless telemetry is active. */
export function captureToolError(err: unknown, toolName = currentToolName()): void {
  if (!runtime) return;
  const scrubbed = scrubASCError(err);
  // Only ASC API failures are reported. A local bug (TypeError etc.) could
  // carry file paths in its message, so it is counted without any detail.
  const isAsc = err instanceof ASCError;
  send(EVENT_TOOL_ERROR, {
    tool: toolName ?? 'unknown',
    kind: isAsc ? 'asc_api' : 'local',
    ...(isAsc ? scrubbed : {}),
  });
}

/** Test seam — lets the suite assert the module is inert when opted out. */
export function __resetTelemetryForTests(): void {
  runtime = undefined;
}
