import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AbortError, FfmpegError, FfmpegNotFoundError } from '../../src/errors.js';
import {
  buildAudioArgs,
  buildChaptersMetadata,
  buildCoverArgs,
  buildMergeArgs,
} from '../../src/ffmpeg/commands.js';
import { FFMPEG_ENV, resolveFfmpeg } from '../../src/ffmpeg/resolve.js';
import { runFfmpeg } from '../../src/ffmpeg/run.js';
import { avStreams, generateClips, probe, testFfmpeg, type Clips } from '../helpers/media.js';

const binary = await testFfmpeg();
const describeIfFfmpeg = binary ? describe : describe.skip;

describe('resolveFfmpeg', () => {
  it('rejects an explicit path that does not exist', async () => {
    await expect(resolveFfmpeg('/definitely/not/ffmpeg')).rejects.toBeInstanceOf(FfmpegNotFoundError);
  });

  it('rejects a bad environment override', async () => {
    await expect(resolveFfmpeg(undefined, { [FFMPEG_ENV]: '/nope/ffmpeg', PATH: '' })).rejects.toThrowError(
      FFMPEG_ENV,
    );
  });

  it('prefers the explicit path, then the environment', async () => {
    if (!binary) return;
    expect(await resolveFfmpeg(binary)).toEqual({ path: binary, source: 'option' });
    expect(await resolveFfmpeg(undefined, { [FFMPEG_ENV]: binary })).toEqual({ path: binary, source: 'env' });
  });

  it('finds the bundled ffmpeg-static binary by default', async () => {
    const resolved = await resolveFfmpeg(undefined, { PATH: '' });
    expect(resolved.source).toBe('ffmpeg-static');
  });
});

