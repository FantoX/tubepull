import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AbortError,
  FileExistsError,
  LiveStreamError,
  NetworkError,
  TubePull,
  VideoUnavailableError,
  type Extractor,
  type MediaFormat,
  type PlaylistInfo,
  type ProgressEvent,
} from '../../src/index.js';
import type { ExtractedVideo, GetVideoOptions } from '../../src/extractor/Extractor.js';
import { avStreams, generateClips, probe, testFfmpeg, type Clips } from '../helpers/media.js';
import { startMediaServer, type MediaServer, type MediaServerOptions } from '../helpers/server.js';

const binary = await testFfmpeg();
const describeIfFfmpeg = binary ? describe : describe.skip;

const ID = 'abcdefghijk';
const ID2 = 'bcdefghijkl';

class FakeExtractor implements Extractor {
  readonly name = 'fake';
  calls = 0;
  live = false;
  expireFirst = false;
  /** When set, stream URLs carry an `expire` this many seconds ahead (like googlevideo URLs). */
  expiresInSec: number | undefined;

  constructor(
    private readonly server: () => MediaServer,
    private readonly files: Record<string, Buffer>,
  ) {}

  excludes: (readonly string[])[] = [];

  async getVideo(videoId: string, options: GetVideoOptions = {}): Promise<ExtractedVideo> {
    this.calls++;
    if (videoId !== ID && videoId !== ID2) throw new VideoUnavailableError(`No video ${videoId}`);
    const excluded = options.excludeClients ?? [];
    this.excludes.push(excluded);
    // Like the real extractor: client A first, B once A's streams were refused.
    const client = excluded.includes('A') ? 'B' : 'A';
    const base = this.server().url;
    const videoPath = this.expireFirst && client === 'A' ? '/expired/video.mp4' : '/video.mp4';
    const fmt = (itag: number, file: string, extra: Partial<MediaFormat>): MediaFormat => ({
      itag,
      url: `${base}${file}?id=${videoId}${this.expiresInSec === undefined ? '' : `&expire=${Math.floor(Date.now() / 1000) + this.expiresInSec}`}`,
      contentLength: (this.files[file.replace('/expired', '')] as Buffer).length,
      bitrate: 1000,
      mimeType: '',
      kind: 'video',
      container: 'mp4',
      ...extra,
    });
    return {
      info: {
        id: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: videoId === ID ? 'Test: Video / One?' : 'Second video',
        author: 'Channel',
        description: 'desc',
        durationSec: 4,
        keywords: [],
        thumbnails: [{ url: `${base}/thumb.jpg`, width: 128, height: 128 }],
        isLive: this.live,
        isUpcoming: false,
        chapters: [
          { title: 'A', startSec: 0 },
          { title: 'B', startSec: 1 },
          { title: 'C', startSec: 2 },
        ],
        uploadDate: '2024-05-06T00:00:00Z',
        formats: [
          fmt(137, videoPath, {
            vcodec: 'avc1.640028',
            width: 320,
            height: 240,
            fps: 25,
            qualityLabel: '240p',
            bitrate: 300_000,
          }),
          fmt(242, '/video.webm', {
            container: 'webm',
            vcodec: 'vp9',
            width: 320,
            height: 240,
            fps: 25,
            qualityLabel: '240p',
            bitrate: 200_000,
          }),
          fmt(140, '/audio.m4a', { kind: 'audio', container: 'm4a', acodec: 'mp4a.40.2', bitrate: 128_000 }),
          fmt(251, '/audio.webm', { kind: 'audio', container: 'webm', acodec: 'opus', bitrate: 160_000 }),
          fmt(18, '/muxed.mp4', {
            kind: 'muxed',
            vcodec: 'avc1.42001E',
            acodec: 'mp4a.40.2',
            width: 320,
            height: 240,
            fps: 25,
            qualityLabel: '240p',
            bitrate: 100_000,
          }),
        ],
        client,
      },
      media: { headers: { 'x-client': client }, rangeMode: 'query' },
    };
  }

  async getPlaylist(playlistId: string): Promise<PlaylistInfo> {
    return {
      id: playlistId,
      title: 'List',
      entries: [
        { id: ID, title: 'one' },
        { id: ID2, title: 'two' },
        { id: 'zzzzzzzzzzz', title: 'gone' },
      ],
    };
  }

  async describe() {
    return { engine: 'fake' };
  }
}

