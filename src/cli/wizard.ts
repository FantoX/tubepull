import * as p from '@clack/prompts';
import { spawn } from 'node:child_process';
import { AbortError } from '../errors.js';
import { selectFormats } from '../selector/select.js';
import type { AudioFormat, Container, DownloadOptions, QualitySelector, VideoInfo } from '../types.js';
import { formatBytes } from '../utils/bytes.js';
import { formatDuration, parseTime } from '../utils/time.js';
import { parseTarget } from '../utils/url.js';
import { DEFAULT_FILENAME_TEMPLATE } from '../TubePull.js';
import { plural } from './output.js';

const LOSSY_BITRATES = ['128k', '192k', '256k', '320k'];

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    throw new AbortError('Cancelled by user');
  }
  return value as Exclude<T, symbol>;
}

export async function askUrl(): Promise<string> {
  const url = unwrap(
    await p.text({
      message: 'Paste a YouTube link',
      placeholder: 'https://www.youtube.com/watch?v=…',
      validate: (value) => {
        const target = parseTarget(value ?? '');
        return target.videoId || target.playlistId
          ? undefined
          : 'That does not look like a YouTube video or playlist link.';
      },
    }),
  );
  return url.trim();
}

function containerHint(info: VideoInfo, base: DownloadOptions, container: Container): string | undefined {
  try {
    const plan = selectFormats(info.formats, { ...base, type: 'video', container });
    if (plan.kind === 'video' && plan.container !== container)
      return `codecs don't fit; will be saved as ${plan.container}`;
  } catch {
    return undefined;
  }
  return container === 'mp4'
    ? 'plays everywhere'
    : container === 'mkv'
      ? 'any codec, best quality'
      : 'VP9/AV1 + Opus';
}

export async function chooseDownloadOptions(
  info: VideoInfo,
  base: DownloadOptions,
): Promise<DownloadOptions> {
  const options: DownloadOptions = { ...base };

  options.type = unwrap(
    await p.select<'video' | 'audio'>({
      message: 'What do you want?',
      options: [
        { value: 'video', label: 'Video', hint: 'with audio' },
        { value: 'audio', label: 'Audio only' },
      ],
      initialValue: base.type ?? 'video',
    }),
  );

  if (options.type === 'video') {
    if (info.qualities.length === 0) throw new AbortError('No video qualities are available for this video.');
    const choice = unwrap(
      await p.select<number>({
        message: 'Quality',
        options: info.qualities.map((q, index) => ({
          value: index,
          label: q.label,
          hint: [q.codecs.join('/'), q.estSizeBytes ? `~${formatBytes(q.estSizeBytes)}` : '']
            .filter(Boolean)
            .join(' · '),
        })),
        initialValue: 0,
        maxItems: 10,
      }),
    );
    const quality = info.qualities[choice];
    if (quality) {
      options.quality = `${quality.height}p${quality.fps > 30 ? quality.fps : ''}` as QualitySelector;
      options.hdr = quality.hdr;
      options.strict = true;
    }
    options.container = unwrap(
      await p.select<Container>({
        message: 'Container',
        options: (['mp4', 'mkv', 'webm'] as const).map((c) => {
          const hint = containerHint(info, options, c);
          return hint ? { value: c, label: c, hint } : { value: c, label: c };
        }),
        initialValue: base.container ?? 'mp4',
      }),
    );
  } else {
    const best = info.audioQualities[0];
    options.audioFormat = unwrap(
      await p.select<AudioFormat>({
        message: 'Audio format',
        options: [
          { value: 'mp3', label: 'mp3', hint: 'plays everywhere (re-encoded)' },
          { value: 'm4a', label: 'm4a', hint: 'AAC, usually no re-encode' },
          { value: 'opus', label: 'opus', hint: 'best quality per size, usually no re-encode' },
          { value: 'flac', label: 'flac', hint: 'lossless container (from lossy source)' },
          { value: 'wav', label: 'wav', hint: 'uncompressed' },
          { value: 'original', label: 'original', hint: best ? `as served: ${best.label}` : 'as served' },
        ],
        initialValue: base.audioFormat ?? 'mp3',
      }),
    );
    let transcodes = options.audioFormat === 'mp3';
    try {
      const plan = selectFormats(info.formats, { ...options, type: 'audio' });
      transcodes =
        plan.kind === 'audio' &&
        plan.transcode &&
        options.audioFormat !== 'flac' &&
        options.audioFormat !== 'wav';
    } catch {
      // Selection errors surface again (with details) when the download starts.
    }
    if (transcodes) {
      options.audioBitrate = unwrap(
        await p.select<string>({
          message: 'Bitrate',
          options: LOSSY_BITRATES.map((b) => ({ value: b, label: b })),
          initialValue: base.audioBitrate ?? '192k',
        }),
      );
    }
  }

  options.outputDir = unwrap(
    await p.text({
      message: 'Save to folder',
      initialValue: base.outputDir ?? process.cwd(),
      validate: (value) => (value?.trim() ? undefined : 'Enter a folder'),
    }),
  ).trim();
  options.filename = unwrap(
    await p.text({
      message: 'Filename',
      initialValue: base.filename ?? DEFAULT_FILENAME_TEMPLATE,
      validate: (value) => (value?.trim() ? undefined : 'Enter a filename template'),
    }),
  ).trim();

  const extras = unwrap(
    await p.multiselect<'trim' | 'metadata' | 'thumbnail'>({
      message: 'Extras (space to toggle, enter to confirm)',
      options: [
        { value: 'metadata', label: 'Embed metadata', hint: 'title, channel, date, chapters' },
        {
          value: 'thumbnail',
          label: 'Embed thumbnail',
          hint: options.type === 'video' ? 'mp4/mkv' : 'mp3/m4a/flac',
        },
        { value: 'trim', label: 'Trim to a time range' },
      ],
      initialValues: options.type === 'audio' ? ['metadata', 'thumbnail'] : ['metadata'],
      required: false,
    }),
  );
  options.embedMetadata = extras.includes('metadata');
  options.embedThumbnail = extras.includes('thumbnail');

  if (extras.includes('trim')) {
    const validateTime = (value: string | undefined) => {
      if (!value?.trim()) return undefined;
      try {
        const sec = parseTime(value);
        return info.durationSec && sec > info.durationSec
          ? `The video is ${formatDuration(info.durationSec)} long`
          : undefined;
      } catch (error) {
        return (error as Error).message;
      }
    };
    const start = unwrap(
      await p.text({ message: 'Start (e.g. 1:30)', placeholder: '0:00', validate: validateTime }),
    );
    const end = unwrap(
      await p.text({
        message: 'End (empty = to the end)',
        placeholder: formatDuration(info.durationSec),
        validate: validateTime,
      }),
    );
    options.range = {};
    if (start?.trim()) options.range.start = start.trim();
    if (end?.trim()) options.range.end = end.trim();
  }
  return options;
}

