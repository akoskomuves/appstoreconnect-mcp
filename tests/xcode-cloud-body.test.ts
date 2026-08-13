import { describe, expect, it } from 'vitest';
import { buildCiBuildRunCreateBody, buildCiWorkflowPatchBody } from '../src/domains/xcode-cloud.js';

// Wire-shape pins for the two Xcode Cloud writes.
// Load-bearing rules:
//   1. Xcode Cloud is the one domain family with NO is-prefix strip:
//      `isEnabled` is the literal wire key on the workflow PATCH. Stripping it
//      to `enabled` (the reflex from every other domain) silently no-ops.
//   2. Build-run create is relationships-first: workflow always, an optional
//      sourceBranchOrTag pointing at scmGitReferences (a reference ID, not a
//      branch name), and NO attributes block unless `clean` was passed.
//   3. Workflow PATCH carries the resource id in the body (Apple 409s
//      without it).

type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
};

const rel = (body: Body, key: string) =>
  (body.data.relationships as Record<string, { data: unknown }>)[key]?.data;

describe('buildCiBuildRunCreateBody', () => {
  it('minimal start: workflow relationship only, no attributes block', () => {
    const body = buildCiBuildRunCreateBody({ workflowId: 'WF-1' }) as Body;
    expect(body.data.type).toBe('ciBuildRuns');
    expect(rel(body, 'workflow')).toEqual({ type: 'ciWorkflows', id: 'WF-1' });
    expect('attributes' in body.data).toBe(false);
    expect('sourceBranchOrTag' in (body.data.relationships ?? {})).toBe(false);
  });

  it('branch/tag override rides as an scmGitReferences relationship', () => {
    const body = buildCiBuildRunCreateBody({
      workflowId: 'WF-1',
      gitReferenceId: 'REF-1',
    }) as Body;
    expect(rel(body, 'sourceBranchOrTag')).toEqual({ type: 'scmGitReferences', id: 'REF-1' });
  });

  it('clean rides in attributes when passed', () => {
    const body = buildCiBuildRunCreateBody({ workflowId: 'WF-1', clean: true }) as Body;
    expect(body.data.attributes).toEqual({ clean: true });
  });
});

describe('buildCiWorkflowPatchBody', () => {
  it('carries the resource id and the literal isEnabled wire key', () => {
    const body = buildCiWorkflowPatchBody({ workflowId: 'WF-1', isEnabled: false }) as Body;
    expect(body.data.type).toBe('ciWorkflows');
    expect(body.data.id).toBe('WF-1');
    expect(body.data.attributes).toEqual({ isEnabled: false });
    expect('enabled' in (body.data.attributes ?? {})).toBe(false);
  });

  it('emits only supplied attributes', () => {
    const body = buildCiWorkflowPatchBody({
      workflowId: 'WF-1',
      name: 'Nightly',
      clean: true,
    }) as Body;
    expect(body.data.attributes).toEqual({ name: 'Nightly', clean: true });
  });
});
