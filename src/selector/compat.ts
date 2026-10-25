import type { AudioCodec, AudioFormat, Container, MediaFormat, VideoCodec } from '../types.js';

export function videoCodecFamily(codec: string | undefined): VideoCodec {
  const c = (codec ?? '').toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('avc3') || c === 'h264') return 'avc1';
  if (c.startsWith('vp9') || c.startsWith('vp09')) return 'vp9';
  if (c.startsWith('av01') || c === 'av1') return 'av01';
  return 'other';
}

export function audioCodecFamily(codec: string | undefined): AudioCodec {
  const c = (codec ?? '').toLowerCase();
  if (c.startsWith('mp4a') || c === 'aac') return 'mp4a';
  if (c === 'opus') return 'opus';
  if (c === 'ac-3' || c === 'ac3') return 'ac-3';
  if (c === 'ec-3' || c === 'eac3') return 'ec-3';
  return 'other';
}

/** Codecs that can be stream-copied (`-c copy`) into each container with broad player support. */
export const COPY_MATRIX: Record<Container, { video: readonly VideoCodec[]; audio: readonly AudioCodec[] }> =
  {
    mp4: { video: ['avc1', 'av01'], audio: ['mp4a', 'ac-3', 'ec-3'] },
    webm: { video: ['vp9', 'av01'], audio: ['opus'] },
    mkv: { video: ['avc1', 'vp9', 'av01', 'other'], audio: ['mp4a', 'opus', 'ac-3', 'ec-3', 'other'] },
  };

/** Default video codec preference per container, best first. */
export const DEFAULT_CODEC_PREFERENCE: Record<Container, readonly VideoCodec[]> = {
  // H.264 first for maximum player compatibility, then AV1.
  mp4: ['avc1', 'av01', 'vp9'],
  webm: ['vp9', 'av01', 'avc1'],
  mkv: ['vp9', 'av01', 'avc1'],
};

export function isVideoCopyCompatible(container: Container, codec: VideoCodec): boolean {
  return COPY_MATRIX[container].video.includes(codec);
}

export function isAudioCopyCompatible(container: Container, codec: AudioCodec): boolean {
  return COPY_MATRIX[container].audio.includes(codec);
}

export function formatVideoCodec(format: MediaFormat): VideoCodec {
  return videoCodecFamily(format.vcodec);
}

export function formatAudioCodec(format: MediaFormat): AudioCodec {
  return audioCodecFamily(format.acodec);
}

/** File extension and the source codec that allows a lossless copy, per audio output format. */
export const AUDIO_OUTPUT: Record<
  Exclude<AudioFormat, 'original'>,
  { ext: string; copyFrom?: AudioCodec }
> = {
  m4a: { ext: 'm4a', copyFrom: 'mp4a' },
  opus: { ext: 'opus', copyFrom: 'opus' },
  mp3: { ext: 'mp3' },
  flac: { ext: 'flac' },
  wav: { ext: 'wav' },
};
