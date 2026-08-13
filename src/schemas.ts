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

export const WinBackOfferIdSchema = z
  .string()
  .min(1)
  .describe('Win-back offer ID (Apple resource ID) from /v1/winBackOffers.');

export const WinBackOfferIdentifierSchema = z
  .string()
  .min(1)
  .describe(
    'Developer-chosen win-back offer identifier (Apple attribute `offerId`). Must be unique within the subscription. Used by StoreKit as the offer identifier when redeeming. Immutable after creation — to change it, delete and re-create.',
  );

export const OfferPrioritySchema = z
  .enum(['HIGH', 'NORMAL'])
  .describe(
    'Win-back offer priority when several offers target the same lapsed customer. HIGH is considered before NORMAL. Mutable via PATCH.',
  );

export const PromotionIntentSchema = z
  .enum(['NOT_PROMOTED', 'USE_AUTO_GENERATED_ASSETS'])
  .describe(
    'Whether Apple auto-surfaces the win-back offer. NOT_PROMOTED: no auto-generated assets (surfaced only through your own StoreKit messaging). USE_AUTO_GENERATED_ASSETS: Apple generates assets and surfaces it automatically to eligible lapsed subscribers. Mutable via PATCH.',
  );

export const SubscriptionPlanTypeSchema = z
  .enum(['MONTHLY', 'UPFRONT'])
  .describe(
    'Target billing plan the win-back offer applies to: MONTHLY or UPFRONT. Optional; omit to target the subscription default. Immutable after creation.',
  );

export const IntegerRangeSchema = z
  .object({
    minimum: z.number().int().nonnegative(),
    maximum: z.number().int().nonnegative().optional(),
  })
  .describe(
    'Inclusive integer range { minimum, maximum? } in months. Omit maximum for "minimum and up". Used for win-back eligibility (time since a customer last subscribed).',
  );

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

// ---------- TestFlight (v0.9.0) ----------

export const BuildIdSchema = z
  .string()
  .min(1)
  .describe(
    'TestFlight build ID from /v1/builds. Apple-generated UUID-style identifier; one per uploaded .ipa. Builds expire 90 days after upload unless explicitly extended; PATCH `expired=true` retires a build early.',
  );

export const BuildBetaDetailIdSchema = z
  .string()
  .min(1)
  .describe(
    'BuildBetaDetail ID from /v1/buildBetaDetails. Per-build companion record carrying autoNotifyEnabled + internalBuildState + externalBuildState. ID is distinct from the parent build ID but 1:1 with it.',
  );

export const BetaGroupIdSchema = z
  .string()
  .min(1)
  .describe(
    'Beta group ID from /v1/betaGroups. Beta groups bundle testers; builds are assigned to groups, not directly to testers. Two kinds: internal (org members; up to 100 testers; no review required) and external (up to 10,000 testers; first external build requires Apple beta review).',
  );

export const BetaTesterIdSchema = z
  .string()
  .min(1)
  .describe(
    'Beta tester ID from /v1/betaTesters. One record per email address per team — a tester can be in many groups across many apps. Email is the uniqueness key for invites; firstName/lastName are optional.',
  );

export const BetaBuildLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'BetaBuildLocalization ID from /v1/betaBuildLocalizations. Per-build, per-locale "What to Test" text shown to TestFlight users. Unique per (build, locale). Distinct from BetaAppLocalization which is per-app (the standing beta description).',
  );

export const BetaAppLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'BetaAppLocalization ID from /v1/betaAppLocalizations. Per-app, per-locale beta description + feedback email + marketing URL + privacy policy URL. Distinct from BetaBuildLocalization which is the per-build "what to test" text.',
  );

export const BetaAppReviewSubmissionIdSchema = z
  .string()
  .min(1)
  .describe(
    "BetaAppReviewSubmission ID from /v1/betaAppReviewSubmissions. One submission per external-test build review request — gates whether external testers can receive the build. Apple's review typically takes 24–48h.",
  );

export const BetaAppReviewDetailIdSchema = z
  .string()
  .min(1)
  .describe(
    'BetaAppReviewDetail ID from /v1/betaAppReviewDetails. Per-app standing record for beta-review contact info, demo account, notes, and sign-in requirement. Persists across builds (not per-submission).',
  );

export const PreReleaseVersionIdSchema = z
  .string()
  .min(1)
  .describe(
    'PreReleaseVersion ID from /v1/preReleaseVersions. Read-only; one per version string Apple has seen for an app (across platforms). Useful for grouping builds by version train.',
  );

export const LocaleSchema = z
  .string()
  .regex(
    /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/,
    'Must be a BCP-47 locale like "en-US", "zh-Hans", or "zh-Hant"',
  )
  .describe(
    'BCP-47 locale identifier as Apple expects it (e.g. "en-US", "de-DE", "ja", "zh-Hans", "zh-Hant"). Used by beta-build-localizations + beta-app-localizations. Apple\'s supported list is a fixed subset of BCP-47; surfaces verbatim if unsupported.',
  );

export const BuildAudienceTypeSchema = z
  .enum(['INTERNAL_ONLY', 'APP_STORE_ELIGIBLE'])
  .describe(
    'Build audience scope. INTERNAL_ONLY: internal-test only (no external distribution path). APP_STORE_ELIGIBLE: eligible for external TestFlight + App Store submission. Apple-side classification; not directly mutable (changes via the build upload flow / Xcode export options).',
  );

export const ProcessingStateSchema = z
  .enum(['PROCESSING', 'FAILED', 'INVALID', 'VALID'])
  .describe(
    "Apple's server-side processing state for an uploaded build. PROCESSING: still being ingested (typically 5–30 min). FAILED: processing crashed; build unusable. INVALID: rejected due to validation (entitlements, signing, etc.). VALID: ready for testing distribution. Filter on this when picking the latest distributable build.",
  );

export const WhatsNewSchema = z
  .string()
  .min(1)
  .max(4000)
  .describe(
    'Per-build "What to Test" body shown to TestFlight users. Apple caps at 4000 characters per locale. Localized via betaBuildLocalizations — one record per (build, locale).',
  );

export const BetaAppDescriptionSchema = z
  .string()
  .min(1)
  .max(4000)
  .describe(
    'Per-app standing beta description shown in TestFlight (before "What to Test"). Apple caps at 4000 characters per locale. One record per (app, locale) via betaAppLocalizations.',
  );

export const FeedbackEmailSchema = z
  .string()
  .email()
  .describe(
    'Email address shown to testers for in-app feedback. Per (app, locale). Apple validates format but not deliverability.',
  );

export const MarketingUrlSchema = z
  .string()
  .url()
  .describe(
    'Marketing URL. Two App Store Connect surfaces both expose a field named `marketingUrl`: ' +
      "(1) AppStoreVersionLocalization — per-version, per-locale; appears on the App Store product page as the 'Developer Website' link below the description. " +
      '(2) BetaAppLocalization — per-app, per-locale; shown in TestFlight beside the beta description. ' +
      'Optional in both contexts. https required.',
  );

export const PrivacyPolicyUrlSchema = z
  .string()
  .url()
  .describe(
    "Privacy policy URL surfaced in TestFlight beside the app's beta description. Per (app, locale). Required by Apple for any app collecting data — TestFlight may refuse submissions without it.",
  );

export const BetaGroupNameSchema = z
  .string()
  .min(1)
  .max(100)
  .describe(
    'Display name for the beta group, shown in App Store Connect UI. Apple does not enforce uniqueness server-side, but this tool pre-flights against existing names on the app to surface accidental collisions.',
  );

export const TesterEmailSchema = z
  .string()
  .email()
  .describe(
    'Tester email address — the uniqueness key for beta-tester records. One BetaTester resource per (team, email). Apple sends the invite + redemption code to this address.',
  );

export const TesterFirstNameSchema = z
  .string()
  .max(50)
  .describe(
    'Tester first name (optional). Apple displays it in the TestFlight invite email and the App Store Connect tester table.',
  );

export const TesterLastNameSchema = z
  .string()
  .max(50)
  .describe('Tester last name (optional). Same display surfaces as firstName.');

export const ContactFirstNameSchema = z
  .string()
  .min(1)
  .max(50)
  .describe(
    "Beta-review contact first name. Per-app via betaAppReviewDetails. Apple's reviewer uses this to address contact emails during beta review.",
  );

export const ContactLastNameSchema = z
  .string()
  .min(1)
  .max(50)
  .describe('Beta-review contact last name. Per-app via betaAppReviewDetails.');

export const ContactPhoneSchema = z
  .string()
  .min(1)
  .describe(
    'Beta-review contact phone, including country code (e.g. "+1 415 555 0100"). Per-app via betaAppReviewDetails. Apple may call during review.',
  );

export const ContactEmailSchema = z
  .string()
  .email()
  .describe(
    'Beta-review contact email. Per-app via betaAppReviewDetails. Apple sends review-status emails here.',
  );

export const DemoAccountNameSchema = z
  .string()
  .max(200)
  .describe(
    'Demo account username for Apple reviewer to sign in (per-app betaAppReviewDetails). Required when the app gates content behind login (demoAccountRequired=true). Plaintext — assume Apple reads it verbatim.',
  );

