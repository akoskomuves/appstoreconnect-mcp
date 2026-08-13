import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { digestBundleIds, digestCertificates, digestDevices, digestProfiles } from '../digest.js';
import { ASCError } from '../errors.js';
import { paginate } from '../jsonapi.js';
import {
  BundleIdCapabilityIdSchema,
  BundleIdPlatformSchema,
  CertificateIdSchema,
  CertificateTypeSchema,
  DeviceIdSchema,
  ProfileIdSchema,
  ProfileTypeSchema,
  ProvisioningBundleIdRecordSchema,
} from '../schemas.js';

// Provisioning & code signing — the Developer-portal surface (fastlane
// match/sigh/cert territory): bundle IDs + capabilities, signing
// certificates, provisioning profiles, registered devices.
//
// ROLE GATE: these endpoints need an API key with the Admin (or Account
// Holder) role — an App Manager / Developer key gets 403 FORBIDDEN on most of
// them. The 403 hint below explains that instead of surfacing a bare error.
//
// Per-resource Apple rules baked into the tools:
//   * Profiles have NO PATCH — they are immutable; "editing" one is DELETE +
//     re-create. The GET carries `profileContent` (base64 of the actual
//     .mobileprovision) — that is the artifact CI needs.
//   * Certificates: create takes a PEM CSR (csrContent); the response carries
//     `certificateContent` (base64 DER). DELETE = REVOKE — signed builds keep
//     working on the App Store, but CI using that cert breaks immediately.
//   * Devices can NEVER be deleted, only DISABLED (they count against the
//     100-per-class membership-year limit until Apple's yearly reset).
//   * BundleIds delete only while no app is attached; the reverse-DNS
//     `identifier` is immutable after creation (only `name` can change).
//   * Capability `settings` are a raw passthrough (array of CapabilitySetting
//     objects) — shapes vary per capability; pass exactly what Apple's docs
//     show for the capability in question.

const BUNDLE_ID_FIELDS = 'identifier,name,platform,seedId';
const CERTIFICATE_FIELDS = 'name,displayName,certificateType,serialNumber,platform,expirationDate';
const PROFILE_FIELDS = 'name,platform,profileType,profileState,uuid,createdDate,expirationDate';
const DEVICE_FIELDS = 'name,platform,udid,deviceClass,status,model,addedDate';

interface JSONAPIBody {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

// ----- Body builders -----

export interface BundleIdCreateInput {
  name: string;
  platform: string;
  identifier: string;
  seedId?: string | undefined;
}

export function buildBundleIdCreateBody(input: BundleIdCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {
    name: input.name,
    platform: input.platform,
    identifier: input.identifier,
  };
  if (input.seedId !== undefined) attributes.seedId = input.seedId;
  return { data: { type: 'bundleIds', attributes } };
}

export function buildBundleIdPatchBody(bundleIdRecord: string, name: string): JSONAPIBody {
  // Only `name` is mutable — the reverse-DNS identifier is fixed at creation.
  return {
    data: {
      type: 'bundleIds',
      // Apple requires the id in the body as well as the URL (409 otherwise).
      id: bundleIdRecord,
      attributes: { name },
    },
  };
}

export interface CapabilityCreateInput {
  bundleIdRecord: string;
  capabilityType: string;
  settings?: unknown[] | undefined;
}

export function buildCapabilityCreateBody(input: CapabilityCreateInput): JSONAPIBody {
  const attributes: Record<string, unknown> = { capabilityType: input.capabilityType };
  if (input.settings !== undefined) attributes.settings = input.settings;
  return {
    data: {
      type: 'bundleIdCapabilities',
      attributes,
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: input.bundleIdRecord } },
      },
    },
  };
}

export interface CapabilityPatchInput {
  capabilityId: string;
  capabilityType: string;
  settings?: unknown[] | undefined;
}

export function buildCapabilityPatchBody(input: CapabilityPatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = { capabilityType: input.capabilityType };
  if (input.settings !== undefined) attributes.settings = input.settings;
  return {
    data: {
      type: 'bundleIdCapabilities',
      id: input.capabilityId,
      attributes,
    },
  };
}

