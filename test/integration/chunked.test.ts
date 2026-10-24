import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchMediaChunks, type MediaSource } from '../../src/download/chunked.js';
import { downloadToFile } from '../../src/download/resume.js';
import { AbortError, NetworkError } from '../../src/errors.js';
import {
  randomBuffer,
  startMediaServer,
  type MediaServer,
  type MediaServerOptions,
} from '../helpers/server.js';

const SIZE = 3 * 1024 * 1024 + 12_345;
const CHUNK = 1024 * 1024;
const DATA = randomBuffer(SIZE, 7);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const fastBackoff = { baseMs: 5, maxMs: 20 };

let dir: string;
let server: MediaServer | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tubepull-chunked-'));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function serve(options: MediaServerOptions = {}) {
  server = await startMediaServer({ '/media': DATA, '/fresh': DATA }, options);
  return server;
}

function source(s: MediaServer, extra: Partial<MediaSource> = {}): MediaSource {
  return {
    url: `${s.url}/media?sig=1`,
    headers: { 'x-test': '1' },
    rangeMode: 'query',
    contentLength: SIZE,
    ...extra,
  };
}

async function download(
  s: MediaServer,
  extra: Partial<MediaSource> = {},
  opts: Partial<Parameters<typeof downloadToFile>[0]> = {},
) {
  const file = path.join(dir, 'out.bin');
  const result = await downloadToFile({
    file,
    source: source(s, extra),
    chunkSize: CHUNK,
    backoff: fastBackoff,
    ...opts,
  });
  return { file, result, data: await readFile(file) };
}

