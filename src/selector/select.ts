import { InvalidArgumentError, NoSuitableFormatError } from '../errors.js';
import type { AudioFormat, Container, DownloadOptions, MediaFormat, VideoCodec } from '../types.js';
import {
  AUDIO_OUTPUT,
  DEFAULT_CODEC_PREFERENCE,
  formatAudioCodec,
  formatVideoCodec,
  isAudioCopyCompatible,
  isVideoCopyCompatible,
} from './compat.js';
import { audioScore, fpsBucket, isDownloadable, qualityHeight } from './qualities.js';

//---- Section used for quality selector parsing ----

export type ParsedQuality =
  { kind: 'best' } | { kind: 'worst' } | { kind: 'height'; height: number; fps?: number };

const ALIASES: Record<string, number> = { '8k': 4320, '4k': 2160, '2k': 1440, uhd: 2160, fhd: 1080, hd: 720 };

/**
 * This function is used for parsing a quality selector (`best`, `worst`, `1080p`, `720p60`, `4k`).
 */
export function parseQuality(selector: string | undefined): ParsedQuality {
  const value = (selector ?? '').trim().toLowerCase() || 'best';
  if (value === 'best' || value === 'highest') return { kind: 'best' };
  if (value === 'worst' || value === 'lowest') return { kind: 'worst' };
  const alias = ALIASES[value];
  if (alias) return { kind: 'height', height: alias };
  const match = /^(\d{2,4})(?:p(\d{2,3})?)?$/.exec(value);
  if (!match) {
    throw new InvalidArgumentError(`Invalid quality "${selector}". Use best, worst, 1080p, 720p60, ...`);
  }
  const height = Number(match[1]);
  const fps = match[2] ? Number(match[2]) : undefined;
  return fps === undefined ? { kind: 'height', height } : { kind: 'height', height, fps };
}

//---- Section used for format selection ----

export interface VideoPlan {
  kind: 'video';
  /** Video-only or muxed format. */
  video: MediaFormat;
  /** Separate audio to merge; absent when `video` is muxed. */
  audio?: MediaFormat;
  container: Container;
  transcodeVideo: boolean;
  transcodeAudio: boolean;
  warnings: string[];
}

export interface AudioPlan {
  kind: 'audio';
  /** Audio-only format, or a muxed one when no audio-only stream exists. */
  audio: MediaFormat;
  format: AudioFormat;
  ext: string;
  /** False when the source can be written as-is or stream-copied. */
  transcode: boolean;
  /** No ffmpeg needed at all: the downloaded file is the output. */
  passthrough: boolean;
  warnings: string[];
}

export type SelectionPlan = VideoPlan | AudioPlan;

type SelectOptions = Pick<
  DownloadOptions,
  | 'type'
  | 'quality'
  | 'strict'
  | 'hdr'
  | 'container'
  | 'codecPreference'
  | 'allowTranscode'
  | 'audioFormat'
  | 'audioLanguage'
  | 'videoItag'
  | 'audioItag'
>;

/**
 * This function is used for resolving the best video + audio format pair (or audio-only format)
 * for the requested quality, container and codecs, deciding stream copy vs transcode.
 */
export function selectFormats(formats: MediaFormat[], options: SelectOptions = {}): SelectionPlan {
  const usable = formats.filter(isDownloadable);
  if (usable.length === 0) {
    const sabrOnly = formats.length > 0 && formats.every((f) => f.sabr);
    throw new NoSuitableFormatError(
      sabrOnly
        ? 'YouTube only offered streaming (SABR) formats for this video, which tubepull cannot download yet.'
        : 'No downloadable formats were returned for this video.',
      sabrOnly ? { hint: 'Try other clients (clients option), cookies, or a PO token (--po-token).' } : {},
    );
  }
  return (options.type ?? 'video') === 'audio' ? selectAudio(usable, options) : selectVideo(usable, options);
}

function findItag(formats: MediaFormat[], itag: number, what: string): MediaFormat {
  const format = formats.find((f) => f.itag === itag);
  if (!format) {
    const available = formats.map((f) => f.itag).join(', ');
    throw new NoSuitableFormatError(`${what} itag ${itag} is not available. Available itags: ${available}`);
  }
  return format;
}

