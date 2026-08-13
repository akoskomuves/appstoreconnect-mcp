#!/usr/bin/env tsx
// Live smoke test for the v1.6.0 Xcode Cloud + SCM reads. Read-only: the two
// triggers (start build run, workflow PATCH) are NOT exercised — starting a
// run consumes real compute hours and a PATCH touches live CI config.
//
// Usage:
//   ASC_ISSUER_ID=… ASC_KEY_ID=… ASC_PRIVATE_KEY_PATH=… \
//     npx tsx scripts/smoke-xcode-cloud.ts
//
// Drill: products → workflows → build runs → actions of the newest run →
// issues / test results / artifacts of its first action → the run's TestFlight
// builds → SCM providers → repositories → git refs + PRs of the first repo.
// Every digest + fields[] selector in the domain gets exercised on real data.

import { createASCClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  digestCiArtifacts,
  digestCiBuildActions,
  digestCiBuildRuns,
  digestCiIssues,
  digestCiProducts,
  digestCiTestResults,
  digestCiWorkflows,
  digestScmGitReferences,
  digestScmPullRequests,
  digestScmRepositories,
} from '../src/digest.js';
import { paginate } from '../src/jsonapi.js';

const client = createASCClient(loadConfig());

function section(label: string, body: string): void {
  console.log(`\n=== ${label} ===\n${body}`);
}

async function main(): Promise<void> {
  const products = await paginate(
    client,
    '/v1/ciProducts?fields[ciProducts]=name,createdDate,productType&limit=200',
    200,
  );
  section('ciProducts', digestCiProducts(products));
  const product = products.data[0];
  if (!product) {
    console.log('\nNo Xcode Cloud products on this team — deeper drill not possible.');
    return;
  }

  const workflows = await paginate(
    client,
    `/v1/ciProducts/${product.id}/workflows?fields[ciWorkflows]=name,isEnabled,isLockedForEditing,clean,lastModifiedDate&limit=200`,
    200,
  );
  section(`workflows of ${product.attributes?.name}`, digestCiWorkflows(workflows));

  const runs = await paginate(
    client,
    `/v1/ciProducts/${product.id}/buildRuns?fields[ciBuildRuns]=number,createdDate,startedDate,finishedDate,isPullRequestBuild,issueCounts,executionProgress,completionStatus,startReason&limit=25`,
    25,
  );
  section('buildRuns (product-wide)', digestCiBuildRuns(runs));
  const run = runs.data[0];
  if (run) {
    const actions = await paginate(
      client,
      `/v1/ciBuildRuns/${run.id}/actions?fields[ciBuildActions]=name,actionType,startedDate,finishedDate,issueCounts,executionProgress,completionStatus,isRequiredToPass&limit=200`,
      200,
    );
    section(`actions of run #${run.attributes?.number}`, digestCiBuildActions(actions));
    const action = actions.data[0];
    if (action) {
      const issues = await paginate(
        client,
        `/v1/ciBuildActions/${action.id}/issues?fields[ciIssues]=issueType,message,fileSource,category&limit=200`,
        200,
      );
      section('issues of first action', digestCiIssues(issues));
      const tests = await paginate(
        client,
        `/v1/ciBuildActions/${action.id}/testResults?fields[ciTestResults]=className,name,status,message,fileSource&limit=200`,
        200,
      );
      section('testResults of first action', digestCiTestResults(tests));
      const artifacts = await paginate(
        client,
        `/v1/ciBuildActions/${action.id}/artifacts?fields[ciArtifacts]=fileType,fileName,fileSize,downloadUrl&limit=200`,
        200,
      );
      section('artifacts of first action', digestCiArtifacts(artifacts));
    }
    const builds = await paginate(client, `/v1/ciBuildRuns/${run.id}/builds?limit=200`, 200);
    section('TestFlight builds of the run', `${builds.data.length} build(s)`);
  }

  const providers = await paginate(client, '/v1/scmProviders?limit=200', 200);
  section(
    'scmProviders',
    providers.data
      .map((p) => {
        // scmProviderType is a STRUCT {kind, displayName, isOnPremise}, not a string.
        const t = p.attributes?.scmProviderType as { displayName?: string } | undefined;
        return `${t?.displayName ?? '?'} ${p.attributes?.url ?? ''} (${p.id})`;
      })
      .join('\n') || '(none)',
  );

  const repos = await paginate(
    client,
    '/v1/scmRepositories?fields[scmRepositories]=ownerName,repositoryName,httpCloneUrl,sshCloneUrl,lastAccessedDate&limit=200',
    200,
  );
  section('scmRepositories', digestScmRepositories(repos));
  const repo = repos.data[0];
  if (repo) {
    const refs = await paginate(
      client,
      `/v1/scmRepositories/${repo.id}/gitReferences?fields[scmGitReferences]=name,canonicalName,isDeleted,kind&limit=50`,
      50,
    );
    section(`gitReferences of ${repo.attributes?.repositoryName}`, digestScmGitReferences(refs));
    const prs = await paginate(
      client,
      `/v1/scmRepositories/${repo.id}/pullRequests?fields[scmPullRequests]=title,number,webUrl,sourceBranchName,destinationBranchName,isClosed&limit=50`,
      50,
    );
    section('pullRequests', digestScmPullRequests(prs));
  }

  console.log('\nSmoke complete.');
}

main().catch((err) => {
  console.error('\nSMOKE FAILURE:', err instanceof Error ? err.message : err);
  if (err && typeof err === 'object' && 'details' in err) {
    console.error(JSON.stringify((err as { details: unknown }).details, null, 2));
  }
  process.exit(1);
});
