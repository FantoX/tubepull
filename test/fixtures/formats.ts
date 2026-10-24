import type { MediaFormat } from '../../src/types.js';

// A realistic adaptive format list (itags, codecs and bitrates as YouTube serves them for a 4K60 upload),
// already normalised. Durations assume a 600 s video.

const U = (itag: number) =>
  `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${itag}&expire=9999999999`;

function video(
  itag: number,
  container: 'mp4' | 'webm',
  vcodec: string,
  height: number,
  fps: number,
  bitrate: number,
  extra: Partial<MediaFormat> = {},
): MediaFormat {
  const width = Math.round((height * 16) / 9);
  const label = `${height}p${fps > 30 ? fps : ''}${extra.hdr ? ' HDR' : ''}`;
  return {
    itag,
    url: U(itag),
    kind: 'video',
    container,
    mimeType: `video/${container}; codecs="${vcodec}"`,
    vcodec,
    width,
    height,
    fps,
    qualityLabel: label,
    bitrate,
    avgBitrate: Math.round(bitrate * 0.8),
    contentLength: Math.round((bitrate * 0.8 * 600) / 8),
    ...extra,
  };
}

function audio(
  itag: number,
  container: 'm4a' | 'webm',
  acodec: string,
  bitrate: number,
  extra: Partial<MediaFormat> = {},
): MediaFormat {
  return {
    itag,
    url: U(itag),
    kind: 'audio',
    container,
    mimeType: `audio/${container === 'm4a' ? 'mp4' : 'webm'}; codecs="${acodec}"`,
    acodec,
    bitrate,
    avgBitrate: Math.round(bitrate * 0.95),
    contentLength: Math.round((bitrate * 0.95 * 600) / 8),
    audioSampleRate: 48000,
    audioChannels: 2,
    ...extra,
  };
}

export const MUXED_18: MediaFormat = {
  itag: 18,
  url: U(18),
  kind: 'muxed',
  container: 'mp4',
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  vcodec: 'avc1.42001E',
  acodec: 'mp4a.40.2',
  width: 640,
  height: 360,
  fps: 30,
  qualityLabel: '360p',
  bitrate: 500_000,
  avgBitrate: 450_000,
  contentLength: 33_750_000,
};

export const FULL_LIST: MediaFormat[] = [
  MUXED_18,
  // H.264
  video(160, 'mp4', 'avc1.4d400c', 144, 30, 110_000),
  video(133, 'mp4', 'avc1.4d4015', 240, 30, 250_000),
  video(134, 'mp4', 'avc1.4d401e', 360, 30, 650_000),
  video(135, 'mp4', 'avc1.4d401f', 480, 30, 1_200_000),
  video(136, 'mp4', 'avc1.4d401f', 720, 30, 2_300_000),
  video(298, 'mp4', 'avc1.4d4020', 720, 60, 3_500_000),
  video(137, 'mp4', 'avc1.640028', 1080, 30, 4_400_000),
  video(299, 'mp4', 'avc1.64002a', 1080, 60, 6_000_000),
  // VP9
  video(278, 'webm', 'vp9', 144, 30, 95_000),
  video(242, 'webm', 'vp9', 240, 30, 220_000),
  video(243, 'webm', 'vp9', 360, 30, 400_000),
  video(244, 'webm', 'vp9', 480, 30, 750_000),
  video(247, 'webm', 'vp9', 720, 30, 1_500_000),
  video(302, 'webm', 'vp9', 720, 60, 2_700_000),
  video(248, 'webm', 'vp9', 1080, 30, 2_600_000),
  video(303, 'webm', 'vp9', 1080, 60, 4_400_000),
  video(271, 'webm', 'vp9', 1440, 30, 9_000_000),
  video(308, 'webm', 'vp9', 1440, 60, 13_000_000),
  video(313, 'webm', 'vp9', 2160, 30, 18_000_000),
  video(315, 'webm', 'vp9', 2160, 60, 26_000_000),
  // VP9.2 HDR
  video(334, 'webm', 'vp09.02.30.10.01.09.16.09.00', 1080, 60, 5_000_000, { hdr: true }),
  video(336, 'webm', 'vp09.02.40.10.01.09.16.09.00', 1440, 60, 15_000_000, { hdr: true }),
  video(337, 'webm', 'vp09.02.51.10.01.09.16.09.00', 2160, 60, 30_000_000, { hdr: true }),
  // AV1
  video(394, 'mp4', 'av01.0.00M.08', 144, 30, 80_000),
  video(395, 'mp4', 'av01.0.00M.08', 240, 30, 180_000),
  video(396, 'mp4', 'av01.0.01M.08', 360, 30, 350_000),
  video(397, 'mp4', 'av01.0.04M.08', 480, 30, 650_000),
  video(398, 'mp4', 'av01.0.08M.08', 720, 60, 2_200_000),
  video(399, 'mp4', 'av01.0.09M.08', 1080, 60, 3_800_000),
  video(400, 'mp4', 'av01.0.12M.08', 1440, 60, 10_000_000),
  video(401, 'mp4', 'av01.0.13M.08', 2160, 60, 20_000_000),
  // Audio
  audio(139, 'm4a', 'mp4a.40.5', 49_000),
  audio(140, 'm4a', 'mp4a.40.2', 130_000),
  audio(140, 'm4a', 'mp4a.40.2', 130_000, { isDrc: true }),
  audio(249, 'webm', 'opus', 55_000),
  audio(250, 'webm', 'opus', 72_000),
  audio(251, 'webm', 'opus', 140_000),
  audio(251, 'webm', 'opus', 140_000, { isDrc: true }),
];

/** Only VP9 at the top resolutions (no AV1), as many uploads look. */
export const VP9_TOP_LIST: MediaFormat[] = FULL_LIST.filter(
  (f) => !(f.vcodec?.startsWith('av01') && (f.height ?? 0) > 1080),
);

/** A dubbed video with two language tracks. */
export const MULTI_LANGUAGE_LIST: MediaFormat[] = [
  video(137, 'mp4', 'avc1.640028', 1080, 30, 4_400_000),
  audio(140, 'm4a', 'mp4a.40.2', 130_000, {
    audioTrack: { id: 'en.4', name: 'English original', isDefault: true },
  }),
  audio(140, 'm4a', 'mp4a.40.2', 129_000, { audioTrack: { id: 'de.3', name: 'German', isDefault: false } }),
  audio(251, 'webm', 'opus', 140_000, {
    audioTrack: { id: 'en.4', name: 'English original', isDefault: true },
  }),
  audio(251, 'webm', 'opus', 139_000, { audioTrack: { id: 'de.3', name: 'German', isDefault: false } }),
];

/** A portrait short: 1080x1920 labelled 1080p. */
export const SHORTS_LIST: MediaFormat[] = [
  {
    ...video(137, 'mp4', 'avc1.640028', 1080, 30, 4_000_000),
    width: 1080,
    height: 1920,
    qualityLabel: '1080p',
  },
  { ...video(136, 'mp4', 'avc1.4d401f', 720, 30, 2_000_000), width: 720, height: 1280, qualityLabel: '720p' },
  audio(140, 'm4a', 'mp4a.40.2', 130_000),
];

/** Formats whose URLs YouTube withheld (SABR-only client response). */
export const SABR_ONLY_LIST: MediaFormat[] = FULL_LIST.map(({ url: _url, ...rest }) => ({
  ...rest,
  sabr: true,
}));
