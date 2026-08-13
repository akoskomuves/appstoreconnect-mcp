import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import {
  digestBuilds,
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
} from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  CiArtifactIdSchema,
  CiBuildActionIdSchema,
  CiBuildRunIdSchema,
  CiProductIdSchema,
  CiWorkflowIdSchema,
  ScmGitReferenceIdSchema,
  ScmProviderIdSchema,
  ScmRepositoryIdSchema,
} from '../schemas.js';

// Xcode Cloud (CI/CD) + the SCM read surface it hangs off.
//
// Hierarchy: ciProducts (one per app/framework onboarded to Xcode Cloud)
//   → workflows → buildRuns → buildActions (build/test/archive/analyze steps)
//     → issues / testResults / artifacts.
// A finished run also links the TestFlight `builds` it produced — which is
// where this domain meets the v0.9 TestFlight surface.
//
// WIRE-KEY NOTE (inverts the usual expectation): Xcode Cloud resources keep
// their is-prefixes ON the wire — `isEnabled`, `isLockedForEditing`,
// `isPullRequestBuild`, `isRequiredToPass`, `isDeleted`, `isClosed` are the
// literal wire keys (confirmed in Apple's OpenAPI spec). Do NOT strip them the
// way every other domain does (`isUploaded`→`uploaded` etc.).
//
// Writes are deliberately few: start a build run (POST /v1/ciBuildRuns with a
// workflow relationship + optional branch/tag) and PATCH a workflow's simple
// attributes (isEnabled / clean / name / description). The deep start-condition
// and actions[] structures stay Xcode-owned — editing them blind from an LLM
// tool is how CI configs die.
//
// Artifact downloadUrls are pre-signed and time-limited; fetch them WITHOUT
// the ASC bearer token (same pattern as v0.18 analytics segment URLs).

const CI_PRODUCT_FIELDS = 'name,createdDate,productType';
const CI_WORKFLOW_FIELDS = 'name,isEnabled,isLockedForEditing,clean,lastModifiedDate';
const CI_BUILD_RUN_FIELDS =
  'number,createdDate,startedDate,finishedDate,isPullRequestBuild,issueCounts,executionProgress,completionStatus,startReason';
const CI_BUILD_ACTION_FIELDS =
  'name,actionType,startedDate,finishedDate,issueCounts,executionProgress,completionStatus,isRequiredToPass';
const CI_ISSUE_FIELDS = 'issueType,message,fileSource,category';
const CI_TEST_RESULT_FIELDS = 'className,name,status,message,fileSource';
const CI_ARTIFACT_FIELDS = 'fileType,fileName,fileSize,downloadUrl';
const SCM_REPOSITORY_FIELDS = 'ownerName,repositoryName,httpCloneUrl,sshCloneUrl,lastAccessedDate';
const SCM_GIT_REFERENCE_FIELDS = 'name,canonicalName,isDeleted,kind';
const SCM_PULL_REQUEST_FIELDS =
  'title,number,webUrl,sourceBranchName,destinationBranchName,isClosed';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface CiBuildRunCreateInput {
  workflowId: string;
  gitReferenceId?: string | undefined;
  clean?: boolean | undefined;
}

export function buildCiBuildRunCreateBody(input: CiBuildRunCreateInput): JSONAPIBody {
  const data: JSONAPIBody['data'] = {
    type: 'ciBuildRuns',
    relationships: {
      workflow: { data: { type: 'ciWorkflows', id: input.workflowId } },
    },
  };
  if (input.gitReferenceId !== undefined) {
    (data.relationships as Record<string, unknown>).sourceBranchOrTag = {
      data: { type: 'scmGitReferences', id: input.gitReferenceId },
    };
  }
  if (input.clean !== undefined) {
    data.attributes = { clean: input.clean };
  }
  return { data };
}

export interface CiWorkflowPatchInput {
  workflowId: string;
  isEnabled?: boolean | undefined;
  clean?: boolean | undefined;
  name?: string | undefined;
  description?: string | undefined;
}