export async function chooseBatchOptions(count: number, base: DownloadOptions): Promise<DownloadOptions> {
  const options: DownloadOptions = { ...base };
  p.log.info(plural(count, 'video'));
  options.type = unwrap(
    await p.select<'video' | 'audio'>({
      message: 'What do you want for each video?',
      options: [
        { value: 'video', label: 'Video', hint: 'with audio' },
        { value: 'audio', label: 'Audio only' },
      ],
    }),
  );
  if (options.type === 'video') {
    options.quality = unwrap(
      await p.select<QualitySelector>({
        message: 'Maximum quality (lower is used when a video does not have it)',
        options: (['best', '2160p', '1440p', '1080p', '720p', '480p', '360p'] as const).map((q) => ({
          value: q,
          label: q,
        })),
        initialValue: '1080p',
      }),
    );
    options.container = unwrap(
      await p.select<Container>({
        message: 'Container',
        options: [
          { value: 'mp4', label: 'mp4', hint: 'switches to mkv when codecs do not fit' },
          { value: 'mkv', label: 'mkv' },
          { value: 'webm', label: 'webm' },
        ],
      }),
    );
  } else {
    options.audioFormat = unwrap(
      await p.select<AudioFormat>({
        message: 'Audio format',
        options: (['mp3', 'm4a', 'opus', 'flac', 'wav', 'original'] as const).map((f) => ({
          value: f,
          label: f,
        })),
      }),
    );
  }
  options.outputDir = unwrap(
    await p.text({ message: 'Save to folder', initialValue: base.outputDir ?? process.cwd() }),
  ).trim();
  options.skipExisting = true;
  return options;
}

export async function offerOpenFolder(folder: string): Promise<void> {
  const open = await p.confirm({ message: 'Open the folder?', initialValue: false });
  if (p.isCancel(open) || !open) return;
  const command =
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(command, [folder], { detached: true, stdio: 'ignore', windowsHide: false })
      .on('error', () => {})
      .unref();
  } catch {
    // Opening a file manager is a convenience; ignore failures (e.g. headless systems).
  }
}

export { p as prompts };