function selectVideo(formats: MediaFormat[], options: SelectOptions): VideoPlan {
  const warnings: string[] = [];
  const requested: Container = options.container ?? 'mp4';
  const prefs = options.codecPreference ?? DEFAULT_CODEC_PREFERENCE[requested];

  let video: MediaFormat;
  if (options.videoItag !== undefined) {
    video = findItag(formats, options.videoItag, 'Video');
    if (video.kind === 'audio') throw new InvalidArgumentError(`itag ${video.itag} is audio-only.`);
  } else {
    const group = pickVideoGroup(formats, options, warnings);
    video = rankVideo(group, requested, prefs)[0] as MediaFormat;
  }

  let container = requested;
  let transcodeVideo = false;
  const vcodec = formatVideoCodec(video);
  if (!isVideoCopyCompatible(container, vcodec)) {
    if (options.allowTranscode) {
      transcodeVideo = true;
      warnings.push(`Re-encoding ${vcodec} video for ${container} (allowTranscode). This is slow.`);
    } else {
      warnings.push(`${vcodec} video cannot be copied into ${container}; saving as mkv instead.`);
      container = 'mkv';
    }
  }

  let audio: MediaFormat | undefined;
  if (options.audioItag !== undefined) {
    audio = findItag(formats, options.audioItag, 'Audio');
    if (audio.kind === 'video') throw new InvalidArgumentError(`itag ${audio.itag} has no audio.`);
  } else if (video.kind !== 'muxed') {
    audio = pickAudio(
      formats,
      options.audioLanguage,
      (codec) => isAudioCopyCompatible(container, codec),
      warnings,
    );
    if (!audio) warnings.push('No audio stream found; the output will be silent.');
  }

  let transcodeAudio = false;
  const audioCodec = audio
    ? formatAudioCodec(audio)
    : video.kind === 'muxed'
      ? formatAudioCodec(video)
      : undefined;
  if (audioCodec && !isAudioCopyCompatible(container, audioCodec)) {
    if (options.allowTranscode || transcodeVideo) {
      transcodeAudio = true;
    } else {
      warnings.push(`${audioCodec} audio cannot be copied into ${container}; saving as mkv instead.`);
      container = 'mkv';
    }
  }

  const plan: VideoPlan = { kind: 'video', video, container, transcodeVideo, transcodeAudio, warnings };
  if (audio) plan.audio = audio;
  return plan;
}

/**
 * This function is used for narrowing video formats to one (height, fps, HDR) group per the selector,
 * falling back to the nearest lower height unless `strict`.
 */
function pickVideoGroup(formats: MediaFormat[], options: SelectOptions, warnings: string[]): MediaFormat[] {
  let candidates = formats.filter((f) => f.kind === 'video' && qualityHeight(f) > 0);
  if (candidates.length === 0) candidates = formats.filter((f) => f.kind === 'muxed' && qualityHeight(f) > 0);
  if (candidates.length === 0)
    throw new NoSuitableFormatError('No video formats are available for this video.');

  if (options.hdr) {
    const hdr = candidates.filter((f) => f.hdr);
    if (hdr.length) candidates = hdr;
    else warnings.push('No HDR streams available; using SDR.');
  } else {
    const sdr = candidates.filter((f) => !f.hdr);
    if (sdr.length) candidates = sdr;
  }

  const quality = parseQuality(options.quality);
  const heights = [...new Set(candidates.map(qualityHeight))].sort((a, b) => b - a);
  let height: number;
  if (quality.kind === 'best') height = heights[0] as number;
  else if (quality.kind === 'worst') height = heights.at(-1) as number;
  else if (heights.includes(quality.height)) height = quality.height;
  else {
    const list = heights.map((h) => `${h}p`).join(', ');
    if (options.strict)
      throw new NoSuitableFormatError(`${quality.height}p is not available. Available: ${list}`);
    height = heights.find((h) => h < quality.height) ?? (heights.at(-1) as number);
    warnings.push(`${quality.height}p is not available; using ${height}p.`);
  }

  const atHeight = candidates.filter((f) => qualityHeight(f) === height);
  const fpsValues = [...new Set(atHeight.map((f) => fpsBucket(f.fps)))].sort((a, b) => b - a);
  let fps: number;
  if (quality.kind === 'height' && quality.fps !== undefined) {
    const wanted = fpsBucket(quality.fps);
    if (fpsValues.includes(wanted)) fps = wanted;
    else {
      if (options.strict) {
        throw new NoSuitableFormatError(
          `${height}p${quality.fps} is not available. Frame rates at ${height}p: ${fpsValues.join(', ')}`,
        );
      }
      fps = fpsValues.find((v) => v <= wanted) ?? (fpsValues.at(-1) as number);
      warnings.push(`${height}p${quality.fps} is not available; using ${height}p${fps > 30 ? fps : ''}.`);
    }
  } else {
    fps = (quality.kind === 'worst' ? fpsValues.at(-1) : fpsValues[0]) as number;
  }
  return atHeight.filter((f) => fpsBucket(f.fps) === fps);
}

/**
 * This function is used for ordering formats of one quality group: copy-compatible with the container
 * first, then codec preference, then bitrate.
 */