export const DemoAccountPasswordSchema = z
  .string()
  .max(200)
  .describe(
    "Demo account password for Apple reviewer (per-app betaAppReviewDetails). Plaintext. Use a throwaway account; rotate after each review cycle since the value sits in App Store Connect indefinitely. Apple's reviewers see this in cleartext in the review tool.",
  );

export const ReviewNotesSchema = z
  .string()
  .max(4000)
  .describe(
    'Notes to Apple beta-review reviewer (per-app betaAppReviewDetails). Capped at 4000 characters. Use to document non-obvious test paths or known issues that the reviewer should bypass.',
  );

// ---------- App Store product page localizations (v0.10.0) ----------

export const AppStoreVersionIdSchema = z
  .string()
  .min(1)
  .describe(
    'App Store Version ID from /v1/appStoreVersions. One per (app, platform, versionString) Apple has seen. Carries the release-track copy (release notes via localizations, copyright, releaseType MANUAL/AFTER_APPROVAL/SCHEDULED, reviewType APP_STORE/NOTARIZATION) — distinct from PreReleaseVersion which is the TestFlight-track grouping.',
  );

export const AppStoreVersionLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppStoreVersionLocalization ID from /v1/appStoreVersionLocalizations. Per (appStoreVersion, locale). Carries description + whatsNew (release notes) + keywords + promotionalText + marketingUrl + supportUrl. The big LLM-win surface — what users see on the App Store product page.',
  );

export const SubscriptionLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'SubscriptionLocalization ID from /v1/subscriptionLocalizations. Per (subscription, locale). Carries the customer-facing name + description Apple shows in the App Store under the subscription product. Has a state attribute (PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED) reflecting Apple-side review status — read-only.',
  );

export const InAppPurchaseLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'InAppPurchaseLocalization ID from /v1/inAppPurchaseLocalizations. Per (IAP, locale). Same shape as SubscriptionLocalization (name + description + state). Parent relationship is `inAppPurchaseV2` (the v2 IAP surface this project uses).',
  );

export const ReleaseNotesSchema = z
  .string()
  .min(1)
  .max(4000)
  .describe(
    'Per-version, per-locale "What\'s New in This Version" release notes (the whatsNew attribute on AppStoreVersionLocalization). Apple caps at 4000 characters per locale. Localized via appStoreVersionLocalizations — one record per (version, locale). This is the highest-LLM-leverage field: translate from a single source locale into N target locales.',
  );

export const ProductDescriptionSchema = z
  .string()
  .min(1)
  .max(4000)
  .describe(
    'Per-version, per-locale long product description shown on the App Store product page. Apple caps at 4000 characters per locale. Persists across versions unless explicitly updated — patching this on a new version usually means refreshing copy across all locales.',
  );

export const KeywordsSchema = z
  .string()
  .min(1)
  .max(100)
  .describe(
    'Per-version, per-locale comma-separated search keywords. Apple caps the TOTAL string at 100 characters (including separators) — count carefully. Whitespace is fine but does not count as a separator; use commas. Keywords drive ASO discovery and are immutable post-release (within a given version).',
  );

export const PromotionalTextSchema = z
  .string()
  .min(1)
  .max(170)
  .describe(
    'Per-version, per-locale promotional text shown above the description on the App Store product page. Apple caps at 170 characters. UNLIKE description/keywords, this field is mutable AFTER release without requiring a new app version review — useful for ongoing campaigns within a released version.',
  );

export const SupportUrlSchema = z
  .string()
  .url()
  .describe(
    "Per-version, per-locale support URL shown on the App Store product page. Required by Apple for every locale; review may reject submissions without it. Wire key is `supportUrl` (camelCase) — NOT all-caps despite Swift's URL suffix convention.",
  );

// Note: MarketingUrlSchema already exists (added in v0.9.0 for beta-app
// localizations — same wire shape works here).

export const SubscriptionLocalizationNameSchema = z
  .string()
  .min(1)
  .max(30)
  .describe(
    'Customer-facing subscription name shown in the App Store, per locale. Apple caps at 30 characters per locale. This is what shows up next to the price in the subscription product surface.',
  );

export const SubscriptionLocalizationDescriptionSchema = z
  .string()
  .min(1)
  .describe(
    "Customer-facing subscription description shown beneath the name in the App Store, per locale. Apple's public docs document a 45-character cap, but the live API accepts values ≥50 characters (confirmed against APPROVED localizations). No client-side max enforced — Apple's API is the authoritative source; surface validation errors verbatim. Optional at create time (Apple permits localizations with only name set), but recommended for review compliance.",
  );

export const IapLocalizationNameSchema = z
  .string()
  .min(1)
  .max(30)
  .describe(
    'Customer-facing IAP name shown in the App Store, per locale. Apple caps at 30 characters per locale. Same shape as subscription localization name — they share a wire structure.',
  );

export const IapLocalizationDescriptionSchema = z
  .string()
  .min(1)
  .describe(
    "Customer-facing IAP description shown beneath the name in the App Store, per locale. Apple's public docs document a 45-character cap, but the live API has been seen accepting longer values on APPROVED records (same as SubscriptionLocalizationDescriptionSchema). No client-side max enforced — Apple's API is the authoritative source. Optional at create time.",
  );

export const PlatformSchema = z
  .enum(['IOS', 'MAC_OS', 'TV_OS', 'WATCH_OS', 'VISION_OS'])
  .describe(
    "Apple's Platform enum used across builds, AppStoreVersion, and elsewhere. IOS / MAC_OS / TV_OS / WATCH_OS / VISION_OS. Note: an `IOS` AppStoreVersion is also distributable to Apple Silicon Macs and Vision Pro if buildAudienceType permits — Platform here is the ASC categorization, not the runtime target list.",
  );

// ---------- App Store Version write surface + Review Submission (v0.11.0) ----------

export const VersionStringSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[0-9]+(\.[0-9]+){0,2}$/, 'Must be a 1-3 segment numeric version (e.g. "2.5" or "2.5.1")')
  .describe(
    'User-visible version string (e.g. "2.5" or "2.5.1"). 1-3 numeric segments. Apple enforces monotonic ordering — a new version\'s string must compare HIGHER than every prior version\'s. Immutable post-release; mutable while the version is still in PREPARE_FOR_SUBMISSION.',
  );

export const CopyrightSchema = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'Copyright notice shown on the App Store product page (typically "© 2026 Your Name"). Per-version, not per-locale. Apple\'s docs document no hard cap; 200 chars is a practical upper bound based on observed limits.',
  );

export const ReleaseTypeSchema = z
  .enum(['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'])
  .describe(
    'Release strategy after Apple approves the version. MANUAL: developer triggers release manually via asc_patch_app_store_version (state flips through PENDING_DEVELOPER_RELEASE). AFTER_APPROVAL: auto-release the moment Apple approves. SCHEDULED: release on a specific earliestReleaseDate (requires earliestReleaseDate to be set in the same call).',
  );

export const EarliestReleaseDateSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([Zz]|[+-]\d{2}:?\d{2})$/,
    'Must be ISO 8601 timestamp with timezone (e.g. 2026-08-01T00:00:00Z)',
  )
  .describe(
    'Earliest release date+time. ISO 8601 with timezone (e.g. 2026-08-01T00:00:00Z). Only meaningful when releaseType is SCHEDULED — Apple holds the release until this moment after approval. Apple requires the date be at least 24h in the future at SCHEDULED-state set time. Date-time format here, NOT date-only — distinct from StartDateSchema on the pricing surface.',
  );

export const ReviewTypeSchema = z
  .enum(['APP_STORE', 'NOTARIZATION'])
  .describe(
    'Review track. APP_STORE: standard App Store review. NOTARIZATION: macOS notarization-only flow (skips store review, just signs the app for outside-the-store distribution). Optional at create; defaults to APP_STORE.',
  );

export const ReviewSubmissionIdSchema = z
  .string()
  .min(1)
  .describe(
    'Review submission ID from /v1/reviewSubmissions. The V2 multi-item review surface — each submission can bundle multiple items (a version + IAPs + in-app events) into one Apple review. Distinct from V1 /v1/appStoreVersionSubmissions (single-version legacy surface, deprecated).',
  );

export const ReviewSubmissionItemIdSchema = z
  .string()
  .min(1)
  .describe(
    'Review submission item ID from /v1/reviewSubmissionItems. One item attaches one resource (an App Store version, an IAP, an in-app event, etc.) to a parent review submission. Items in a READY_FOR_REVIEW submission can be added/removed; once the submission is submitted, items are frozen.',
  );

export const ReviewSubmissionActionSchema = z
  .enum(['submit', 'cancel'])
  .describe(
    'Action to apply to a review submission. "submit": flip Apple\'s `submitted` attribute to true — actually sends it to Apple for review (state walks READY_FOR_REVIEW → WAITING_FOR_REVIEW → IN_REVIEW). "cancel": flip `canceled` to true — withdraw a submission from Apple\'s review queue (only works while state is WAITING_FOR_REVIEW or IN_REVIEW; complete and canceling states reject).',
  );

// ---------- App Info + structured ASO (v0.12.0) ----------

export const AppInfoIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppInfo ID from /v1/apps/{id}/appInfos. Per-app metadata layer above the version: carries primary/secondary categories (+ subcategories one/two) and appStoreAgeRating. (kidsAgeBand was removed from AppInfo specifically — it lives on the age-rating declaration, reachable via asc_get_age_rating_declaration.) Apple manages create/delete automatically (typically one per app, sometimes more across NOTARIZATION/APP_STORE tracks); only PATCH is exposed for setting category relationships. The AppInfo ID doubles as the AgeRatingDeclaration ID.',
  );

