import type { AudioFormat, Chapter, Container } from '../types.js';
import { toFfmpegTime, type ResolvedRange } from '../utils/time.js';

//---- Section used for ffmpeg argument builders ----

export interface MetadataTags {
  title?: string;
  artist?: string;
  album?: string;
  date?: string;
  comment?: string;
  description?: string;
  purl?: string;
}

export interface MergeArgsInput {
  video: string;
  /** Separate audio track; omit for a muxed source. */
  audio?: string;
  output: string;
  container: Container;
  range?: ResolvedRange;
  transcodeVideo?: boolean;
  transcodeAudio?: boolean;
  metadata?: MetadataTags;
  /** ffmetadata file with chapters. */
  chaptersFile?: string;
  /** JPEG cover image. */
  cover?: string;
}

export type ConvertFormat = Exclude<AudioFormat, 'original'>;

export interface AudioArgsInput {
  input: string;
  output: string;
  format: ConvertFormat;
  transcode: boolean;
  /** e.g. `192k`. */
  bitrate?: string;
  range?: ResolvedRange;
  metadata?: MetadataTags;
  chaptersFile?: string;
  cover?: string;
}

/** Audio formats whose muxer can carry an attached cover picture. */
export const COVER_AUDIO_FORMATS: ReadonlySet<ConvertFormat> = new Set(['m4a', 'mp3', 'flac']);
/** Containers that carry chapters. */
const CHAPTER_CONTAINERS: ReadonlySet<string> = new Set(['mp4', 'mkv', 'm4a']);

/**
 * This function is used for input-side seek options. Input seeking is fast and, with stream copy,
 * keyframe-accurate-ish; with transcoding it is frame-accurate.
 */
function seekArgs(range: ResolvedRange | undefined): string[] {
  const args: string[] = [];
  if (range?.startSec !== undefined) args.push('-ss', toFfmpegTime(range.startSec));
  if (range?.endSec !== undefined) args.push('-to', toFfmpegTime(range.endSec));
  return args;
}

function metadataArgs(metadata: MetadataTags | undefined): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined && value !== '') args.push('-metadata', `${key}=${value}`);
  }
  return args;
}

/**
 * This function is used for building the merge command (video + audio → container), stream-copying
 * unless transcoding was requested, with optional trim, metadata, chapters and cover.
 */
