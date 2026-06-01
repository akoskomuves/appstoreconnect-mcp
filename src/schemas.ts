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
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Must be a BCP-47 locale like "en-US" or "zh-Hant"')
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
