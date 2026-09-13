import { describe, expect, it } from 'vitest';
import { ASCError } from '../src/errors.js';
import { baseProperties, parseTelemetryEnv, scrubASCError } from '../src/telemetry.js';

// This suite is the contract with every user of this package.
//
// The server holds App Store Connect credentials, and Apple's error bodies
// carry the caller's commercially sensitive data — app IDs, bundle IDs,
// subscription names, prices, review states. If scrubbing regresses, that data
// leaves the machine. So these tests assert on what is ABSENT at least as hard
// as on what is present.

// A realistic worst case: Apple's `detail` naming a resource, a `source.pointer`,
// a request trace id, and the kind of values that must never be transmitted.
const appleError = new ASCError(
  409,
  'App Store Connect API 409 on PATCH /v1/subscriptionLocalizations/abc-123',
  {
    errors: [
      {
        id: '3f9a1c2e-0000-4a1b-9c3d-ffffffffffff',
        status: '409',
        code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE',
        title: 'The provided entity contains a field that can not be modified in the current state',
        detail: 'Cannot edit SubscriptionLocalization when it is in ACTIVE state',
        source: { pointer: '/data/attributes/state' },
      },
    ],
  },
);

describe('scrubASCError', () => {
  const out = scrubASCError(appleError);

  it('keeps the status, the error code, the generic title and the JSON pointer', () => {
    expect(out.status).toBe(409);
    expect(out.code).toBe('ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE');
    expect(out.title).toContain('can not be modified');
    // A pointer is a path into the request SHAPE, never a value — and it is
    // what separates two different failures sharing one code.
    expect(out.pointer).toBe('/data/attributes/state');
  });

  it("drops Apple's detail string entirely", () => {
    // `detail` interpolates resource names and values. Dropped wholesale
    // rather than pattern-matched, because the safe-looking cases and the
    // dangerous ones share one field.
    expect(JSON.stringify(out)).not.toContain('Cannot edit');
    expect(JSON.stringify(out)).not.toContain('ACTIVE state');
    expect(Object.keys(out)).not.toContain('detail');
  });

  it("drops Apple's request trace id", () => {
    expect(JSON.stringify(out)).not.toContain('3f9a1c2e');
  });

  it('never carries the request path, which holds app and resource IDs', () => {
    expect(JSON.stringify(out)).not.toContain('subscriptionLocalizations');
    expect(JSON.stringify(out)).not.toContain('abc-123');
    expect(JSON.stringify(out)).not.toContain('/v1/');
  });

  it('emits ONLY the four whitelisted keys — a new Apple field cannot leak through', () => {
    // The guard that matters most: scrubbing is an allow-list, so a field
    // Apple adds tomorrow is absent by construction rather than by review.
    expect(Object.keys(out).sort()).toEqual(['code', 'pointer', 'status', 'title']);
  });

  it('survives an error body that is a bare string', () => {
    const out2 = scrubASCError(new ASCError(500, 'boom', 'upstream exploded'));
    expect(out2.status).toBe(500);
    expect(JSON.stringify(out2)).not.toContain('upstream exploded');
  });

  it('survives a missing, empty or malformed errors array', () => {
    expect(scrubASCError(new ASCError(404, 'x')).status).toBe(404);
    expect(scrubASCError(new ASCError(404, 'x', {})).status).toBe(404);
    expect(scrubASCError(new ASCError(404, 'x', { errors: [] })).status).toBe(404);
    expect(scrubASCError(new ASCError(404, 'x', { errors: 'nope' })).status).toBe(404);
    expect(() => scrubASCError(new ASCError(404, 'x', { errors: [null] }))).not.toThrow();
  });

  it('returns nothing at all for a non-ASC error, whose message may hold local paths', () => {
    // A TypeError's message can carry file paths from the user's machine, so
    // local failures are counted without any detail rather than described.
    expect(scrubASCError(new Error('ENOENT /Users/someone/.appstore/AuthKey_ABC.p8'))).toEqual({});
    expect(scrubASCError('a string')).toEqual({});
    expect(scrubASCError(undefined)).toEqual({});
  });

  it('ignores non-string values in the whitelisted fields', () => {
    const weird = scrubASCError(
      new ASCError(400, 'x', { errors: [{ code: 12345, title: {}, source: { pointer: [] } }] }),
    );
    expect(weird).toEqual({ status: 400 });
  });
});

describe('parseTelemetryEnv', () => {
  // Pure and env-injected on purpose: these must never read or write the real
  // ~/.appstore/telemetry.json belonging to whoever runs the suite.
  it('returns undefined when nothing is set, so disk decides', () => {
    expect(parseTelemetryEnv({})).toBeUndefined();
    expect(parseTelemetryEnv({ ASC_MCP_TELEMETRY: '' })).toBeUndefined();
  });

  it('honours DO_NOT_TRACK', () => {
    expect(parseTelemetryEnv({ DO_NOT_TRACK: '1' })).toBe(false);
    expect(parseTelemetryEnv({ DO_NOT_TRACK: 'true' })).toBe(false);
  });

  it('lets DO_NOT_TRACK beat an explicit opt-in', () => {
    // Someone who sets DO_NOT_TRACK machine-wide should not have to know this
    // package exists in order to be respected by it.
    expect(parseTelemetryEnv({ DO_NOT_TRACK: '1', ASC_MCP_TELEMETRY: '1' })).toBe(false);
  });

  it.each(['0', 'false', 'off', 'OFF', 'False'])('treats %s as disabled', (v) => {
    expect(parseTelemetryEnv({ ASC_MCP_TELEMETRY: v })).toBe(false);
  });

  it.each(['1', 'true', 'on', 'ON', 'True'])('treats %s as enabled', (v) => {
    expect(parseTelemetryEnv({ ASC_MCP_TELEMETRY: v })).toBe(true);
  });

  it('does NOT read an unrecognised value as consent', () => {
    // Fail closed: a typo must fall through to "no choice recorded", which is
    // off, rather than silently enabling collection.
    expect(parseTelemetryEnv({ ASC_MCP_TELEMETRY: 'yes-please' })).toBeUndefined();
    expect(parseTelemetryEnv({ ASC_MCP_TELEMETRY: '2' })).toBeUndefined();
  });
});

describe('baseProperties privacy defaults', () => {
  const base = baseProperties();

  it('disables collector-side geolocation', () => {
    // Found live, not by reading docs: without this the collector derives
    // city, postal code and lat/long from the request IP and attaches them to
    // every event. An unguarded test event came back tagged with a postal
    // code we never sent, which would make "anonymous" a false claim in the
    // consent prompt and the README.
    expect(base.$geoip_disable).toBe(true);
    expect(base.$ip).toBeNull();
  });

  it('does not build a person profile', () => {
    expect(base.$process_person_profile).toBe(false);
  });

  it('carries only coarse environment facts', () => {
    expect(Object.keys(base).sort()).toEqual([
      '$geoip_disable',
      '$ip',
      '$process_person_profile',
      'arch',
      'node_version',
      'os',
      'package_version',
    ]);
  });

  it('never carries hostname, username or working directory', () => {
    const json = JSON.stringify(base);
    expect(json).not.toContain(process.cwd());
    // `os` is the platform ("darwin"), never os.hostname().
    expect(base.os).toBe(process.platform);
  });
});