describeIfFfmpeg('ffmpeg service with the bundled binary', () => {
  const ff = binary as string;
  let clips: Clips;
  let out: string;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tubepull-ffmpeg-'));
    clips = await generateClips(ff, dir);
    out = path.join(dir, 'out');
    await rm(out, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.mkdir(out, { recursive: true }));
  }, 120_000);

  afterAll(async () => {
    if (clips) await rm(clips.dir, { recursive: true, force: true });
  });

  const target = (name: string) => path.join(out, name);

  it('merges H.264 + AAC into mp4 by stream copy, with progress', async () => {
    const percents: number[] = [];
    await runFfmpeg(
      ff,
      buildMergeArgs({
        video: clips.videoMp4,
        audio: clips.audioM4a,
        output: target('a.mp4'),
        container: 'mp4',
      }),
      {
        durationSec: 4,
        onProgress: (p) => percents.push(p),
      },
    );
    const info = await probe(ff, target('a.mp4'));
    expect(info.streams.map((s) => `${s.type}:${s.codec}`)).toEqual(['Video:h264', 'Audio:aac']);
    expect(info.durationSec).toBeCloseTo(4, 0);
    expect(percents.at(-1)).toBe(100);
  });

  it('merges VP9 + Opus into webm and into mkv', async () => {
    for (const container of ['webm', 'mkv'] as const) {
      const file = target(`b.${container}`);
      await runFfmpeg(
        ff,
        buildMergeArgs({ video: clips.videoWebm, audio: clips.audioWebm, output: file, container }),
      );
      const info = await probe(ff, file);
      expect(info.streams.map((s) => `${s.type}:${s.codec}`)).toEqual(['Video:vp9', 'Audio:opus']);
    }
  });

  it('merges mixed codecs into mkv (H.264 + Opus)', async () => {
    await runFfmpeg(
      ff,
      buildMergeArgs({
        video: clips.videoMp4,
        audio: clips.audioWebm,
        output: target('c.mkv'),
        container: 'mkv',
      }),
    );
    expect((await probe(ff, target('c.mkv'))).streams.map((s) => s.codec)).toEqual(['h264', 'opus']);
  });

  it('remuxes a muxed source', async () => {
    await runFfmpeg(ff, buildMergeArgs({ video: clips.muxedMp4, output: target('d.mp4'), container: 'mp4' }));
    expect((await probe(ff, target('d.mp4'))).streams.map((s) => s.type)).toEqual(['Video', 'Audio']);
  });

  it('trims with stream copy', async () => {
    await runFfmpeg(
      ff,
      buildMergeArgs({
        video: clips.videoMp4,
        audio: clips.audioM4a,
        output: target('e.mp4'),
        container: 'mp4',
        range: { startSec: 1, endSec: 3 },
      }),
    );
    expect((await probe(ff, target('e.mp4'))).durationSec).toBeCloseTo(2, 0);
  });

  it('transcodes VP9 + Opus into mp4 when asked', async () => {
    await runFfmpeg(
      ff,
      buildMergeArgs({
        video: clips.videoWebm,
        audio: clips.audioWebm,
        output: target('f.mp4'),
        container: 'mp4',
        transcodeVideo: true,
        transcodeAudio: true,
      }),
    );
    expect((await probe(ff, target('f.mp4'))).streams.map((s) => s.codec)).toEqual(['h264', 'aac']);
  });

  it('embeds metadata, chapters and cover art in mp4', async () => {
    const chapters = path.join(out, 'chapters.txt');
    await writeFile(
      chapters,
      buildChaptersMetadata(
        [
          { title: 'Intro', startSec: 0 },
          { title: 'Middle; = part', startSec: 1.5 },
          { title: 'End', startSec: 3 },
        ],
        4,
        'Chaptered',
      ),
    );
    const cover = path.join(out, 'cover-out.jpg');
    await runFfmpeg(ff, buildCoverArgs(clips.coverJpg, cover));
    await runFfmpeg(
      ff,
      buildMergeArgs({
        video: clips.videoMp4,
        audio: clips.audioM4a,
        output: target('g.mp4'),
        container: 'mp4',
        chaptersFile: chapters,
        cover,
        metadata: {
          title: 'Tübe = Pull: test',
          artist: 'Channel',
          date: '2024-01-02',
          comment: 'https://youtu.be/x',
        },
      }),
    );
    const info = await probe(ff, target('g.mp4'));
    expect(avStreams(info)).toEqual(['h264', 'aac']);
    expect(info.metadata.title).toBe('Tübe = Pull: test');
    expect(info.metadata.artist).toBe('Channel');
    expect(info.chapters).toBe(3);
    expect(info.streams.filter((s) => s.attachedPic)).toHaveLength(1);
  });

  it('attaches the cover as a file in mkv (read back as an attached picture)', async () => {
    await runFfmpeg(
      ff,
      buildMergeArgs({
        video: clips.videoWebm,
        audio: clips.audioWebm,
        output: target('h.mkv'),
        container: 'mkv',
        cover: clips.coverJpg,
      }),
    );
    const info = await probe(ff, target('h.mkv'));
    expect(avStreams(info)).toEqual(['vp9', 'opus']);
    expect(info.streams.filter((s) => s.attachedPic).map((s) => s.codec)).toEqual(['mjpeg']);
  });

  it.each([
    ['mp3', clips_audio('webm'), true, 'mp3'],
    ['m4a', clips_audio('m4a'), false, 'aac'],
    ['opus', clips_audio('webm'), false, 'opus'],
    ['flac', clips_audio('webm'), true, 'flac'],
    ['wav', clips_audio('m4a'), true, 'pcm_s16le'],
  ] as const)('converts audio to %s', async (format, input, transcode, codec) => {
    const file = target(`audio.${format}`);
    await runFfmpeg(
      ff,
      buildAudioArgs({
        input: input(),
        output: file,
        format,
        transcode,
        bitrate: '128k',
        metadata: { title: 'Song' },
      }),
      {
        durationSec: 4,
      },
    );
    const info = await probe(ff, file);
    expect(info.streams.filter((s) => s.type === 'Audio').map((s) => s.codec)).toEqual([codec]);
    expect(info.durationSec).toBeCloseTo(4, 0);
  });

  it.each(['mp3', 'm4a', 'flac'] as const)('embeds cover art in %s', async (format) => {
    const file = target(`cover.${format}`);
    await runFfmpeg(
      ff,
      buildAudioArgs({
        input: clips.audioWebm,
        output: file,
        format,
        transcode: true,
        cover: clips.coverJpg,
        metadata: { title: 'Song', artist: 'A' },
      }),
    );
    const info = await probe(ff, file);
    expect(info.streams.some((s) => s.attachedPic)).toBe(true);
    expect(info.metadata.title).toBe('Song');
  });

  it('extracts audio from a muxed source', async () => {
    await runFfmpeg(
      ff,
      buildAudioArgs({ input: clips.muxedMp4, output: target('x.m4a'), format: 'm4a', transcode: false }),
    );
    expect((await probe(ff, target('x.m4a'))).streams.map((s) => s.type)).toEqual(['Audio']);
  });

  it('reports ffmpeg failures with stderr', async () => {
    const error = await runFfmpeg(ff, ['-i', path.join(out, 'missing.mp4'), target('never.mp4')]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FfmpegError);
    expect((error as Error).message).toMatch(/exited with code/);
  });

  it('kills ffmpeg on abort', async () => {
    const controller = new AbortController();
    const pending = runFfmpeg(ff, ['-y', '-re', '-f', 'lavfi', '-i', 'sine=duration=60', '-f', 'null', '-'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('reports a missing binary as FfmpegNotFoundError', async () => {
    await expect(runFfmpeg(path.join(out, 'no-ffmpeg.exe'), ['-version'])).rejects.toBeInstanceOf(
      FfmpegNotFoundError,
    );
  });

  function clips_audio(kind: 'webm' | 'm4a') {
    return () => (kind === 'webm' ? clips.audioWebm : clips.audioM4a);
  }
});
