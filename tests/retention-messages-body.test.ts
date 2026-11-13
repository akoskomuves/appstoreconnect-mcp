import { describe, expect, it } from 'vitest';
import {
  buildRetentionMessageCreateBody,
  buildRetentionMessageListQuery,
  buildRetentionMessageLocalizationCreateBody,
  buildRetentionMessageLocalizationPatchBody,
  buildRetentionMessageOffersLinkageBody,
  buildRetentionMessageReviewItemBody,
  buildRetentionMessageVersionCreateBody,
  buildRetentionOfferCreateBody,
  buildRetentionOfferListQuery,
  buildRetentionOfferPatchBody,
  buildSubscriptionRetentionMessageLinkageBody,
  digestRetentionMessages,
  digestRetentionOfferPrices,
  evaluateRetentionLocalizationDeleteGate,
  evaluateRetentionMessageDeleteGate,
  evaluateRetentionOfferDeleteGate,
  PAID_DURATION_MONTHS,
  type RetentionOfferCreateInput,
} from '../src/domains/retention-messages.js';

// Pins the wire shapes of every API 4.6 retention-messaging write against the
// spec's *CreateRequest / *UpdateRequest / linkage request schemas and the
// examples in Apple's "Setting up retention messaging" article.

// Apple's JSON:API local-ID literal `${priceN}`, built via a template literal
// so biome's noTemplateCurlyInString rule does not flag the strings.
const temp = (n: number) => `\${price${n}}`;

describe('buildRetentionMessageCreateBody', () => {
  it('sends referenceName + the app relationship', () => {
    expect(buildRetentionMessageCreateBody('6446671421', 'exa-winter-stay-with-us')).toEqual({
      data: {
        type: 'retentionMessages',
        attributes: { referenceName: 'exa-winter-stay-with-us' },
        relationships: { app: { data: { type: 'apps', id: '6446671421' } } },
      },
    });
  });
});

describe('buildRetentionMessageVersionCreateBody', () => {
  it('is relationships-only, with no placement for a text-only message', () => {
    const body = buildRetentionMessageVersionCreateBody('MSG1');
    expect(body).toEqual({
      data: {
        type: 'retentionMessageVersions',
        relationships: { retentionMessage: { data: { type: 'retentionMessages', id: 'MSG1' } } },
      },
    });
    expect(body.data).not.toHaveProperty('attributes');
    expect(body.data.relationships).not.toHaveProperty('placement');
  });

  it('adds the appAssetLibraryPlacements relationship when given', () => {
    expect(buildRetentionMessageVersionCreateBody('MSG1', 'PL1').data.relationships).toEqual({
      retentionMessage: { data: { type: 'retentionMessages', id: 'MSG1' } },
      placement: { data: { type: 'appAssetLibraryPlacements', id: 'PL1' } },
    });
  });
});

describe('buildRetentionMessageLocalizationCreateBody', () => {
  it('sends locale/header/body and the version relationship', () => {
    expect(
      buildRetentionMessageLocalizationCreateBody({
        versionId: 'V1',
        locale: 'en-US',
        header: 'Your cortado is waiting',
        body: 'Stay subscribed.',
      }),
    ).toEqual({
      data: {
        type: 'retentionMessageLocalizations',
        attributes: {
          locale: 'en-US',
          header: 'Your cortado is waiting',
          body: 'Stay subscribed.',
        },
        relationships: {
          retentionMessageVersion: { data: { type: 'retentionMessageVersions', id: 'V1' } },
        },
      },
    });
  });

  it('omits header/body when undefined (only locale is required)', () => {
    const body = buildRetentionMessageLocalizationCreateBody({ versionId: 'V1', locale: 'de-DE' });
    expect(body.data.attributes).toEqual({ locale: 'de-DE' });
  });
});

describe('buildRetentionMessageLocalizationPatchBody', () => {
  it('carries id + only the changed fields, never locale or relationships', () => {
    const body = buildRetentionMessageLocalizationPatchBody('L1', { body: 'New body' });
    expect(body).toEqual({
      data: { type: 'retentionMessageLocalizations', id: 'L1', attributes: { body: 'New body' } },
    });
    expect(body.data).not.toHaveProperty('relationships');
  });

  it('passes null through to clear a field', () => {
    expect(
      buildRetentionMessageLocalizationPatchBody('L1', { header: null, body: 'x' }).data.attributes,
    ).toEqual({ header: null, body: 'x' });
  });
});

