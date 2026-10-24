import type { AudioQualityOption, MediaFormat, QualityOption, VideoCodec } from '../types.js';
import { formatAudioCodec, formatVideoCodec } from './compat.js';

//---- Section used for quality grouping ----

const CODEC_RANK: Record<VideoCodec, number> = { av01: 0, vp9: 1, avc1: 2, other: 3 };

/**
 * This function is used for the "p" value of a video format. YouTube labels portrait videos by
 * their shorter side (a 1080×1920 short is "1080p"), so the label wins over raw height.
 */
export function qualityHeight(format: MediaFormat): number {
  const fromLabel = format.qualityLabel ? Number.parseInt(format.qualityLabel, 10) : Number.NaN;
  if (Number.isFinite(fromLabel) && fromLabel > 0) return fromLabel;
  if (format.width && format.height) return Math.min(format.width, format.height);
  return format.height ?? 0;
}

/**
 * This function is used for the frame rate used in labels/grouping: anything ≤ 30 fps is "standard".
 */
export function fpsBucket(fps: number | undefined): number {
  const value = Math.round(fps ?? 30);
  return value > 30 ? value : 30;
}

/**
 * This function is used for the human label of a quality, e.g. `1080p60 HDR`.
 */
export function qualityLabel(height: number, fps: number, hdr: boolean): string {
  return `${height}p${fps > 30 ? fps : ''}${hdr ? ' HDR' : ''}`;
}

/**
 * This function is used for estimating a stream's size from its length or bitrate × duration.
 */
export function estimateSize(format: MediaFormat, durationSec: number): number | undefined {
  if (format.contentLength) return format.contentLength;
  const bitrate = format.avgBitrate ?? format.bitrate;
  if (!bitrate || !durationSec) return undefined;
  return Math.round((bitrate * durationSec) / 8);
}

/**
 * This function is used for whether a format can be downloaded with the engine (has a direct URL).
 */
export function isDownloadable(format: MediaFormat): boolean {
  return Boolean(format.url);
}

/**
 * This function is used for grouping video formats into de-duplicated qualities, best first:
 * by height, then frame rate, then HDR — listing the codecs available at each.
 */
export function buildQualities(formats: MediaFormat[], durationSec: number): QualityOption[] {
  const usable = formats.some(isDownloadable) ? formats.filter(isDownloadable) : formats;
  const videos = usable.filter((f) => f.kind !== 'audio' && qualityHeight(f) > 0);
  const bestAudio = buildAudioQualities(usable, durationSec)[0];

  const groups = new Map<string, MediaFormat[]>();
  for (const format of videos) {
    const key = `${qualityHeight(format)}|${fpsBucket(format.fps)}|${format.hdr ? 1 : 0}`;
    const list = groups.get(key);
    if (list) list.push(format);
    else groups.set(key, [format]);
  }

  const options: QualityOption[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const height = qualityHeight(first);
    const fps = fpsBucket(first.fps);
    const hdr = Boolean(first.hdr);
    const codecs = [...new Set(group.map(formatVideoCodec))].sort((a, b) => CODEC_RANK[a] - CODEC_RANK[b]);
    const sizes = group.map((f) => estimateSize(f, durationSec)).filter((n): n is number => n !== undefined);
    const hasSeparateAudio = group.some((f) => f.kind === 'video');
    const audioSize = hasSeparateAudio ? (bestAudio?.estSizeBytes ?? 0) : 0;
    const option: QualityOption = {
      label: qualityLabel(height, fps, hdr),
      height,
      fps,
      hdr,
      codecs,
      itags: group.map((f) => f.itag),
    };
    const width = first.width && first.height ? Math.max(first.width, first.height) : first.width;
    if (width !== undefined) option.width = width;
    if (sizes.length) option.estSizeBytes = Math.max(...sizes) + audioSize;
    options.push(option);
  }

  return options.sort((a, b) => b.height - a.height || b.fps - a.fps || Number(b.hdr) - Number(a.hdr));
}

/** Opus reaches AAC's quality at roughly 80% of the bitrate, so it ranks as if it had 25% more. */
const OPUS_EFFICIENCY = 1.25;

/**
 * This function is used for ranking audio sources by perceived quality: bitrate, adjusted for codec
 * efficiency (a 127 kbps Opus stream beats a 130 kbps AAC one as the source for an mp3).
 */
export function audioScore(format: MediaFormat): number {
  const bitrate = format.avgBitrate ?? format.bitrate;
  return formatAudioCodec(format) === 'opus' ? bitrate * OPUS_EFFICIENCY : bitrate;
}

/**
 * This function is used for listing audio-only formats, best first (default track, non-DRC, quality).
 */
export function buildAudioQualities(formats: MediaFormat[], durationSec: number): AudioQualityOption[] {
  const usable = formats.some(isDownloadable) ? formats.filter(isDownloadable) : formats;
  const audios = usable.filter((f) => f.kind === 'audio');
  const multiLanguage = new Set(audios.map((f) => f.audioTrack?.id).filter(Boolean)).size > 1;

  return [...audios]
    .sort(
      (a, b) =>
        Number(b.audioTrack ? b.audioTrack.isDefault : true) -
          Number(a.audioTrack ? a.audioTrack.isDefault : true) ||
        Number(Boolean(a.isDrc)) - Number(Boolean(b.isDrc)) ||
        audioScore(b) - audioScore(a),
    )
    .map((f): AudioQualityOption => {
      const codec = formatAudioCodec(f);
      const kbps = Math.round((f.avgBitrate ?? f.bitrate) / 1000);
      const codecName = codec === 'mp4a' ? 'aac' : codec;
      const lang = multiLanguage && f.audioTrack ? ` ${f.audioTrack.name}` : '';
      const option: AudioQualityOption = {
        label: `${kbps}kbps ${codecName}${f.isDrc ? ' (DRC)' : ''}${lang}`,
        itag: f.itag,
        codec,
        container: f.container === 'webm' ? 'webm' : 'm4a',
        bitrateKbps: kbps,
        isDefault: f.audioTrack ? f.audioTrack.isDefault : true,
        isDrc: Boolean(f.isDrc),
      };
      if (f.audioSampleRate) option.sampleRate = f.audioSampleRate;
      if (f.audioChannels) option.channels = f.audioChannels;
      if (f.audioTrack) option.language = f.audioTrack.id;
      const size = estimateSize(f, durationSec);
      if (size !== undefined) option.estSizeBytes = size;
      return option;
    });
}