describe('chunked download engine', () => {
  it('downloads in ~chunk-sized ranges and reassembles exactly', async () => {
    const s = await serve();
    const progress: number[] = [];
    const { data, result } = await download(s, {}, { onProgress: (b) => progress.push(b) });
    expect(sha(data)).toBe(sha(DATA));
    expect(result.bytes).toBe(SIZE);
    expect(s.requests.map((r) => `${r.start}-${r.end}`)).toEqual([
      `0-${CHUNK - 1}`,
      `${CHUNK}-${2 * CHUNK - 1}`,
      `${2 * CHUNK}-${3 * CHUNK - 1}`,
      `${3 * CHUNK}-${SIZE - 1}`,
    ]);
    expect(s.requests.every((r) => r.query.get('sig') === '1')).toBe(true);
    expect(progress.at(-1)).toBe(SIZE);
    // The .part file and sidecar are gone after completion.
    await expect(stat(path.join(dir, 'out.bin.part'))).rejects.toThrow();
  });

  it('works with standard Range headers', async () => {
    const s = await serve({ rangeMode: 'header' });
    const { data } = await download(s, { rangeMode: 'header' });
    expect(sha(data)).toBe(sha(DATA));
  });

  it('copes with a server that ignores Range (full body from byte 0)', async () => {
    const s = await serve({ rangeMode: 'ignore' });
    const { data } = await download(s, { rangeMode: 'header' });
    expect(sha(data)).toBe(sha(DATA));
    expect(s.requests).toHaveLength(1);
  });

  it('learns an unknown size and stops at the end of the file', async () => {
    const s = await serve();
    const { data } = await download(s, { contentLength: undefined });
    expect(sha(data)).toBe(sha(DATA));
  });

  it('resumes mid-chunk after a dropped connection without re-downloading bytes', async () => {
    const s = await serve({
      fault: ({ index }) => (index === 1 ? { kind: 'drop', afterBytes: 300_000 } : undefined),
    });
    const retries: string[] = [];
    const { data } = await download(s, {}, { onRetry: (r) => retries.push(r.reason) });
    expect(sha(data)).toBe(sha(DATA));
    expect(retries).toHaveLength(1);
    // The retry continues exactly where the dropped response stopped.
    expect(s.requests[2]?.start).toBe(CHUNK + 300_000);
    expect(s.bytesServed()).toBe(SIZE);
  });

  it('retries 5xx and 429 with backoff, honouring Retry-After', async () => {
    const s = await serve({
      fault: ({ index }) =>
        index === 0
          ? { kind: 'status', status: 503 }
          : index === 1
            ? { kind: 'status', status: 429, retryAfter: '0' }
            : undefined,
    });
    const retries: number[] = [];
    const { data } = await download(s, {}, { onRetry: (r) => retries.push(r.delayMs) });
    expect(sha(data)).toBe(sha(DATA));
    expect(retries).toHaveLength(2);
    expect(retries[1]).toBe(0);
  });

  it('gives up after the retry budget', async () => {
    const s = await serve({ fault: () => ({ kind: 'status', status: 500 }) });
    await expect(download(s, {}, { retries: 2 })).rejects.toThrowError(/after 2 retries: HTTP 500/);
  });

  it('refreshes the URL on 403 and continues', async () => {
    const s = await serve({
      fault: ({ path: p }) =>
        p === '/media' && s.requests.length > 1 ? { kind: 'status', status: 403 } : undefined,
    });
    let refreshes = 0;
    const { data } = await download(s, {
      refresh: async () => {
        refreshes++;
        return `${s.url}/fresh?sig=2`;
      },
    });
    expect(sha(data)).toBe(sha(DATA));
    expect(refreshes).toBe(1);
    expect(s.requests.filter((r) => r.path === '/fresh').every((r) => r.query.get('sig') === '2')).toBe(true);
  });

  it('uses the headers a refresh returns (stream now signed by another client)', async () => {
    const s = await serve({
      fault: ({ path: p }) =>
        p === '/media' && s.requests.length > 1 ? { kind: 'status', status: 403 } : undefined,
    });
    const { data } = await download(s, {
      headers: { 'user-agent': 'client-a' },
      refresh: async () => ({ url: `${s.url}/fresh?sig=2`, headers: { 'user-agent': 'client-b' } }),
    });
    expect(sha(data)).toBe(sha(DATA));
    expect(
      s.requests.filter((r) => r.path === '/media').every((r) => r.headers['user-agent'] === 'client-a'),
    ).toBe(true);
    const fresh = s.requests.filter((r) => r.path === '/fresh');
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => r.headers['user-agent'] === 'client-b')).toBe(true);
  });

  it('fails with NetworkError when 403 persists after refreshes', async () => {
    const s = await serve({ fault: () => ({ kind: 'status', status: 403 }) });
    const error = await download(s, { refresh: async () => `${s.url}/media?sig=again` }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toMatch(/HTTP 403 after refreshing/);
  });

  it('does not retry a 404 without a refresher', async () => {
    const s = await serve({ fault: () => ({ kind: 'status', status: 404 }) });
    await expect(download(s)).rejects.toThrowError(/HTTP 404/);
    expect(s.requests).toHaveLength(1);
  });

  it('detects a stalled response and retries', async () => {
    const s = await serve({
      fault: ({ index }) => (index === 0 ? { kind: 'stall', afterBytes: 1000 } : undefined),
    });
    const retries: string[] = [];
    const { data } = await download(s, {}, { stallTimeoutMs: 300, onRetry: (r) => retries.push(r.reason) });
    expect(sha(data)).toBe(sha(DATA));
    expect(retries[0]).toMatch(/no data received/);
  });

  it('aborts promptly with AbortError and leaves the partial file for resume', async () => {
    const s = await serve({
      fault: ({ index }) => (index === 1 ? { kind: 'stall', afterBytes: 1000 } : undefined),
    });
    const controller = new AbortController();
    const file = path.join(dir, 'out.bin');
    const pending = downloadToFile({
      file,
      identity: 'v1',
      source: source(s),
      chunkSize: CHUNK,
      signal: controller.signal,
      onProgress: (bytes) => {
        if (bytes > CHUNK) controller.abort();
      },
    });
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect((await stat(`${file}.part`)).size).toBeGreaterThan(CHUNK);
  });

  it('resumes a leftover .part for the same content and restarts for different content', async () => {
    const s = await serve();
    const file = path.join(dir, 'out.bin');
    await writeFile(`${file}.part`, DATA.subarray(0, 1_500_000));
    await writeFile(`${file}.part.json`, JSON.stringify({ identity: 'same' }));
    await downloadToFile({ file, identity: 'same', source: source(s), chunkSize: CHUNK });
    expect(sha(await readFile(file))).toBe(sha(DATA));
    expect(s.requests[0]?.start).toBe(1_500_000);
    expect(s.bytesServed()).toBe(SIZE - 1_500_000);

    await rm(file);
    await writeFile(`${file}.part`, Buffer.alloc(1_500_000, 1));
    await writeFile(`${file}.part.json`, JSON.stringify({ identity: 'old' }));
    const before = s.requests.length;
    await downloadToFile({ file, identity: 'new', source: source(s), chunkSize: CHUNK });
    expect(sha(await readFile(file))).toBe(sha(DATA));
    expect(s.requests[before]?.start).toBe(0);
  });

  it('rejects a download whose size does not match the declared length', async () => {
    const s = await serve();
    await expect(download(s, { contentLength: SIZE + 10 })).rejects.toThrow();
  });

  it('streams via the generator and cleans up when the consumer stops early', async () => {
    const s = await serve();
    let received = 0;
    for await (const piece of fetchMediaChunks({ source: source(s), chunkSize: CHUNK })) {
      received += piece.byteLength;
      if (received > 100_000) break;
    }
    expect(received).toBeGreaterThan(100_000);
    expect(s.requests).toHaveLength(1);
  });
});
