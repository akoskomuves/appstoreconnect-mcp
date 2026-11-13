import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { paginate } from '../jsonapi.js';
import {
  buildProductVersionCreateBody,
  type ProductVersionKind,
  productVersionListPath,
  productVersionResource,
} from './product-versions.js';

// Product id → version id, for the tools that still take a product id.
//
// Apple is removing the product-scoped v1 endpoints for IAP / subscription /
// subscription-group localizations, images and standalone submissions
// ("beginning in early 2027", Apple developer email 2026-11). The v2
// replacements hang off a VERSION of the product, and submission goes through
// a reviewSubmission item that points at a version. The v1-era tools keep
// their product-id inputs; this module finds the version they should act on.
//
// The rule, by the LATEST version's state (highest `version` number):
//   - editable (PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW, REJECTED,
//     DEVELOPER_REJECTED) → use it.
//   - live (APPROVED, REPLACED_WITH_NEW_VERSION) → changes need a NEW
//     version. Created only when the caller passes createVersionIfNeeded,
//     because a new version is itself a write Apple then expects submitted.
//   - in flight (WAITING_FOR_REVIEW, IN_REVIEW, ACCEPTED) → refuse; Apple
//     locks the metadata until review finishes.
//
// Live-verified 2026-11-13: a localization keeps the SAME id in v1 and v2
// (checked on an IAP, a subscription and a subscription group), so tools that
// take a localization id just switch to the /v2 path.

export const EDITABLE_VERSION_STATES: ReadonlySet<string> = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'REJECTED',
  'DEVELOPER_REJECTED',
]);
const LIVE_VERSION_STATES: ReadonlySet<string> = new Set(['APPROVED', 'REPLACED_WITH_NEW_VERSION']);

export interface VersionRow {
  id: string;
  version: number | null;
  state: string | null;
}

/** Highest `version` number wins; rows without a number sort first. */
export function pickLatestVersion(rows: VersionRow[]): VersionRow | null {
  let best: VersionRow | null = null;
  for (const r of rows) {
    if (best === null || (r.version ?? -1) >= (best.version ?? -1)) best = r;
  }
  return best;
}

export type VersionDecision =
  | { action: 'use'; version: VersionRow }
  | { action: 'create'; latest: VersionRow | null }
  | { action: 'refuse'; reason: string };

const LABEL: Record<ProductVersionKind, string> = {
  iap: 'in-app purchase',
  subscription: 'subscription',
  subscriptionGroup: 'subscription group',
};
const VERSION_TOOL: Record<ProductVersionKind, string> = {
  iap: 'asc_post_iap_version',
  subscription: 'asc_post_subscription_version',
  subscriptionGroup: 'asc_post_subscription_group_version',
};

/** Which version a WRITE should target, given the product's latest version. */
export function decideWriteVersion(
  kind: ProductVersionKind,
  productId: string,
  latest: VersionRow | null,
  createVersionIfNeeded: boolean,
): VersionDecision {
  const label = LABEL[kind];
  if (latest === null) {
    return createVersionIfNeeded
      ? { action: 'create', latest: null }
      : {
          action: 'refuse',
          reason: `The ${label} ${productId} has no version yet. Pass createVersionIfNeeded: true, or create one with ${VERSION_TOOL[kind]}.`,
        };
  }
  const state = latest.state ?? '';
  if (EDITABLE_VERSION_STATES.has(state)) return { action: 'use', version: latest };
  if (LIVE_VERSION_STATES.has(state)) {
    return createVersionIfNeeded
      ? { action: 'create', latest }
      : {
          action: 'refuse',
          reason: `The ${label} ${productId}'s latest version (${latest.id}, version ${latest.version ?? '?'}) is ${state}, so its metadata is locked. Changes go on a new version: pass createVersionIfNeeded: true, or create one with ${VERSION_TOOL[kind]}. The new version then needs submitting for review.`,
        };
  }
  return {
    action: 'refuse',
    reason: `The ${label} ${productId}'s latest version (${latest.id}) is ${state || 'in an unknown state'}: it is going through App Review and can't be edited until review finishes.`,
  };
}

export class VersionResolutionError extends Error {}

// Shared tool inputs for the product-id tools that now write to a version.
export const VersionIdInput = z
  .string()
  .min(1)
  .optional()
  .describe('Act on this version instead of the latest one.');
export const CreateVersionIfNeededInput = z
  .boolean()
  .default(false)
  .describe(
    'When the latest version is already approved (locked), create a new version for this change. Off by default: a new version is a write of its own, and it then needs submitting for review.',
  );
export const WRITE_VERSION_NOTE =
  'Writes go to the latest version when it is still editable (PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW, REJECTED, DEVELOPER_REJECTED). If it is already approved the tool refuses unless createVersionIfNeeded: true, and it always refuses while a version is in review. Pass versionId to pick the version yourself.';