describeIfFfmpeg('TubePull end to end (fake extractor, local server, real ffmpeg)', () => {
  const ff = binary as string;
  let clips: Clips;
  let files: Record<string, Buffer>;
  let server: MediaServer;
  let work: string;
  let outDir: string;
  let tempDir: string;
  let extractor: FakeExtractor;
  let yt: TubePull;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tubepull-e2e-clips-'));
    clips = await generateClips(ff, dir);
    files = {
      '/video.mp4': await readFile(clips.videoMp4),
      '/expired/video.mp4': await readFile(clips.videoMp4),
      '/video.webm': await readFile(clips.videoWebm),
      '/audio.m4a': await readFile(clips.audioM4a),
      '/audio.webm': await readFile(clips.audioWebm),
      '/muxed.mp4': await readFile(clips.muxedMp4),
      '/thumb.jpg': await readFile(clips.coverJpg),
    };
  }, 120_000);

  afterAll(async () => {
    if (clips) await rm(clips.dir, { recursive: true, force: true });
  });

  async function setup(serverOptions: MediaServerOptions = {}) {
    server = await startMediaServer(files, serverOptions);
  }

  beforeEach(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'tubepull-e2e-'));
    outDir = path.join(work, 'out');
    tempDir = path.join(work, 'tmp');
    await mkdir(tempDir, { recursive: true });
    await setup();
    extractor = new FakeExtractor(() => server, files);
    yt = await TubePull.create({ extractor, tempDir, ffmpegPath: ff });
  });

  afterEach(async () => {
    await server.close();
    await rm(work, { recursive: true, force: true });
  });

  it('downloads best video+audio into mp4 with metadata, chapters and progress; cleans temp files', async () => {
    const events: ProgressEvent[] = [];
    yt.on('progress', (e) => events.push(e));
    const result = await yt.download(ID, { outputDir: outDir });

    expect(path.basename(result.path)).toBe('Test_ Video _ One_ [abcdefghijk].mp4');
    expect(result.container).toBe('mp4');
    expect(result.video?.itag).toBe(137);
    expect(result.audio?.itag).toBe(140);
    expect(result.sizeBytes).toBe((await stat(result.path)).size);

    const info = await probe(ff, result.path);
    expect(avStreams(info)).toEqual(['h264', 'aac']);
    expect(info.metadata.title).toBe('Test: Video / One?');
    expect(info.metadata.artist).toBe('Channel');
    expect(info.chapters).toBe(3);

    const stages = new Set(events.map((e) => e.stage));
    expect([...stages]).toEqual(expect.arrayContaining(['video', 'audio', 'merge', 'done']));
    const lastVideo = events.filter((e) => e.stage === 'video').at(-1);
    expect(lastVideo?.percent).toBe(100);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it('selects VP9 + Opus for mkv and embeds the thumbnail as an attachment', async () => {
    const result = await yt.download(ID, { outputDir: outDir, container: 'mkv', embedThumbnail: true });
    expect(result.container).toBe('mkv');
    const info = await probe(ff, result.path);
    expect(avStreams(info)).toEqual(['vp9', 'opus']);
    expect(info.streams.filter((s) => s.attachedPic)).toHaveLength(1);
  });

  it('converts audio to mp3 with cover art and metadata', async () => {
    const result = await yt.download(ID, {
      type: 'audio',
      audioFormat: 'mp3',
      outputDir: outDir,
      filename: '{author} - {title}',
    });
    expect(path.basename(result.path)).toBe('Channel - Test_ Video _ One_.mp3');
    const info = await probe(ff, result.path);
    expect(info.streams.find((s) => s.type === 'Audio')?.codec).toBe('mp3');
    expect(info.streams.some((s) => s.attachedPic)).toBe(true);
    expect(info.metadata.title).toBe('Test: Video / One?');
  });

  it('passes the original audio through byte-for-byte', async () => {
    const result = await yt.download(ID, { type: 'audio', audioFormat: 'original', outputDir: outDir });
    expect(result.container).toBe('webm');
    expect(Buffer.compare(await readFile(result.path), files['/audio.webm'] as Buffer)).toBe(0);
  });

  it('trims to a time range', async () => {
    const result = await yt.download(ID, { outputDir: outDir, range: { start: 1, end: '0:03' } });
    expect((await probe(ff, result.path)).durationSec).toBeCloseTo(2, 0);
  });

  it('refuses to overwrite, can skip, and can overwrite', async () => {
    const first = await yt.download(ID, { outputDir: outDir });
    await expect(yt.download(ID, { outputDir: outDir })).rejects.toBeInstanceOf(FileExistsError);
    const skipped = await yt.download(ID, { outputDir: outDir, skipExisting: true });
    expect(skipped.skipped).toBe(true);
    expect(skipped.path).toBe(first.path);
    await writeFile(first.path, 'junk');
    const replaced = await yt.download(ID, { outputDir: outDir, overwrite: true });
    expect(replaced.sizeBytes).toBeGreaterThan(100);
  });

  it('re-extracts and retries when a media URL is rejected with 403', async () => {
    await server.close();
    await setup({
      fault: ({ path: p }) => (p.startsWith('/expired') ? { kind: 'status', status: 403 } : undefined),
    });
    extractor.expireFirst = true;
    const retries: string[] = [];
    yt.on('retry', (r) => retries.push(r.reason));
    const result = await yt.download(ID, { outputDir: outDir });
    expect(avStreams(await probe(ff, result.path))).toEqual(['h264', 'aac']);
    expect(extractor.calls).toBe(2);
    expect(retries.some((r) => r.includes('403'))).toBe(true);
    // The refused client is excluded on re-extraction, and the new client's headers are used.
    expect(extractor.excludes).toEqual([[], ['A']]);
    const videoRequests = server.requests.filter((r) => r.path.endsWith('video.mp4'));
    expect(
      videoRequests.filter((r) => r.path.startsWith('/expired')).every((r) => r.headers['x-client'] === 'A'),
    ).toBe(true);
    expect(
      videoRequests.filter((r) => r.path === '/video.mp4').every((r) => r.headers['x-client'] === 'B'),
    ).toBe(true);
  });

  it('reuses one extraction for getInfo → download instead of asking YouTube again', async () => {
    const info = await yt.getInfo(ID);
    await yt.download(ID, { outputDir: outDir, type: 'audio', audioFormat: 'original' });
    await yt.download(info, { outputDir: outDir, type: 'audio', audioFormat: 'm4a' });
    expect(extractor.calls).toBe(1);
  });

  it('re-extracts before downloading when stream URLs are about to expire', async () => {
    extractor.expiresInSec = 60; // inside the 5-minute safety margin
    const info = await yt.getInfo(ID);
    expect(extractor.calls).toBe(1);
    extractor.expiresInSec = 6 * 3600;
    const result = await yt.download(info, { outputDir: outDir, type: 'audio', audioFormat: 'original' });
    expect(extractor.calls).toBe(2);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('returns independent copies, so mutating a result does not affect later downloads', async () => {
    const info = await yt.getInfo(ID);
    for (const format of info.formats) format.url = 'http://127.0.0.1:1/broken';
    const result = await yt.download(ID, { outputDir: outDir, type: 'audio', audioFormat: 'original' });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(extractor.calls).toBe(1);
  });

  it('cancels cleanly: AbortError, no output, no temp files', async () => {
    await server.close();
    await setup({
      fault: ({ path: p }) => (p === '/audio.m4a' ? { kind: 'stall', afterBytes: 100 } : undefined),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(yt.download(ID, { outputDir: outDir, signal: controller.signal })).rejects.toBeInstanceOf(
      AbortError,
    );
    await expect(readdir(outDir)).rejects.toThrow();
    expect(await readdir(tempDir)).toEqual([]);
  });

  it('a failing track stops its sibling and surfaces the root cause', async () => {
    await server.close();
    await setup({
      fault: ({ path: p }) =>
        p === '/audio.m4a'
          ? { kind: 'status', status: 500 }
          : p === '/video.mp4'
            ? { kind: 'stall', afterBytes: 100 }
            : undefined,
    });
    const error = await yt.download(ID, { outputDir: outDir, retries: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it('streams a single format without ffmpeg', async () => {
    const stream = await yt.stream(ID, { type: 'audio' });
    expect(stream.format.itag).toBe(251);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.compare(Buffer.concat(chunks), files['/audio.webm'] as Buffer)).toBe(0);

    const muxed = await yt.stream(ID, { type: 'video' });
    expect(muxed.format.itag).toBe(18);
    muxed.destroy();
  });

  it('downloads playlists with bounded concurrency and per-item failures', async () => {
    const results = await yt.downloadMany(['https://www.youtube.com/playlist?list=PLtest123'], {
      outputDir: outDir,
      type: 'audio',
      audioFormat: 'm4a',
      concurrency: 2,
    });
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]?.error).toBeInstanceOf(VideoUnavailableError);
    expect((await readdir(outDir)).sort()).toEqual([
      'Second video [bcdefghijkl].m4a',
      'Test_ Video _ One_ [abcdefghijk].m4a',
    ]);
  });

  it('rejects live streams', async () => {
    extractor.live = true;
    await expect(yt.download(ID, { outputDir: outDir })).rejects.toBeInstanceOf(LiveStreamError);
  });

  it('getInfo builds qualities from the formats', async () => {
    const info = await yt.getInfo(`https://youtu.be/${ID}`);
    expect(info.qualities.map((q) => q.label)).toEqual(['240p']);
    expect(info.qualities[0]?.codecs).toEqual(['vp9', 'avc1']);
    expect(info.audioQualities[0]?.itag).toBe(251);
    await expect(yt.getInfo('https://www.youtube.com/playlist?list=PLx')).rejects.toThrowError(
      /playlist link/,
    );
  });
});