export const AppInfoLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppInfoLocalization ID from /v1/appInfoLocalizations. Per-app, per-locale name/subtitle/privacy URLs. Distinct from AppStoreVersionLocalization (per-version) — this is the persistent app-level copy that survives across versions.',
  );

export const AppCategoryIdSchema = z
  .string()
  .min(1)
  .describe(
    "App Category ID from /v1/appCategories. Apple's structured-ASO category catalog. Each category may have subcategories (parent → subcategories to-many relationship) and applies to one or more platforms (iOS/macOS/tvOS/visionOS).",
  );

export const AppTagIdSchema = z
  .string()
  .min(1)
  .describe(
    "AppTag ID. Apple's structured-ASO tag surface — picks from a catalog and applies per-app per-territory. PATCH toggles isVisibleInAppStore (wire: visibleInAppStore, stripped prefix). Tag membership management (add/remove a tag from an app) is via the App.appTags linkage — not yet wrapped, coming in v0.12.1.",
  );

export const AppKeywordIdSchema = z
  .string()
  .min(1)
  .describe(
    "AppKeyword ID from /v1/apps/{id}/searchKeywords. Apple's aggregated search-keyword surface — surfaces every keyword the app has indexed across all locales × platforms. Read-only at this resource level; actual keyword writes still happen via the per-version keywords field on AppStoreVersionLocalization (v0.10).",
  );

export const AppInfoLocalizationNameSchema = z
  .string()
  .min(1)
  .max(30)
  .describe(
    "App display name shown in the App Store, per locale. Apple's documented cap is 30 characters. This is the name customers see — distinct from `sku` (your internal identifier) and `bundleId` (the build identifier). Required at create; immutable would be ideal but Apple permits PATCH.",
  );

export const SubtitleSchema = z
  .string()
  .min(1)
  .max(30)
  .describe(
    "Short subtitle shown below the app name on the App Store product page, per locale. Apple's documented cap is 30 characters. Higher-ASO leverage than description for many indie apps — the only second-impression slot on a search result row.",
  );

export const PrivacyPolicyTextSchema = z
  .string()
  .min(1)
  .describe(
    "Full privacy policy TEXT (not URL) for territories where Apple requires inline text rather than a URL. Per (app, locale). Apple's docs document an upper bound around 10000 characters but no client-side cap is enforced — Apple's API stays the source of truth.",
  );

export const PrivacyChoicesUrlSchema = z
  .string()
  .url()
  .describe(
    "Privacy choices URL — Apple's surface for apps that offer user-facing privacy choices (typically required for apps subject to CCPA/CPRA or similar). Per (app, locale). Wire key is `privacyChoicesUrl` (camelCase, NOT all-caps despite Swift's URL suffix convention) — same strip pattern as marketingUrl/supportUrl.",
  );

export const VisibleInAppStoreSchema = z
  .boolean()
  .describe(
    "Whether an AppTag is shown in the App Store search results / product page surface. Wire key `visibleInAppStore` (Apple strips Swift's `is` prefix). Toggling false hides the tag without removing it from the app's tag list.",
  );

// ---------- Asset upload + Custom Product Pages (v0.13.0) ----------

export const AppScreenshotSetIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppScreenshotSet ID from /v1/appScreenshotSets. One set per (parent localization, screenshotDisplayType) — e.g. en-US × APP_IPHONE_67. The set is the container; individual AppScreenshot resources live under it. Parent can be AppStoreVersionLocalization, AppCustomProductPageLocalization, or AppStoreVersionExperimentTreatmentLocalization (one-of — exactly one parent per set).',
  );

export const AppScreenshotIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppScreenshot ID from /v1/appScreenshots. Carries the file payload metadata (fileSize, fileName, sourceFileChecksum), assetDeliveryState (UPLOAD_COMPLETE / PROCESSING / COMPLETE), and the uploadOperations[] returned at reserve time. Three-step lifecycle: POST reserves and returns operations → PUT each chunk to Apple storage → PATCH commits with sourceFileChecksum + uploaded=true.',
  );

export const AppPreviewSetIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppPreviewSet ID from /v1/appPreviewSets. One set per (parent localization, previewType — e.g. IPHONE_67). Same three-way parent options as AppScreenshotSet (one-of). Distinct enum from ScreenshotDisplayType — previewType strips the `APP_` prefix (IPHONE_67, not APP_IPHONE_67).',
  );

export const AppPreviewIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppPreview ID from /v1/appPreviews. Video asset (vs screenshot images). Same three-step lifecycle as AppScreenshot. Extra attrs over a screenshot: previewFrameTimeCode (poster-frame selector), mimeType (often inferred), videoUrl (read-only post-ingest — Swift `videoURL` maps to wire `videoUrl`).',
  );

export const AppCustomProductPageIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppCustomProductPage ID from /v1/appCustomProductPages. A CPP is an alternate product-page variant attached to an app — visible via a unique URL, used for paid-ads landing pages, campaign-specific copy, etc. Each page has one or more versions; the current version is what customers see.',
  );

export const AppCustomProductPageVersionIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppCustomProductPageVersion ID from /v1/appCustomProductPageVersions. Versions are the editable units — new copy/screenshots/previews land on a new version. State machine (PREPARE_FOR_SUBMISSION / READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW / ACCEPTED / APPROVED / REPLACED_WITH_NEW_VERSION / REJECTED) parallels AppInfo. Localizations + screenshot sets + preview sets attach to the version.',
  );

export const AppCustomProductPageLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppCustomProductPageLocalization ID from /v1/appCustomProductPageLocalizations. Per (CPP version, locale). Carries only `promotionalText` (170 chars) as a copy attribute — the rest of the product-page surface (description, keywords, name) inherits from the parent AppStoreVersionLocalization. Screenshot sets + preview sets + search keywords can attach here to override the version-level assets.',
  );

export const ScreenshotDisplayTypeSchema = z
  .enum([
    'APP_IPHONE_67',
    'APP_IPHONE_65',
    'APP_IPHONE_61',
    'APP_IPHONE_58',
    'APP_IPHONE_55',
    'APP_IPHONE_47',
    'APP_IPHONE_40',
    'APP_IPHONE_35',
    'APP_IPAD_PRO_3GEN_129',
    'APP_IPAD_PRO_3GEN_11',
    'APP_IPAD_PRO_129',
    'APP_IPAD_105',
    'APP_IPAD_97',
    'APP_DESKTOP',
    'APP_WATCH_ULTRA',
    'APP_WATCH_SERIES_10',
    'APP_WATCH_SERIES_7',
    'APP_WATCH_SERIES_4',
    'APP_WATCH_SERIES_3',
    'APP_APPLE_TV',
    'APP_APPLE_VISION_PRO',
    'IMESSAGE_APP_IPHONE_67',
    'IMESSAGE_APP_IPHONE_65',
    'IMESSAGE_APP_IPHONE_61',
    'IMESSAGE_APP_IPHONE_58',
    'IMESSAGE_APP_IPHONE_55',
    'IMESSAGE_APP_IPHONE_47',
    'IMESSAGE_APP_IPHONE_40',
    'IMESSAGE_APP_IPAD_PRO_3GEN_129',
    'IMESSAGE_APP_IPAD_PRO_3GEN_11',
    'IMESSAGE_APP_IPAD_PRO_129',
    'IMESSAGE_APP_IPAD_105',
    'IMESSAGE_APP_IPAD_97',
  ])
  .describe(
    'Screenshot display category — the device-class enum scoping a set. APP_IPHONE_67 = 6.7" iPhone Pro Max. APP_IPAD_PRO_3GEN_129 = 12.9" iPad Pro 3rd gen+. IMESSAGE_* variants are for iMessage extension screenshots. Each (parent localization, display type) gets exactly one AppScreenshotSet — uniqueness enforced server-side.',
  );

export const PreviewTypeSchema = z
  .enum([
    'IPHONE_67',
    'IPHONE_65',
    'IPHONE_61',
    'IPHONE_58',
    'IPHONE_55',
    'IPHONE_47',
    'IPHONE_40',
    'IPHONE_35',
    'IPAD_PRO_3GEN_129',
    'IPAD_PRO_3GEN_11',
    'IPAD_PRO_129',
    'IPAD_105',
    'IPAD_97',
    'DESKTOP',
    'APPLE_TV',
    'APPLE_VISION_PRO',
  ])
  .describe(
    'App preview (video) display category. SAME device classes as ScreenshotDisplayType but WITHOUT the `APP_` prefix — e.g. IPHONE_67 (not APP_IPHONE_67). The enums are distinct; values are NOT interchangeable. No iMessage variants (no preview videos for iMessage extensions).',
  );

export const ScreenshotSetParentTypeSchema = z
  .enum([
    'appStoreVersionLocalizations',
    'appCustomProductPageLocalizations',
    'appStoreVersionExperimentTreatmentLocalizations',
  ])
  .describe(
    'Parent resource type for a screenshot or preview set. Apple permits exactly one of the three: a standard version localization, a Custom Product Page localization, or an A/B-test treatment localization. Pass the matching ID as parentLocalizationId. Swift contract marks the relationships block as optional but Apple rejects POSTs that omit all three.',
  );

