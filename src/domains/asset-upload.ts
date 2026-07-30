// Shared helpers for the v0.13 asset-upload flow (screenshots + previews).
//
// Apple's upload is multi-step:
import type { McpServer } from '@modelcontextprotocol/server';

//   1. POST /v1/appScreenshots (or /v1/appPreviews) — reserve. Body carries
//      fileSize + fileName + parent-set relationship. Apple returns the
//      resource with uploadOperations[] populated: one operation per chunk,
//      each with method (always PUT), url (Apple's storage), length, offset,
//      and requestHeaders.
//   2. For each operation: PUT the slice [offset, offset+length) of the
//      local file to the operation's url with the operation's requestHeaders.
//      These PUTs hit Apple's S3-style storage, NOT the ASC API — no bearer
//      auth, no 429 envelope. Treat them as plain HTTP.
//   3. PATCH the resource with sourceFileChecksum (hex MD5 of the full file)
//      + uploaded: true (wire key `uploaded`, Swift `isUploaded` — same
//      strip pattern as AppCustomProductPage.isVisible → `visible`).
//
// The composite asc_upload_screenshot / asc_upload_app_preview tools wrap
// 1+2+3 into a single call from a local file path. The raw asc_post_* /
// asc_patch_* / asc_upload_asset_chunk tools are escape hatches for callers
// that want manual control over each step.

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { z } from 'zod';
import { ASCError } from '../errors.js';
import { LocalFilePathSchema } from '../schemas.js';

export interface UploadOperationHeader {
  name: string;
  value: string;
}

export interface UploadOperation {
  method?: string;
  url?: string;
  length?: number;
  offset?: number;
  requestHeaders?: UploadOperationHeader[];
}

export interface AssetReserveResponse {
  data?: {
    id?: string;
    attributes?: {
      uploadOperations?: UploadOperation[];
      fileSize?: number;
      fileName?: string;
    };
  };
}

export function expandHomePath(input: string): string {
  if (input.startsWith('~/')) return input.replace('~', homedir());
  if (input === '~') return homedir();
  return input;
}

export async function computeFileMd5Hex(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('md5');
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function readFileSizeBytes(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size;
}

export interface ExecutedOperation {
  index: number;
  url: string;
  length: number;
  offset: number;
  status: number;
}

/**
 * PUT one chunk to Apple's storage. The chunk is read from the local file at
 * [offset, offset+length). Apple's storage URLs are pre-signed — bearer auth
 * is NOT applied here. Returns the HTTP status; throws on non-2xx with the
 * response body included.
 */
export async function executeUploadOperation(
  op: UploadOperation,
  filePath: string,
): Promise<number> {
  if (!op.url) throw new Error('UploadOperation missing url');
  if (!op.method) throw new Error('UploadOperation missing method');
  if (op.length === undefined) throw new Error('UploadOperation missing length');
  if (op.offset === undefined) throw new Error('UploadOperation missing offset');

  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(op.length);
    await handle.read(buffer, 0, op.length, op.offset);
    const headers = new Headers();
    for (const h of op.requestHeaders ?? []) headers.set(h.name, h.value);
    // Force Buffer to ArrayBuffer for fetch's BodyInit typing.
    const body = new Uint8Array(buffer);
    const res = await fetch(op.url, { method: op.method, headers, body });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Apple storage ${op.method} returned ${res.status}` +
          (detail ? `: ${detail.slice(0, 500)}` : ''),
      );
    }
    return res.status;
  } finally {
    await handle.close();
  }
}

/**
 * Run every uploadOperation sequentially. Apple returns chunks in offset
 * order; running them serially keeps the local file-descriptor + memory
 * pressure bounded and matches what e.g. Fastlane Deliver does.
 */
export async function executeAllUploadOperations(
  operations: UploadOperation[],
  filePath: string,
): Promise<ExecutedOperation[]> {
  const results: ExecutedOperation[] = [];
  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    if (!op) continue;
    const status = await executeUploadOperation(op, filePath);
    results.push({
      index: i,
      url: op.url ?? '',
      length: op.length ?? 0,
      offset: op.offset ?? 0,
      status,
    });
  }
  return results;
}

export function summarizeUpload(filePath: string, operations: ExecutedOperation[]): string {
  const totalBytes = operations.reduce((acc, op) => acc + op.length, 0);
  return [
    `Uploaded ${filePath}`,
    `Chunks: ${operations.length} · Total: ${totalBytes} bytes`,
    ...operations.map(
      (op) => `  chunk ${op.index}: offset=${op.offset} length=${op.length} → ${op.status}`,
    ),
  ].join('\n');
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerAssetUpload(server: McpServer): void {
  // Raw escape hatch — one chunk PUT to Apple storage. Used by callers who
  // want to drive the three-step flow manually after asc_post_app_screenshot /
  // asc_post_app_preview returns uploadOperations[]. The composite
  // asc_upload_screenshot / asc_upload_app_preview tools wrap this internally.
  server.registerTool(
    'asc_upload_asset_chunk',
    {
      title: 'Upload one asset chunk to Apple storage (raw step 2)',
      description:
        "RAW step 2 of the three-step screenshot / preview upload flow. Apple's reserve response returns uploadOperations[] — one per chunk, each with method (always PUT), url (Apple's pre-signed storage URL), length, offset, and requestHeaders. This tool executes ONE operation: reads localFilePath at [offset, offset+length), PUTs the bytes to url with all requestHeaders, and returns the HTTP status. Apple's storage URLs are pre-signed — no ASC bearer auth is applied. Tilde paths (~/...) are expanded.",
      inputSchema: z.object({
        method: z.string().default('PUT'),
        url: z.string().url(),
        requestHeaders: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
        localFilePath: LocalFilePathSchema,
        offset: z.number().int().min(0),
        length: z.number().int().positive(),
      }),
    },
    async ({ method, url, requestHeaders, localFilePath, offset, length }) => {
      const resolvedPath = expandHomePath(localFilePath);
      try {
        const status = await executeUploadOperation(
          { method, url, offset, length, requestHeaders },
          resolvedPath,
        );
        return {
          content: [
            {
              type: 'text',
              text: `${method} ${url} offset=${offset} length=${length} → ${status}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
