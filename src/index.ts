#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ASCClient } from './client.js';
import { createASCClient } from './client.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { registerAccessibilityDeclarations } from './domains/accessibility-declarations.js';
import { registerAgeRating } from './domains/age-rating.js';
import { registerAlternativeDistribution } from './domains/alternative-distribution.js';
import { registerAnalyticsReports } from './domains/analytics-reports.js';
import { registerAppAvailability } from './domains/app-availability.js';
import { registerAppEventScreenshots } from './domains/app-event-screenshots.js';
import { registerAppEventVideoClips } from './domains/app-event-video-clips.js';
import { registerAppEvents } from './domains/app-events.js';
import { registerAppInfo } from './domains/app-info.js';
import { registerAppPricing } from './domains/app-pricing.js';
import { registerApps } from './domains/apps.js';
import { registerAppStoreVersionLocalizations } from './domains/appstore-version-localizations.js';
import { registerAppStoreVersions } from './domains/appstore-versions.js';
import { registerAsoCatalog } from './domains/aso-catalog.js';
import { registerAssetUpload } from './domains/asset-upload.js';
import { registerAvailabilities } from './domains/availabilities.js';
import { registerBetaFeedback } from './domains/beta-feedback.js';
import { registerBetaGroups } from './domains/beta-groups.js';
import { registerBetaLocalizations } from './domains/beta-localizations.js';
import { registerBetaRecruitment } from './domains/beta-recruitment.js';
import { registerBetaReview } from './domains/beta-review.js';
import { registerBetaTesters } from './domains/beta-testers.js';
import { registerBuildBetaNotifications } from './domains/build-beta-notifications.js';
import { registerBuilds } from './domains/builds.js';
import { registerCustomProductPages } from './domains/custom-product-pages.js';
import { registerCustomerReviews } from './domains/customer-reviews.js';
import { registerDiagnostics } from './domains/diagnostics.js';
import { registerEncryptionDeclarations } from './domains/encryption-declarations.js';
import { registerIaps } from './domains/iap.js';
import { registerIapLocalizations } from './domains/iap-localizations.js';
import { registerIntroOffers } from './domains/intro-offers.js';
import { registerOfferCodes } from './domains/offer-codes.js';
import { registerOfferSigning } from './domains/offer-signing.js';
import { registerPhasedRelease } from './domains/phased-release.js';
import { registerPpp } from './domains/ppp.js';
import { registerPreviews } from './domains/previews.js';
import { registerPricing } from './domains/pricing.js';
import { registerPromoOffers } from './domains/promo-offers.js';
import { registerPromotedPurchases } from './domains/promoted-purchases.js';
import { registerReviewAssets } from './domains/review-assets.js';
import { registerReviewDetails } from './domains/review-details.js';
import { registerReviewSubmissions } from './domains/review-submissions.js';
import { registerSalesReports } from './domains/sales-reports.js';
import { registerSandboxTesters } from './domains/sandbox-testers.js';
import { registerScreenshots } from './domains/screenshots.js';
import { registerSubscriptionLocalizations } from './domains/subscription-localizations.js';
import { registerSubscriptions } from './domains/subscriptions.js';
import { registerTerritories } from './domains/territories.js';
import { registerVersionExperiments } from './domains/version-experiments.js';
import { registerWebhooks } from './domains/webhooks.js';
import { registerWinBackOffers } from './domains/win-back-offers.js';
import { registerXcodeCloud } from './domains/xcode-cloud.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

interface PackageMeta {
  name: string;
  version: string;
}

function readPackageMeta(): PackageMeta {
  const pkgUrl = new URL('../package.json', import.meta.url);
  try {
    const raw = readFileSync(fileURLToPath(pkgUrl), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: parsed.name ?? 'appstoreconnect-mcp',
      version: parsed.version ?? '0.0.0',
    };
  } catch {
    return { name: 'appstoreconnect-mcp', version: '0.0.0' };
  }
}

const HELP = `appstoreconnect-mcp — Model Context Protocol server for the App Store Connect API.

Usage:
  appstoreconnect-mcp                Run the MCP server over stdio (default; this is what your MCP client invokes).
  appstoreconnect-mcp init           Interactive setup wizard: place .p8, verify auth, register with installed clients.
  appstoreconnect-mcp doctor         Read-only diagnostic of keys, client integrations, and live auth.
  appstoreconnect-mcp --version      Print the package version.
  appstoreconnect-mcp --help         Show this help.

Environment variables (read when running as a server):
  ASC_ISSUER_ID             App Store Connect issuer UUID.
  ASC_KEY_ID                10-character key ID.
  ASC_PRIVATE_KEY_PATH      Path to the .p8 private key file (~ is expanded).

Optional — only needed for the asc_sign_* offer-signing tools:
  ASC_IAP_ISSUER_ID         Issuer UUID for the In-App Purchase signing key
                            (different from ASC_ISSUER_ID; same key page in ASC).
  ASC_IAP_KEY_ID            10-character key ID for the IAP signing key.
  ASC_IAP_PRIVATE_KEY_PATH  Path to the IAP signing .p8.

Optional — default for the sales/finance report tools:
  ASC_VENDOR_NUMBER         Account-level vendor number (App Store Connect →
                            Payments and Financial Reports). Without it,
                            asc_get_sales_report / asc_get_finance_report
                            need vendorNumber passed per call.

Documentation: https://github.com/akoskomuves/appstoreconnect-mcp
`;