export const FileNameSchema = z
  .string()
  .min(1)
  .describe(
    'Original file name (e.g. "iphone-67-1.png", "preview-ja.mov"). Sent at reserve time; surfaces in App Store Connect UI + read responses. Apple uses the extension to validate format compatibility against the parent set\'s display type.',
  );

export const FileSizeSchema = z
  .number()
  .int()
  .positive()
  .describe(
    'File size in bytes. Apple chunks the upload based on this — the reserve response returns one uploadOperation per chunk, each with its own offset+length. For composite asc_upload_* tools this is computed via fs.stat; for the raw asc_post_app_screenshot / asc_post_app_preview you must pass it explicitly.',
  );

export const SourceFileChecksumSchema = z
  .string()
  .min(1)
  .describe(
    'Lowercase hex MD5 of the source file (the full file, NOT individual chunks). Sent at commit time alongside uploaded=true. Apple may reject if it does not match what it received. For composite asc_upload_* tools this is computed automatically; for raw asc_patch_app_screenshot / asc_patch_app_preview you must pass it.',
  );

export const LocalFilePathSchema = z
  .string()
  .min(1)
  .describe(
    "Absolute or tilde-expanded local path to the asset file. The composite asc_upload_* tools read this file directly — its size becomes fileSize, its MD5 becomes sourceFileChecksum, and Apple's chunk operations slice into it at offset+length. Apple's recommended formats: screenshots — PNG or JPEG; previews — MOV (H.264 or HEVC), ≤ 500 MB, 15–30s.",
  );

export const InAppPurchaseImageIdSchema = z
  .string()
  .min(1)
  .describe('In-app purchase promotional image ID from /v1/inAppPurchaseImages.');

export const InAppPurchaseAppStoreReviewScreenshotIdSchema = z
  .string()
  .min(1)
  .describe(
    'In-app purchase App Store review screenshot ID from /v1/inAppPurchaseAppStoreReviewScreenshots (to-one per IAP).',
  );

export const SubscriptionImageIdSchema = z
  .string()
  .min(1)
  .describe('Subscription promotional image ID from /v1/subscriptionImages.');

export const SubscriptionAppStoreReviewScreenshotIdSchema = z
  .string()
  .min(1)
  .describe(
    'Subscription App Store review screenshot ID from /v1/subscriptionAppStoreReviewScreenshots (to-one per subscription).',
  );

export const PreviewFrameTimeCodeSchema = z
  .string()
  .min(1)
  .describe(
    'SMPTE-style timecode selecting the poster frame for an app preview (e.g. "00:00:05:00" = 5 seconds in, 0 frames). Apple\'s docs use HH:MM:SS:frames. Tweakable post-upload via asc_patch_app_preview without re-uploading the file.',
  );

export const PreviewMimeTypeSchema = z
  .string()
  .min(1)
  .describe(
    'MIME type of the preview video (e.g. "video/quicktime" for .mov, "video/mp4"). Optional at reserve — Apple infers from the file when omitted. Pass only to override an incorrect inference.',
  );

export const CustomProductPageNameSchema = z
  .string()
  .min(1)
  .describe(
    "Reference name for a CPP, shown in App Store Connect UI (not customer-facing). Required at create; mutable via PATCH. No client-side max enforced — Apple's API is the authoritative source; surface validation errors verbatim.",
  );

export const CustomProductPageVisibleSchema = z
  .boolean()
  .describe(
    "Whether the CPP's URL is publicly resolvable. Wire key `visible` (Apple strips Swift's `is` prefix, same pattern as AppTag.visibleInAppStore and AppScreenshot.uploaded). Toggling false retracts the page without deletion.",
  );

export const CustomProductPageDeepLinkSchema = z
  .string()
  .url()
  .describe(
    'Optional deep link URL appended to the CPP click-through. Carried on AppCustomProductPageVersion (not the page itself). Useful for ad campaigns to land users on a specific in-app surface.',
  );

export const CustomProductPagePromotionalTextSchema = z
  .string()
  .min(1)
  .max(170)
  .describe(
    'Per-CPP-localization promotional text (170 chars). Overrides the AppStoreVersionLocalization promotionalText for customers landing via this CPP URL. Same cap as the version-level field. Mutable across CPP version states — Apple lets it change post-approval, same as the version-level promotional text.',
  );

// ---------- In-App Events + Promoted Purchases (v0.14.0) ----------

export const AppEventIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppEvent ID from /v1/appEvents. Per-app live promotional event surfaced on the App Store product page (e.g. "Salmon Season Opens", "Spring Sale"). Carries a reference name, badge (LIVE_EVENT / PREMIERE / CHALLENGE / …), purpose, priority, and one or more TerritorySchedule entries that say WHERE the event runs, WHEN it publishes, and the event start + end times. Distinct from CustomProductPage (variant landing pages) — events are time-bound and ride on the standard product page.',
  );

export const AppEventLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppEventLocalization ID from /v1/appEventLocalizations. Per (AppEvent, locale). Carries the customer-facing copy: name (event title), shortDescription (event card subline), longDescription (event details page body). Per-locale screenshot + video clip sets attach here.',
  );

export const AppEventScreenshotIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppEventScreenshot ID from /v1/appEventScreenshots. Image asset for an event localization. Uses the same three-step upload protocol as v0.13 AppScreenshot (reserve → chunk-PUT → commit). The appEventAssetType slot determines whether this image shows on the EVENT_CARD (product-page tile) or the EVENT_DETAILS_PAGE (full event view).',
  );

export const AppEventVideoClipIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppEventVideoClip ID from /v1/appEventVideoClips. Video asset for an event localization. Same three-step upload + appEventAssetType slot (EVENT_CARD / EVENT_DETAILS_PAGE) as AppEventScreenshot. Carries previewFrameTimeCode (poster frame) — Swift `videoURL` is `videoUrl` on the wire.',
  );

export const PromotedPurchaseIdSchema = z
  .string()
  .min(1)
  .describe(
    'PromotedPurchase ID from /v1/promotedPurchases. Per-app linkage to ONE IAP or subscription that surfaces it on the storefront tile + the in-app-purchases section of the product page. Carries a tiny attribute surface: visibleForAllUsers + enabled (both wire-key-stripped from Swift `isVisibleForAllUsers` / `isEnabled`). State machine: PREPARE_FOR_SUBMISSION / IN_REVIEW / APPROVED / REJECTED.',
  );

export const AppEventBadgeSchema = z
  .enum([
    'LIVE_EVENT',
    'PREMIERE',
    'CHALLENGE',
    'COMPETITION',
    'NEW_SEASON',
    'MAJOR_UPDATE',
    'SPECIAL_EVENT',
  ])
  .describe(
    "Event badge label shown on the App Store event tile. Apple's enum: LIVE_EVENT (stream / live broadcast), PREMIERE (first showing of new content), CHALLENGE (limited-time goal-based event), COMPETITION (PvP / tournament), NEW_SEASON (multiplayer / battle-pass refresh), MAJOR_UPDATE (large feature drop), SPECIAL_EVENT (catch-all). Optional but recommended — drives the badge styling.",
  );

export const AppEventPurchaseRequirementSchema = z
  .enum(['NO_COST_ASSOCIATED', 'IN_APP_PURCHASE'])
  .describe(
    'Whether participating in the event requires an IAP. NO_COST_ASSOCIATED: free for all users. IN_APP_PURCHASE: requires an IAP / active subscription. Apple uses this in event search results + filters.',
  );

export const AppEventPrioritySchema = z
  .enum(['HIGH', 'NORMAL'])
  .describe(
    "Event priority signalling to Apple's event surfacing. HIGH: pitch for editorial featuring + higher impression rate. NORMAL: standard. Apple caps the number of HIGH events per app — abusing it can result in rejection.",
  );

export const AppEventPurposeSchema = z
  .enum([
    'APPROPRIATE_FOR_ALL_USERS',
    'ATTRACT_NEW_USERS',
    'KEEP_ACTIVE_USERS_INFORMED',
    'BRING_BACK_LAPSED_USERS',
  ])
  .describe(
    'Who the event is FOR. APPROPRIATE_FOR_ALL_USERS: broad. ATTRACT_NEW_USERS: aimed at non-installers. KEEP_ACTIVE_USERS_INFORMED: aimed at current users (in-app surfacing). BRING_BACK_LAPSED_USERS: aimed at uninstallers / lapsed (re-engagement). Apple uses this to decide which audiences see the event card.',
  );

export const AppEventAssetTypeSchema = z
  .enum(['EVENT_CARD', 'EVENT_DETAILS_PAGE'])
  .describe(
    'Asset slot that this AppEventScreenshot / AppEventVideoClip targets. EVENT_CARD: small tile shown on the product page + search results. EVENT_DETAILS_PAGE: full-bleed asset shown on the event details view (after the tile is tapped). One asset per (localization, slot) — uploading a second to the same slot replaces it.',
  );

export const AppEventReferenceNameSchema = z
  .string()
  .min(1)
  .describe(
    "Reference name for an event — internal-only, NOT customer-facing. Required at create; mutable via PATCH. Apple's docs do not document a hard cap; surfaces in App Store Connect UI for picking events out of the list.",
  );

