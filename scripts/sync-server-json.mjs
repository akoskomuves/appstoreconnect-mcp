#!/usr/bin/env node
// Keep server.json's version fields in lockstep with package.json.
//
// server.json is the manifest the official MCP Registry reads. Changesets
// bumps package.json but knows nothing about it, so without this hook the
// registry listing silently rots — it sat at 1.0.1 while npm was on 1.9.0,
// pointing every registry-driven install at a four-month-old build.
//
// Wired into the `version` script, which is what `changesets/action` runs to
// perform the bump, so the sync lands inside the release PR's commit.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pkgPath = fileURLToPath(new URL('package.json', root));
const serverPath = fileURLToPath(new URL('server.json', root));

const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
if (!version) {
  console.error('sync-server-json: package.json has no version');
  process.exit(1);
}

const raw = readFileSync(serverPath, 'utf-8');
const server = JSON.parse(raw);

const before = [server.version, ...(server.packages ?? []).map((p) => p.version)];
server.version = version;
for (const pkg of server.packages ?? []) {
  // Only the npm package entry tracks our version; leave any other registry
  // type alone rather than assuming they move together.
  if (pkg.registryType === 'npm') pkg.version = version;
}

// Preserve the trailing newline convention of the checked-in file.
const out = `${JSON.stringify(server, null, 2)}\n`;
if (out !== raw) {
  writeFileSync(serverPath, out);
  console.log(`sync-server-json: ${before.join(' / ')} -> ${version}`);
} else {
  console.log(`sync-server-json: already at ${version}`);
}
