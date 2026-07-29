import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { resolveConfirmation } from '../src/domains/ppp.js';

// The apply_* tools are the only destructive writes in the server, and under
// MCP 2026-07-28 their human confirmation is a multi-round-trip (MRTR) flow:
// the handler RETURNS `input_required` and is re-entered with the answer,
// instead of pushing an `elicitation/create` mid-handler.
//
// These pin the decision table, because getting it wrong either (a) writes to
// App Store Connect without a human ack, or (b) loops the client until the
// SDK's maxRounds cap.

const KEY = 'ppp_test_ack';

/** A server whose client either advertises elicitation support or doesn't. */
function fakeServer(canElicit: boolean): McpServer {
  return {
    server: { getClientCapabilities: () => (canElicit ? { elicitation: {} } : {}) },
  } as unknown as McpServer;
}

/** A request context carrying (or not carrying) MRTR input responses. */
function fakeCtx(inputResponses?: Record<string, unknown>): ServerContext {
  return { mcpReq: { inputResponses } } as unknown as ServerContext;
}

function resolve(server: McpServer, mcpCtx: ServerContext) {
  return resolveConfirmation({
    server,
    mcpCtx,
    key: KEY,
    message: 'Apply 3 price changes?',
    ackTitle: 'I have reviewed the proposal above',
  });
}

describe('resolveConfirmation — first pass', () => {
  it('asks via input_required when the client can elicit', () => {
    const outcome = resolve(fakeServer(true), fakeCtx(undefined));
    expect(outcome.status).toBe('ask');
    if (outcome.status !== 'ask') throw new Error('unreachable');

    // The result must be a real MRTR interim result keyed by our identifier,
    // so the client knows which request to answer on retry.
    expect(outcome.result.resultType).toBe('input_required');
    expect(Object.keys(outcome.result.inputRequests ?? {})).toEqual([KEY]);
  });

  it('embeds a form-mode elicitation asking for a required boolean', () => {
    const outcome = resolve(fakeServer(true), fakeCtx(undefined));
    if (outcome.status !== 'ask') throw new Error('expected ask');

    const req = outcome.result.inputRequests?.[KEY];
    expect(req?.method).toBe('elicitation/create');
    if (!req || req.method !== 'elicitation/create') throw new Error('expected an elicitation');

    // Form mode (not URL mode) — URL-mode params carry no requestedSchema.
    const params = req.params;
    if (!('requestedSchema' in params)) throw new Error('expected form-mode elicitation');

    const schema = params.requestedSchema as {
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    expect(schema.required).toEqual(['acknowledge']);
    expect(schema.properties?.acknowledge?.type).toBe('boolean');
  });

  it('does NOT mint requestState — the proposal is recomputed on re-entry', () => {
    const outcome = resolve(fakeServer(true), fakeCtx(undefined));
    if (outcome.status !== 'ask') throw new Error('expected ask');
    expect(outcome.result.requestState).toBeUndefined();
  });

  it('reports unsupported (never asks) when the client cannot elicit', () => {
    // Asking a client with no elicitation capability would fail the round
    // trip; callers fall back to "re-run with confirm: true" instead.
    expect(resolve(fakeServer(false), fakeCtx(undefined)).status).toBe('unsupported');
  });
});

describe('resolveConfirmation — re-entry', () => {
  it('confirms only when accepted AND the box is ticked', () => {
    const ctx = fakeCtx({ [KEY]: { action: 'accept', content: { acknowledge: true } } });
    expect(resolve(fakeServer(true), ctx).status).toBe('confirmed');
  });

  it('refuses an accept whose acknowledgement is false', () => {
    const ctx = fakeCtx({ [KEY]: { action: 'accept', content: { acknowledge: false } } });
    const outcome = resolve(fakeServer(true), ctx);
    expect(outcome).toEqual({ status: 'declined', action: 'accept' });
  });

  it('refuses an accept that omits the acknowledgement entirely', () => {
    const ctx = fakeCtx({ [KEY]: { action: 'accept', content: {} } });
    expect(resolve(fakeServer(true), ctx).status).toBe('declined');
  });

  it('does not accept a truthy non-boolean acknowledgement', () => {
    // Input responses are untrusted client data — "true" is not true.
    const ctx = fakeCtx({ [KEY]: { action: 'accept', content: { acknowledge: 'true' } } });
    expect(resolve(fakeServer(true), ctx).status).toBe('declined');
  });

  it.each(['decline', 'cancel'] as const)('propagates a %s action', (action) => {
    const ctx = fakeCtx({ [KEY]: { action } });
    expect(resolve(fakeServer(true), ctx)).toEqual({ status: 'declined', action });
  });

  it('reports unsupported when the retry carries no answer for our key', () => {
    // A retry that came back empty can never satisfy the prompt; re-asking
    // would burn round trips until the SDK's maxRounds cap.
    expect(resolve(fakeServer(true), fakeCtx({})).status).toBe('unsupported');
  });

  it('reports unsupported when the retry answers a different key', () => {
    const ctx = fakeCtx({ some_other_key: { action: 'accept', content: { acknowledge: true } } });
    expect(resolve(fakeServer(true), ctx).status).toBe('unsupported');
  });

  it('honours an answer even if the client stopped advertising elicitation', () => {
    // The capability check only gates ASKING. An answer already in hand is
    // still a valid human acknowledgement.
    const ctx = fakeCtx({ [KEY]: { action: 'accept', content: { acknowledge: true } } });
    expect(resolve(fakeServer(false), ctx).status).toBe('confirmed');
  });
});