// The tool list is fixed at build time: every register* call below runs
// unconditionally at startup and nothing registers or unregisters a tool
// later, so tools/list is byte-identical for the whole process lifetime and
// carries no account-derived data (the offer-signing tools are always
// registered; they check ASC_IAP_* config when *called*, not when listed).
// That makes a long TTL honest and `public` scope accurate.
const TOOLS_LIST_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: 'public' } as const;

// Factory — `serveStdio` calls this once per connection and pins the instance
// for that connection's lifetime, which is how the SDK serves the 2026-07-28
// and 2025-era openings from the same registration code.
function buildServer(meta: PackageMeta, client: ASCClient, config: Config): McpServer {
  const server = new McpServer(
    { name: meta.name, version: meta.version },
    { cacheHints: { 'tools/list': TOOLS_LIST_CACHE_HINT } },
  );

  registerApps(server, client);
  registerSubscriptions(server, client);
  registerPricing(server, client);
  registerAppPricing(server, client);
  registerIaps(server, client);
  registerReviewAssets(server, client);
  registerIntroOffers(server, client);
  registerPromoOffers(server, client);
  registerWinBackOffers(server, client);
  registerOfferCodes(server, client);
  registerOfferSigning(server, config.iap);
  registerTerritories(server, client);
  registerBuilds(server, client);
  registerBetaGroups(server, client);
  registerBetaTesters(server, client);
  registerBetaLocalizations(server, client);
  registerBetaReview(server, client);
  registerAppStoreVersions(server, client);
  registerAppStoreVersionLocalizations(server, client);
  registerReviewSubmissions(server, client);
  registerReviewDetails(server, client);
  registerSubscriptionLocalizations(server, client);
  registerIapLocalizations(server, client);
  registerAppInfo(server, client);
  registerAsoCatalog(server, client);
  registerScreenshots(server, client);
  registerPreviews(server, client);
  registerAssetUpload(server);
  registerCustomProductPages(server, client);
  registerAppEvents(server, client);
  registerAppEventScreenshots(server, client);
  registerAppEventVideoClips(server, client);
  registerPromotedPurchases(server, client);
  registerAppAvailability(server, client);
  registerAvailabilities(server, client);
  registerXcodeCloud(server, client);
  registerSandboxTesters(server, client);
  registerPhasedRelease(server, client);
  registerEncryptionDeclarations(server, client);
  registerBetaFeedback(server, client);
  registerBuildBetaNotifications(server, client);
  registerBetaRecruitment(server, client);
  registerWebhooks(server, client);
  registerSalesReports(server, client);
  registerAnalyticsReports(server, client);
  registerCustomerReviews(server, client);
  registerVersionExperiments(server, client);
  registerDiagnostics(server, client);
  registerAccessibilityDeclarations(server, client);
  registerAlternativeDistribution(server, client);
  registerAgeRating(server, client);
  registerPpp(server, client);

  return server;
}

function runServer(): void {
  const meta = readPackageMeta();
  // Resolve credentials before serving so a misconfigured key fails fast with
  // a readable message on stderr, rather than once per tool call.
  const config = loadConfig();
  const client = createASCClient(config);

  // `legacy: 'serve'` (the default) keeps 2025-era clients working: the
  // opening exchange picks the era and the same handlers serve both. Switch to
  // 'reject' only once every client we care about speaks 2026-07-28.
  serveStdio(() => buildServer(meta, client, config), {
    onerror: (err) => {
      process.stderr.write(`[appstoreconnect-mcp] transport: ${err.message}\n`);
    },
  });
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  switch (subcommand) {
    case undefined: {
      runServer();
      return;
    }
    case 'init': {
      const { main: runInit } = await import('./init.js');
      const meta = readPackageMeta();
      await runInit({ execScriptPath: SCRIPT_PATH, pkgName: meta.name });
      return;
    }
    case 'doctor': {
      const { main: runDoctor } = await import('./doctor.js');
      await runDoctor();
      return;
    }
    case '-v':
    case '--version': {
      const meta = readPackageMeta();
      process.stdout.write(`${meta.version}\n`);
      return;
    }
    case '-h':
    case '--help':
    case 'help': {
      process.stdout.write(HELP);
      return;
    }
    default: {
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${HELP}`);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[appstoreconnect-mcp] fatal: ${message}\n`);
  process.exit(1);
});