const offerInput: RetentionOfferCreateInput = {
  subscriptionId: 'SUB1',
  referenceName: 'exa-winter-one-month-offer',
  offerId: 'exa_winter_one_month',
  duration: 'ONE_MONTH',
  offerMode: 'PAY_UP_FRONT',
  periodCount: 1,
  customerEligibilityPaidSubscriptionDurationInMonths: 3,
  pricePointIds: ['PP_USA', 'PP_DEU'],
};

describe('buildRetentionOfferCreateBody', () => {
  it('sends required attributes, subscription + prices relationships and inline prices', () => {
    expect(buildRetentionOfferCreateBody(offerInput)).toEqual({
      data: {
        type: 'retentionOffers',
        attributes: {
          referenceName: 'exa-winter-one-month-offer',
          offerId: 'exa_winter_one_month',
          duration: 'ONE_MONTH',
          offerMode: 'PAY_UP_FRONT',
          periodCount: 1,
          customerEligibilityPaidSubscriptionDurationInMonths: 3,
        },
        relationships: {
          subscription: { data: { type: 'subscriptions', id: 'SUB1' } },
          prices: {
            data: [
              { type: 'retentionOfferPrices', id: temp(1) },
              { type: 'retentionOfferPrices', id: temp(2) },
            ],
          },
        },
      },
      included: [
        {
          type: 'retentionOfferPrices',
          id: temp(1),
          relationships: {
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'PP_USA' } },
          },
        },
        {
          type: 'retentionOfferPrices',
          id: temp(2),
          relationships: {
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'PP_DEU' } },
          },
        },
      ],
    });
  });

  it('never sends a territory on inline prices (the price point implies it)', () => {
    for (const p of buildRetentionOfferCreateBody(offerInput).included ?? []) {
      expect(p.relationships).not.toHaveProperty('territory');
    }
  });

  it('adds the optional wait + plan type only when given', () => {
    const attrs = buildRetentionOfferCreateBody({
      ...offerInput,
      customerEligibilityWaitBetweenOffersInMonths: 6,
      targetSubscriptionPlanType: 'UPFRONT',
    }).data.attributes;
    expect(attrs.customerEligibilityWaitBetweenOffersInMonths).toBe(6);
    expect(attrs.targetSubscriptionPlanType).toBe('UPFRONT');
    const bare = buildRetentionOfferCreateBody(offerInput).data.attributes;
    expect(bare).not.toHaveProperty('customerEligibilityWaitBetweenOffersInMonths');
    expect(bare).not.toHaveProperty('targetSubscriptionPlanType');
  });
});

describe('buildRetentionOfferPatchBody', () => {
  it('is eligibility-only, attributes-only', () => {
    const body = buildRetentionOfferPatchBody('RO1', {
      customerEligibilityPaidSubscriptionDurationInMonths: 12,
      customerEligibilityWaitBetweenOffersInMonths: null,
    });
    expect(body).toEqual({
      data: {
        type: 'retentionOffers',
        id: 'RO1',
        attributes: {
          customerEligibilityPaidSubscriptionDurationInMonths: 12,
          customerEligibilityWaitBetweenOffersInMonths: null,
        },
      },
    });
    expect(body).not.toHaveProperty('included');
  });

  it('omits fields not passed', () => {
    expect(
      buildRetentionOfferPatchBody('RO1', { customerEligibilityWaitBetweenOffersInMonths: 4 }).data
        .attributes,
    ).toEqual({ customerEligibilityWaitBetweenOffersInMonths: 4 });
  });
});

describe('linkage bodies', () => {
  it('to-one retentionMessage is a single {type,id}', () => {
    expect(buildSubscriptionRetentionMessageLinkageBody('MSG1')).toEqual({
      data: { type: 'retentionMessages', id: 'MSG1' },
    });
  });

  it('to-many retentionMessageOffers is an array of retentionOffers', () => {
    expect(buildRetentionMessageOffersLinkageBody(['A', 'B'])).toEqual({
      data: [
        { type: 'retentionOffers', id: 'A' },
        { type: 'retentionOffers', id: 'B' },
      ],
    });
  });

  it('review submission item uses the retentionMessageVersion slot', () => {
    expect(buildRetentionMessageReviewItemBody('RS1', 'V1')).toEqual({
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: 'RS1' } },
          retentionMessageVersion: { data: { type: 'retentionMessageVersions', id: 'V1' } },
        },
      },
    });
  });
});

