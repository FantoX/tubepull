import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveFfmpeg } from '../../src/ffmpeg/resolve.js';
import { probeFfmpeg } from '../../src/ffmpeg/run.js';

export interface Clips {
  dir: string;
  videoMp4: string;
  audioM4a: string;
  videoWebm: string;
  audioWebm: string;
  muxedMp4: string;
  coverJpg: string;
}

export interface Probe {
  durationSec: number;
  streams: { type: string; codec: string; attachedPic: boolean }[];
  metadata: Record<string, string>;
  chapters: number;
  attachments: number;
}

/** The ffmpeg used by tests, or undefined when none is available (tests then skip). */
export async function testFfmpeg(): Promise<string | undefined> {
  try {
    const { path: binary } = await resolveFfmpeg();
    const { encoders } = await probeFfmpeg(binary);
    for (const needed of ['libx264', 'libvpx-vp9', 'aac', 'libopus', 'libmp3lame', 'mjpeg']) {
      if (!encoders.has(needed)) return undefined;
    }
    return binary;
  } catch {
    return undefined;
  }
}

/**
 * This function is used for running ffmpeg and collecting stderr (exit code is returned, not thrown).
 */
export function ffmpegRaw(binary: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/**
 * This function is used for generating short synthetic clips in the codecs YouTube serves.
 */
export async function generateClips(binary: string, dir: string): Promise<Clips> {
  const clips: Clips = {
    dir,
    videoMp4: path.join(dir, 'video.mp4'),
    audioM4a: path.join(dir, 'audio.m4a'),
    videoWebm: path.join(dir, 'video.webm'),
    audioWebm: path.join(dir, 'audio.webm'),
    muxedMp4: path.join(dir, 'muxed.mp4'),
    coverJpg: path.join(dir, 'cover.jpg'),
  };
  const video = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4'];
  const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4'];
  const jobs: string[][] = [
    [
      '-y',
      ...video,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '25',
      '-pix_fmt',
      'yuv420p',
      '-an',
      clips.videoMp4,
    ],
    ['-y', ...audio, '-c:a', 'aac', '-b:a', '128k', '-vn', clips.audioM4a],
    [
      '-y',
      ...video,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '200k',
      '-g',
      '25',
      '-an',
      clips.videoWebm,
    ],
    ['-y', ...audio, '-c:a', 'libopus', '-b:a', '96k', '-vn', clips.audioWebm],
    [
      '-y',
      ...video,
      ...audio,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      clips.muxedMp4,
    ],
    ['-y', '-f', 'lavfi', '-i', 'color=c=red:size=128x128', '-frames:v', '1', '-update', '1', clips.coverJpg],
  ];
  for (const args of jobs) {
    const { code, stderr } = await ffmpegRaw(binary, ['-loglevel', 'error', ...args]);
    if (code !== 0) throw new Error(`fixture generation failed: ${args.at(-1)}\n${stderr}`);
  }
  return clips;
}

/**
 * This function is used for the real audio/video tracks: no cover pictures (mkv attachments are read
 * back as attached-pic video streams) and no data tracks (mp4 chapters are a QuickTime text track).
 */
export function avStreams(info: Probe): string[] {
  return info.streams
    .filter((s) => (s.type === 'Video' || s.type === 'Audio') && !s.attachedPic)
    .map((s) => s.codec);
}

/**
 * This function is used for inspecting a media file with ffmpeg (ffmpeg-static ships no ffprobe).
 */
export async function probe(binary: string, file: string): Promise<Probe> {
  const { stderr } = await ffmpegRaw(binary, ['-i', file]);
  const result: Probe = { durationSec: Number.NaN, streams: [], metadata: {}, chapters: 0, attachments: 0 };
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (duration)
    result.durationSec = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);

  const lines = stderr.split(/\r?\n/);
  let inGlobalMetadata = false;
  for (const line of lines) {
    if (/^\s{2}Metadata:/.test(line)) {
      inGlobalMetadata = true;
      continue;
    }
    if (inGlobalMetadata) {
      const kv = /^\s{4}(\S[^:]*?)\s*:\s?(.*)$/.exec(line);
      if (kv && /^\s{4}\S/.test(line)) {
        result.metadata[kv[1]!.toLowerCase()] = kv[2] ?? '';
        continue;
      }
      inGlobalMetadata = false;
    }
    if (/^\s+Chapter #\d+:\d+:/.test(line)) result.chapters++;
    const stream = /Stream #\d+:\d+.*?: (Video|Audio|Attachment|Data|Subtitle): ?(\w+)?/.exec(line);
    if (stream) {
      if (stream[1] === 'Attachment') result.attachments++;
      result.streams.push({
        type: stream[1]!,
        codec: stream[2] ?? '',
        attachedPic: line.includes('(attached pic)'),
      });
    }
  }
  return result;
}
