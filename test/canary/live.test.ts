import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TubePull } from '../../src/index.js';

// Live tests against YouTube, run nightly by .github/workflows/canary.yml (never by `npm test`).
// Targets are short, stable, public videos. Failures here are the early warning that YouTube changed.
const TARGETS = {
  // "Me at the zoo" — 19 s, the first YouTube upload.
  short: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  // Big Buck Bunny (Blender Foundation, CC BY 3.0) — 4K60, long.
  hq: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
};

describe('live canary', () => {
  let yt: TubePull;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tubepull-canary-'));
    yt = await TubePull.create({
      ...(process.env.TUBEPULL_CANARY_COOKIES ? { cookies: process.env.TUBEPULL_CANARY_COOKIES } : {}),
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts metadata and downloadable formats', async () => {
    const info = await yt.getInfo(TARGETS.hq);
    expect(info.title).toMatch(/Big Buck Bunny/i);
    expect(info.durationSec).toBeGreaterThan(600);
    expect(info.formats.filter((f) => f.url).length).toBeGreaterThan(0);
    expect(info.qualities[0]?.height).toBeGreaterThanOrEqual(1080);
  });

  it('downloads and merges a short video', async () => {
    const result = await yt.download(TARGETS.short, { quality: '360p', outputDir: dir });
    expect((await stat(result.path)).size).toBeGreaterThan(100_000);
  });

  it('downloads audio as mp3', async () => {
    const result = await yt.download(TARGETS.short, { type: 'audio', audioFormat: 'mp3', outputDir: dir });
    expect(result.path.endsWith('.mp3')).toBe(true);
    expect((await stat(result.path)).size).toBeGreaterThan(50_000);
  });

  it('downloads a large stream fully (catches mid-file 403s and throttling)', async () => {
    const result = await yt.download(TARGETS.hq, { type: 'audio', audioFormat: 'original', outputDir: dir });
    expect(result.audio?.contentLength).toBe(result.sizeBytes);
  });
});
