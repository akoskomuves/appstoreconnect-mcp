#!/usr/bin/env tsx
// Live smoke test for the v0.9.0 TestFlight surface. Not wired into the test
// suite — meant to be run by a human with real ASC creds in env, exercising
// the actual /v1/builds, /v1/betaGroups, /v1/betaTesters,
// /v1/betaBuildLocalizations, /v1/betaAppLocalizations,
// /v1/betaAppReviewSubmissions, /v1/betaAppReviewDetails, and
// /v1/preReleaseVersions endpoints.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-testflight.ts                       # enumerate apps + builds
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-testflight.ts --app <APP_ID>        # walk every TestFlight surface on one app
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-testflight.ts --build <BUILD_ID>    # exercise build-scoped surfaces (loc, review submissions)
//
// This script is READ-ONLY by default. It does NOT POST/PATCH/DELETE anything.
// To exercise writes, follow the offer-codes smoke pattern: use the MCP tools
// directly via Claude (reload from local build first), one at a time.
//
// What this verifies (against the live API):
//   1. /v1/apps/{id}/builds returns rows with version/processingState/
//      buildAudienceType + uploadedDate. digestBuilds renders them with the
//      STATE/AUDIENCE/EXP columns.
//   2. /v1/apps/{id}/betaGroups walks. Per group, /v1/betaGroups/{id} expands
//      app+builds+betaTesters. Wire-key keys are present per Apple's contract
//      (isInternalGroup, hasAccessToAllBuilds keep the prefix; publicLinkEnabled
//      strips it).
//   3. /v1/apps/{id}/betaTesters returns rows with email/firstName/lastName/
//      inviteType/state.
//   4. /v1/apps/{id}/betaAppLocalizations walks; per row, the URL attributes
//      use camelCase wire keys (marketingUrl, not marketingURL).
//   5. /v1/builds/{id}/betaBuildLocalizations walks; the whatsNew preview
//      renders without exploding the table.
//   6. /v1/betaAppReviewDetails (filter[app]) returns the per-app standing
//      detail with demoAccountRequired flag visible.
//   7. /v1/preReleaseVersions (scoped by app) walks; rows group builds by
//      version train.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestApps,
  digestBetaAppLocalizations,
  digestBetaAppReviewDetails,
  digestBetaAppReviewSubmissions,
  digestBetaBuildLocalizations,
  digestBetaGroups,
  digestBetaTesters,
  digestBuilds,
  digestPreReleaseVersions,
} from '../src/digest.js';
import { paginate } from '../src/jsonapi.js';

async function enumerate(client: ReturnType<typeof createASCClient>): Promise<void> {
  console.log('=== Enumerate: apps ===\n');
  const apps = await paginate(client, '/v1/apps?limit=200', 200);
  console.log(digestApps(apps));
  console.log('');
  console.log('\nPick an app ID from above and re-run:');
  console.log('  npx tsx scripts/smoke-testflight.ts --app <APP_ID>');
}