export interface CertificateCreateInput {
  csrContent: string;
  certificateType: string;
}

export function buildCertificateCreateBody(input: CertificateCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'certificates',
      attributes: {
        csrContent: input.csrContent,
        certificateType: input.certificateType,
      },
    },
  };
}

export interface ProfileCreateInput {
  name: string;
  profileType: string;
  bundleIdRecord: string;
  certificateIds: string[];
  deviceIds?: string[] | undefined;
}

export function buildProfileCreateBody(input: ProfileCreateInput): JSONAPIBody {
  const relationships: Record<string, unknown> = {
    bundleId: { data: { type: 'bundleIds', id: input.bundleIdRecord } },
    certificates: {
      data: input.certificateIds.map((id) => ({ type: 'certificates', id })),
    },
  };
  if (input.deviceIds !== undefined) {
    relationships.devices = {
      data: input.deviceIds.map((id) => ({ type: 'devices', id })),
    };
  }
  return {
    data: {
      type: 'profiles',
      attributes: { name: input.name, profileType: input.profileType },
      relationships,
    },
  };
}

export interface DeviceCreateInput {
  name: string;
  platform: string;
  udid: string;
}

export function buildDeviceCreateBody(input: DeviceCreateInput): JSONAPIBody {
  return {
    data: {
      type: 'devices',
      attributes: { name: input.name, platform: input.platform, udid: input.udid },
    },
  };
}

export interface DevicePatchInput {
  deviceId: string;
  name?: string | undefined;
  status?: string | undefined;
}

