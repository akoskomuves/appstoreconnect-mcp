import { describe, expect, it } from 'vitest';
import { buildAssetCommitBody, buildAssetReserveBody } from '../src/domains/review-assets.js';

// Pin the wire shapes for the four review-asset reserve/commit endpoints.
// Apple quirks driving these assertions:
//   1. The reserve relationship KEY differs per resource — IAP image uses
//      `inAppPurchase`, IAP review screenshot uses `inAppPurchaseV2`, both
//      targeting data.type `inAppPurchases`. Subscriptions use `subscription`.
//      A wrong key is a silent 4xx.
//   2. Commit uses wire key `uploaded` (Swift `isUploaded`) and must OMIT
//      absent attributes, not send null.

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

describe('buildAssetReserveBody', () => {
  it('IAP image reserves with relationship key `inAppPurchase` → inAppPurchases', () => {
    const body = buildAssetReserveBody({
      resourceType: 'inAppPurchaseImages',
      relKey: 'inAppPurchase',
      relType: 'inAppPurchases',
      parentId: 'IAP1',
      fileName: 'promo.png',
      fileSize: 2048,
    }) as Body;
    expect(body.data.type).toBe('inAppPurchaseImages');
    expect(body.data.attributes).toEqual({ fileName: 'promo.png', fileSize: 2048 });
    expect(body.data.relationships).toEqual({
      inAppPurchase: { data: { type: 'inAppPurchases', id: 'IAP1' } },
    });
  });

  it('IAP review screenshot reserves with the DIFFERENT key `inAppPurchaseV2` (same target type)', () => {
    const body = buildAssetReserveBody({
      resourceType: 'inAppPurchaseAppStoreReviewScreenshots',
      relKey: 'inAppPurchaseV2',
      relType: 'inAppPurchases',
      parentId: 'IAP1',
      fileName: 'review.png',
      fileSize: 4096,
    }) as Body;
    expect(body.data.type).toBe('inAppPurchaseAppStoreReviewScreenshots');
    expect(body.data.relationships).toEqual({
      inAppPurchaseV2: { data: { type: 'inAppPurchases', id: 'IAP1' } },
    });
    // Guard against the copy-paste trap: it must NOT use the image's key.
    expect(body.data.relationships).not.toHaveProperty('inAppPurchase');
  });

  it('subscription image + review screenshot both use `subscription` → subscriptions', () => {
    for (const resourceType of ['subscriptionImages', 'subscriptionAppStoreReviewScreenshots']) {
      const body = buildAssetReserveBody({
        resourceType,
        relKey: 'subscription',
        relType: 'subscriptions',
        parentId: 'SUB1',
        fileName: 'a.png',
        fileSize: 10,
      }) as Body;
      expect(body.data.relationships).toEqual({
        subscription: { data: { type: 'subscriptions', id: 'SUB1' } },
      });
    }
  });
});

describe('buildAssetCommitBody', () => {
  it('emits the wire key `uploaded` (not isUploaded) plus the checksum', () => {
    const body = buildAssetCommitBody({
      resourceType: 'inAppPurchaseImages',
      id: 'IMG1',
      sourceFileChecksum: 'abc123',
      uploaded: true,
    }) as Body;
    expect(body.data).toEqual({
      type: 'inAppPurchaseImages',
      id: 'IMG1',
      attributes: { sourceFileChecksum: 'abc123', uploaded: true },
    });
    expect(body.data.attributes).not.toHaveProperty('isUploaded');
  });

  it('omits absent attributes (no nulls)', () => {
    const body = buildAssetCommitBody({
      resourceType: 'subscriptionImages',
      id: 'IMG2',
      uploaded: true,
    }) as Body;
    expect(body.data.attributes).toEqual({ uploaded: true });
    expect(body.data.attributes).not.toHaveProperty('sourceFileChecksum');
  });

  it('carries id + type for the PATCH target', () => {
    const body = buildAssetCommitBody({
      resourceType: 'subscriptionAppStoreReviewScreenshots',
      id: 'SS9',
      sourceFileChecksum: 'deadbeef',
    }) as Body;
    expect(body.data.type).toBe('subscriptionAppStoreReviewScreenshots');
    expect(body.data.id).toBe('SS9');
    expect(body.data.attributes).toEqual({ sourceFileChecksum: 'deadbeef' });
  });
});
