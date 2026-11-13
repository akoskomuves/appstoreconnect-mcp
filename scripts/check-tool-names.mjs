#!/usr/bin/env node
// Start the BUILT server (dist/index.js), call tools/list, and fail on any
// duplicate tool name. McpServer only throws on a name collision at runtime,
// so tests and tsc never see it; this is the check to run after merging
// branches that each add tools. Needs ASC_* creds in the environment, like
// the smoke scripts (the server loads its config at startup).
//
// Usage: node scripts/check-tool-names.mjs [path/to/dist/index.js]

import { spawn } from 'node:child_process';

const entry = process.argv[2] ?? 'dist/index.js';
const server = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let buffer = '';
let stderr = '';
server.stderr.on('data', (d) => {
  stderr += d;
});
const send = (msg) => server.stdin.write(`${JSON.stringify(msg)}\n`);
const finish = (code, message) => {
  console.log(message);
  server.kill();
  process.exit(code);
};

server.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    } else if (msg.id === 2) {
      const names = msg.result.tools.map((t) => t.name);
      const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      finish(
        dupes.length ? 1 : 0,
        `${names.length} tools, ${dupes.length ? `DUPLICATES: ${dupes.join(', ')}` : 'no duplicate names'}${msg.result.nextCursor ? ' (list is paginated; only the first page was checked)' : ''}`,
      );
    }
  }
});
server.on('exit', (code) => finish(1, `server exited (${code}) before listing tools:\n${stderr.slice(0, 800)}`));
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-tool-names', version: '0' } },
});
setTimeout(() => finish(1, `timed out:\n${stderr.slice(0, 800)}`), 20000);