export const AppEventDeepLinkSchema = z
  .string()
  .url()
  .describe(
    "Deep link URL appended to the event tile / details page tap. Takes users to a specific in-app surface when they engage with the event card. Optional. Apple's accepted schemes include universal links and app-specific custom URL schemes.",
  );

export const AppEventPrimaryLocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/, 'Must be a BCP-47 locale')
  .describe(
    "BCP-47 locale that is the master copy for the event. Used as the fallback when a customer's locale has no AppEventLocalization. Set once at create time.",
  );

export const AppEventTerritorySchedulesSchema = z
  .array(
    z.object({
      territories: z.array(z.string().length(3)).min(1),
      publishStart: z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([Zz]|[+-]\d{2}:?\d{2})$/,
          'publishStart must be ISO 8601 with timezone',
        ),
      eventStart: z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([Zz]|[+-]\d{2}:?\d{2})$/,
          'eventStart must be ISO 8601 with timezone',
        ),
      eventEnd: z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([Zz]|[+-]\d{2}:?\d{2})$/,
          'eventEnd must be ISO 8601 with timezone',
        ),
    }),
  )
  .min(1)
  .describe(
    'Per-territory schedule(s) for the event. Each entry: { territories: [ISO3], publishStart: ISO8601, eventStart: ISO8601, eventEnd: ISO8601 }. publishStart is when the event tile becomes visible; eventStart/eventEnd bound the active window. Multiple entries let an event run on different schedules per territory cluster (e.g. US runs first, EU one week later). Apple holds Dates with timezone — distinct from the date-only StartDate schema on pricing.',
  );

export const AppEventNameSchema = z
  .string()
  .min(1)
  .max(30)
  .describe(
    "Customer-facing event name (per locale). Apple's documented cap is 30 characters. Surfaces on the event card + details page header.",
  );

export const AppEventShortDescriptionSchema = z
  .string()
  .min(1)
  .max(50)
  .describe(
    "Customer-facing one-liner shown beneath the event name on the tile (per locale). Apple's documented cap is 50 characters.",
  );

export const AppEventLongDescriptionSchema = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "Customer-facing event body shown on the event details page (per locale). Apple's documented cap is 120 characters — tighter than most other surfaces.",
  );

export const PromotedPurchaseVisibleForAllUsersSchema = z
  .boolean()
  .describe(
    "Whether this promoted purchase is shown to ALL users. Wire key `visibleForAllUsers` (Apple strips Swift's `is` prefix, same pattern as AppCustomProductPage.isVisible → `visible`, AppTag.isVisibleInAppStore → `visibleInAppStore`). Required at create. false hides the promotion from new users while leaving it active server-side.",
  );

export const PromotedPurchaseEnabledSchema = z
  .boolean()
  .describe(
    "Whether the promoted purchase is enabled at all. Wire key `enabled` (Apple strips Swift's `is` prefix). Optional at create (defaults to false). Toggle to retire a promotion without deleting the linkage.",
  );

// ---------- App Availability + Phased Release + Encryption Declarations (v0.15.0) ----------

export const AppAvailabilityIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppAvailabilityV2 ID. NOTE: Apple shares the numeric identifier between AppAvailability and App — appAvailability.id == appId on the wire. Per-app record carrying the master `availableInNewTerritories` flag and the linkage to the set of territoryAvailabilities the app is currently sold in. POST-only (no PATCH / DELETE) — replace by POSTing a new record with the full territory list.',
  );

export const PhasedReleaseIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppStoreVersionPhasedRelease ID from /v1/appStoreVersionPhasedReleases. Attached to ONE AppStoreVersion. State machine: INACTIVE (created but not started) / ACTIVE (rolling out) / PAUSED (developer paused) / COMPLETE (100% rolled out). currentDayNumber reflects how many days into the 7-day rollout the release is on.',
  );

export const AppEncryptionDeclarationIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppEncryptionDeclaration ID from /v1/appEncryptionDeclarations. Per-app US export-compliance record. Has 6 states (CREATED / IN_REVIEW / APPROVED / REJECTED / INVALID / EXPIRED) and a codeValue (the U.S. export ECCN classification code Apple assigns after review). Declarations are append-only — create new ones rather than mutating existing ones.',
  );

export const AppEncryptionDeclarationDocumentIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppEncryptionDeclarationDocument ID from /v1/appEncryptionDeclarationDocuments. Asset record for the supporting document (typically a PDF questionnaire) attached to a declaration. Uses the same three-step reserve / chunk-PUT / commit protocol as v0.13 AppScreenshot — reserve returns uploadOperations[], commit takes sourceFileChecksum + uploaded=true.',
  );

export const PhasedReleaseStateSchema = z
  .enum(['INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETE'])
  .describe(
    "Phased release state. Apple's lifecycle: INACTIVE (just created, not started) → ACTIVE (rolling out — Apple bumps the rollout 1% / 2% / 5% / 10% / 20% / 50% / 100% across 7 days) → PAUSED (developer hit pause; user-installed % is frozen) → COMPLETE (100% rollout, lifecycle terminal). Valid transitions: INACTIVE → ACTIVE, ACTIVE ↔ PAUSED, ACTIVE → COMPLETE (force-complete / immediate 100% bump). Apple may also force-complete on its own after the 7-day window.",
  );