describe('query builders', () => {
  it('message list pins only spec-valid fields + includes', () => {
    const q = buildRetentionMessageListQuery();
    expect(q.get('fields[retentionMessages]')).toBe('referenceName,versions,subscriptions');
    expect(q.get('include')).toBe('versions,subscriptions');
    expect(q.get('fields[retentionMessageVersions]')).toBe('state');
    expect(q.get('limit')).toBe('200');
  });

  it('offer list pins offerId (the create pre-flight depends on it)', () => {
    expect(buildRetentionOfferListQuery().get('fields[retentionOffers]')).toContain('offerId');
  });
});

describe('delete gates', () => {
  it('message: refuses when assigned to a subscription', () => {
    expect(evaluateRetentionMessageDeleteGate([], 1).allow).toBe(false);
  });

  it('message: refuses with a version in review or approved', () => {
    for (const s of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACCEPTED', 'APPROVED']) {
      expect(evaluateRetentionMessageDeleteGate(['PREPARE_FOR_SUBMISSION', s], 0).allow).toBe(
        false,
      );
    }
  });

  it('message: allows drafts and rejected versions when unassigned', () => {
    expect(
      evaluateRetentionMessageDeleteGate(
        ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'REJECTED', 'DEVELOPER_REJECTED'],
        0,
      ).allow,
    ).toBe(true);
  });

  it('localization: follows the parent version state', () => {
    expect(evaluateRetentionLocalizationDeleteGate('PREPARE_FOR_SUBMISSION').allow).toBe(true);
    expect(evaluateRetentionLocalizationDeleteGate('REJECTED').allow).toBe(true);
    expect(evaluateRetentionLocalizationDeleteGate('APPROVED').allow).toBe(false);
    expect(evaluateRetentionLocalizationDeleteGate('IN_REVIEW').allow).toBe(false);
    expect(evaluateRetentionLocalizationDeleteGate(undefined).allow).toBe(true);
  });

  it('offer: refuses while presented', () => {
    expect(evaluateRetentionOfferDeleteGate(true).allow).toBe(false);
    expect(evaluateRetentionOfferDeleteGate(false).allow).toBe(true);
  });
});

describe('eligibility domain', () => {
  it('matches Apple: 1..24, 36, 48, 60', () => {
    expect(PAID_DURATION_MONTHS).toHaveLength(27);
    expect(PAID_DURATION_MONTHS).toContain(24);
    expect(PAID_DURATION_MONTHS).not.toContain(25);
    expect(PAID_DURATION_MONTHS.slice(-3)).toEqual([36, 48, 60]);
  });
});

describe('digests', () => {
  it('lists messages with version states and assigned product ids', () => {
    const text = digestRetentionMessages({
      data: [
        {
          type: 'retentionMessages',
          id: 'MSG1',
          attributes: { referenceName: 'winter' },
          relationships: {
            versions: { data: [{ type: 'retentionMessageVersions', id: 'V1' }] },
            subscriptions: { data: [{ type: 'subscriptions', id: 'S1' }] },
          },
        },
      ],
      included: [
        { type: 'retentionMessageVersions', id: 'V1', attributes: { state: 'APPROVED' } },
        { type: 'subscriptions', id: 'S1', attributes: { productId: 'com.x.monthly' } },
      ],
      pagesFetched: 1,
      truncated: false,
    });
    expect(text).toContain('winter');
    expect(text).toContain('APPROVED');
    expect(text).toContain('com.x.monthly');
  });

  it('resolves price territory + amount from included', () => {
    const text = digestRetentionOfferPrices({
      data: [
        {
          type: 'retentionOfferPrices',
          id: 'P1',
          relationships: {
            territory: { data: { type: 'territories', id: 'USA' } },
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'PP1' } },
          },
        },
      ],
      included: [
        { type: 'territories', id: 'USA', attributes: { currency: 'USD' } },
        { type: 'subscriptionPricePoints', id: 'PP1', attributes: { customerPrice: '1.99' } },
      ],
      pagesFetched: 1,
      truncated: false,
    });
    expect(text).toContain('USD');
    expect(text).toContain('1.99');
  });
});
