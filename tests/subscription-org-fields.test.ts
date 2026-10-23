import { describe, expect, it } from 'vitest';
import { digestSubscriptions } from '../src/digest.js';
import {
  SubscriptionMarketSettingsSchema,
  SubscriptionMultiSeatStatusSchema,
} from '../src/schemas.js';

// API 4.5 organization fields on Subscription. Both are PATCH-only
// (SubscriptionCreateRequest does not carry them). marketSettings is an array
// whose PATCH replaces the whole list.

describe('subscription organization fields', () => {
  it('multiSeatStatus is ENABLED / DISABLED only', () => {
    expect(SubscriptionMultiSeatStatusSchema.safeParse('ENABLED').success).toBe(true);
    expect(SubscriptionMultiSeatStatusSchema.safeParse('DISABLED').success).toBe(true);
    expect(SubscriptionMultiSeatStatusSchema.safeParse('ON').success).toBe(false);
  });

  it('marketSettings takes the three Apple markets, non-empty and without duplicates', () => {
    expect(
      SubscriptionMarketSettingsSchema.safeParse(['APP_STORE', 'APPLE_SCHOOL', 'APPLE_BUSINESS'])
        .success,
    ).toBe(true);
    expect(SubscriptionMarketSettingsSchema.safeParse([]).success).toBe(false);
    expect(SubscriptionMarketSettingsSchema.safeParse(['APP_STORE', 'APP_STORE']).success).toBe(
      false,
    );
    expect(SubscriptionMarketSettingsSchema.safeParse(['APPLE_EDUCATION']).success).toBe(false);
  });

  it('digest shows multi-seat status and joins the markets', () => {
    const out = digestSubscriptions({
      data: [
        {
          type: 'subscriptions',
          id: 'SUB-1',
          attributes: {
            name: 'Pro',
            productId: 'com.example.pro',
            subscriptionPeriod: 'ONE_MONTH',
            state: 'APPROVED',
            groupLevel: 1,
            multiSeatStatus: 'ENABLED',
            marketSettings: ['APP_STORE', 'APPLE_BUSINESS'],
          },
        },
      ],
    } as never);
    expect(out).toContain('MULTI_SEAT');
    expect(out).toContain('ENABLED');
    expect(out).toContain('APP_STORE,APPLE_BUSINESS');
  });
});
