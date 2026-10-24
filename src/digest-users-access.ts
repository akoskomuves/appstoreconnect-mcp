import { type CollectedPages, type Column, formatTable, type JSONAPIResource } from './jsonapi.js';

// Digests for Users & Access, the legal agreements and Pass Type / Merchant
// IDs. Kept out of digest.ts so this surface lands without touching the shared
// file. Same conventions: a summary footer, then a fixed-width table with the
// resource id in the last column.

function attr<T>(resource: JSONAPIResource, key: string): T | undefined {
  return resource.attributes?.[key] as T | undefined;
}

function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function summaryFooter(pages: CollectedPages, label: string): string {
  const count = pages.data.length;
  const total = pages.total ?? count;
  const more = pages.truncated ? ` (truncated — set raw:true or pass maxItems to fetch more)` : '';
  return `${count} ${label}${count === total ? '' : ` of ${total}`}${more}`;
}

function roles(resource: JSONAPIResource): string {
  return (attr<string[]>(resource, 'roles') ?? []).join(',');
}

function fullName(resource: JSONAPIResource): string {
  return [attr<string>(resource, 'firstName'), attr<string>(resource, 'lastName')]
    .filter(Boolean)
    .join(' ');
}

/** Visible-app ids from a to-many relationship (only present with include=visibleApps). */
function visibleAppsCell(resource: JSONAPIResource): string {
  if (attr<boolean>(resource, 'allAppsVisible')) return 'ALL';
  const data = resource.relationships?.visibleApps?.data;
  if (!Array.isArray(data)) return '';
  return data.length === 0 ? 'none' : data.map((d) => d.id).join(',');
}

export function digestUsers(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'USERNAME' },
    { header: 'ROLES' },
    { header: 'APPS' },
    { header: 'PROVISIONING' },
    { header: 'USER_ID' },
  ];
  const rows = pages.data.map((u) => [
    fullName(u),
    s(attr(u, 'username')),
    roles(u),
    visibleAppsCell(u),
    s(attr(u, 'provisioningAllowed') ?? ''),
    u.id,
  ]);
  return `${summaryFooter(pages, 'users')}\n\n${formatTable(columns, rows)}`;
}

export function digestUserInvitations(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'EMAIL' },
    { header: 'ROLES' },
    { header: 'APPS' },
    { header: 'EXPIRES' },
    { header: 'INVITATION_ID' },
  ];
  const rows = pages.data.map((i) => [
    fullName(i),
    s(attr(i, 'email')),
    roles(i),
    visibleAppsCell(i),
    s(attr<string>(i, 'expirationDate')?.slice(0, 10) ?? ''),
    i.id,
  ]);
  return `${summaryFooter(pages, 'pending invitations')}\n\n${formatTable(columns, rows)}`;
}

export function digestActors(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'TYPE' },
    { header: 'NAME' },
    { header: 'EMAIL' },
    { header: 'API_KEY_ID' },
    { header: 'ACTOR_ID' },
  ];
  const rows = pages.data.map((a) => [
    s(attr(a, 'actorType')),
    [attr<string>(a, 'userFirstName'), attr<string>(a, 'userLastName')].filter(Boolean).join(' '),
    s(attr(a, 'userEmail') ?? ''),
    s(attr(a, 'apiKeyId') ?? ''),
    a.id,
  ]);
  return `${summaryFooter(pages, 'actors')}\n\n${formatTable(columns, rows)}`;
}

export function digestVisibleApps(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'NAME' }, { header: 'BUNDLE_ID' }, { header: 'APP_ID' }];
  const rows = pages.data.map((a) => [s(attr(a, 'name')), s(attr(a, 'bundleId')), a.id]);
  return `${summaryFooter(pages, 'visible apps')}\n\n${formatTable(columns, rows)}`;
}

/** Pass Type IDs and Merchant IDs share one shape: name + reverse-DNS identifier. */
export function digestIdentifierRecords(pages: CollectedPages, label: string): string {
  const columns: Column[] = [{ header: 'NAME' }, { header: 'IDENTIFIER' }, { header: 'ID' }];
  const rows = pages.data.map((r) => [s(attr(r, 'name')), s(attr(r, 'identifier')), r.id]);
  return `${summaryFooter(pages, label)}\n\n${formatTable(columns, rows)}`;
}

export function digestLinkedCertificates(pages: CollectedPages): string {
  const columns: Column[] = [
    { header: 'NAME' },
    { header: 'TYPE' },
    { header: 'SERIAL' },
    { header: 'EXPIRES' },
    { header: 'ACTIVATED' },
    { header: 'CERTIFICATE_ID' },
  ];
  const rows = pages.data.map((c) => [
    s(attr(c, 'displayName') ?? attr(c, 'name')),
    s(attr(c, 'certificateType')),
    s(attr(c, 'serialNumber')),
    s(attr<string>(c, 'expirationDate')?.slice(0, 10) ?? ''),
    s(attr(c, 'activated') ?? ''),
    c.id,
  ]);
  return `${summaryFooter(pages, 'certificates')}\n\n${formatTable(columns, rows)}`;
}

export function digestBetaLicenseAgreements(pages: CollectedPages): string {
  const columns: Column[] = [{ header: 'APP_ID' }, { header: 'TEXT' }, { header: 'AGREEMENT_ID' }];
  const rows = pages.data.map((b) => {
    const appRel = b.relationships?.app?.data;
    const appId = appRel && !Array.isArray(appRel) ? appRel.id : '';
    const text = attr<string>(b, 'agreementText');
    const preview = text
      ? `${text.slice(0, 60).replace(/\s+/g, ' ')}${text.length > 60 ? '…' : ''}`
      : '(Apple standard)';
    return [appId, preview, b.id];
  });
  return `${summaryFooter(pages, 'beta license agreements')}\n\n${formatTable(columns, rows)}`;
}