async function smokeApp(client: ReturnType<typeof createASCClient>, appId: string): Promise<void> {
  console.log(`=== TestFlight surface for app ${appId} ===\n`);

  // 1. Builds
  console.log('--- Builds (newest first) ---\n');
  const buildsParams = new URLSearchParams();
  buildsParams.set(
    'fields[builds]',
    'version,uploadedDate,expirationDate,expired,minOsVersion,processingState,buildAudienceType,usesNonExemptEncryption',
  );
  buildsParams.set('limit', '50');
  buildsParams.set('sort', '-uploadedDate');
  let builds: Awaited<ReturnType<typeof paginate>>;
  try {
    builds = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(appId)}/builds?${buildsParams.toString()}`,
      50,
    );
    console.log(digestBuilds(builds));
  } catch (err) {
    console.log(`[FAIL] builds: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2. Pre-release versions
  console.log('\n--- Pre-release versions ---\n');
  try {
    const prv = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(appId)}/preReleaseVersions?fields[preReleaseVersions]=version,platform&limit=50`,
      50,
    );
    console.log(digestPreReleaseVersions(prv));
  } catch (err) {
    console.log(`[FAIL] preReleaseVersions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Beta groups
  console.log('\n--- Beta groups ---\n');
  let groups: Awaited<ReturnType<typeof paginate>>;
  try {
    groups = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(appId)}/betaGroups?fields[betaGroups]=name,createdDate,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLinkLimitEnabled,publicLinkLimit,publicLink,feedbackEnabled,iosBuildsAvailableForAppleSiliconMac,iosBuildsAvailableForAppleVision&limit=100`,
      100,
    );
    console.log(digestBetaGroups(groups));
  } catch (err) {
    console.log(`[FAIL] betaGroups: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 4. Beta testers (app-scoped)
  console.log('\n--- Beta testers (first 100) ---\n');
  try {
    const testers = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(appId)}/betaTesters?fields[betaTesters]=firstName,lastName,email,inviteType,state&limit=100`,
      100,
    );
    console.log(digestBetaTesters(testers));
  } catch (err) {
    console.log(`[FAIL] betaTesters: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Beta app localizations
  console.log('\n--- Beta app localizations ---\n');
  try {
    const bal = await paginate(
      client,
      `/v1/apps/${encodeURIComponent(appId)}/betaAppLocalizations?fields[betaAppLocalizations]=feedbackEmail,marketingUrl,privacyPolicyUrl,tvOsPrivacyPolicy,description,locale&limit=100`,
      100,
    );
    console.log(digestBetaAppLocalizations(bal));
    // Verify wire-key correctness on the first row, if any.
    const first = bal.data[0];
    if (first?.attributes) {
      const attrs = first.attributes as Record<string, unknown>;
      const hasCamel = 'marketingUrl' in attrs || 'privacyPolicyUrl' in attrs;
      const hasCaps = 'marketingURL' in attrs || 'privacyPolicyURL' in attrs;
      console.log(
        `\n[wire-key] marketingUrl/privacyPolicyUrl present: ${hasCamel} · all-caps form present: ${hasCaps} (expected: camelCase yes, all-caps no)`,
      );
    }
  } catch (err) {
    console.log(`[FAIL] betaAppLocalizations: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Beta app review detail (per-app standing record)
  console.log('\n--- Beta app review detail ---\n');
  try {
    const detail = await paginate(
      client,
      `/v1/betaAppReviewDetails?filter[app]=${encodeURIComponent(appId)}&fields[betaAppReviewDetails]=contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountName,demoAccountPassword,demoAccountRequired,notes&limit=10`,
      10,
    );
    console.log(digestBetaAppReviewDetails(detail));
    const dRow = detail.data[0];
    if (dRow?.attributes) {
      const attrs = dRow.attributes as Record<string, unknown>;
      const hasStripped = 'demoAccountRequired' in attrs;
      const hasUnstripped = 'isDemoAccountRequired' in attrs;
      console.log(
        `\n[wire-key] demoAccountRequired present: ${hasStripped} · isDemoAccountRequired present: ${hasUnstripped} (expected: stripped yes, prefixed no)`,
      );
    }
  } catch (err) {
    console.log(`[FAIL] betaAppReviewDetails: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7. Per-group walk: fetch the first group to verify expand
  if (groups.data.length > 0) {
    const firstGroup = groups.data[0];
    if (firstGroup) {
      console.log(`\n--- Group ${firstGroup.id} expanded ---\n`);
      try {
        const expanded = await client.request<unknown>(
          `/v1/betaGroups/${encodeURIComponent(firstGroup.id)}?include=app,builds,betaTesters`,
          { method: 'GET' },
        );
        // Just print top-level keys; the full body is verbose.
        const shape = (() => {
          const r = expanded as Record<string, unknown>;
          const keys = Object.keys(r);
          const inc = (r['included'] as unknown[]) ?? [];
          return `{ ${keys.join(',')} } included.length=${inc.length}`;
        })();
        console.log(`[ok] expanded shape: ${shape}`);
      } catch (err) {
        console.log(`[FAIL] expand: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 8. Per-build walk: fetch the first build's localizations
  if (builds.data.length > 0) {
    const firstBuild = builds.data[0];
    if (firstBuild) {
      console.log(`\n--- Build ${firstBuild.id} localizations ---\n`);
      try {
        const localizations = await paginate(
          client,
          `/v1/builds/${encodeURIComponent(firstBuild.id)}/betaBuildLocalizations?fields[betaBuildLocalizations]=whatsNew,locale&limit=100`,
          100,
        );
        console.log(digestBetaBuildLocalizations(localizations));
      } catch (err) {
        console.log(
          `[FAIL] betaBuildLocalizations: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      console.log(`\n--- Build ${firstBuild.id} review submission(s) ---\n`);
      try {
        const submissions = await paginate(
          client,
          `/v1/betaAppReviewSubmissions?filter[build]=${encodeURIComponent(firstBuild.id)}&fields[betaAppReviewSubmissions]=betaReviewState,submittedDate&limit=10`,
          10,
        );
        console.log(digestBetaAppReviewSubmissions(submissions));
      } catch (err) {
        console.log(
          `[FAIL] betaAppReviewSubmissions: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log('\n\n=== Smoke complete ===');
  console.log(
    'To exercise WRITES (post/patch/delete), use the MCP tools via a Claude session — reload the MCP from the local build first.',
  );
}

async function smokeBuild(
  client: ReturnType<typeof createASCClient>,
  buildId: string,
): Promise<void> {
  console.log(`=== Build-scoped surface for build ${buildId} ===\n`);
  try {
    const data = await client.request<unknown>(
      `/v1/builds/${encodeURIComponent(buildId)}?include=app,preReleaseVersion,buildBetaDetail,betaBuildLocalizations,betaGroups,betaAppReviewSubmission`,
      { method: 'GET' },
    );
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.log(`[FAIL] get build: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  let appId: string | undefined;
  let buildId: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--app' && args[i + 1]) {
      appId = args[i + 1];
      i++;
    } else if (args[i] === '--build' && args[i + 1]) {
      buildId = args[i + 1];
      i++;
    }
  }

  const config = loadConfig();
  const client = createASCClient(config);

  if (buildId) {
    await smokeBuild(client, buildId);
  } else if (appId) {
    await smokeApp(client, appId);
  } else {
    await enumerate(client);
  }
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
