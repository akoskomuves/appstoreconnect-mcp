# appstoreconnect-mcp

[![npm](https://img.shields.io/npm/v/@akoskomuves/appstoreconnect-mcp.svg)](https://www.npmjs.com/package/@akoskomuves/appstoreconnect-mcp)
[![CI](https://github.com/akoskomuves/appstoreconnect-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/akoskomuves/appstoreconnect-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Apple App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi). Drives apps, subscriptions, pricing, and more from any MCP-compatible client (Claude Code, Claude Desktop, Cursor, Windsurf).

The first published surface is **subscription pricing** — including a Purchasing Power Parity rebalance flow that's already been used to schedule 120 production price changes across 65 territories on a real iOS app. New ASC domains (TestFlight, sales, screenshots, IAPs) are designed to plug in one file at a time; see [Roadmap](#roadmap).

## Install (zero-config)

```sh
npx @akoskomuves/appstoreconnect-mcp init
```

The wizard:

1. Opens [App Store Connect → Keys](https://appstoreconnect.apple.com/access/integrations/api) so you can download a `.p8` (skipped if you already have one).
2. Copies the key to `~/.appstore/` with `chmod 600`.
3. Asks for your Issuer ID and (auto-detected) Key ID.
4. Verifies auth with a real API call before writing anything.
5. Detects which MCP clients you have installed — Claude Code, Claude Desktop, Cursor, Windsurf — and registers itself in the ones you pick.

When something looks off later, run a read-only diagnostic:

```sh
npx @akoskomuves/appstoreconnect-mcp doctor
```

### Manual install

If you'd rather wire it up by hand, add to `~/.claude.json` (Claude Code), `claude_desktop_config.json` (Claude Desktop), or your client's equivalent:

```json
{
  "mcpServers": {
    "appstoreconnect": {
      "command": "npx",
      "args": ["-y", "@akoskomuves/appstoreconnect-mcp"],
      "env": {
        "ASC_ISSUER_ID": "...",
        "ASC_KEY_ID": "...",
        "ASC_PRIVATE_KEY_PATH": "~/.appstore/AuthKey_XXXXXXXXXX.p8"
      }
    }
  }
}
```

Or via Claude Code's CLI:

```sh
claude mcp add appstoreconnect \
  -e ASC_ISSUER_ID=... \
  -e ASC_KEY_ID=... \
  -e ASC_PRIVATE_KEY_PATH=~/.appstore/AuthKey_XXXXXXXXXX.p8 \
  -- npx -y @akoskomuves/appstoreconnect-mcp
```

## Configure

Generate an App Store Connect API key at [App Store Connect → Users and Access → Integrations → Keys](https://appstoreconnect.apple.com/access/integrations/api). Pricing writes need the **Admin** role; read-only operations work with **App Manager**.

| Variable | What |
| --- | --- |
| `ASC_ISSUER_ID` | Issuer UUID from the Keys page |
| `ASC_KEY_ID` | 10-character Key ID |
| `ASC_PRIVATE_KEY_PATH` | Path to your downloaded `AuthKey_XXXXXXXXXX.p8` file (`~` is expanded) |

The `.p8` file is a private key — never commit it. Recommended: `~/.appstore/AuthKey_XXXXXXXXXX.p8` outside any repo.

### Optional: In-App Purchase signing key

Only needed for the `asc_sign_*` tools (subscription offer redemption signing). Issue a second key at App Store Connect → Users and Access → Integrations → **In-App Purchase** — this is a separate key from the ASC API key above, generated on a different tab of the same page.

| Variable | What |
| --- | --- |
| `ASC_IAP_ISSUER_ID` | Issuer UUID from the In-App Purchase keys tab (different from `ASC_ISSUER_ID`) |
| `ASC_IAP_KEY_ID` | 10-character Key ID for the IAP key |
| `ASC_IAP_PRIVATE_KEY_PATH` | Path to the IAP signing `.p8` (`~` is expanded) |

The server starts fine without these — only the `asc_sign_*` tools refuse with a setup message if they're missing. Set one or two but not all three and the server rejects with a clear error. Run `appstoreconnect-mcp doctor` to verify the key loads as a valid ES256 PKCS#8.

## Tools

### Apps
- `asc_list_apps` — list apps (filter by `bundleId`)
- `asc_get_app` — fetch one app by ID

### Subscriptions
- `asc_list_subscription_groups` — groups for an app
- `asc_list_subscriptions` — auto-renewable subscriptions in a group
- `asc_list_subscription_prices` — current price schedule per subscription
- `asc_list_subscription_price_points` — valid price points for a subscription in a territory. Pass `nearAmount` to narrow the response to the nearest tiers around a target price.

### Subscription pricing (writes)
- `asc_post_subscription_price` — schedule a price change for one territory
- `asc_delete_subscription_price` — cancel a pending scheduled change

### App pricing (paid non-subscription apps)
- `asc_list_app_prices` — current price schedule for an app, splitting manual overrides from auto-derived prices and surfacing the base territory
- `asc_list_app_price_points` — valid Apple price tiers for an app in a given territory (~600+ tiers per territory). Pass `nearAmount` (target price) and optional `nearCount` (default 10) to narrow the response to the nearest tiers — Apple does not support a near-amount filter server-side, so the full list is still paginated but only the nearest tiers are surfaced.
- `asc_post_app_price_schedule` — replace the entire price schedule (whole-schedule replace, NOT a merge — matches Apple's API). Pre-flight refuses unless at least one entry targets the base territory with no `startDate`, and requires explicit `acknowledgeReplacesAll: true`. A separate `acknowledgeDeletesScheduledIfBaseChanges` ack is required when changing the base territory (Apple wipes pending scheduled changes on base-change). Apps have no grandfather mechanism — new schedules activate atomically at each entry's `startDate`.

### In-app purchases (consumables, non-consumables, non-renewing subs)
- `asc_list_iaps` — list IAPs for an app (v2 surface only — auto-renewable subscriptions are covered by the Subscriptions tools above). Filterable by `inAppPurchaseType` and `state`. If this returns zero rows for an app you know has IAPs, the IAPs may be legacy-only and need to be migrated in the App Store Connect web UI before they appear here.
- `asc_get_iap` — fetch a single IAP by ID.
- `asc_list_iap_prices` — current price schedule for an IAP (same shape as app prices: manual overrides + auto-derived + base territory).
- `asc_list_iap_price_points` — valid Apple price tiers for an IAP in a given territory. Same `nearAmount` / `nearCount` narrowing as the app and subscription price-point tools.
- `asc_post_iap_price_schedule` — replace the entire IAP price schedule (same whole-schedule replace semantics as `asc_post_app_price_schedule`: `acknowledgeReplacesAll: true`, base-territory entry with no `startDate`, base-change ack required). No grandfather mechanism — same as apps.

### Subscription introductory offers
Introductory offers target **new** subscribers — the discounted "first window" before the regular price kicks in.

- `asc_list_subscription_introductory_offers` — list intro offers (free trial / pay-as-you-go / pay-up-front) configured for a subscription, across territories. Apple's "all territories" wildcard (a single offer with no `territory`) surfaces as `TERR=(all)` in the table.
- `asc_get_subscription_introductory_offer` — fetch one offer by ID.
- `asc_post_subscription_introductory_offer` — create an offer. Three `offerMode`s: `FREE_TRIAL` (no price; omit `pricePointId`), `PAY_AS_YOU_GO` (charge the offer price each period for `numberOfPeriods` periods), `PAY_UP_FRONT` (single charge for the whole duration). Pass `territoryId` to target one market, or omit it for Apple's "all territories" wildcard (uses the literal price point in every market — no auto-FX). Server-side validation refuses `PAY_*` without `pricePointId`, `PAY_AS_YOU_GO` without `numberOfPeriods`, and `endDate ≤ startDate` — Apple's error is surfaced inline otherwise.
- `asc_patch_subscription_introductory_offer` — narrow update path: only `startDate`, `endDate`, and `pricePointId` can change after creation. To change mode / duration / periods, delete and re-create.
- `asc_delete_subscription_introductory_offer` — delete a pending or active offer. Apple refuses to delete one that is currently redeemable; PATCH `endDate` to today to stop it instead.

### Subscription promotional offers
Promotional offers target **existing or lapsed** subscribers — opposite eligibility from intro offers, set by the resource type itself (no per-offer flag). Apple caps active promo offers at 10 per subscription. After creation, only the per-territory prices can be edited — `name`, `offerCode`, `offerMode`, `duration`, and `numberOfPeriods` are immutable.

- `asc_list_subscription_promotional_offers` — list promo offers configured for a subscription.
- `asc_get_subscription_promotional_offer` — fetch a single offer, including its per-territory prices.
- `asc_list_subscription_promotional_offer_prices` — list per-territory price rows attached to an offer (territory + currency + amount + price-point ID).
- `asc_post_subscription_promotional_offer` — create an offer (`name` + `offerCode` + mode + duration + all per-territory prices) in one atomic POST. Pre-flights Apple's 10-offer cap and `offerCode` collisions, refusing with a clear remedy message instead of letting Apple 409.
- `asc_patch_subscription_promotional_offer_prices` — update the offer's per-territory prices. Apple's wire semantic is replace (the new prices array becomes the post-state, dropping any territory not listed); the tool's `mode: 'replace' | 'add' | 'remove'` parameter hides the footgun — `'add'` reads current prices and merges, `'remove'` reads and filters.
- `asc_delete_subscription_promotional_offer` — DELETE → 204.

### Subscription offer signing (in-app redemption)
The cryptographic signer that makes promo/intro offers redeemable in your iOS app via StoreKit. Uses a **separate** signing key from the ASC API key — issued at App Store Connect → Users and Access → Integrations → In-App Purchase. See the [optional config section](#optional-in-app-purchase-signing-key) for env vars. Built on Apple's official [`@apple/app-store-server-library`](https://github.com/apple/app-store-server-library-node).

- `asc_sign_promotional_offer_legacy` — legacy ECDSA-concatenated signature used by StoreKit 1's `SKPaymentDiscount` and the original StoreKit 2 `Product.PurchaseOption.promotionalOffer(offerID:keyID:nonce:signature:timestamp:)` API. Returns the base64 signature plus the nonce, timestamp, and keyId for the caller to pass to StoreKit. Auto-generates a UUID nonce and current timestamp; both overridable for testing.
- `asc_sign_promotional_offer` — JWS v2 format introduced at WWDC 2025 (back-deployed to iOS 15). Use with StoreKit 2's newer promotional-offer purchase options. Returns the JWS compact serialization directly. `transactionId` (the customer's `appTransactionId`) is optional but strongly recommended.
- `asc_sign_introductory_offer_eligibility` — JWS v2 with `aud="introductory-offer-eligibility"`. Lets you override StoreKit's default introductory-offer eligibility check (e.g. grant a returning customer another trial). New in WWDC 2025.

All signatures are valid for 24 hours from signing time — re-sign per redemption attempt rather than pre-signing and caching.

### Territories
- `asc_list_territories` — all 175 App Store territories

### PPP rebalancing
- `ppp_load_index` — return the bundled Apple Music Individual-plan price snapshot used as the PPP signal
- `ppp_compute_proposal` — compute a proposed per-territory price schedule (read-only dry-run; uses Apple Music ratios as implied PPP-FX, snaps to valid Apple price points, applies a configurable round strategy and floor). Pass `resourceType: "subscription"` (default) with `subscriptionId`, `resourceType: "app"` with `appId` for paid apps, `resourceType: "iap"` with `iapId`, `resourceType: "introductoryOffer"` with `subscriptionId` plus `offerMode` / `duration` (and `numberOfPeriods` for `PAY_AS_YOU_GO`), or `resourceType: "promotionalOffer"` with `subscriptionId` plus `offerMode` / `duration` / `promoOfferName` / `promoOfferCode` (and `numberOfPeriods` for `PAY_AS_YOU_GO`).
- `ppp_apply_proposal` — recompute and apply the proposal against ASC after confirming via MCP elicitation (or `confirm: true` for unattended use). Refuses if any row drops by more than `maxDropPct` (default 90%); skips territories where ASC billing currency ≠ Apple Music currency.
  - For **subscriptions**: per-territory `subscriptionPrices` POSTs, paced at `maxConcurrency` (default 2), retrying 429s automatically; existing subscribers grandfathered when `preserveCurrentPrice: true` (default).
  - For **apps** and **IAPs**: a single whole-schedule-replace POST (one HTTP call, atomic). Apps/IAPs have no grandfather mechanism — new prices activate at each entry's `startDate`. Requires `acknowledgeDeletesScheduledIfBaseChanges: true` when changing the base territory (Apple wipes pending scheduled changes on base-change).
  - For **introductory offers**: per-territory `subscriptionIntroductoryOffers` POSTs, paced at `maxConcurrency`. The Δ column compares the snapped offer price against the current regular sub price in that territory, so `-50%` means the offer is half off the sub. `FREE_TRIAL` is rejected (no price to compute — use `asc_post_subscription_introductory_offer` with `territoryId` omitted for a single global free trial). Intro offers are additions, not replacements — Apple returns 409 if an active offer already exists for a `(sub, territory)` cell, and those rows show as `failed` in the result table.
  - For **promotional offers**: one atomic POST to `/v1/subscriptionPromotionalOffers` creates the offer + all per-territory PPP-snapped prices in a single request. Create-only — refuses if `offerCode` collides with an existing offer or the sub is at Apple's 10-offer cap. `FREE_TRIAL` rejected (no price to compute). Same Δ-vs-current-sub-price reporting as intro offers.

### Response shape

Every list/get tool returns a compact text table by default — designed for an LLM to read without burning context. Every tool also accepts:

- `raw: true` — return the full JSON:API payload (`data`, `included`, `links`, `meta`) for debugging or advanced use.
- `maxItems: number` — cap auto-pagination (default 500–1000 depending on the tool). The MCP follows `links.next` and merges + dedupes `included` resources across pages.

Sparse fieldsets (`fields[type]=...`) are applied per tool to avoid pulling unused attributes. The whole 175-territory price schedule comes back in one paginated call (200/page) at roughly 1/10th the size of the unfiltered payload.

## Production behavior

A few details worth knowing before running `ppp_apply_proposal` against a live App Store Connect account:

- **Rate limit handling.** Apple throttles POST endpoints around 50/min. `client.request` honours `Retry-After` headers and falls back to exponential backoff (2s → 60s, capped, up to 6 retries). A 60-territory rebalance pacing through retries finishes in about 2 minutes wall time with zero manual intervention.
- **Currency-mismatch skip.** If the bundled Apple Music index lists a territory in one currency (say BHD) but ASC bills your subscription in another (USD), the PPP-FX ratio breaks dimensionally. The proposal marks those rows `currency-mismatch (asc=USD, am=BHD)` and excludes them from the apply set. Common in Gulf USD-billed markets (BHR, KWT, OMN). Set those manually if you want to.
- **Sanity floor.** `floorFactor` (default 0.15) is a hard lower bound on per-territory drops as a fraction of the current price — guards against a stale index entry collapsing a price to near-zero. For a more conservative rebalance, pass 0.30 or 0.50.
- **Sanity ceiling on drops.** `maxDropPct` (default 90%) refuses to apply *any* run where a single row drops more than this. If you've ever seen Apple Music tank a market price aggressively, this catches the resulting outlier before you write it to ASC.
- **Refresh the snapshot when you care.** `data/apple-music-prices.json` is a hand-curated snapshot. Each entry is dated; the snapshot date is shown in proposal output. Pull request a refresh when Apple Music prices move and the project will fold it in.

## PPP rebalancing skill

The `examples/ppp-rebalance/` directory contains a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that wraps these tools into a Purchasing Power Parity workflow (dry-run → schedule → rollback) with the gotchas baked in.

```sh
mkdir -p ~/.claude/skills && \
  ln -s "$PWD/examples/ppp-rebalance" ~/.claude/skills/ppp-rebalance
```

Then ask Claude: *"Rebalance my subscription prices using the ppp-rebalance skill."*

## Roadmap

v0.1–v0.16 cover monetization + beta distribution + the full App Store product-page surface + live promotional events + territory / rollout / export compliance: the full pricing/IAP/offers surface (subscriptions, paid apps, IAPs, intro offers, promo offers, offer-code campaigns, signers), TestFlight (builds, beta groups, beta testers, beta localizations, beta review submissions), the per-locale product-page copy (release notes, descriptions, keywords, promotional text), the release lifecycle (App Store Version write + V2 Review Submission), App Info / category / tag / search-keyword surfaces (v0.12), screenshot + preview asset upload + Custom Product Pages (v0.13), In-App Events + Promoted Purchases (v0.14), App Availability + Phased Release + Encryption Declarations (v0.15), and the TestFlight feedback loop — beta feedback screenshots/crashes, build notifications, public-link recruitment criteria (v0.16). The rest is fertile ground for LLM-driven ops because so much App Store work is judgment-heavy text — review responses, pricing positioning — that a model can draft and a human approves.

| Phase | Domain | What it unlocks |
| --- | --- | --- |
| **v0.1** ✓ | Apps · subscriptions · subscription pricing · PPP rebalance | Schedule per-territory price changes by purchasing power. |
| **v0.2.0** ✓ | App pricing (non-subscription): list / list price points / replace schedule · PPP compute extended to apps | PPP dry-run against paid apps; manual apply via `asc_post_app_price_schedule`. |
| **v0.3.0** ✓ | In-app purchases (v2): list / get / price schedule reads + writes | Same monetization surface for IAPs (consumables, non-consumables, non-renewing subs). Auto-renewables stay on the Subscriptions tools. |
| **v0.4.0** ✓ | `ppp_apply_proposal` auto-apply for apps + IAPs · PPP for IAPs · `nearAmount` filter on price-point listings | One-shot PPP rebalance for *every* paid surface, not just subs. |
| **v0.5.0** ✓ | Subscription introductory offers (free trial / pay-as-you-go / pay-up-front): list / get / post / patch / delete · PPP extended to intro offers | PPP-aware "first month" / "first three months" promos that adapt to local purchasing power instead of a literal $0.99 everywhere. |
| **v0.6.0** ✓ | Subscription promotional offers (existing/lapsed subscribers): list / get / post / patch-prices / delete · PPP extended to promo offers (create-only, atomic single-POST) | Win-back campaigns with PPP-aware per-territory pricing. |
| **v0.7.0** ✓ | Subscription offer signing: three signers (legacy ECDSA, JWS v2 promo, JWS v2 intro eligibility) covering every current Apple-supported format | StoreKit redemption end-to-end — promo offers from v0.6 are now usable in an iOS app, not just configurable in ASC. |
| **v0.8.0** ✓ | Subscription offer codes (campaign CRUD-minus-D · per-territory prices · one-time-use code batches · text/csv export via /values) · PPP extended to offer-code campaigns | Promo-code redemption campaigns (App Store Connect → "Offer codes") — generate, deactivate, export CSV. |
| **v0.8.1** ✓ | Subscription offer codes follow-ons: custom (multi-use) codes (list/post/patch) · `environment: SANDBOX\|PRODUCTION` on batch create · `autoRenewEnabled` on campaign create · campaign digest now surfaces autoRenew + prod/sbx code counts · PPP apply forwards autoRenewEnabled | Public-facing redeemable strings (one string, many redemptions) + sandbox-vs-production batch tagging + non-renewing one-shot offer codes. |
| **v0.9.0** ✓ | TestFlight surface across 5 sub-domains: builds (list/get/expire/build-beta-detail) · beta groups (CRUD + tester linkage + build linkage) · beta testers (CRUD + invitation send/resend) · beta build localizations (CRUD per build × locale) · beta app localizations (CRUD per app × locale) · beta app review submissions + details · pre-release versions (read-only). 32 new tools. | "Invite these 30 testers to the new build with this test note in EN/ES/JA." |
| **v0.10.0** ✓ | App-store product page localizations across 4 surfaces: App Store versions (read-only list/get) · App Store version localizations (CRUD — release notes / description / keywords / promotional text / marketing+support URLs) · subscription localizations (CRUD — name + description per locale) · IAP localizations (CRUD — same shape on v2 IAP surface). 17 new tools. | The biggest LLM win. Translate release notes into 35 locales using existing localizations as voice reference, present diff, push on approval. |
| **v0.10.1** ✓ | Fix: state-aware pre-check on `asc_patch_app_store_version_localization` — refuses incompatible field batches client-side with `{state, allowed, blocked, reason, nextEditablePath}` before Apple's bare 409 STATE_ERROR. `MarketingUrlSchema` description rewritten to differentiate App Store product page vs TestFlight surfaces. | Avoid wasted PATCH round-trips against `READY_FOR_SALE` versions. |
| **v0.11.0** ✓ | App Store Version write surface (create / patch / delete with state-gated delete) + V2 Review Submission flow (create draft → add items → submit/cancel + status reads). Closes the release loop — ship a new version end-to-end through the MCP without opening ASC. | "Translate release notes into 35 locales and submit version 2.5 for review." |
| **v0.12.0** ✓ | App Info (list/get + state-gated PATCH for category relationships) · AppInfoLocalization CRUD (name + subtitle + privacy URLs + privacy text per locale) · AppCategory catalog (read-only with subcategories included) · AppTag (list per app + PATCH `visibleInAppStore` visibility toggle) · SearchKeywords aggregated read surface (filter by platform + locale). 12 new tools. | "Swap your app's secondary category from Travel to Sports, then update the subtitle across all 13 locales." |
| **v0.13.0** ✓ | Asset upload: Screenshots + App Previews (three-step reserve / chunk-PUT / commit, exposed as composite shortcuts (`asc_upload_screenshot`, `asc_upload_app_preview`) AND raw three-step variants for manual control). Custom Product Pages: page + version + localization CRUD with state gate on the version. Pinned wire-key gotchas (`isUploaded`→`uploaded`, `isVisible`→`visible`, `videoURL`→`videoUrl`) and no-attrs-block omission on CPP version create. ~25 new tools. | "Generate App Store screenshots for 12 locales from these source files, push them to a Custom Product Page variant called `paid-ads-summer`." |
| **v0.14.0** ✓ | In-App Events: AppEvent + AppEventLocalization CRUD with 10-value state gate (refuses WAITING_FOR_REVIEW / IN_REVIEW), TerritorySchedule arrays (ISO 8601), and event screenshot + video clip upload (composite + raw three-step, reusing the v0.13 asset-upload helpers). Promoted Purchases: CRUD + per-app ordering linkage (bare-array PATCH; array order = storefront order). Pinned wire-key gotchas: `isUploaded`→`uploaded`, `isVisibleForAllUsers`→`visibleForAllUsers`, `isEnabled`→`enabled`. ~28 new tools. | "Create an in-app event 'Salmon Season Opens' for your app running 2026-06-15 to 2026-07-15." |
| **v0.15.0** ✓ | App Availability v2 (POST-only full-replace; 3-letter ISO codes ARE the IDs; pre-order end-tool) + Phased Release (4-state lifecycle PATCH on AppStoreVersion) + Encryption Declarations (append-only declarations + build linkage + supporting-document upload reusing v0.13 asset-upload). Pinned wire-key gotchas: `isAvailableInNewTerritories`→`availableInNewTerritories`, `isAvailableOnFrenchStore`→`availableOnFrenchStore`, `isUploaded`→`uploaded`, `downloadURL`→`downloadUrl`. ~19 new tools. | "Enable your app in 3 new territories and start a phased release on version 2.5." |
| **v0.16** ✓ | TestFlight follow-ons: Beta Feedback Submissions (screenshot + crash feedback lists with build/tester/device filters, crash-log text fetch, deletes) + Build Beta Notifications (manual "new build available" ping; relationships-only POST, no attrs block at all) + Beta Recruitment Criteria (to-ONE per beta group; create/patch/delete + valid-options catalog + compatible-build check). Pinned wire-key gotcha: `buildBundleID`→`buildBundleId` (trailing-ID strip). DELETEs on feedback + criteria documented by Apple but missing from the Swift SDK — verified against Apple doc JSON. Dotted filter `filter[build.preReleaseVersion]`. 14 new tools. | "Summarize beta feedback on build 132 by frequency and severity, draft a triage list." |
| **v0.17** | Webhooks (app-level Connect notifications — subscription state changes, review state transitions, build availability). | "Set up a webhook so a Slack channel hears about every new beta build going live." |
| **v0.18** | Sales/trends · finance reports · app analytics. Pushed back because everything above makes day-to-day ops cheaper; sales is read-only "look at what happened". | "Why did MRR drop in Brazil last week? Compare to the rebalance activation date." |
| **v0.19** | Customer reviews (read · respond · filter by sentiment/version) + customer review summarizations (Apple's AI-aggregated review insight, the new resource on the App Store Connect side). | "Draft a response to every 1-star review on the latest version that mentions the export bug. Show me before posting." |
| **v1.0+** | EU DMA + alternative distribution · real-FX for currency-mismatch territories · App Store Version Experiments (A/B tests on product page) · Pre-orders config · niche read surfaces (diagnostic signatures, power/performance metrics, accessibility declarations). | Compliance + advanced ASO + niche analytics. |

**Out of scope** (Fastlane / Xcode already do these well): provisioning profiles, certificates, devices, capabilities, Game Center config.

Think of this as the LLM companion for App Store Connect ops. Fastlane is for the build/release pipeline; this is for the post-release knowledge work — release lifecycle, translation, pricing, ASO, customer feedback, in-store promotion, and analytics.

Each new domain is one file under `src/domains/<name>.ts` plus a `register*` call in `src/index.ts`. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Develop

```sh
git clone https://github.com/akoskomuves/appstoreconnect-mcp.git
cd appstoreconnect-mcp
npm install
npm run dev   # tsx watch mode
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor flow (changesets, PR template, branch naming).

## License

[MIT](LICENSE) © 2026 Akos Komuves
