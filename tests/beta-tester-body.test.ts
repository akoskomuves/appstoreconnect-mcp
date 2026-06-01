import { describe, expect, it } from 'vitest';
import {
  buildBetaTesterCreateBody,
  buildBetaTesterInvitationBody,
} from '../src/domains/beta-testers.js';

// Pin the wire shape for the two writable beta-tester endpoints:
//   POST /v1/betaTesters
//   POST /v1/betaTesterInvitations
//
// Apple's quirks:
//   1. BetaTesterCreateRequest requires email; firstName/lastName are
//      encodeIfPresent. Optional to-many rels: betaGroups, builds.
//   2. BetaTesterInvitationCreateRequest has NO attributes block AT ALL —
//      only relationships (app required; betaTester optional + DEPRECATED).
//      Body builder must omit `attributes` entirely.

type Body = {
  data: {
    type: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildBetaTesterCreateBody', () => {
  it('uses betaTesters type with email as the required attribute', () => {
    const body = buildBetaTesterCreateBody({ email: 'qa@example.com' }) as Body;
    expect(body.data.type).toBe('betaTesters');
    expect((body.data.attributes as Record<string, unknown>).email).toBe('qa@example.com');
  });

  it('OMITS firstName/lastName when not provided (encodeIfPresent)', () => {
    const body = buildBetaTesterCreateBody({ email: 'qa@example.com' }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('firstName' in attrs).toBe(false);
    expect('lastName' in attrs).toBe(false);
  });

  it('emits firstName/lastName when provided', () => {
    const body = buildBetaTesterCreateBody({
      email: 'qa@example.com',
      firstName: 'Alex',
      lastName: 'Doe',
    }) as Body;
    expect(body.data.attributes).toEqual({
      email: 'qa@example.com',
      firstName: 'Alex',
      lastName: 'Doe',
    });
  });

  it('OMITS relationships entirely when no initial groups/builds are passed', () => {
    const body = buildBetaTesterCreateBody({ email: 'qa@example.com' }) as Body;
    expect('relationships' in body.data).toBe(false);
  });

  it('attaches initialBetaGroupIds as a to-many betaGroups relationship', () => {
    const body = buildBetaTesterCreateBody({
      email: 'qa@example.com',
      initialBetaGroupIds: ['BG-1', 'BG-2'],
    }) as Body;
    const rels = body.data.relationships as {
      betaGroups: { data: Array<{ type: string; id: string }> };
    };
    expect(rels.betaGroups.data).toEqual([
      { type: 'betaGroups', id: 'BG-1' },
      { type: 'betaGroups', id: 'BG-2' },
    ]);
  });

  it('attaches initialBuildIds as a to-many builds relationship', () => {
    const body = buildBetaTesterCreateBody({
      email: 'qa@example.com',
      initialBuildIds: ['B-1'],
    }) as Body;
    const rels = body.data.relationships as {
      builds: { data: Array<{ type: string; id: string }> };
    };
    expect(rels.builds.data).toEqual([{ type: 'builds', id: 'B-1' }]);
  });

  it('OMITS empty initial arrays from the relationships block', () => {
    const body = buildBetaTesterCreateBody({
      email: 'qa@example.com',
      initialBetaGroupIds: [],
      initialBuildIds: [],
    }) as Body;
    // No relationships block at all — both arrays empty + no other rels to add.
    expect('relationships' in body.data).toBe(false);
  });
});

describe('buildBetaTesterInvitationBody', () => {
  it('uses betaTesterInvitations type with the app relationship', () => {
    const body = buildBetaTesterInvitationBody({ appId: 'APP-1' }) as Body;
    expect(body.data.type).toBe('betaTesterInvitations');
    const rels = body.data.relationships as { app: { data: { type: string; id: string } } };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
  });

  it("OMITS the attributes block entirely (Apple's contract has no attrs at all)", () => {
    const body = buildBetaTesterInvitationBody({ appId: 'APP-1' }) as Body;
    expect('attributes' in body.data).toBe(false);
  });

  it('OMITS the legacy betaTester relationship when not provided (modern flow)', () => {
    const body = buildBetaTesterInvitationBody({ appId: 'APP-1' }) as Body;
    const rels = body.data.relationships as Record<string, unknown>;
    expect('betaTester' in rels).toBe(false);
  });

  it('emits the deprecated betaTester relationship when caller passes betaTesterId (legacy shape)', () => {
    const body = buildBetaTesterInvitationBody({ appId: 'APP-1', betaTesterId: 'T-1' }) as Body;
    const rels = body.data.relationships as {
      betaTester: { data: { type: string; id: string } };
    };
    expect(rels.betaTester.data).toEqual({ type: 'betaTesters', id: 'T-1' });
  });
});