export function buildCiWorkflowPatchBody(input: CiWorkflowPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  // `isEnabled` keeps its is-prefix on the wire — Xcode Cloud is the one
  // domain family with NO is-strip (see header note).
  if (input.isEnabled !== undefined) attributes.isEnabled = input.isEnabled;
  if (input.clean !== undefined) attributes.clean = input.clean;
  if (input.name !== undefined) attributes.name = input.name;
  if (input.description !== undefined) attributes.description = input.description;
  return {
    data: {
      type: 'ciWorkflows',
      // Apple requires the id in the body as well as the URL (409 otherwise).
      id: input.workflowId,
      attributes,
    },
  };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const maxItemsSchema = z.number().int().positive().max(2000).default(500);

export function registerXcodeCloud(server: McpServer, client: ASCClient): void {
  // ----- CI reads -----

  server.registerTool(
    'asc_list_ci_products',
    {
      title: 'List Xcode Cloud products',
      description:
        'List Xcode Cloud products — one per app/framework onboarded to Xcode Cloud. The product id is the root of the CI hierarchy (workflows hang off it).',
      inputSchema: z.object({
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[ciProducts]', CI_PRODUCT_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(client, `/v1/ciProducts?${params.toString()}`, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestCiProducts(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_ci_workflows',
    {
      title: 'List Xcode Cloud workflows of a product',
      description:
        "List a product's workflows with their isEnabled / isLockedForEditing / clean flags. Use asc_get_ci_workflow for the full start-condition + actions configuration.",
      inputSchema: z.object({
        productId: CiProductIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ productId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[ciWorkflows]', CI_WORKFLOW_FIELDS);
      params.set('limit', '200');
      const path = `/v1/ciProducts/${encodeURIComponent(productId)}/workflows?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestCiWorkflows(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_ci_workflow',
    {
      title: 'Get an Xcode Cloud workflow (full configuration)',
      description:
        'Fetch a workflow with its complete configuration: start conditions (branch/tag/PR/scheduled/manual), actions[] (build/test/archive/analyze steps with platform + destination), container file path, Xcode + macOS version relationships. Raw JSON — the config is deeply nested.',
      inputSchema: z.object({
        workflowId: CiWorkflowIdSchema,
      }),
    },
    async ({ workflowId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/ciWorkflows/${encodeURIComponent(workflowId)}?include=repository,xcodeVersion,macOsVersion`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_ci_build_runs',
    {
      title: 'List Xcode Cloud build runs',
      description:
        'List build runs of a workflow (workflowId) or across a whole product (productId) — pass exactly one. Newest runs carry executionProgress until they finish, then completionStatus. The ISSUES column is errors/warnings/testFailures/analyzerWarnings.',
      inputSchema: z.object({
        workflowId: CiWorkflowIdSchema.optional(),
        productId: CiProductIdSchema.optional(),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ workflowId, productId, maxItems, raw }) => {
      if ((workflowId === undefined) === (productId === undefined)) {
        return {
          content: [{ type: 'text', text: 'Pass exactly one of workflowId, productId.' }],
          isError: true,
        };
      }
      const params = new URLSearchParams();
      params.set('fields[ciBuildRuns]', CI_BUILD_RUN_FIELDS);
      params.set('limit', '200');
      const base = workflowId
        ? `/v1/ciWorkflows/${encodeURIComponent(workflowId)}/buildRuns`
        : `/v1/ciProducts/${encodeURIComponent(productId as string)}/buildRuns`;
      try {
        const pages = await paginate(client, `${base}?${params.toString()}`, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestCiBuildRuns(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_ci_build_run',
    {
      title: 'Get an Xcode Cloud build run',
      description:
        'Fetch one build run with source/destination commit details, issue counts, progress/completion status and start/cancel reasons. Raw JSON (the commit structs are nested).',
      inputSchema: z.object({
        buildRunId: CiBuildRunIdSchema,
      }),
    },
    async ({ buildRunId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/ciBuildRuns/${encodeURIComponent(buildRunId)}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_ci_build_actions',
    {
      title: 'List the actions of a build run',
      description:
        'List the build actions (build / test / archive / analyze steps) of a run, with per-action status and issue counts. Action ids feed asc_list_ci_issues / asc_list_ci_test_results / asc_list_ci_artifacts.',
      inputSchema: z.object({
        buildRunId: CiBuildRunIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildRunId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[ciBuildActions]', CI_BUILD_ACTION_FIELDS);
      params.set('limit', '200');
      const path = `/v1/ciBuildRuns/${encodeURIComponent(buildRunId)}/actions?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestCiBuildActions(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_ci_issues',
    {
      title: 'List the issues of a build action',
      description:
        'List the compiler/analyzer/test issues an action produced (type, category, file:line, message). The digest truncates messages at 120 chars — raw:true for full text.',
      inputSchema: z.object({
        buildActionId: CiBuildActionIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildActionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[ciIssues]', CI_ISSUE_FIELDS);
      params.set('limit', '200');
      const path = `/v1/ciBuildActions/${encodeURIComponent(buildActionId)}/issues?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestCiIssues(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_ci_test_results',
    {
      title: 'List the test results of a build action',
      description:
        'List per-test results of a TEST action (class, test name, status, failure message). Per-device destination details are in raw:true.',
      inputSchema: z.object({
        buildActionId: CiBuildActionIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildActionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[ciTestResults]', CI_TEST_RESULT_FIELDS);
      params.set('limit', '200');
      const path = `/v1/ciBuildActions/${encodeURIComponent(buildActionId)}/testResults?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestCiTestResults(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_ci_artifacts',
    {
      title: 'List the artifacts of a build action',
      description:
        'List the artifacts an action produced (archive, logs, result bundles, symbols). Fetch a single artifact with asc_get_ci_artifact to get its pre-signed downloadUrl.',
      inputSchema: z.object({
        buildActionId: CiBuildActionIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildActionId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[ciArtifacts]', CI_ARTIFACT_FIELDS);
      params.set('limit', '200');
      const path = `/v1/ciBuildActions/${encodeURIComponent(buildActionId)}/artifacts?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestCiArtifacts(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_ci_artifact',
    {
      title: 'Get an Xcode Cloud artifact (with download URL)',
      description:
        'Fetch one artifact including its downloadUrl. The URL is pre-signed and TIME-LIMITED — download promptly, and fetch it WITHOUT the ASC bearer token (same pattern as analytics report segments).',
      inputSchema: z.object({
        artifactId: CiArtifactIdSchema,
      }),
    },
    async ({ artifactId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/ciArtifacts/${encodeURIComponent(artifactId)}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_ci_build_run_builds',
    {
      title: 'List the TestFlight builds a run produced',
      description:
        'List the TestFlight builds created by an Xcode Cloud run — the handoff point from CI to the v0.9 TestFlight surface (beta groups, testers, submit).',
      inputSchema: z.object({
        buildRunId: CiBuildRunIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ buildRunId, maxItems, raw }) => {
      const path = `/v1/ciBuildRuns/${encodeURIComponent(buildRunId)}/builds?limit=200`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBuilds(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_ci_environment_versions',
    {
      title: 'List Xcode Cloud environment versions (Xcode + macOS)',
      description:
        "The Xcode and macOS versions Xcode Cloud currently offers — what a workflow's xcodeVersion / macOsVersion relationships can point at. Raw JSON (testDestinations nested under each Xcode version).",
      inputSchema: z.object({
        catalog: z
          .enum(['xcode', 'macos'])
          .describe('Which catalog: "xcode" (includes test destinations) or "macos".'),
        maxItems: maxItemsSchema,
      }),
    },
    async ({ catalog, maxItems }) => {
      const path =
        catalog === 'xcode' ? '/v1/ciXcodeVersions?limit=200' : '/v1/ciMacOsVersions?limit=200';
      try {
        const pages = await paginate(client, path, maxItems);
        return { content: [{ type: 'text', text: JSON.stringify(pages.data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- SCM reads -----

  server.registerTool(
    'asc_list_scm_providers',
    {
      title: 'List source-control providers',
      description:
        'List the SCM connections of the team (GitHub / GitHub Enterprise / GitLab / Bitbucket), with provider type + endpoint URL. Provider ids feed asc_list_scm_repositories.',
      inputSchema: z.object({
        maxItems: maxItemsSchema,
      }),
    },
    async ({ maxItems }) => {
      try {
        const pages = await paginate(client, '/v1/scmProviders?limit=200', maxItems);
        return { content: [{ type: 'text', text: JSON.stringify(pages.data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_scm_repositories',
    {
      title: 'List source-control repositories',
      description:
        'List the repositories Xcode Cloud can see — all of them, or those of one provider (providerId). Repo ids feed the git-reference and pull-request listings.',
      inputSchema: z.object({
        providerId: ScmProviderIdSchema.optional(),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ providerId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[scmRepositories]', SCM_REPOSITORY_FIELDS);
      params.set('limit', '200');
      const base = providerId
        ? `/v1/scmProviders/${encodeURIComponent(providerId)}/repositories`
        : '/v1/scmRepositories';
      try {
        const pages = await paginate(client, `${base}?${params.toString()}`, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestScmRepositories(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_scm_git_references',
    {
      title: 'List the git references of a repository',
      description:
        'List the branches + tags of a repository as Apple tracks them. The reference id (NOT the bare branch name) is what asc_post_ci_build_run takes as sourceBranchOrTag.',
      inputSchema: z.object({
        repositoryId: ScmRepositoryIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ repositoryId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[scmGitReferences]', SCM_GIT_REFERENCE_FIELDS);
      params.set('limit', '200');
      const path = `/v1/scmRepositories/${encodeURIComponent(repositoryId)}/gitReferences?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestScmGitReferences(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_list_scm_pull_requests',
    {
      title: 'List the pull requests of a repository',
      description:
        'List the pull requests of a repository as Apple tracks them — number, title, source→destination branches, open/closed.',
      inputSchema: z.object({
        repositoryId: ScmRepositoryIdSchema,
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ repositoryId, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[scmPullRequests]', SCM_PULL_REQUEST_FIELDS);
      params.set('limit', '200');
      const path = `/v1/scmRepositories/${encodeURIComponent(repositoryId)}/pullRequests?${params.toString()}`;
      try {
        const pages = await paginate(client, path, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestScmPullRequests(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- CI triggers -----

  server.registerTool(
    'asc_post_ci_build_run',
    {
      title: 'Start an Xcode Cloud build',
      description:
        "Start a build run of a workflow. Defaults to the workflow's configured branch; pass gitReferenceId (from asc_list_scm_git_references — the reference id, not a bare branch name) to build a specific branch/tag, and clean:true to skip the derived-data cache. Uses compute hours from the team's Xcode Cloud allowance.",
      inputSchema: z.object({
        workflowId: CiWorkflowIdSchema,
        gitReferenceId: ScmGitReferenceIdSchema.optional(),
        clean: z
          .boolean()
          .optional()
          .describe('true = clean build (no derived-data cache). Omit for the default.'),
      }),
    },
    async ({ workflowId, gitReferenceId, clean }) => {
      const body = buildCiBuildRunCreateBody({ workflowId, gitReferenceId, clean });
      try {
        const data = await client.request<{
          data?: { id?: string; attributes?: { number?: number } };
        }>('/v1/ciBuildRuns', { method: 'POST', body: JSON.stringify(body) });
        const id = data?.data?.id;
        const num = data?.data?.attributes?.number;
        return {
          content: [
            {
              type: 'text',
              text: `Started build run${num ? ` #${num}` : ''} on workflow ${workflowId}${id ? ` (run id ${id})` : ''}. Watch it with asc_list_ci_build_runs / asc_get_ci_build_run.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_ci_workflow',
    {
      title: 'Update an Xcode Cloud workflow (simple attributes)',
      description:
        'PATCH a workflow: isEnabled (pause/resume it — the main use), clean, name, description. Deliberately does NOT expose the start-condition / actions[] structures — edit those in Xcode where they are validated. Pass at least one attribute. Wire note: the attribute really is `isEnabled` — Xcode Cloud keeps is-prefixes on the wire.',
      inputSchema: z.object({
        workflowId: CiWorkflowIdSchema,
        isEnabled: z
          .boolean()
          .optional()
          .describe('false pauses the workflow (no new runs start).'),
        clean: z.boolean().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
      }),
    },
    async ({ workflowId, isEnabled, clean, name, description }) => {
      if (
        isEnabled === undefined &&
        clean === undefined &&
        name === undefined &&
        description === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Refused: pass at least one of isEnabled, clean, name, description.',
            },
          ],
          isError: true,
        };
      }
      const body = buildCiWorkflowPatchBody({ workflowId, isEnabled, clean, name, description });
      try {
        const data = await client.request<unknown>(
          `/v1/ciWorkflows/${encodeURIComponent(workflowId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Patched workflow ${workflowId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