export const EncryptionDeclarationStateSchema = z
  .enum(['CREATED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'INVALID', 'EXPIRED'])
  .describe(
    "Encryption declaration state. CREATED: developer submitted, awaiting Apple review. IN_REVIEW: Apple is reviewing. APPROVED: cleared for export. REJECTED: Apple disagreed with the developer's classification. INVALID: declaration became invalid (e.g. app encryption profile changed). EXPIRED: rolling annual expiry (US export compliance recertifies yearly). Read-only — set by Apple after review.",
  );

export const AvailableInNewTerritoriesSchema = z
  .boolean()
  .describe(
    "Whether the app automatically becomes available in NEW territories Apple adds in the future. Wire key `availableInNewTerritories` (Apple strips Swift's `is` prefix, same pattern as v0.13 AppCustomProductPage.isVisible). Set explicitly at create — Apple does not infer it.",
  );

export const TerritoryAvailabilityIdSchema = z
  .string()
  .min(1)
  // Pre-flight the single most likely mistake. A real ID is base64 of a JSON
  // object, so it is always ~38 chars — a bare 3-letter code can never be
  // one, and Apple's own error for it is an opaque 404/409 that doesn't say
  // what to do instead. Verified against live IDs 2026-07-30.
  .refine((v) => !/^[A-Z]{3}$/.test(v), {
    message:
      'Looks like a bare territory code, not a TerritoryAvailability ID. These IDs are per-(app, territory) Apple-opaque composites — call asc_list_territory_availabilities and pass its TERR_ID values through verbatim.',
  })
  .describe(
    'TerritoryAvailability ID. APPLE-OPAQUE composite: base64 of `{"s":"<appId>","t":"<3-letter-code>"}` with padding stripped — e.g. `eyJzIjoiMTIzNDU2Nzg5MCIsInQiOiJVU0EifQ` decodes to `{"s":"1234567890","t":"USA"}` (38 chars, no trailing `=`). The ID is per-(app, territory), NOT the bare territory code — DO NOT pass `"USA"` directly. Get IDs by calling asc_list_territory_availabilities first, then pass them through to asc_post_app_availability_v2 / asc_end_app_availability_pre_order verbatim.',
  );

export const AppEncryptionDeclarationDescriptionSchema = z
  .string()
  .min(1)
  .describe(
    "Free-text description of how the app uses encryption. Required at create. Apple's reviewer reads this to classify the export-compliance status. Surface validation errors verbatim — Apple's docs do not document a hard cap.",
  );

export const ContainsProprietaryCryptographySchema = z
  .boolean()
  .describe(
    'Whether the app contains proprietary (non-standard, custom-developed) cryptographic algorithms. Triggers a more involved Apple review path when true. Required at create.',
  );

export const ContainsThirdPartyCryptographySchema = z
  .boolean()
  .describe(
    'Whether the app contains third-party (open-source or licensed) cryptographic algorithms beyond what Apple ships. Required at create.',
  );

export const AvailableOnFrenchStoreSchema = z
  .boolean()
  .describe(
    'Whether the app is offered on the French App Store. Required at create — French export law requires explicit attestation. WIRE KEY GOTCHA: Swift `isAvailableOnFrenchStore` → wire `availableOnFrenchStore` (same is-prefix strip).',
  );

// ---------- TestFlight follow-ons (v0.16) ----------

export const BetaFeedbackScreenshotSubmissionIdSchema = z
  .string()
  .min(1)
  .describe(
    'BetaFeedbackScreenshotSubmission ID from /v1/apps/{id}/betaFeedbackScreenshotSubmissions. One record per screenshot feedback a tester sends from TestFlight (shake-to-report or screenshot markup). Read-only resource — testers create them from the device; the API can list, get, and delete.',
  );

export const BetaFeedbackCrashSubmissionIdSchema = z
  .string()
  .min(1)
  .describe(
    'BetaFeedbackCrashSubmission ID from /v1/apps/{id}/betaFeedbackCrashSubmissions. One record per crash feedback a tester agreed to share from TestFlight. The crash log text itself lives behind /v1/betaFeedbackCrashSubmissions/{id}/crashLog (asc_get_beta_feedback_crash_log).',
  );

export const BetaRecruitmentCriterionIdSchema = z
  .string()
  .min(1)
  .describe(
    "BetaRecruitmentCriterion ID from /v1/betaGroups/{id}/betaRecruitmentCriteria. A beta group has AT MOST ONE criterion record (to-one relationship) holding deviceFamilyOsVersionFilters that gate who can join via the public link. Created via POST /v1/betaRecruitmentCriteria, mutated via PATCH, removed via DELETE. Live-observed (2026-06-10): Apple's no-criterion error resolves the criterion by the BETA GROUP'S id, so the criterion id likely EQUALS the beta group id (same shared-ID family as AppAvailabilityV2.id == app.id) — but always read the id back from a GET rather than assuming.",
  );

export const DeviceFamilySchema = z
  .enum(['IPHONE', 'IPAD', 'APPLE_TV', 'APPLE_WATCH', 'MAC', 'VISION'])
  .describe('Apple device family. VISION is Apple Vision Pro.');

export const DeviceFamilyOsVersionFilterSchema = z
  .object({
    deviceFamily: DeviceFamilySchema,
    minimumOsInclusive: z
      .string()
      .optional()
      .describe('Lowest OS version (inclusive) that may join, e.g. "17.0". Omit for no floor.'),
    maximumOsInclusive: z
      .string()
      .optional()
      .describe('Highest OS version (inclusive) that may join, e.g. "18.4". Omit for no ceiling.'),
  })
  .describe(
    'One device-family + OS-version window a public-link tester must match to auto-join the group. Wire keys are verbatim camelCase (deviceFamily / minimumOsInclusive / maximumOsInclusive) — no is-prefix or URL strips on this shape. Valid OS versions per family come from asc_list_beta_recruitment_criterion_options.',
  );

export const FeedbackPlatformFilterSchema = z
  .enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'])
  .describe(
    'Platform filter for beta feedback lists. Note this is the PLATFORM enum (IOS / MAC_OS / TV_OS / VISION_OS), not the DeviceFamily enum — feedback filters use platform, recruitment criteria use device family.',
  );

// ---------- Webhooks (v0.17) ----------

export const WebhookIdSchema = z
  .string()
  .min(1)
  .describe(
    'Webhook ID from /v1/apps/{id}/webhooks. One webhook = one HTTPS endpoint + a set of event types for ONE app. Apple signs each delivery with the webhook secret (HMAC-SHA256 in the X-Apple-Signature header).',
  );

export const WebhookDeliveryIdSchema = z
  .string()
  .min(1)
  .describe(
    'WebhookDelivery ID from /v1/webhooks/{id}/deliveries. One record per delivery attempt (state SUCCEEDED / FAILED / PENDING, with request URL + response status/body). Pass a FAILED delivery id as the template to asc_post_webhook_redelivery to retry it.',
  );

export const WebhookEventTypeSchema = z
  .enum([
    'APP_STORE_VERSION_APP_VERSION_STATE_UPDATED',
    'BUILD_UPLOAD_STATE_UPDATED',
    'BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED',
    'BETA_FEEDBACK_CRASH_SUBMISSION_CREATED',
    'BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED',
    'BACKGROUND_ASSET_VERSION_STATE_UPDATED',
    'BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED',
    'BACKGROUND_ASSET_VERSION_EXTERNAL_BETA_RELEASE_STATE_UPDATED',
    'BACKGROUND_ASSET_VERSION_INTERNAL_BETA_RELEASE_CREATED',
    'ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED',
    'ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED',
    'ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED',
  ])
  .describe(
    'Webhook event type (12 values). The day-to-day ones: APP_STORE_VERSION_APP_VERSION_STATE_UPDATED (review/release state transitions), BUILD_UPLOAD_STATE_UPDATED + BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED (build pipeline), BETA_FEEDBACK_*_CREATED (pairs with the v0.16 beta-feedback read tools). BACKGROUND_ASSET_* and ALTERNATIVE_DISTRIBUTION_* are niche (Background Assets / EU DMA).',
  );

export const WebhookSecretSchema = z
  .string()
  .min(1)
  .describe(
    'Shared secret Apple uses to sign every delivery (HMAC-SHA256, X-Apple-Signature header) so the receiver can verify authenticity. WRITE-ONLY: never echoed back by any GET. Store it on the receiving side before creating the webhook.',
  );

export const WebhookDeliveryStateSchema = z
  .enum(['SUCCEEDED', 'FAILED', 'PENDING'])
  .describe(
    'Delivery attempt state. FAILED deliveries can be retried via asc_post_webhook_redelivery.',
  );

// ---------- Sales/finance reports + Analytics (v0.18) ----------

export const VendorNumberSchema = z
  .string()
  .min(1)
  .describe(
    'Account-level vendor number (numeric string, e.g. "85123456") from App Store Connect → Payments and Financial Reports. NOT per-app. Falls back to the ASC_VENDOR_NUMBER env var when omitted.',
  );

export const SalesReportTypeSchema = z
  .enum([
    'SALES',
    'SUBSCRIPTION',
    'SUBSCRIPTION_EVENT',
    'SUBSCRIBER',
    'SUBSCRIPTION_OFFER_CODE_REDEMPTION',
    'INSTALLS',
    'FIRST_ANNUAL',
    'PRE_ORDER',
    'NEWSSTAND',
    'WIN_BACK_ELIGIBILITY',
  ])
  .describe(
    'Sales report family. SALES: units + proceeds per row (the classic daily report). SUBSCRIPTION: snapshot of active subscriptions. SUBSCRIPTION_EVENT: state-change events (renew, cancel, billing retry). SUBSCRIBER: per-subscriber transaction detail. SUBSCRIPTION_OFFER_CODE_REDEMPTION: offer-code redemptions (pairs with the v0.8 offer-code tools). INSTALLS: install/first-launch events. Others are niche.',
  );

export const SalesReportSubTypeSchema = z
  .enum(['SUMMARY', 'DETAILED', 'SUMMARY_INSTALL_TYPE', 'SUMMARY_TERRITORY', 'SUMMARY_CHANNEL'])
  .describe(
    'Report granularity variant. SUMMARY works for most reportTypes; DETAILED for SUBSCRIPTION_EVENT/SUBSCRIBER; the SUMMARY_* variants only apply to INSTALLS. Invalid (type, subType, frequency) combos are rejected by Apple — surface the error verbatim.',
  );

export const ReportFrequencySchema = z
  .enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
  .describe(
    'Report period. Determines reportDate granularity: DAILY/WEEKLY take YYYY-MM-DD (WEEKLY = the Sunday ending the week), MONTHLY takes YYYY-MM, YEARLY takes YYYY. Daily reports are available ~5am Pacific next day and retained ~1 year.',
  );

export const FinanceRegionCodeSchema = z
  .string()
  .min(1)
  .describe(
    'Finance report region/currency code: a region like "US", "EU", "JP", "WW", or "ZZ" for the single consolidated FINANCIAL report across all regions. FINANCE_DETAIL uses "Z1". Region list lives in App Store Connect → Payments.',
  );

export const AnalyticsReportRequestIdSchema = z
  .string()
  .min(1)
  .describe(
    'AnalyticsReportRequest ID from /v1/apps/{id}/analyticsReportRequests. The top of the four-level analytics chain: request → reports → instances → segments. One request per (app, accessType); creating a duplicate is rejected.',
  );

export const AnalyticsReportIdSchema = z
  .string()
  .min(1)
  .describe(
    'AnalyticsReport ID from /v1/analyticsReportRequests/{id}/reports. One per report name within a category (APP_USAGE / APP_STORE_ENGAGEMENT / COMMERCE / FRAMEWORK_USAGE / PERFORMANCE). Live-observed (2026-06-12): the ID is a COMPOSITE like "r3-<requestUUID>" (report-slot prefix + parent request id), not an opaque UUID — pass it through verbatim; never parse or construct one.',
  );

export const AnalyticsReportInstanceIdSchema = z
  .string()
  .min(1)
  .describe(
    'AnalyticsReportInstance ID from /v1/analyticsReports/{id}/instances. One instance per (granularity, processingDate) — the dated materialization of a report.',
  );

export const AnalyticsReportSegmentIdSchema = z
  .string()
  .min(1)
  .describe(
    'AnalyticsReportSegment ID from /v1/analyticsReportInstances/{id}/segments. Each segment is one downloadable gzip CSV chunk with a PRE-SIGNED, TIME-LIMITED url + checksum + sizeInBytes. Download promptly after listing.',
  );

export const AnalyticsAccessTypeSchema = z
  .enum(['ONGOING', 'ONE_TIME_SNAPSHOT'])
  .describe(
    'ONGOING: Apple keeps generating new daily/weekly/monthly instances (auto-pauses after ~inactivity — see stoppedDueToInactivity; recreate to resume). ONE_TIME_SNAPSHOT: a single backfill of historical data.',
  );

export const AnalyticsReportCategorySchema = z
  .enum(['APP_USAGE', 'APP_STORE_ENGAGEMENT', 'COMMERCE', 'FRAMEWORK_USAGE', 'PERFORMANCE'])
  .describe(
    'Analytics report category. APP_USAGE: sessions, installs, deletions, crashes. APP_STORE_ENGAGEMENT: impressions, product-page views. COMMERCE: downloads, purchases, proceeds. FRAMEWORK_USAGE / PERFORMANCE: technical.',
  );

export const AnalyticsGranularitySchema = z
  .enum(['DAILY', 'WEEKLY', 'MONTHLY'])
  .describe('Instance granularity (filter[granularity] on the instances list).');

// ---------- Customer reviews (v0.19) ----------

export const CustomerReviewIdSchema = z
  .string()
  .min(1)
  .describe(
    'CustomerReview ID from /v1/apps/{id}/customerReviews. One per published App Store review (rating + optional title/body + reviewerNickname + territory). Reviews are customer-created and read-only — the only developer write is the response.',
  );

export const CustomerReviewResponseIdSchema = z
  .string()
  .min(1)
  .describe(
    "CustomerReviewResponse ID from /v1/customerReviews/{id}/response. The developer's single public reply to one review (state PUBLISHED or PENDING_PUBLISH). DELETE removes the public reply.",
  );

export const ReviewRatingFilterSchema = z
  .array(z.enum(['1', '2', '3', '4', '5']))
  .min(1)
  .describe('Star ratings to include, as STRINGS per the wire contract (e.g. ["1","2"] for 1–2★).');

export const ReviewSortSchema = z
  .enum(['createdDate', '-createdDate', 'rating', '-rating'])
  .describe('Sort order. -createdDate = newest first (default), -rating = highest first.');

export const SummarizationPlatformSchema = z
  .enum(['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'])
  .describe('Platform whose review summarization to fetch. REQUIRED by Apple on this endpoint.');

// ---------- App Store Version Experiments V2 (v0.20) ----------

export const VersionExperimentIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppStoreVersionExperiment (V2) ID. QUIRK: the app-scoped LIST lives at /v1/apps/{id}/appStoreVersionExperimentsV2, but the resource CRUD lives under /v2/appStoreVersionExperiments — same IDs across both. The deprecated v1 experiments (attached to a single version) are not exposed by this server.',
  );

export const ExperimentTreatmentIdSchema = z
  .string()
  .min(1)
  .describe(
    'AppStoreVersionExperimentTreatment ID from /v2/appStoreVersionExperiments/{id}/appStoreVersionExperimentTreatments. One treatment = one product-page variant being tested (vs the control). Carries name, optional appIconName, and promotedDate once a winner is promoted.',
  );

export const TreatmentLocalizationIdSchema = z
  .string()
  .min(1)
  .describe(
    "ExperimentTreatmentLocalization ID from /v1/appStoreVersionExperimentTreatments/{id}/appStoreVersionExperimentTreatmentLocalizations. Per-treatment, per-locale container for variant screenshots/previews — create one per locale you're testing, then hang screenshot/preview sets off it with the v0.13 asset tools (parentType appStoreVersionExperimentTreatmentLocalizations).",
  );

export const TrafficProportionSchema = z
  .number()
  .int()
  .min(1)
  .max(99)
  .describe(
    'Percentage of product-page traffic diverted to the experiment (split evenly across treatments). Apple accepts 1–99; the rest sees the control page.',
  );

export const ExperimentStateSchema = z
  .enum([
    'PREPARE_FOR_SUBMISSION',
    'READY_FOR_REVIEW',
    'WAITING_FOR_REVIEW',
    'IN_REVIEW',
    'ACCEPTED',
    'APPROVED',
    'REJECTED',
    'COMPLETED',
    'STOPPED',
  ])
  .describe(
    'Experiment lifecycle state. PREPARE_FOR_SUBMISSION: build treatments + localizations + assets. Submit via the V2 review submission flow (asc_post_review_submission_item with the experiment). APPROVED: ready — PATCH started=true to begin. COMPLETED / STOPPED: terminal.',
  );

// ---------- Diagnostics + perf/power + accessibility (v0.21) ----------

export const DiagnosticSignatureIdSchema = z
  .string()
  .min(1)
  .describe(
    'DiagnosticSignature ID from /v1/builds/{id}/diagnosticSignatures. One per aggregated problem signature (a hang/disk-write/launch hotspot) on a build, weighted by impact. The call-stack logs live behind /v1/diagnosticSignatures/{id}/logs.',
  );

export const DiagnosticTypeSchema = z
  .enum(['DISK_WRITES', 'HANGS', 'LAUNCHES'])
  .describe('Diagnostic signature family: excessive disk writes, hangs, or slow launches.');

export const PerfMetricTypeSchema = z
  .enum(['DISK', 'HANG', 'BATTERY', 'LAUNCH', 'MEMORY', 'ANIMATION', 'TERMINATION', 'STORAGE'])
  .describe('Xcode-metrics category filter for perf/power metrics.');

export const AccessibilityDeclarationIdSchema = z
  .string()
  .min(1)
  .describe(
    'AccessibilityDeclaration ID from /v1/apps/{id}/accessibilityDeclarations. Per-(app, deviceFamily) declaration of supported accessibility features ("Accessibility Nutrition Label" on the product page). States: DRAFT → PUBLISHED (live on the store) → REPLACED (superseded by a newer publish). One DRAFT per device family at a time.',
  );

export const AccessibilityDeclarationStateSchema = z
  .enum(['DRAFT', 'PUBLISHED', 'REPLACED'])
  .describe(
    'DRAFT: editable, not visible. PUBLISHED: live on the product page. REPLACED: superseded.',
  );

// ---------- EU DMA / alternative distribution (v1.0) ----------

export const AlternativeDistributionDomainIdSchema = z
  .string()
  .min(1)
  .describe(
    'AlternativeDistributionDomain ID from /v1/alternativeDistributionDomains. A registered website domain for distributing iOS apps from the web in the EU (DMA). Create + delete only — no patch.',
  );

export const AlternativeDistributionKeyIdSchema = z
  .string()
  .min(1)
  .describe(
    'AlternativeDistributionKey ID from /v1/alternativeDistributionKeys. The PUBLIC key (PEM) registered for signing alternative-distribution artifacts; the private half never leaves your infrastructure. To-one per app via /v1/apps/{id}/alternativeDistributionKey.',
  );

export const AlternativeDistributionPackageIdSchema = z
  .string()
  .min(1)
  .describe(
    'AlternativeDistributionPackage ID. One per App Store Version (to-one via /v1/appStoreVersions/{id}/alternativeDistributionPackage); its versions carry PRE-SIGNED, TIME-LIMITED download URLs for the signed package + variants + deltas.',
  );

export const AlternativeDistributionPackageVersionIdSchema = z
  .string()
  .min(1)
  .describe(
    'AlternativeDistributionPackageVersion ID from /v1/alternativeDistributionPackages/{id}/versions. State COMPLETED (downloadable) or REPLACED (superseded). url + urlExpirationDate are pre-signed and time-limited — download promptly, re-list for fresh URLs.',
  );

export const MarketplaceSearchDetailIdSchema = z
  .string()
  .min(1)
  .describe(
    "MarketplaceSearchDetail ID from /v1/apps/{id}/marketplaceSearchDetail (to-one). Only relevant for MARKETPLACE apps (alternative app stores): the catalogUrl Apple's marketplace-kit search uses. Wire key catalogUrl (Swift catalogURL).",
  );

export const MarketplaceWebhookIdSchema = z
  .string()
  .min(1)
  .describe(
    'MarketplaceWebhook ID from /v1/marketplaceWebhooks. Team-level webhook for marketplace apps (alternative app stores) — Apple notifies the marketplace about app updates. endpointUrl + write-only secret (HMAC), same secret semantics as v0.17 app webhooks.',
  );

// ---------------------------------------------------------------------------
// Age rating declarations
//
// The declaration hangs off AppInfo, NOT AppStoreVersion
// (/v1/appStoreVersions/{id}/ageRatingDeclaration 404s — verified live
// 2026-07-30), and its `id` IS the appInfo id (another entry in the
// "Apple resource ids are not always opaque" family).
//
// Three value vocabularies across 29 attributes: a shared content-frequency
// enum, three rating-override enums, and plain booleans.

export const AgeRatingDeclarationIdSchema = z
  .string()
  .min(1)
  .describe(
    'AgeRatingDeclaration ID. Equal to the AppInfo ID it belongs to — read it from /v1/apps/{id}/appInfos, or let asc_patch_age_rating_declaration resolve it for you by passing appId.',
  );

export const AgeRatingFrequencySchema = z
  .enum(['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE', 'INFREQUENT', 'FREQUENT'])
  .describe(
    'How often/intensely this content appears. NONE = absent. INFREQUENT_OR_MILD / FREQUENT_OR_INTENSE are the pair Apple uses for most categories; INFREQUENT / FREQUENT appear on newer categories. Raising any of these raises the computed age rating.',
  );

export const AgeRatingOverrideV2Schema = z
  .enum(['NONE', 'NINE_PLUS', 'THIRTEEN_PLUS', 'SIXTEEN_PLUS', 'EIGHTEEN_PLUS', 'UNRATED'])
  .describe(
    "Raise the app's rating ABOVE what the questionnaire computes (you can never lower it). NONE = use the computed rating. UNRATED withholds a rating in territories that require one. Note EIGHTEEN_PLUS — the deprecated v1 attribute used SEVENTEEN_PLUS instead.",
  );

export const KoreaAgeRatingOverrideSchema = z
  .enum(['NONE', 'FIFTEEN_PLUS', 'NINETEEN_PLUS'])
  .describe(
    'Korea-specific rating override, applied only in the Korean storefront. NONE = use the computed rating.',
  );

export const KidsAgeBandSchema = z
  .enum(['FIVE_AND_UNDER', 'SIX_TO_EIGHT', 'NINE_TO_ELEVEN'])
  .describe(
    'Kids Category age band. Set ONLY if the app is in the Kids category — it brings extra App Review requirements (no third-party analytics/ads without parental gate). Lives on the age-rating declaration; it was removed from AppInfo, which is a different resource.',
  );

// ----- v1.5 ship-loop completeness (availabilities + review details) -----

export const SubscriptionAvailabilityIdSchema = z
  .string()
  .min(1)
  .describe(
    'SubscriptionAvailability record id — equals the subscription id (verified live; same "shared numeric identifier" pattern as AppAvailability.id == app id). Get it from asc_get_subscription_availability. Its availableTerritories relationship targets plain Territory rows (bare 3-letter ISO codes).',
  );

export const InAppPurchaseAvailabilityIdSchema = z
  .string()
  .min(1)
  .describe(
    'InAppPurchaseAvailability record id — get it from asc_get_iap_availability. Territory linkage uses bare 3-letter ISO codes.',
  );

export const SubscriptionPlanAvailabilityIdSchema = z
  .string()
  .min(1)
  .describe(
    'SubscriptionPlanAvailability record id — an Apple-OPAQUE base64 composite (unlike the plain-numeric subscription availability id); always get it from asc_list_subscription_plan_availabilities, never construct it.',
  );

export const AppStoreReviewDetailIdSchema = z
  .string()
  .min(1)
  .describe(
    'appStoreReviewDetail id — the App Review contact/demo-account/notes card of a version (to-one). Get it from asc_get_app_store_review_detail; also the parent id for App Review attachments.',
  );

export const AppStoreReviewAttachmentIdSchema = z
  .string()
  .min(1)
  .describe(
    'appStoreReviewAttachment id — a file provided to App Review (e.g. demo video), attached to a version via its appStoreReviewDetail.',
  );

export const SubscriptionGracePeriodIdSchema = z
  .string()
  .min(1)
  .describe(
    "subscriptionGracePeriod id — equals the app id (verified live; the per-app config record shares the app's numeric identifier). Get it from asc_get_subscription_grace_period.",
  );

export const GracePeriodDurationSchema = z
  .enum(['THREE_DAYS', 'SIXTEEN_DAYS', 'TWENTY_EIGHT_DAYS'])
  .describe(
    'How long a lapsed subscriber keeps access while Apple retries the failed renewal payment. Renewals recovered inside the window keep the original renewal date (no revenue gap).',
  );

export const GracePeriodRenewalTypeSchema = z
  .enum(['ALL_RENEWALS', 'PAID_TO_PAID_ONLY'])
  .describe(
    'Which renewals get a grace period: ALL_RENEWALS includes free-trial → paid conversions; PAID_TO_PAID_ONLY covers only existing paid subscribers renewing.',
  );

// ----- v1.6 Xcode Cloud -----

export const CiProductIdSchema = z
  .string()
  .min(1)
  .describe(
    'Xcode Cloud product id — from asc_list_ci_products. One product per app/framework onboarded to Xcode Cloud.',
  );

export const CiWorkflowIdSchema = z
  .string()
  .min(1)
  .describe('Xcode Cloud workflow id — from asc_list_ci_workflows.');

export const CiBuildRunIdSchema = z
  .string()
  .min(1)
  .describe('Xcode Cloud build-run id — from asc_list_ci_build_runs.');

export const CiBuildActionIdSchema = z
  .string()
  .min(1)
  .describe(
    'Xcode Cloud build-action id — one step of a build run (build/test/archive/analyze), from asc_list_ci_build_actions.',
  );

export const CiArtifactIdSchema = z
  .string()
  .min(1)
  .describe('Xcode Cloud artifact id — from asc_list_ci_artifacts.');

export const ScmProviderIdSchema = z
  .string()
  .min(1)
  .describe(
    'Source-control provider id (GitHub / GitLab / Bitbucket connection) — from asc_list_scm_providers.',
  );

export const ScmRepositoryIdSchema = z
  .string()
  .min(1)
  .describe('Source-control repository id — from asc_list_scm_repositories.');

export const ScmGitReferenceIdSchema = z
  .string()
  .min(1)
  .describe(
    'Git reference id (a branch or tag as Apple tracks it) — from asc_list_scm_git_references. NOT a bare branch name.',
  );

// ----- v1.7 sandbox testers -----

export const SandboxTesterIdSchema = z
  .string()
  .min(1)
  .describe(
    'Sandbox tester id — from asc_list_sandbox_testers. Testers are created in the ASC UI (Users and Access → Sandbox Testers); the API manages settings + purchase history.',
  );

export const SubscriptionRenewalRateSchema = z
  .enum([
    'MONTHLY_RENEWAL_EVERY_ONE_HOUR',
    'MONTHLY_RENEWAL_EVERY_THIRTY_MINUTES',
    'MONTHLY_RENEWAL_EVERY_FIFTEEN_MINUTES',
    'MONTHLY_RENEWAL_EVERY_FIVE_MINUTES',
    'MONTHLY_RENEWAL_EVERY_THREE_MINUTES',
  ])
  .describe(
    'Accelerated sandbox renewal clock: how fast a ONE-MONTH subscription period elapses for this tester (longer/shorter real periods scale proportionally). For testing renewals, billing retry, and grace-period flows.',
  );

// ----- v1.8 provisioning & code signing (Developer-portal surface) -----

export const ProvisioningBundleIdRecordSchema = z
  .string()
  .min(1)
  .describe(
    'BundleId RESOURCE id (opaque, from asc_list_bundle_ids) — not the reverse-DNS identifier string itself.',
  );

export const BundleIdCapabilityIdSchema = z
  .string()
  .min(1)
  .describe('BundleIdCapability record id — from the capabilities listing on asc_get_bundle_id.');

export const CertificateIdSchema = z
  .string()
  .min(1)
  .describe('Certificate id — from asc_list_certificates.');

export const ProfileIdSchema = z
  .string()
  .min(1)
  .describe('Provisioning profile id — from asc_list_profiles.');

export const DeviceIdSchema = z
  .string()
  .min(1)
  .describe('Device id — from asc_list_devices (not the UDID).');

export const BundleIdPlatformSchema = z
  .enum(['IOS', 'MAC_OS', 'UNIVERSAL'])
  .describe('Bundle-ID platform. UNIVERSAL covers iOS + macOS.');

export const CertificateTypeSchema = z
  .enum([
    'APPLE_PAY',
    'APPLE_PAY_MERCHANT_IDENTITY',
    'APPLE_PAY_PSP_IDENTITY',
    'APPLE_PAY_RSA',
    'DEVELOPER_ID_KEXT',
    'DEVELOPER_ID_KEXT_G2',
    'DEVELOPER_ID_APPLICATION',
    'DEVELOPER_ID_APPLICATION_G2',
    'DEVELOPMENT',
    'DISTRIBUTION',
    'IDENTITY_ACCESS',
    'IOS_DEVELOPMENT',
    'IOS_DISTRIBUTION',
    'MAC_APP_DISTRIBUTION',
    'MAC_INSTALLER_DISTRIBUTION',
    'MAC_APP_DEVELOPMENT',
    'PASS_TYPE_ID',
    'PASS_TYPE_ID_WITH_NFC',
  ])
  .describe(
    'Certificate type. DEVELOPMENT / DISTRIBUTION are the modern platform-agnostic pair (IOS_* / MAC_* are the legacy per-platform forms).',
  );

export const ProfileTypeSchema = z
  .enum([
    'IOS_APP_DEVELOPMENT',
    'IOS_APP_STORE',
    'IOS_APP_ADHOC',
    'IOS_APP_INHOUSE',
    'MAC_APP_DEVELOPMENT',
    'MAC_APP_STORE',
    'MAC_APP_DIRECT',
    'TVOS_APP_DEVELOPMENT',
    'TVOS_APP_STORE',
    'TVOS_APP_ADHOC',
    'TVOS_APP_INHOUSE',
    'MAC_CATALYST_APP_DEVELOPMENT',
    'MAC_CATALYST_APP_STORE',
    'MAC_CATALYST_APP_DIRECT',
  ])
  .describe(
    'Provisioning profile type. *_APP_STORE profiles need distribution certificates and no device list; *_APP_DEVELOPMENT and *_ADHOC need registered devices.',
  );

// ----- v1.9 featuring nominations -----

export const NominationIdSchema = z
  .string()
  .min(1)
  .describe('Featuring nomination id — from asc_list_nominations.');

export const NominationTypeSchema = z
  .enum(['APP_LAUNCH', 'APP_ENHANCEMENTS', 'NEW_CONTENT'])
  .describe(
    'What is being nominated: APP_LAUNCH (new app or major day-1 release), APP_ENHANCEMENTS (significant update / new features), NEW_CONTENT (content drop in an existing app).',
  );

export const NominationDeviceFamilySchema = z
  .enum(['IPHONE', 'IPAD', 'APPLE_TV', 'APPLE_WATCH', 'MAC', 'VISION'])
  .describe('Device families the nominated experience shines on.');
