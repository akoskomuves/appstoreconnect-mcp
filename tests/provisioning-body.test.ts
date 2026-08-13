import { describe, expect, it } from 'vitest';
import {
  buildBundleIdCreateBody,
  buildBundleIdPatchBody,
  buildCapabilityCreateBody,
  buildCertificateCreateBody,
  buildDeviceCreateBody,
  buildDevicePatchBody,
  buildProfileCreateBody,
} from '../src/domains/provisioning.js';

// Wire-shape pins for the v1.8 provisioning writes.
// Load-bearing rules:
//   1. Profile create carries bundleId (to-one) + certificates (to-many,
//      required) and only includes the devices relationship when the caller
//      supplied device ids — App Store profile types reject a devices key.
//   2. Capability create relates via `bundleId`, and `settings` is omitted
//      entirely (not []) when not provided — an empty array is a real value
//      to Apple.
//   3. PATCH bodies carry the resource id.
//   4. BundleId PATCH sends only `name` — the identifier is immutable.

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

describe('buildProfileCreateBody', () => {
  it('carries bundleId + certificates, omits devices when not supplied', () => {
    const body = buildProfileCreateBody({
      name: 'AppStore com.example.app',
      profileType: 'IOS_APP_STORE',
      bundleIdRecord: 'BID-1',
      certificateIds: ['CERT-1', 'CERT-2'],
    }) as Body;
    expect(body.data.type).toBe('profiles');
    expect(body.data.attributes).toEqual({
      name: 'AppStore com.example.app',
      profileType: 'IOS_APP_STORE',
    });
    expect(rel(body, 'bundleId')).toEqual({ type: 'bundleIds', id: 'BID-1' });
    expect(rel(body, 'certificates')).toEqual([
      { type: 'certificates', id: 'CERT-1' },
      { type: 'certificates', id: 'CERT-2' },
    ]);
    expect('devices' in (body.data.relationships ?? {})).toBe(false);
  });

  it('includes devices for development/ad-hoc profiles', () => {
    const body = buildProfileCreateBody({
      name: 'Dev',
      profileType: 'IOS_APP_DEVELOPMENT',
      bundleIdRecord: 'BID-1',
      certificateIds: ['CERT-1'],
      deviceIds: ['DEV-1'],
    }) as Body;
    expect(rel(body, 'devices')).toEqual([{ type: 'devices', id: 'DEV-1' }]);
  });
});

describe('buildCapabilityCreateBody', () => {
  it('relates via bundleId and omits settings when not provided', () => {
    const body = buildCapabilityCreateBody({
      bundleIdRecord: 'BID-1',
      capabilityType: 'PUSH_NOTIFICATIONS',
    }) as Body;
    expect(body.data.type).toBe('bundleIdCapabilities');
    expect(body.data.attributes).toEqual({ capabilityType: 'PUSH_NOTIFICATIONS' });
    expect('settings' in (body.data.attributes ?? {})).toBe(false);
    expect(rel(body, 'bundleId')).toEqual({ type: 'bundleIds', id: 'BID-1' });
  });

  it('passes settings through verbatim when provided', () => {
    const settings = [{ key: 'ICLOUD_VERSION', options: [{ key: 'XCODE_6' }] }];
    const body = buildCapabilityCreateBody({
      bundleIdRecord: 'BID-1',
      capabilityType: 'ICLOUD',
      settings,
    }) as Body;
    expect(body.data.attributes).toEqual({ capabilityType: 'ICLOUD', settings });
  });
});

describe('buildCertificateCreateBody', () => {
  it('carries csrContent + certificateType', () => {
    const body = buildCertificateCreateBody({
      csrContent: '-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----',
      certificateType: 'DISTRIBUTION',
    }) as Body;
    expect(body.data.type).toBe('certificates');
    expect(body.data.attributes?.certificateType).toBe('DISTRIBUTION');
    expect(String(body.data.attributes?.csrContent)).toContain('BEGIN CERTIFICATE REQUEST');
  });
});

describe('bundleId + device bodies', () => {
  it('bundleId create includes seedId only when provided', () => {
    const body = buildBundleIdCreateBody({
      name: 'My App',
      platform: 'IOS',
      identifier: 'com.example.app',
    }) as Body;
    expect(body.data.attributes).toEqual({
      name: 'My App',
      platform: 'IOS',
      identifier: 'com.example.app',
    });
  });

  it('bundleId PATCH sends only name (identifier is immutable) + id in body', () => {
    const body = buildBundleIdPatchBody('BID-1', 'Renamed') as Body;
    expect(body.data.id).toBe('BID-1');
    expect(body.data.attributes).toEqual({ name: 'Renamed' });
  });

  it('device create carries name/platform/udid; PATCH carries id + supplied attrs', () => {
    const create = buildDeviceCreateBody({
      name: 'Test iPhone',
      platform: 'IOS',
      udid: '00008120-000A1B2C3D4E5F6G',
    }) as Body;
    expect(create.data.type).toBe('devices');
    expect(create.data.attributes?.udid).toBe('00008120-000A1B2C3D4E5F6G');

    const patch = buildDevicePatchBody({ deviceId: 'DEV-1', status: 'DISABLED' }) as Body;
    expect(patch.data.id).toBe('DEV-1');
    expect(patch.data.attributes).toEqual({ status: 'DISABLED' });
  });
});