export function buildMergeArgs(input: MergeArgsInput): string[] {
  const args: string[] = ['-y'];
  const seek = seekArgs(input.range);
  let inputs = 0;
  const addInput = (...inputArgs: string[]) => {
    args.push(...inputArgs);
    return inputs++;
  };

  const videoIndex = addInput(...seek, '-i', input.video);
  let audioIndex: number | undefined;
  if (input.audio) {
    audioIndex = addInput(...seek, '-i', input.audio);
  }
  // Chapter times are relative to the full video, so they are dropped when trimming.
  let chaptersIndex: number | undefined;
  if (input.chaptersFile && !input.range && CHAPTER_CONTAINERS.has(input.container)) {
    chaptersIndex = addInput('-f', 'ffmetadata', '-i', input.chaptersFile);
  }
  let coverIndex: number | undefined;
  if (input.cover && input.container === 'mp4') {
    coverIndex = addInput('-i', input.cover);
  }

  args.push('-map', `${videoIndex}:v:0`);
  if (audioIndex !== undefined) args.push('-map', `${audioIndex}:a:0`);
  else args.push('-map', `${videoIndex}:a:0?`);
  if (coverIndex !== undefined) args.push('-map', `${coverIndex}:v:0`);
  if (chaptersIndex !== undefined)
    args.push('-map_metadata', String(chaptersIndex), '-map_chapters', String(chaptersIndex));

  args.push('-c', 'copy');
  if (input.transcodeVideo) {
    if (input.container === 'webm') {
      args.push(
        '-c:v:0',
        'libvpx-vp9',
        '-crf',
        '32',
        '-b:v',
        '0',
        '-row-mt',
        '1',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
      );
    } else {
      args.push('-c:v:0', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
    }
  }
  if (input.transcodeAudio) {
    if (input.container === 'webm') args.push('-c:a', 'libopus', '-b:a', '160k');
    else args.push('-c:a', 'aac', '-b:a', '192k');
  }
  if (coverIndex !== undefined) args.push('-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic');
  if (input.cover && input.container === 'mkv') {
    args.push(
      '-attach',
      input.cover,
      '-metadata:s:t',
      'mimetype=image/jpeg',
      '-metadata:s:t',
      'filename=cover.jpg',
    );
  }

  args.push(...metadataArgs(input.metadata));
  if (input.range) args.push('-avoid_negative_ts', 'make_zero');
  if (input.container === 'mp4') args.push('-movflags', '+faststart');
  args.push('-f', input.container === 'mkv' ? 'matroska' : input.container, input.output);
  return args;
}

const AUDIO_CODEC: Record<ConvertFormat, string[]> = {
  m4a: ['-c:a', 'aac'],
  opus: ['-c:a', 'libopus'],
  mp3: ['-c:a', 'libmp3lame'],
  flac: ['-c:a', 'flac'],
  wav: ['-c:a', 'pcm_s16le'],
};

const AUDIO_MUXER: Record<ConvertFormat, string> = {
  m4a: 'ipod',
  opus: 'opus',
  mp3: 'mp3',
  flac: 'flac',
  wav: 'wav',
};

/** Encoders each audio format needs when transcoding. */
export const AUDIO_ENCODER: Record<ConvertFormat, string> = {
  m4a: 'aac',
  opus: 'libopus',
  mp3: 'libmp3lame',
  flac: 'flac',
  wav: 'pcm_s16le',
};

/**
 * This function is used for building the audio extraction/conversion command (copy when the source
 * codec already matches, otherwise encode at the requested bitrate).
 */
export function buildAudioArgs(input: AudioArgsInput): string[] {
  const args: string[] = ['-y'];
  let inputs = 0;
  const addInput = (...inputArgs: string[]) => {
    args.push(...inputArgs);
    return inputs++;
  };
  addInput(...seekArgs(input.range), '-i', input.input);
  let chaptersIndex: number | undefined;
  if (input.chaptersFile && !input.range && CHAPTER_CONTAINERS.has(input.format)) {
    chaptersIndex = addInput('-f', 'ffmetadata', '-i', input.chaptersFile);
  }
  let coverIndex: number | undefined;
  if (input.cover && COVER_AUDIO_FORMATS.has(input.format)) {
    coverIndex = addInput('-i', input.cover);
  }

  args.push('-map', '0:a:0');
  if (coverIndex !== undefined) args.push('-map', `${coverIndex}:v:0`);
  else args.push('-vn');
  if (chaptersIndex !== undefined)
    args.push('-map_metadata', String(chaptersIndex), '-map_chapters', String(chaptersIndex));

  if (input.transcode) {
    args.push(...AUDIO_CODEC[input.format]);
    const lossless = input.format === 'flac' || input.format === 'wav';
    if (!lossless) args.push('-b:a', input.bitrate ?? '192k');
  } else {
    args.push('-c:a', 'copy');
  }

  if (coverIndex !== undefined) {
    args.push('-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
    if (input.format === 'mp3')
      args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  }
  if (input.format === 'mp3') args.push('-id3v2_version', '3');
  args.push(...metadataArgs(input.metadata));
  if (input.range) args.push('-avoid_negative_ts', 'make_zero');
  if (input.format === 'm4a') args.push('-movflags', '+faststart');
  args.push('-f', AUDIO_MUXER[input.format], input.output);
  return args;
}

/**
 * This function is used for converting any downloaded thumbnail (jpg/webp/png) into a baseline JPEG
 * cover that every muxer accepts.
 */
export function buildCoverArgs(input: string, output: string): string[] {
  return ['-y', '-i', input, '-frames:v', '1', '-q:v', '2', '-update', '1', '-f', 'image2', output];
}

/**
 * This function is used for escaping a value for the ffmetadata format.
 */
function escapeMeta(value: string): string {
  return value.replace(/([=;#\\\n])/g, '\\$1');
}

/**
 * This function is used for writing chapters (and title) as an ffmetadata document.
 */
export function buildChaptersMetadata(chapters: Chapter[], durationSec: number, title?: string): string {
  const lines = [';FFMETADATA1'];
  if (title) lines.push(`title=${escapeMeta(title)}`);
  chapters.forEach((chapter, index) => {
    const nextStart = chapters[index + 1]?.startSec ?? durationSec;
    const start = Math.round(chapter.startSec * 1000);
    const end = Math.max(start + 1, Math.round(nextStart * 1000));
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${start}`,
      `END=${end}`,
      `title=${escapeMeta(chapter.title)}`,
    );
  });
  return `${lines.join('\n')}\n`;
}
