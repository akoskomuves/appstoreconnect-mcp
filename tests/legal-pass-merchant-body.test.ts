import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ASCClient } from '../src/client.js';
import {
  buildBetaLicenseAgreementPatchBody,
  buildEulaCreateBody,
  buildEulaPatchBody,
  registerLegalAgreements,
} from '../src/domains/legal-agreements.js';
import {
  buildIdentifierCreateBody,
  buildIdentifierPatchBody,
} from '../src/domains/pass-merchant-ids.js';

// Wire-shape pins for the legal agreements and Pass Type / Merchant IDs.
//   1. EULA create requires app + territories relationships and agreementText.
//   2. EULA PATCH sends only what was supplied; territories REPLACE the set.
//   3. PATCH bodies carry the resource id.
//   4. Pass/Merchant PATCH sends only `name` — the identifier is immutable.

describe('EULA bodies', () => {
  it('create carries text, app and territories', () => {
    expect(
      buildEulaCreateBody({ appId: 'A1', agreementText: 'Terms', territoryIds: ['USA', 'HUN'] }),
    ).toEqual({
      data: {
        type: 'endUserLicenseAgreements',
        attributes: { agreementText: 'Terms' },
        relationships: {
          app: { data: { type: 'apps', id: 'A1' } },
          territories: {
            data: [
              { type: 'territories', id: 'USA' },
              { type: 'territories', id: 'HUN' },
            ],
          },
        },
      },
    });
  });

  it('patch omits what was not supplied', () => {
    expect(buildEulaPatchBody({ eulaId: 'E1', agreementText: 'New' })).toEqual({
      data: { type: 'endUserLicenseAgreements', id: 'E1', attributes: { agreementText: 'New' } },
    });
    expect(buildEulaPatchBody({ eulaId: 'E1', territoryIds: ['USA'] })).toEqual({
      data: {
        type: 'endUserLicenseAgreements',
        id: 'E1',
        relationships: { territories: { data: [{ type: 'territories', id: 'USA' }] } },
      },
    });
  });

  it('beta license agreement patch carries id and text', () => {
    expect(buildBetaLicenseAgreementPatchBody('B1', 'Beta terms')).toEqual({
      data: {
        type: 'betaLicenseAgreements',
        id: 'B1',
        attributes: { agreementText: 'Beta terms' },
      },
    });
  });
});

describe('Pass Type / Merchant ID bodies', () => {
  it.each([
    'passTypeIds',
    'merchantIds',
  ] as const)('%s create carries name + identifier', (kind) => {
    expect(buildIdentifierCreateBody(kind, { name: 'N', identifier: 'x.com.example.n' })).toEqual({
      data: { type: kind, attributes: { name: 'N', identifier: 'x.com.example.n' } },
    });
  });

  it.each([
    'passTypeIds',
    'merchantIds',
  ] as const)('%s patch sends only name, with the id', (kind) => {
    expect(buildIdentifierPatchBody(kind, 'R1', 'Renamed')).toEqual({
      data: { type: kind, id: 'R1', attributes: { name: 'Renamed' } },
    });
  });
});

describe('asc_get_app_end_user_license_agreement', () => {
  // Live 2026-10-24: an app without a custom EULA answers 200 with data: null.
  async function call(response: unknown) {
    let handler: ((a: Record<string, unknown>) => Promise<unknown>) | undefined;
    const server = {
      registerTool: (name: string, _d: unknown, h: typeof handler) => {
        if (name === 'asc_get_app_end_user_license_agreement') handler = h;
      },
    } as unknown as McpServer;
    const client = { request: async () => response } as unknown as ASCClient;
    registerLegalAgreements(server, client);
    return (await handler?.({ appId: 'A1' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
  }

  it('reports the standard EULA when Apple returns data: null', async () => {
    const res = await call({ data: null });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain(
      "has no custom EULA — the App Store shows Apple's standard EULA",
    );
  });

  it('returns the agreement when one exists', async () => {
    const res = await call({ data: { type: 'endUserLicenseAgreements', id: 'E1' } });
    expect(res.content[0]?.text).toContain('"id": "E1"');
  });
});