async function listVersions(
  client: ASCClient,
  kind: ProductVersionKind,
  productId: string,
): Promise<VersionRow[]> {
  const { type } = productVersionResource(kind);
  const params = new URLSearchParams();
  params.set(`fields[${type}]`, 'version,state');
  params.set('limit', '200');
  const pages = await paginate(
    client,
    `${productVersionListPath(kind, productId)}?${params}`,
    2000,
  );
  return pages.data.map((r) => {
    const v = r.attributes?.version;
    const s = r.attributes?.state;
    return {
      id: r.id,
      version: typeof v === 'number' ? v : null,
      state: typeof s === 'string' ? s : null,
    };
  });
}

/** The product's latest version id, for reads. Throws when it has none. */
export async function resolveVersionForRead(
  client: ASCClient,
  kind: ProductVersionKind,
  productId: string,
  versionId?: string | undefined,
): Promise<string> {
  if (versionId) return versionId;
  const latest = pickLatestVersion(await listVersions(client, kind, productId));
  if (!latest) {
    throw new VersionResolutionError(`The ${LABEL[kind]} ${productId} has no versions.`);
  }
  return latest.id;
}

export interface ResolvedWriteVersion {
  versionId: string;
  /** Human note for the tool response, e.g. that a new version was created. */
  note: string;
}

/** The version a write should land on; may create one (opt-in). Throws VersionResolutionError on refusal. */
export async function resolveVersionForWrite(
  client: ASCClient,
  kind: ProductVersionKind,
  productId: string,
  opts: { versionId?: string | undefined; createVersionIfNeeded?: boolean | undefined } = {},
): Promise<ResolvedWriteVersion> {
  if (opts.versionId) return { versionId: opts.versionId, note: '' };
  const latest = pickLatestVersion(await listVersions(client, kind, productId));
  const decision = decideWriteVersion(kind, productId, latest, opts.createVersionIfNeeded ?? false);
  if (decision.action === 'refuse') throw new VersionResolutionError(decision.reason);
  if (decision.action === 'use') {
    return {
      versionId: decision.version.id,
      note: `Using ${LABEL[kind]} version ${decision.version.version ?? '?'} (${decision.version.id}, ${decision.version.state}).`,
    };
  }
  const { path } = productVersionResource(kind);
  const created = await client.request<{
    data?: { id?: string; attributes?: { version?: number } };
  }>(path, {
    method: 'POST',
    body: JSON.stringify(buildProductVersionCreateBody(kind, productId)),
  });
  const id = created.data?.id;
  if (!id) throw new Error(`Creating a new ${LABEL[kind]} version returned no id.`);
  return {
    versionId: id,
    note: `Created a new ${LABEL[kind]} version ${created.data?.attributes?.version ?? ''} (${id}) because the latest one was ${decision.latest?.state ?? 'missing'}. Submit it for review when the edits are done.`,
  };
}

// ----- Version-lock gate for localization edits -----
//
// Apple refuses edits to copy that belongs to an approved version. Live
// 2026-09-13 on v1 it said "Cannot edit SubscriptionLocalization when it is in
// ACTIVE state" (409 ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE), with a state
// no public enum lists. In the version model the cause is visible: the
// localization's VERSION is APPROVED. So the pre-check reads the version's
// state (one GET with include=version) and refuses with the way forward:
// edit a new version's copy instead.

export interface VersionLockGate {
  allow: boolean;
  versionState: string | undefined;
  reason?: string;
}

export function evaluateVersionLockGate(
  kind: ProductVersionKind,
  versionState: string | undefined,
): VersionLockGate {
  if (!versionState || EDITABLE_VERSION_STATES.has(versionState)) {
    return { allow: true, versionState };
  }
  if (LIVE_VERSION_STATES.has(versionState)) {
    return {
      allow: false,
      versionState,
      reason: `this localization belongs to a ${LABEL[kind]} version that is ${versionState}, and Apple locks approved copy (409 UNMODIFIABLE). Create a new version (${VERSION_TOOL[kind]}, or createVersionIfNeeded: true on the localization create tool), edit the copy on that version, then submit it for review.`,
    };
  }
  return {
    allow: false,
    versionState,
    reason: `this localization belongs to a ${LABEL[kind]} version that is ${versionState}: it is in App Review, and Apple locks its copy until review finishes.`,
  };
}

/** The state of the version a v2 localization belongs to; undefined if it can't be read. */
export async function fetchLocalizationVersionState(
  client: ASCClient,
  kind: ProductVersionKind,
  localizationType: string,
  localizationId: string,
): Promise<string | undefined> {
  const { type } = productVersionResource(kind);
  try {
    const res = await client.request<{
      included?: Array<{ type?: string; attributes?: { state?: string } }>;
    }>(
      `/v2/${localizationType}/${encodeURIComponent(localizationId)}?include=version&fields[${localizationType}]=locale,version&fields[${type}]=state`,
    );
    return res.included?.find((r) => r.type === type)?.attributes?.state;
  } catch {
    // Non-fatal: a failed pre-check must never block an edit Apple would accept.
    return undefined;
  }
}

export function formatVersionLockRefusal(gate: VersionLockGate): string {
  return `Refused: ${gate.reason}\n\nIf you believe Apple would accept this edit, retry with force: true; the pre-check is skipped and Apple decides.`;
}
