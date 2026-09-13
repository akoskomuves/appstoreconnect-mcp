import { describe, expect, it } from 'vitest';
import { digestCiWorkflow } from '../src/digest.js';
import type { JSONAPIResource } from '../src/jsonapi.js';

// Shape pinned against Apple's official OpenAPI spec (CiWorkflow,
// CiBranchStartCondition -> CiBranchPatterns -> {pattern, isPrefix},
// CiAction, CiXcodeVersion). The digest exists because the raw document with
// `include=xcodeVersion` runs to ~90k characters — Apple attaches every test
// destination × runtime — which is enough to blow a tool-result token cap.

const workflow: JSONAPIResource = {
  type: 'ciWorkflows',
  id: 'wf-1',
  attributes: {
    name: 'Release',
    description: 'Archive + upload to TestFlight',
    isEnabled: true,
    isLockedForEditing: false,
    clean: true,
    containerFilePath: 'MyApp.xcodeproj',
    lastModifiedDate: '2026-08-13T09:12:44-07:00',
    branchStartCondition: {
      source: { patterns: [{ pattern: 'main' }, { pattern: 'release/', isPrefix: true }] },
      autoCancel: true,
      filesAndFoldersRule: { mode: 'START_IF_ANY_FILE_MATCHES', matchers: [{}, {}] },
    },
    pullRequestStartCondition: {
      source: { isAllMatch: true },
      destination: { patterns: [{ pattern: 'main' }] },
    },
    actions: [
      {
        name: 'Archive',
        actionType: 'ARCHIVE',
        platform: 'IOS',
        scheme: 'MyApp',
        destination: 'ANY_IOS_DEVICE',
        isRequiredToPass: true,
      },
      { name: 'Test', actionType: 'TEST', platform: 'IOS', scheme: 'MyAppTests' },
    ],
  },
  relationships: {
    xcodeVersion: { data: { type: 'ciXcodeVersions', id: 'xc-1' } },
    macOsVersion: { data: { type: 'ciMacOsVersions', id: 'mac-1' } },
    repository: { data: { type: 'scmRepositories', id: 'repo-1' } },
  },
};

const included: JSONAPIResource[] = [
  {
    type: 'ciXcodeVersions',
    id: 'xc-1',
    attributes: { name: 'Latest Beta or Release', version: '27A266a' },
  },
  { type: 'ciMacOsVersions', id: 'mac-1', attributes: { name: 'Latest Release', version: '15.5' } },
  {
    type: 'scmRepositories',
    id: 'repo-1',
    attributes: { ownerName: 'octocat', repositoryName: 'myapp' },
  },
];

describe('digestCiWorkflow', () => {
  const out = digestCiWorkflow({ data: workflow, included });

  it('leads with the workflow name and id', () => {
    expect(out.startsWith('Workflow "Release" (wf-1)')).toBe(true);
  });

  it('renders the enabled / locked / clean flags', () => {
    expect(out).toContain('enabled');
    expect(out).toMatch(/enabled\s+true/);
    expect(out).toMatch(/lockedForEditing\s+false/);
  });

  it('resolves the Xcode version from included[], pairing the selection rule with the build it resolved to', () => {
    // The whole reason to include[] the version: "which Xcode will this
    // actually use" is unanswerable from the workflow attributes alone.
    expect(out).toContain('Latest Beta or Release (27A266a)');
  });

  it('resolves the macOS version and repository from included[]', () => {
    expect(out).toContain('Latest Release (15.5)');
    expect(out).toContain('octocat/myapp');
  });

  it('renders branch start-condition patterns, marking prefix matches with *', () => {
    expect(out).toContain('main, release/*');
  });

  it('renders isAllMatch as "any" rather than an empty pattern list', () => {
    expect(out).toContain('any');
  });

  it('renders the pull-request destination patterns', () => {
    expect(out).toContain('-> main');
  });

  it('surfaces autoCancel and the files-and-folders rule', () => {
    expect(out).toContain('auto-cancel');
    expect(out).toContain('START_IF_ANY_FILE_MATCHES (2 matchers)');
  });

  it('lists actions with type, platform, scheme and destination', () => {
    expect(out).toContain('Actions (2):');
    expect(out).toMatch(/Archive\s+ARCHIVE\s+IOS\s+MyApp\s+ANY_IOS_DEVICE/);
    expect(out).toContain('TEST');
  });

  it('omits start conditions Apple did not return rather than rendering them empty', () => {
    // Only branch + pullRequest are configured above; the other five structs
    // are absent from the payload, not present-and-empty.
    expect(out).toContain('Start conditions (2):');
    expect(out).not.toContain('manual:tag');
    expect(out).not.toContain('scheduled');
  });

  it('stays small — that is the entire point of the summary mode', () => {
    expect(out.length).toBeLessThan(2000);
  });

  it('handles a workflow with no actions and no start conditions', () => {
    const bare = digestCiWorkflow({
      data: { type: 'ciWorkflows', id: 'wf-2', attributes: { name: 'Bare' } },
      included: [],
    });
    expect(bare).toContain('(none configured — manual start only)');
    expect(bare).toContain('Actions: (none)');
  });

  it('does not throw when Apple returns no data', () => {
    expect(digestCiWorkflow({})).toBe('No workflow returned.');
  });
});
