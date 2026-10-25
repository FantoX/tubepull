import type { AudioQualityOption, MediaFormat, QualityOption, VideoCodec } from '../types.js';
import { formatAudioCodec, formatVideoCodec } from './compat.js';

const CODEC_RANK: Record<VideoCodec, number> = { av01: 0, vp9: 1, avc1: 2, other: 3 };

/** Portrait quality labels use the shorter side, not raw height. */
export function qualityHeight(format: MediaFormat): number {
  const fromLabel = format.qualityLabel ? Number.parseInt(format.qualityLabel, 10) : Number.NaN;
  if (Number.isFinite(fromLabel) && fromLabel > 0) return fromLabel;
  if (format.width && format.height) return Math.min(format.width, format.height);
  return format.height ?? 0;
}

/** Group frame rates up to 30 fps as standard. */
export function fpsBucket(fps: number | undefined): number {
  const value = Math.round(fps ?? 30);
  return value > 30 ? value : 30;
}

export function qualityLabel(height: number, fps: number, hdr: boolean): string {
  return `${height}p${fps > 30 ? fps : ''}${hdr ? ' HDR' : ''}`;
}

export function estimateSize(format: MediaFormat, durationSec: number): number | undefined {
  if (format.contentLength) return format.contentLength;
  const bitrate = format.avgBitrate ?? format.bitrate;
  if (!bitrate || !durationSec) return undefined;
  return Math.round((bitrate * durationSec) / 8);
}

export function isDownloadable(format: MediaFormat): boolean {
  return Boolean(format.url);
}

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

/** Codec efficiency matters: Opus can beat higher-bitrate AAC as a conversion source. */
export function audioScore(format: MediaFormat): number {
  const bitrate = format.avgBitrate ?? format.bitrate;
  return formatAudioCodec(format) === 'opus' ? bitrate * OPUS_EFFICIENCY : bitrate;
}

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