export function buildDevicePatchBody(input: DevicePatchInput): JSONAPIBody {
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.status !== undefined) attributes.status = input.status;
  return {
    data: {
      type: 'devices',
      id: input.deviceId,
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

/**
 * Provisioning endpoints are role-gated: an App Manager / Developer API key
 * gets 403 FORBIDDEN here even though the same key works everywhere else in
 * this server. Explain that instead of surfacing a bare 403.
 */
function explainProvisioning403(err: unknown): string | undefined {
  if (!(err instanceof ASCError) || err.status !== 403) return undefined;
  return `403 FORBIDDEN — the provisioning surface (bundle IDs, certificates, profiles, devices) requires an API key with the ADMIN (or Account Holder) role. Keys scoped App Manager / Developer work for the rest of this server but not here. Generate an Admin key in App Store Connect → Users and Access → Integrations, or perform this step in the developer portal UI.\n\n${formatASCError(err)}`;
}

const maxItemsSchema = z.number().int().positive().max(2000).default(500);

export function registerProvisioning(server: McpServer, client: ASCClient): void {
  // ----- Bundle IDs -----

  server.registerTool(
    'asc_list_bundle_ids',
    {
      title: 'List registered bundle IDs',
      description:
        'List the bundle IDs registered on the developer portal. The BUNDLE_ID_RECORD column is the opaque resource id the other provisioning tools take — not the reverse-DNS identifier. Optional identifier filter matches exactly. Requires an Admin-role API key.',
      inputSchema: z.object({
        identifier: z
          .string()
          .optional()
          .describe('Exact reverse-DNS identifier to filter on (e.g. com.example.app).'),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ identifier, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[bundleIds]', BUNDLE_ID_FIELDS);
      params.set('limit', '200');
      if (identifier) params.set('filter[identifier]', identifier);
      try {
        const pages = await paginate(client, `/v1/bundleIds?${params.toString()}`, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestBundleIds(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_bundle_id',
    {
      title: 'Get a bundle ID with capabilities + profiles',
      description:
        'Fetch one bundle-ID record including its enabled capabilities and the provisioning profiles built on it (capability ids feed the capability PATCH/DELETE tools).',
      inputSchema: z.object({
        bundleIdRecord: ProvisioningBundleIdRecordSchema,
      }),
    },
    async ({ bundleIdRecord }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/bundleIds/${encodeURIComponent(bundleIdRecord)}?include=bundleIdCapabilities,profiles`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_bundle_id',
    {
      title: 'Register a bundle ID',
      description:
        'Register a new bundle ID on the developer portal. The reverse-DNS identifier is IMMUTABLE after creation (only the display name can change later), so double-check it — a typo means registering another one and abandoning this record.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Display name in the portal (mutable later).'),
        identifier: z
          .string()
          .min(1)
          .describe('Reverse-DNS bundle identifier (com.example.app). IMMUTABLE.'),
        platform: BundleIdPlatformSchema,
        seedId: z.string().optional().describe('Team seed ID override; normally omit.'),
      }),
    },
    async ({ name, identifier, platform, seedId }) => {
      const body = buildBundleIdCreateBody({ name, identifier, platform, seedId });
      try {
        const data = await client.request<unknown>('/v1/bundleIds', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_bundle_id',
    {
      title: 'Rename a bundle ID',
      description:
        "Update a bundle-ID record's display name — the only mutable attribute (the reverse-DNS identifier is fixed at creation).",
      inputSchema: z.object({
        bundleIdRecord: ProvisioningBundleIdRecordSchema,
        name: z.string().min(1),
      }),
    },
    async ({ bundleIdRecord, name }) => {
      const body = buildBundleIdPatchBody(bundleIdRecord, name);
      try {
        const data = await client.request<unknown>(
          `/v1/bundleIds/${encodeURIComponent(bundleIdRecord)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_bundle_id',
    {
      title: 'Delete a bundle ID',
      description:
        'Delete a bundle-ID record. Apple refuses while any app is attached to it — this only works for unused registrations. Profiles built on it become invalid.',
      inputSchema: z.object({
        bundleIdRecord: ProvisioningBundleIdRecordSchema,
      }),
    },
    async ({ bundleIdRecord }) => {
      try {
        await client.request<void>(`/v1/bundleIds/${encodeURIComponent(bundleIdRecord)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Deleted bundle ID record ${bundleIdRecord}.` }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Capabilities -----

  server.registerTool(
    'asc_post_bundle_id_capability',
    {
      title: 'Enable a capability on a bundle ID',
      description:
        'Enable a capability (PUSH_NOTIFICATIONS, ICLOUD, APPLE_PAY, HEALTHKIT, …) on a bundle ID. `settings` is a raw passthrough array of CapabilitySetting objects — shapes vary per capability; most capabilities need none. Existing provisioning profiles on the bundle ID become invalid and must be regenerated after capability changes.',
      inputSchema: z.object({
        bundleIdRecord: ProvisioningBundleIdRecordSchema,
        capabilityType: z
          .string()
          .min(1)
          .describe(
            'Capability type constant, e.g. PUSH_NOTIFICATIONS, ICLOUD, GAME_CENTER, IN_APP_PURCHASE, HEALTHKIT, APP_GROUPS, SIGN_IN_WITH_APPLE.',
          ),
        settings: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'Raw CapabilitySetting objects, only for capabilities that take options (e.g. ICLOUD version).',
          ),
      }),
    },
    async ({ bundleIdRecord, capabilityType, settings }) => {
      const body = buildCapabilityCreateBody({ bundleIdRecord, capabilityType, settings });
      try {
        const data = await client.request<unknown>('/v1/bundleIdCapabilities', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_bundle_id_capability',
    {
      title: 'Update the settings of a capability',
      description:
        "Update a capability's settings (capability id from asc_get_bundle_id's included capabilities). capabilityType must be re-stated on the PATCH. Profiles on the bundle ID must be regenerated afterwards.",
      inputSchema: z.object({
        capabilityId: BundleIdCapabilityIdSchema,
        capabilityType: z.string().min(1),
        settings: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    },
    async ({ capabilityId, capabilityType, settings }) => {
      const body = buildCapabilityPatchBody({ capabilityId, capabilityType, settings });
      try {
        const data = await client.request<unknown>(
          `/v1/bundleIdCapabilities/${encodeURIComponent(capabilityId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_bundle_id_capability',
    {
      title: 'Disable a capability on a bundle ID',
      description:
        'Disable a capability (DELETE the capability record). Apps relying on the entitlement lose it on their next profile regeneration — verify nothing ships with it first.',
      inputSchema: z.object({
        capabilityId: BundleIdCapabilityIdSchema,
      }),
    },
    async ({ capabilityId }) => {
      try {
        await client.request<void>(`/v1/bundleIdCapabilities/${encodeURIComponent(capabilityId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Disabled capability ${capabilityId}.` }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Certificates -----

  server.registerTool(
    'asc_list_certificates',
    {
      title: 'List signing certificates',
      description:
        'List the signing certificates of the team with type, serial and expiry. Filter by certificateType to find e.g. all DISTRIBUTION certs. Requires an Admin-role API key.',
      inputSchema: z.object({
        certificateType: CertificateTypeSchema.optional(),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ certificateType, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[certificates]', CERTIFICATE_FIELDS);
      params.set('limit', '200');
      if (certificateType) params.set('filter[certificateType]', certificateType);
      try {
        const pages = await paginate(client, `/v1/certificates?${params.toString()}`, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestCertificates(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_certificate',
    {
      title: 'Get a certificate (with content)',
      description:
        'Fetch one certificate including `certificateContent` — the base64 DER to install in a keychain / CI secret.',
      inputSchema: z.object({
        certificateId: CertificateIdSchema,
      }),
    },
    async ({ certificateId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/certificates/${encodeURIComponent(certificateId)}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_certificate',
    {
      title: 'Create a signing certificate from a CSR',
      description:
        'Create a certificate from a PEM certificate-signing request. csrContent is the full PEM text (including the BEGIN/END CERTIFICATE REQUEST lines) — generate one with `openssl req -new -newkey rsa:2048 -nodes -keyout key.pem -out csr.pem`. The private key NEVER goes to Apple; the response carries the signed certificateContent (base64 DER). Team certificate-count limits apply (typically 2 distribution certs).',
      inputSchema: z.object({
        csrContent: z.string().min(1).describe('Full PEM CSR text.'),
        certificateType: CertificateTypeSchema,
      }),
    },
    async ({ csrContent, certificateType }) => {
      const body = buildCertificateCreateBody({ csrContent, certificateType });
      try {
        const data = await client.request<unknown>('/v1/certificates', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_certificate',
    {
      title: 'Revoke a signing certificate',
      description:
        '⚠️ DELETE = REVOKE. Shipped App Store builds keep working, but any CI pipeline or colleague signing with this certificate breaks immediately, and every provisioning profile referencing it becomes invalid. Verify nothing depends on it (asc_list_profiles) before revoking.',
      inputSchema: z.object({
        certificateId: CertificateIdSchema,
      }),
    },
    async ({ certificateId }) => {
      try {
        await client.request<void>(`/v1/certificates/${encodeURIComponent(certificateId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Revoked certificate ${certificateId}.` }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Profiles -----

  server.registerTool(
    'asc_list_profiles',
    {
      title: 'List provisioning profiles',
      description:
        'List the provisioning profiles of the team with type, state (ACTIVE / INVALID) and expiry. Filter by profileType. INVALID profiles (after a cert revoke or capability change) need delete + re-create — profiles have no PATCH.',
      inputSchema: z.object({
        profileType: ProfileTypeSchema.optional(),
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ profileType, maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[profiles]', PROFILE_FIELDS);
      params.set('limit', '200');
      if (profileType) params.set('filter[profileType]', profileType);
      try {
        const pages = await paginate(client, `/v1/profiles?${params.toString()}`, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestProfiles(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_get_profile',
    {
      title: 'Get a provisioning profile (with content)',
      description:
        'Fetch one profile including `profileContent` — base64 of the actual .mobileprovision file (decode and drop into ~/Library/MobileDevice/Provisioning Profiles or a CI secret). Includes the bundle ID, certificates, and devices it was built from.',
      inputSchema: z.object({
        profileId: ProfileIdSchema,
      }),
    },
    async ({ profileId }) => {
      try {
        const data = await client.request<unknown>(
          `/v1/profiles/${encodeURIComponent(profileId)}?include=bundleId,certificates,devices`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_profile',
    {
      title: 'Create a provisioning profile',
      description:
        'Generate a provisioning profile: name + profileType + the bundle-ID record + certificate ids (+ device ids for DEVELOPMENT/ADHOC types — App Store types take none). The response carries profileContent (base64 .mobileprovision) immediately. Profiles are immutable — to change one later, delete and re-create.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Profile display name (must be unique on the team).'),
        profileType: ProfileTypeSchema,
        bundleIdRecord: ProvisioningBundleIdRecordSchema,
        certificateIds: z
          .array(CertificateIdSchema)
          .min(1)
          .describe('Signing certificates to embed (asc_list_certificates).'),
        deviceIds: z
          .array(DeviceIdSchema)
          .optional()
          .describe(
            'Devices to include — required for *_APP_DEVELOPMENT and *_ADHOC profile types, forbidden for App Store types.',
          ),
      }),
    },
    async ({ name, profileType, bundleIdRecord, certificateIds, deviceIds }) => {
      const body = buildProfileCreateBody({
        name,
        profileType,
        bundleIdRecord,
        certificateIds,
        deviceIds,
      });
      try {
        const data = await client.request<unknown>('/v1/profiles', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_delete_profile',
    {
      title: 'Delete a provisioning profile',
      description:
        'Delete a provisioning profile. Installed copies keep working until expiry; CI that fetches it fresh breaks. The standard rotate move is delete + asc_post_profile with the same name.',
      inputSchema: z.object({
        profileId: ProfileIdSchema,
      }),
    },
    async ({ profileId }) => {
      try {
        await client.request<void>(`/v1/profiles/${encodeURIComponent(profileId)}`, {
          method: 'DELETE',
        });
        return { content: [{ type: 'text', text: `Deleted profile ${profileId}.` }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  // ----- Devices -----

  server.registerTool(
    'asc_list_devices',
    {
      title: 'List registered devices',
      description:
        'List the registered test devices of the team (name, class, model, status, UDID). Disabled devices still count against the 100-per-class membership-year limit until Apple’s annual reset.',
      inputSchema: z.object({
        maxItems: maxItemsSchema,
        raw: z.boolean().default(false),
      }),
    },
    async ({ maxItems, raw }) => {
      const params = new URLSearchParams();
      params.set('fields[devices]', DEVICE_FIELDS);
      params.set('limit', '200');
      try {
        const pages = await paginate(client, `/v1/devices?${params.toString()}`, maxItems);
        const text = raw ? JSON.stringify(pages, null, 2) : digestDevices(pages);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_post_device',
    {
      title: 'Register a device',
      description:
        'Register a test device by UDID. ⚠️ Registration is effectively permanent: devices can never be deleted (only DISABLED) and count against the 100-per-class membership-year limit until Apple’s yearly reset — check the UDID carefully.',
      inputSchema: z.object({
        name: z.string().min(1),
        platform: BundleIdPlatformSchema,
        udid: z.string().min(1).describe('Device UDID (Xcode → Devices, or Finder).'),
      }),
    },
    async ({ name, platform, udid }) => {
      const body = buildDeviceCreateBody({ name, platform, udid });
      try {
        const data = await client.request<unknown>('/v1/devices', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'asc_patch_device',
    {
      title: 'Rename or enable/disable a device',
      description:
        'Update a registered device: name and/or status (ENABLED / DISABLED). DISABLED removes it from new profiles but does NOT free its slot in the membership-year device count. Pass at least one attribute.',
      inputSchema: z.object({
        deviceId: DeviceIdSchema,
        name: z.string().optional(),
        status: z.enum(['ENABLED', 'DISABLED']).optional(),
      }),
    },
    async ({ deviceId, name, status }) => {
      if (name === undefined && status === undefined) {
        return {
          content: [{ type: 'text', text: 'Refused: pass at least one of name, status.' }],
          isError: true,
        };
      }
      const body = buildDevicePatchBody({ deviceId, name, status });
      try {
        const data = await client.request<unknown>(`/v1/devices/${encodeURIComponent(deviceId)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const hint = explainProvisioning403(err);
        return { content: [{ type: 'text', text: hint ?? formatASCError(err) }], isError: true };
      }
    },
  );
}