function rankVideo(group: MediaFormat[], container: Container, prefs: readonly VideoCodec[]): MediaFormat[] {
  const prefIndex = (codec: VideoCodec) => {
    const index = prefs.indexOf(codec);
    return index === -1 ? prefs.length : index;
  };
  return [...group].sort((a, b) => {
    const ca = formatVideoCodec(a);
    const cb = formatVideoCodec(b);
    return (
      Number(isVideoCopyCompatible(container, cb)) - Number(isVideoCopyCompatible(container, ca)) ||
      prefIndex(ca) - prefIndex(cb) ||
      Number(a.kind === 'muxed') - Number(b.kind === 'muxed') ||
      (b.avgBitrate ?? b.bitrate) - (a.avgBitrate ?? a.bitrate)
    );
  });
}

/**
 * This function is used for matching an audio track against a language id or name (`en`, `de.3`, `German`).
 */
function matchesLanguage(format: MediaFormat, language: string): boolean {
  const track = format.audioTrack;
  if (!track) return false;
  const wanted = language.toLowerCase();
  const id = track.id.toLowerCase();
  return id === wanted || id.split('.')[0] === wanted || track.name.toLowerCase().includes(wanted);
}

/**
 * This function is used for picking the best audio-only format: requested language (or the default
 * track), preferred codec, non-DRC, highest bitrate.
 */
function pickAudio(
  formats: MediaFormat[],
  language: string | undefined,
  preferCodec: (codec: ReturnType<typeof formatAudioCodec>) => boolean,
  warnings: string[],
): MediaFormat | undefined {
  let audios = formats.filter((f) => f.kind === 'audio');
  if (audios.length === 0) return undefined;

  if (language) {
    const matching = audios.filter((f) => matchesLanguage(f, language));
    if (matching.length) audios = matching;
    else {
      const available = [...new Set(audios.map((f) => f.audioTrack?.id).filter(Boolean))].join(', ');
      warnings.push(
        `Audio language "${language}" not found${available ? ` (available: ${available})` : ''}; using the default track.`,
      );
    }
  }
  if (!language || audios.every((f) => !matchesLanguage(f, language))) {
    const defaults = audios.filter((f) => !f.audioTrack || f.audioTrack.isDefault);
    if (defaults.length) audios = defaults;
  }

  return [...audios].sort(
    (a, b) =>
      Number(preferCodec(formatAudioCodec(b))) - Number(preferCodec(formatAudioCodec(a))) ||
      Number(Boolean(a.isDrc)) - Number(Boolean(b.isDrc)) ||
      audioScore(b) - audioScore(a),
  )[0];
}

function selectAudio(formats: MediaFormat[], options: SelectOptions): AudioPlan {
  const warnings: string[] = [];
  const format: AudioFormat = options.audioFormat ?? 'm4a';
  const output = format === 'original' ? undefined : AUDIO_OUTPUT[format];
  if (format !== 'original' && !output) throw new InvalidArgumentError(`Unknown audio format "${format}".`);

  let audio: MediaFormat | undefined;
  if (options.audioItag !== undefined) {
    audio = findItag(formats, options.audioItag, 'Audio');
    if (audio.kind === 'video') throw new InvalidArgumentError(`itag ${audio.itag} has no audio.`);
  } else {
    // Lossy targets are transcoded anyway, so take the best source regardless of codec.
    const copyFrom = output?.copyFrom;
    audio = pickAudio(formats, options.audioLanguage, (codec) => codec === copyFrom, warnings);
    if (!audio) {
      audio = [...formats]
        .filter((f) => f.kind === 'muxed')
        .sort((a, b) => (b.avgBitrate ?? b.bitrate) - (a.avgBitrate ?? a.bitrate))[0];
      if (!audio) throw new NoSuitableFormatError('No audio formats are available for this video.');
      warnings.push('No audio-only stream available; extracting audio from a combined stream.');
    }
  }

  const codec = formatAudioCodec(audio);
  if (format === 'original') {
    if (audio.kind === 'muxed') {
      // A muxed file is not "audio"; copy the track out into m4a instead.
      return {
        kind: 'audio',
        audio,
        format: 'm4a',
        ext: 'm4a',
        transcode: codec !== 'mp4a',
        passthrough: false,
        warnings,
      };
    }
    const ext = audio.container === 'webm' ? 'webm' : 'm4a';
    return { kind: 'audio', audio, format, ext, transcode: false, passthrough: true, warnings };
  }

  const out = output as { ext: string; copyFrom?: ReturnType<typeof formatAudioCodec> };
  const transcode = out.copyFrom === undefined || out.copyFrom !== codec;
  return { kind: 'audio', audio, format, ext: out.ext, transcode, passthrough: false, warnings };
}
