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

export const SubscriptionOfferCodeIdSchema = z
  .string()
  .min(1)
  .describe(
    'Subscription offer code (campaign) ID from /v1/subscriptionOfferCodes. The campaign is the config; the actual redeemable codes live under it as one-time-use batches or custom multi-use codes.',
  );

export const SubscriptionOfferCodeOneTimeUseCodesIdSchema = z
  .string()
  .min(1)
  .describe(
    'Subscription offer code one-time-use batch ID from /v1/subscriptionOfferCodeOneTimeUseCodes. One batch contains many redeemable strings (one redemption each), retrievable via asc_export_subscription_offer_code_one_time_use_values.',
  );

export const SubscriptionOfferCodeCustomCodesIdSchema = z
  .string()
  .min(1)
  .describe(
    'Subscription offer code custom (multi-use) code ID from /v1/subscriptionOfferCodeCustomCodes. The string customers redeem is the customCode attribute on this resource — the same string can be redeemed up to numberOfCodes times across customers.',
  );

export const CustomCodeStringSchema = z
  .string()
  .min(1)
  .describe(
    'Developer-chosen redeemable string for a custom multi-use offer code (e.g. "LAUNCH2026"). Customers type this exact value in the App Store. Must be unique across all custom codes on the subscription. Immutable after creation. Apple does not document casing or charset constraints — surface the API error verbatim if rejected.',
  );

export const OfferCodeEnvironmentSchema = z
  .enum(['SANDBOX', 'PRODUCTION'])
  .describe(
    "Generate codes redeemable in SANDBOX (StoreKit testing accounts) or PRODUCTION (real App Store accounts). Defaults to PRODUCTION when omitted. Sandbox codes never bill real money and don't count against the live campaign's production allotment.",
  );

export const AutoRenewEnabledSchema = z
  .boolean()
  .describe(
    'Whether the subscription auto-renews after the offer-code period ends. Default Apple behavior is auto-renew on; pass false to make the offer a one-shot non-renewing period. Immutable after creation. ' +
      'CROSS-FIELD RULE: when false, offerEligibility MUST be REPLACE_INTRO_OFFERS — Apple rejects STACK_WITH_INTRO_OFFERS for non-renewing offers with "Offers without auto-renew behavior can not be stacked with Intro-Offers." (Apple\'s error source pointer mis-points at customerEligibilities; the title/detail are the diagnostic.)',
  );

export const CustomerEligibilitiesSchema = z
  .array(z.enum(['NEW', 'EXISTING', 'EXPIRED']))
  .min(1)
  .describe(
    'Which subscriber cohorts may redeem this offer code: NEW (never subscribed to this group), EXISTING (currently subscribed), EXPIRED (lapsed). At least one required. Pass all three to make the offer broadly redeemable. Immutable after creation.',
  );

export const OfferEligibilitySchema = z
  .enum(['STACK_WITH_INTRO_OFFERS', 'REPLACE_INTRO_OFFERS'])
  .describe(
    'How this offer code interacts with any introductory offer the subscriber is otherwise eligible for. STACK_WITH_INTRO_OFFERS: redeemers get both the intro offer AND this code (additive). REPLACE_INTRO_OFFERS: this code overrides the intro offer (redeemer skips the intro). Required at create time; immutable after. ' +
      'CROSS-FIELD RULE: STACK_WITH_INTRO_OFFERS requires autoRenewEnabled unset or true — Apple rejects STACK on non-renewing offers with "Offers without auto-renew behavior can not be stacked with Intro-Offers." Pair autoRenewEnabled=false with REPLACE_INTRO_OFFERS.',
  );

export const OfferCodeNameSchema = z
  .string()
  .min(1)
  .describe(
    'Display/reference name for the offer code campaign (visible in App Store Connect UI). Must be unique within the subscription. Immutable after creation.',
  );

export const TotalNumberOfCodesSchema = z
  .number()
  .int()
  .positive()
  .max(25_000)
  .describe(
    "Number of unique one-time-use codes to generate in this batch. Apple caps a single batch at 25,000 codes (working assumption; surface Apple's error verbatim if it disagrees). Create additional batches against the same campaign for larger campaigns.",
  );

export const CustomCodeNumberOfCodesSchema = z
  .number()
  .int()
  .min(500)
  .max(25_000)
  .describe(
    'Maximum number of redemptions for this single custom-code string. Apple requires a minimum of 500 (lower values rejected pre-wire is preferable — live API returns ENTITY_ERROR.ATTRIBUTE.INVALID "Invalid number of codes"). Ceiling is 25,000 per code. Customers redeem the same customCode first-come-first-served until this cap is hit.',
  );

export const ExpirationDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO 8601 DATE (YYYY-MM-DD)')
  .describe(
    'Expiration DATE for redeemable codes in this batch, ISO 8601 calendar date (YYYY-MM-DD — e.g. 2026-12-31). Date-only, NOT a timestamp; Apple rejects requests that include a time portion. After this date Apple rejects redemption attempts. Per-batch, not per-campaign. ' +
      'Apple caps this at no more than 6 months from request time (undocumented) — further-future dates are rejected with ENTITY_ERROR.ATTRIBUTE.INVALID "Please select an expiration date no more than 6 months in the future." Apple\'s server clock is authoritative; pick the date relative to today.',
  );

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

export const ProductIdSchema = z
  .string()
  .min(1)
  .describe(
    'Subscription product identifier (e.g. "com.example.app.monthly") — the productId attribute returned by asc_list_subscriptions, NOT the numeric subscription ID.',
  );

export const ApplicationUsernameSchema = z
  .string()
  .describe(
    "Per-user opaque identifier (legacy signer only). Apple recommends a UUID or a hash of your internal user ID rather than the raw user ID. Apple's signer library lowercases this value before signing; pass it as you want it post-lowercase, or expect it to come back lowercased. May be an empty string.",
  );

export const TransactionIdSchema = z
  .string()
  .min(1)
  .describe(
    "Any transaction ID belonging to the customer — the customer's appTransactionId works even if they've never made an IAP. Optional for promotional offer V2 (recommended); required for introductory offer eligibility.",
  );

export const NonceSchema = z
  .string()
  .uuid()
  .describe(
    'One-time UUID for replay protection (legacy signer only). When omitted, a fresh UUID v4 is generated. Apple recommends a new nonce per signature attempt.',
  );

export const TimestampMillisSchema = z
  .number()
  .int()
  .positive()
  .describe(
    'Milliseconds since UNIX epoch (legacy signer only). When omitted, the current time is used. Signature is valid for 24 hours from this timestamp.',
  );
