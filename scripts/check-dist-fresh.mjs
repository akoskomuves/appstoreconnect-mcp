#!/usr/bin/env node
// Is dist/ older than src/?
//
// This exists because of a real miss on 2026-09-16: a fix was written,
// unit-tested, live-smoked and published to npm, and the user's MCP server
// still ran the old behaviour for hours. The smoke scripts run `tsx` against
// src/, but a locally-registered server runs `node dist/index.js` — so every
// verification passed against code the server was not executing.
//
// Anything that claims a local fix "works" should run this first.
//
//   node scripts/check-dist-fresh.mjs      (exit 1 when stale)

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function newest(dir) {
  let latest = { mtimeMs: 0, path: null };
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const s = statSync(p);
        if (s.mtimeMs > latest.mtimeMs) latest = { mtimeMs: s.mtimeMs, path: p };
      }
    }
  };
  walk(dir);
  return latest;
}

const src = newest('src');
const dist = newest('dist');

if (!dist.path) {
  console.error('dist/ is missing entirely — run `npm run build`.');
  process.exit(1);
}

const skewMs = src.mtimeMs - dist.mtimeMs;
if (skewMs > 0) {
  const mins = Math.round(skewMs / 60000);
  console.error('STALE BUILD: dist/ is older than src/.');
  console.error(`  newest src:  ${src.path}`);
  console.error(`  newest dist: ${dist.path}`);
  console.error(`  src is ${mins} minute(s) ahead.`);
  console.error('');
  console.error('A locally-registered MCP server runs dist/, not src/, so it is');
  console.error('executing the OLD code. Run `npm run build`, then reconnect the');
  console.error('server (/mcp in Claude Code) before verifying anything.');
  process.exit(1);
}

console.log(`dist/ is current (newest src: ${src.path}).`);
