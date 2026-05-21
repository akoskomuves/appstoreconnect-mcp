import { z } from 'zod';

export const BundleIdSchema = z
  .string()
  .min(1)
  .describe('App bundle identifier (e.g., com.example.MyApp).');

export const AppIdSchema = z
  .string()
  .min(1)
  .describe('App Store Connect app ID (numeric string from /v1/apps).');

export const SubscriptionGroupIdSchema = z
  .string()
  .min(1)
  .describe('Subscription group ID from /v1/subscriptionGroups.');

export const SubscriptionIdSchema = z
  .string()
  .min(1)
  .describe('Subscription ID from /v1/subscriptions.');

export const TerritoryIdSchema = z
  .string()
  .length(3)
  .describe('3-letter ISO territory code (e.g., USA, BRA, JPN).');

export const PricePointIdSchema = z
  .string()
  .min(1)
  .describe('Subscription price-point ID from /v1/subscriptions/{id}/pricePoints.');

export const SubscriptionPriceIdSchema = z
  .string()
  .min(1)
  .describe('Subscription price ID (an entry in the price schedule).');

export const StartDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .describe(
    'Date the price change takes effect, YYYY-MM-DD. Apple requires it to be at least 24h in the future; ≥7 days recommended.',
  );

export const AppPricePointIdSchema = z
  .string()
  .min(1)
  .describe('App price-point ID from /v1/apps/{id}/appPricePoints.');

export const AppPriceScheduleIdSchema = z
  .string()
  .min(1)
  .describe('App price schedule ID from /v1/apps/{id}/appPriceSchedule.');

export const InAppPurchaseIdSchema = z
  .string()
  .min(1)
  .describe(
    'In-app purchase ID from /v1/apps/{id}/inAppPurchasesV2 (v2 surface only — legacy v1 IAPs not supported).',
  );

export const InAppPurchasePricePointIdSchema = z
  .string()
  .min(1)
  .describe('IAP price-point ID from /v2/inAppPurchases/{id}/pricePoints.');

export const SubscriptionIntroductoryOfferIdSchema = z
  .string()
  .min(1)
  .describe('Subscription introductory offer ID from /v1/subscriptionIntroductoryOffers.');

export const OfferModeSchema = z
  .enum(['FREE_TRIAL', 'PAY_AS_YOU_GO', 'PAY_UP_FRONT'])
  .describe(
    'Offer mode. FREE_TRIAL has no price (omit pricePointId). PAY_AS_YOU_GO charges the offer price each period for numberOfPeriods periods. PAY_UP_FRONT charges once for the whole duration.',
  );

export const SubscriptionOfferDurationSchema = z
  .enum([
    'THREE_DAYS',
    'ONE_WEEK',
    'TWO_WEEKS',
    'ONE_MONTH',
    'TWO_MONTHS',
    'THREE_MONTHS',
    'SIX_MONTHS',
    'ONE_YEAR',
  ])
  .describe(
    "Offer period length. Apple's enum: THREE_DAYS, ONE_WEEK, TWO_WEEKS, ONE_MONTH, TWO_MONTHS, THREE_MONTHS, SIX_MONTHS, ONE_YEAR.",
  );

export const NumberOfPeriodsSchema = z
  .number()
  .int()
  .positive()
  .describe(
    'Number of times the offer duration repeats. Only meaningful for PAY_AS_YOU_GO (e.g. duration=ONE_MONTH × periods=3 = "promo price for 3 months").',
  );

export const SubscriptionPromotionalOfferIdSchema = z
  .string()
  .min(1)
  .describe('Subscription promotional offer ID from /v1/subscriptionPromotionalOffers.');

export const OfferCodeSchema = z
  .string()
  .min(1)
  .describe(
    'Developer-chosen promotional offer code. Must be unique within the subscription. Used by StoreKit as SubscriptionOffer.id when redeeming. Immutable after creation — to rename, delete and re-create with a new code.',
  );

export const OfferNameSchema = z
  .string()
  .min(1)
  .describe(
    'Display/reference name for the promotional offer (visible in App Store Connect UI). Immutable after creation.',
  );
