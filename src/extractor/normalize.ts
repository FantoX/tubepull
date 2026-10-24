import type { MediaFormat } from '../types.js';

//---- Section used for raw format normalisation ----

/** The subset of a youtubei.js `Format` that normalisation reads (kept structural for testing). */
export interface RawFormat {
  itag: number;
  url?: string;
  signature_cipher?: string;
  cipher?: string;
  mime_type: string;
  bitrate: number;
  average_bitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  quality_label?: string;
  content_length?: number;
  audio_sample_rate?: number;
  audio_channels?: number;
  has_audio: boolean;
  has_video: boolean;
  has_text?: boolean;
  is_type_otf?: boolean;
  drm_families?: string[];
  is_drc?: boolean;
  last_modified_ms?: string;
  audio_track?: { id: string; display_name: string; audio_is_default: boolean };
  color_info?: { transfer_characteristics?: string };
}

export interface ParsedMime {
  type: string;
  subtype: string;
  codecs: string[];
}

const HDR_TRANSFERS = new Set([
  'COLOR_TRANSFER_CHARACTERISTICS_SMPTEST2084',
  'COLOR_TRANSFER_CHARACTERISTICS_ARIB_STD_B67',
]);

/**
 * This function is used for splitting `video/mp4; codecs="avc1.640028, mp4a.40.2"` into its parts.
 */
export function parseMime(mime: string): ParsedMime {
  const [essence = '', ...params] = mime.split(';');
  const [type = '', subtype = ''] = essence.trim().toLowerCase().split('/');
  let codecs: string[] = [];
  for (const param of params) {
    const match = /^\s*codecs\s*=\s*"?([^"]*)"?\s*$/i.exec(param);
    if (match?.[1])
      codecs = match[1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
  }
  return { type, subtype, codecs };
}

/**
 * This function is used for converting one raw format into a MediaFormat, or undefined when it cannot
 * be downloaded at all (DRM, OTF/segmented, captions, unknown container).
 */
export function normalizeFormat(
  raw: RawFormat,
  url: string | undefined,
  sabrAvailable: boolean,
): MediaFormat | undefined {
  if (raw.drm_families?.length) return undefined;
  if (raw.is_type_otf) return undefined;
  if (raw.has_text && !raw.has_audio && !raw.has_video) return undefined;
  if (!raw.has_audio && !raw.has_video) return undefined;

  const mime = parseMime(raw.mime_type);
  if (mime.subtype !== 'mp4' && mime.subtype !== 'webm') return undefined;

  const kind: MediaFormat['kind'] =
    raw.has_video && raw.has_audio ? 'muxed' : raw.has_video ? 'video' : 'audio';
  const container: MediaFormat['container'] =
    mime.subtype === 'webm' ? 'webm' : kind === 'audio' ? 'm4a' : 'mp4';

  const format: MediaFormat = {
    itag: raw.itag,
    kind,
    container,
    mimeType: raw.mime_type,
    bitrate: raw.bitrate,
  };

  if (url) format.url = url;
  else if (sabrAvailable) format.sabr = true;

  if (kind === 'audio') {
    if (mime.codecs[0]) format.acodec = mime.codecs[0];
  } else {
    if (mime.codecs[0]) format.vcodec = mime.codecs[0];
    if (kind === 'muxed' && mime.codecs[1]) format.acodec = mime.codecs[1];
  }

  if (kind !== 'audio') {
    if (raw.width) format.width = raw.width;
    if (raw.height) format.height = raw.height;
    if (raw.fps) format.fps = raw.fps;
    if (raw.quality_label) format.qualityLabel = raw.quality_label;
    const hdr =
      HDR_TRANSFERS.has(raw.color_info?.transfer_characteristics ?? '') ||
      /hdr/i.test(raw.quality_label ?? '');
    if (hdr) format.hdr = true;
  }
  if (kind !== 'video') {
    if (raw.audio_sample_rate) format.audioSampleRate = Number(raw.audio_sample_rate);
    if (raw.audio_channels) format.audioChannels = raw.audio_channels;
    if (raw.is_drc) format.isDrc = true;
    if (raw.audio_track) {
      format.audioTrack = {
        id: raw.audio_track.id,
        name: raw.audio_track.display_name,
        isDefault: raw.audio_track.audio_is_default,
      };
    }
  }
  if (raw.average_bitrate) format.avgBitrate = raw.average_bitrate;
  if (raw.content_length) format.contentLength = Number(raw.content_length);
  if (raw.last_modified_ms) format.lastModified = raw.last_modified_ms;
  return format;
}

/**
 * This function is used for dropping exact duplicates (same itag and audio track) that some clients return.
 */
export function dedupeFormats(formats: MediaFormat[]): MediaFormat[] {
  const seen = new Map<string, MediaFormat>();
  for (const format of formats) {
    const key = `${format.itag}|${format.audioTrack?.id ?? ''}|${format.isDrc ? 1 : 0}`;
    const existing = seen.get(key);
    // Keep the variant that is actually downloadable.
    if (!existing || (!existing.url && format.url)) seen.set(key, format);
  }
  return [...seen.values()];
}
