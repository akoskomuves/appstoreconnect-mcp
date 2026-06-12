#!/usr/bin/env tsx
// Live smoke for the v0.21 surface (diagnostics + perf/power + accessibility).
//
// Usage:
//   npx tsx scripts/smoke-insights.ts <APP_ID> [--drill]
//
// Reads: diagnostic signatures on the latest build, app perf/power metrics,
// accessibility declarations list. Small apps legitimately return empty/404
// on the first two — that IS the expected shape to verify.
//
// --drill: accessibility DRAFT create → flag patch → delete (DRAFTs are
// invisible until published; publish=true is NEVER touched).

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { digestAccessibilityDeclarations, digestDiagnosticSignatures } from '../src/digest.js';
import {
  buildAccessibilityDeclarationCreateBody,
  buildAccessibilityDeclarationPatchBody,
} from '../src/domains/accessibility-declarations.js';
import { paginate } from '../src/jsonapi.js';

type Client = ReturnType<typeof createASCClient>;

const ACCESSIBILITY_FIELDS =
  'deviceFamily,state,supportsAudioDescriptions,supportsCaptions,supportsDarkInterface,supportsDifferentiateWithoutColorAlone,supportsLargerText,supportsReducedMotion,supportsSufficientContrast,supportsVoiceControl,supportsVoiceover';

async function listDeclarations(client: Client, appId: string): Promise<void> {
  const params = new URLSearchParams();
  params.set('fields[accessibilityDeclarations]', ACCESSIBILITY_FIELDS);
  params.set('limit', '200');
  const pages = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/accessibilityDeclarations?${params.toString()}`,
    200,
  );
  console.log(digestAccessibilityDeclarations(pages));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const appId = args.find((a) => !a.startsWith('--'));
  if (!appId) {
    console.error('Usage: npx tsx scripts/smoke-insights.ts <APP_ID> [--drill]');
    process.exit(1);
  }
  const client = createASCClient(loadConfig());

  console.log('=== Latest build ===\n');
  const builds = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/builds?fields[builds]=version,processingState&limit=1`,
    1,
  );
  const build = builds.data[0];
  console.log(build ? `build ${build.attributes?.version} (${build.id})` : '(no builds)');

  if (build) {
    console.log('\n=== Diagnostic signatures (latest build) ===\n');
    try {
      const params = new URLSearchParams();
      params.set('fields[diagnosticSignatures]', 'diagnosticType,signature,weight,insight');
      params.set('limit', '200');
      const sigs = await paginate(
        client,
        `/v1/builds/${encodeURIComponent(build.id)}/diagnosticSignatures?${params.toString()}`,
        200,
      );
      console.log(digestDiagnosticSignatures(sigs));
    } catch (err) {
      console.log(`(${err instanceof Error ? err.message.split('\n')[0] : err})`);
    }

    console.log('\n=== Build perf/power metrics (LAUNCH) ===\n');
    try {
      const text = await client.requestText(
        `/v1/builds/${encodeURIComponent(build.id)}/perfPowerMetrics?filter%5BmetricType%5D=LAUNCH`,
        { headers: { accept: 'application/vnd.apple.xcode-metrics+json' } },
      );
      console.log(`${text.slice(0, 600)}${text.length > 600 ? '…' : ''}`);
    } catch (err) {
      console.log(`(${err instanceof Error ? err.message.split('\n')[0] : err})`);
    }
  }

  console.log('\n=== App perf/power metrics (LAUNCH) ===\n');
  try {
    const text = await client.requestText(
      `/v1/apps/${encodeURIComponent(appId)}/perfPowerMetrics?filter%5BmetricType%5D=LAUNCH`,
      { headers: { accept: 'application/vnd.apple.xcode-metrics+json' } },
    );
    console.log(`${text.slice(0, 600)}${text.length > 600 ? '…' : ''}`);
  } catch (err) {
    console.log(`(${err instanceof Error ? err.message.split('\n')[0] : err})`);
  }

  console.log('\n=== Accessibility declarations ===\n');
  await listDeclarations(client, appId);

  if (!args.includes('--drill')) return;

  console.log('\n=== DRILL: DRAFT create → flag patch → delete (publish NEVER touched) ===\n');
  const created = await client.request<{ data: { id: string } }>('/v1/accessibilityDeclarations', {
    method: 'POST',
    body: JSON.stringify(
      buildAccessibilityDeclarationCreateBody({
        appId,
        deviceFamily: 'IPHONE',
        flags: { supportsVoiceover: true, supportsLargerText: true },
      }),
    ),
  });
  const declId = created.data.id;
  console.log(`1. CREATE DRAFT ok — ${declId}`);
  try {
    await client.request(`/v1/accessibilityDeclarations/${declId}`, {
      method: 'PATCH',
      body: JSON.stringify(
        buildAccessibilityDeclarationPatchBody({
          declarationId: declId,
          flags: { supportsDarkInterface: true },
        }),
      ),
    });
    console.log('2. PATCH flags ok (publish not sent)');
    await listDeclarations(client, appId);
  } finally {
    await client.request(`/v1/accessibilityDeclarations/${declId}`, { method: 'DELETE' });
    console.log(`3. DELETE DRAFT ok — ${declId}`);
  }
  await listDeclarations(client, appId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
