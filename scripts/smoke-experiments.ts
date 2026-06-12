#!/usr/bin/env tsx
// Live smoke for the v0.20 Version Experiments V2 surface.
//
// Usage:
//   npx tsx scripts/smoke-experiments.ts <APP_ID>            # read-only list
//   npx tsx scripts/smoke-experiments.ts <APP_ID> --drill    # full chain drill
//
// The drill creates an experiment in PREPARE_FOR_SUBMISSION — publicly
// INVISIBLE (nothing shows until submitted via review AND started) — adds a
// treatment + localization, walks the lists, then deletes everything in a
// finally block. It NEVER touches started=true (customer-facing) and never
// submits for review.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestExperimentTreatments,
  digestTreatmentLocalizations,
  digestVersionExperiments,
} from '../src/digest.js';
import {
  buildExperimentCreateBody,
  buildExperimentPatchBody,
  buildTreatmentCreateBody,
  buildTreatmentLocalizationCreateBody,
} from '../src/domains/version-experiments.js';
import { paginate } from '../src/jsonapi.js';

type Client = ReturnType<typeof createASCClient>;

const EXPERIMENT_FIELDS =
  'name,platform,trafficProportion,state,reviewRequired,startDate,endDate,appStoreVersionExperimentTreatments';

async function listExperiments(client: Client, appId: string): Promise<void> {
  console.log(`=== Experiments on app ${appId} ===\n`);
  const params = new URLSearchParams();
  params.set('fields[appStoreVersionExperiments]', EXPERIMENT_FIELDS);
  params.set('limit', '200');
  const pages = await paginate(
    client,
    `/v1/apps/${encodeURIComponent(appId)}/appStoreVersionExperimentsV2?${params.toString()}`,
    200,
  );
  console.log(digestVersionExperiments(pages));
}

async function drill(client: Client, appId: string): Promise<void> {
  console.log('\n=== DRILL: create → patch → treatment → localization → lists → DELETE ===\n');
  const created = await client.request<{ data: { id: string } }>('/v2/appStoreVersionExperiments', {
    method: 'POST',
    body: JSON.stringify(
      buildExperimentCreateBody({
        appId,
        name: 'v020-smoke-DELETE-ME',
        platform: 'IOS',
        trafficProportion: 10,
      }),
    ),
  });
  const experimentId = created.data.id;
  console.log(`1. CREATE experiment ok — ${experimentId}`);

  try {
    const got = await client.request<{ data: { attributes?: Record<string, unknown> } }>(
      `/v2/appStoreVersionExperiments/${experimentId}?include=appStoreVersionExperimentTreatments,latestControlVersion`,
      { method: 'GET' },
    );
    console.log(
      `2. GET ok — state=${String(got.data.attributes?.state)} traffic=${String(got.data.attributes?.trafficProportion)}%`,
    );

    await client.request(`/v2/appStoreVersionExperiments/${experimentId}`, {
      method: 'PATCH',
      body: JSON.stringify(
        buildExperimentPatchBody({ experimentId, name: 'v020-smoke-renamed-DELETE-ME' }),
      ),
    });
    console.log('3. PATCH (rename only — started NOT touched) ok');

    const treatment = await client.request<{ data: { id: string } }>(
      '/v1/appStoreVersionExperimentTreatments',
      {
        method: 'POST',
        body: JSON.stringify(
          buildTreatmentCreateBody({ experimentId, name: 'v020-smoke-variant' }),
        ),
      },
    );
    const treatmentId = treatment.data.id;
    console.log(`4. CREATE treatment ok — ${treatmentId}`);

    const loc = await client.request<{ data: { id: string } }>(
      '/v1/appStoreVersionExperimentTreatmentLocalizations',
      {
        method: 'POST',
        body: JSON.stringify(
          buildTreatmentLocalizationCreateBody({ treatmentId, locale: 'en-US' }),
        ),
      },
    );
    console.log(`5. CREATE treatment localization ok — ${loc.data.id}`);

    const tParams = new URLSearchParams();
    tParams.set(
      'fields[appStoreVersionExperimentTreatments]',
      'name,appIcon,appIconName,promotedDate',
    );
    tParams.set('limit', '200');
    const treatments = await paginate(
      client,
      `/v2/appStoreVersionExperiments/${experimentId}/appStoreVersionExperimentTreatments?${tParams.toString()}`,
      200,
    );
    console.log(`6. LIST treatments ok:\n\n${digestExperimentTreatments(treatments)}`);

    const lParams = new URLSearchParams();
    lParams.set(
      'fields[appStoreVersionExperimentTreatmentLocalizations]',
      'locale,appScreenshotSets,appPreviewSets',
    );
    lParams.set('limit', '200');
    const locs = await paginate(
      client,
      `/v1/appStoreVersionExperimentTreatments/${treatmentId}/appStoreVersionExperimentTreatmentLocalizations?${lParams.toString()}`,
      200,
    );
    console.log(`\n7. LIST localizations ok:\n\n${digestTreatmentLocalizations(locs)}`);
  } finally {
    await client.request(`/v2/appStoreVersionExperiments/${experimentId}`, { method: 'DELETE' });
    console.log(`\n8. DELETE experiment ok — ${experimentId} (treatments cascade)`);
  }

  await listExperiments(client, appId);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const appId = args.find((a) => !a.startsWith('--'));
  if (!appId) {
    console.error('Usage: npx tsx scripts/smoke-experiments.ts <APP_ID> [--drill]');
    process.exit(1);
  }
  const client = createASCClient(loadConfig());
  await listExperiments(client, appId);
  if (args.includes('--drill')) await drill(client, appId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
