#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createASCClient } from './client.js';
import { loadConfig } from './config.js';
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
import { registerBetaFeedback } from './domains/beta-feedback.js';
import { registerBetaGroups } from './domains/beta-groups.js';
import { registerBetaLocalizations } from './domains/beta-localizations.js';
import { registerBetaRecruitment } from './domains/beta-recruitment.js';
import { registerBetaReview } from './domains/beta-review.js';
import { registerBetaTesters } from './domains/beta-testers.js';
import { registerBuildBetaNotifications } from './domains/build-beta-notifications.js';
import { registerBuilds } from './domains/builds.js';
import { registerCustomProductPages } from './domains/custom-product-pages.js';
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
import { registerReviewSubmissions } from './domains/review-submissions.js';
import { registerSalesReports } from './domains/sales-reports.js';
import { registerScreenshots } from './domains/screenshots.js';
import { registerSubscriptionLocalizations } from './domains/subscription-localizations.js';
import { registerSubscriptions } from './domains/subscriptions.js';
import { registerTerritories } from './domains/territories.js';
import { registerWebhooks } from './domains/webhooks.js';

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

async function runServer(): Promise<void> {
  const meta = readPackageMeta();
  const config = loadConfig();
  const client = createASCClient(config);

  const server = new McpServer({ name: meta.name, version: meta.version });

  registerApps(server, client);
  registerSubscriptions(server, client);
  registerPricing(server, client);
  registerAppPricing(server, client);
  registerIaps(server, client);
  registerIntroOffers(server, client);
  registerPromoOffers(server, client);
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
  registerPhasedRelease(server, client);
  registerEncryptionDeclarations(server, client);
  registerBetaFeedback(server, client);
  registerBuildBetaNotifications(server, client);
  registerBetaRecruitment(server, client);
  registerWebhooks(server, client);
  registerSalesReports(server, client);
  registerAnalyticsReports(server, client);
  registerPpp(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  switch (subcommand) {
    case undefined: {
      await runServer();
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
