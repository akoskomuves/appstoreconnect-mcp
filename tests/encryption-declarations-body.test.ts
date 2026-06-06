import { describe, expect, it } from 'vitest';
import {
  buildAppEncryptionDeclarationCreateBody,
  buildAppEncryptionDeclarationDocumentCreateBody,
  buildAppEncryptionDeclarationDocumentPatchBody,
  buildBuildEncryptionLinkageBody,
} from '../src/domains/encryption-declarations.js';

// Pin the wire shape for AppEncryptionDeclaration + Document + Build linkage.
//
// Quirks driving these assertions:
//   1. WIRE-KEY GOTCHA: Swift `isAvailableOnFrenchStore` → wire
//      `availableOnFrenchStore` (same is-prefix-strip family).
//   2. DEPRECATED field exclusion on Create: `usesEncryption` is in the
//      legacy resource attrs but NOT on the modern CreateRequest. Body
//      builder must NOT emit it.
//   3. WIRE-KEY GOTCHA on Document Update: Swift `isUploaded` → wire
//      `uploaded` (3rd time, same as v0.13 / v0.14).
//   4. Build → Declaration linkage uses bare-data shape:
//      { data: { type, id } } to link, { data: null } to unlink — no
//      `relationships` envelope, no `attributes` block.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAppEncryptionDeclarationCreateBody', () => {
  it('uses appEncryptionDeclarations type with required attrs + app rel', () => {
    const body = buildAppEncryptionDeclarationCreateBody({
      appId: 'APP-1',
      appDescription: 'Uses HTTPS only',
      containsProprietaryCryptography: false,
      containsThirdPartyCryptography: false,
      availableOnFrenchStore: true,
    }) as Body;
    expect(body.data.type).toBe('appEncryptionDeclarations');
    const rels = body.data.relationships as { app: { data: { type: string; id: string } } };
    expect(rels.app.data).toEqual({ type: 'apps', id: 'APP-1' });
  });

  it('emits wire key `availableOnFrenchStore` (NOT Swift `isAvailableOnFrenchStore`)', () => {
    const body = buildAppEncryptionDeclarationCreateBody({
      appId: 'APP-1',
      appDescription: 'X',
      containsProprietaryCryptography: false,
      containsThirdPartyCryptography: false,
      availableOnFrenchStore: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.availableOnFrenchStore).toBe(true);
    expect('isAvailableOnFrenchStore' in attrs).toBe(false);
  });

  it('does NOT emit the deprecated `usesEncryption` attr (modern path uses `exempt` server-set)', () => {
    const body = buildAppEncryptionDeclarationCreateBody({
      appId: 'APP-1',
      appDescription: 'X',
      containsProprietaryCryptography: false,
      containsThirdPartyCryptography: true,
      availableOnFrenchStore: false,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect('usesEncryption' in attrs).toBe(false);
    // also verify the exact set of emitted attrs
    expect(Object.keys(attrs).sort()).toEqual([
      'appDescription',
      'availableOnFrenchStore',
      'containsProprietaryCryptography',
      'containsThirdPartyCryptography',
    ]);
  });
});

describe('buildBuildEncryptionLinkageBody', () => {
  it('emits bare-data linkage with type + id when linking', () => {
    const body = buildBuildEncryptionLinkageBody({
      appEncryptionDeclarationId: 'DECL-1',
    });
    expect(body).toEqual({
      data: { type: 'appEncryptionDeclarations', id: 'DECL-1' },
    });
  });

  it('emits { data: null } when clearing the linkage', () => {
    const body = buildBuildEncryptionLinkageBody({
      appEncryptionDeclarationId: null,
    });
    expect(body).toEqual({ data: null });
  });
});

describe('buildAppEncryptionDeclarationDocumentCreateBody', () => {
  it('uses appEncryptionDeclarationDocuments type with required attrs + declaration rel', () => {
    const body = buildAppEncryptionDeclarationDocumentCreateBody({
      appEncryptionDeclarationId: 'DECL-1',
      fileName: 'encryption-questionnaire.pdf',
      fileSize: 524288,
    }) as Body;
    expect(body.data.type).toBe('appEncryptionDeclarationDocuments');
    expect(body.data.attributes).toEqual({
      fileName: 'encryption-questionnaire.pdf',
      fileSize: 524288,
    });
    const rels = body.data.relationships as {
      appEncryptionDeclaration: { data: { type: string; id: string } };
    };
    expect(rels.appEncryptionDeclaration.data).toEqual({
      type: 'appEncryptionDeclarations',
      id: 'DECL-1',
    });
  });

  it('fileSize is a number (Apple expects Int, not string)', () => {
    const body = buildAppEncryptionDeclarationDocumentCreateBody({
      appEncryptionDeclarationId: 'DECL-1',
      fileName: 'x.pdf',
      fileSize: 999,
    }) as Body;
    expect(typeof (body.data.attributes as Record<string, unknown>).fileSize).toBe('number');
  });
});

describe('buildAppEncryptionDeclarationDocumentPatchBody', () => {
  it('emits wire key `uploaded` (NOT Swift `isUploaded`)', () => {
    const body = buildAppEncryptionDeclarationDocumentPatchBody({
      appEncryptionDeclarationDocumentId: 'DOC-1',
      uploaded: true,
    }) as Body;
    const attrs = body.data.attributes as Record<string, unknown>;
    expect(attrs.uploaded).toBe(true);
    expect('isUploaded' in attrs).toBe(false);
  });

  it('OMITS undefined attrs (encodeIfPresent)', () => {
    const body = buildAppEncryptionDeclarationDocumentPatchBody({
      appEncryptionDeclarationDocumentId: 'DOC-1',
      sourceFileChecksum: 'deadbeef',
    }) as Body;
    expect(body.data.attributes).toEqual({ sourceFileChecksum: 'deadbeef' });
  });

  it('does not emit a relationships block', () => {
    const body = buildAppEncryptionDeclarationDocumentPatchBody({
      appEncryptionDeclarationDocumentId: 'DOC-1',
      uploaded: true,
    }) as Body;
    expect('relationships' in body.data).toBe(false);
  });
});
