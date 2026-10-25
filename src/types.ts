import type { Extractor } from './extractor/Extractor.js';

export type MediaType = 'video' | 'audio';

/** Use best/worst or resolution labels such as 1080p and 720p60; missing qualities fall back unless strict. */
export type QualitySelector = 'best' | 'worst' | `${number}p` | `${number}p${number}`;

export type Container = 'mp4' | 'webm' | 'mkv';

/** Output format for audio downloads. `original` keeps the source file untouched (no ffmpeg). */
export type AudioFormat = 'm4a' | 'opus' | 'mp3' | 'flac' | 'wav' | 'original';

export type VideoCodec = 'avc1' | 'vp9' | 'av01' | 'other';

export type AudioCodec = 'mp4a' | 'opus' | 'ac-3' | 'ec-3' | 'other';

export interface Thumbnail {
  url: string;
  width: number;
  height: number;
}

export interface Chapter {
  title: string;
  startSec: number;
}

export interface AudioTrack {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface MediaFormat {
  itag: number;
  /** Direct URL. Absent when the format is only reachable over SABR. */
  url?: string;

  sabr?: boolean;
  kind: 'video' | 'audio' | 'muxed';
  /** Source container. Audio-only mp4 is reported as `m4a`. */
  container: 'mp4' | 'webm' | 'm4a';
  mimeType: string;
  /** Full codec string from the mime type, e.g. `avc1.640028`. */
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  hdr?: boolean;
  /** YouTube's label, e.g. `1080p60 HDR`. */
  qualityLabel?: string;
  bitrate: number;
  avgBitrate?: number;
  contentLength?: number;
  audioSampleRate?: number;
  audioChannels?: number;
  audioTrack?: AudioTrack;
  /** Dynamic-range-compressed audio variant. */
  isDrc?: boolean;
  /** Last-modified marker; changes when YouTube re-encodes the stream. */
  lastModified?: string;
}

export interface QualityOption {
  /** e.g. `2160p60 HDR`, `1080p`, `720p60`. Usable as a `quality` selector (minus the HDR suffix). */
  label: string;
  /** The "p" value (shorter side for portrait videos, as YouTube labels it). */
  height: number;
  width?: number;
  fps: number;
  hdr: boolean;
  /** Codec families available at this quality, best first. */
  codecs: VideoCodec[];
  itags: number[];
  /** Estimated size of the largest video stream plus the best audio, in bytes. */
  estSizeBytes?: number;
}

export interface AudioQualityOption {
  /** e.g. `160kbps opus`. */
  label: string;
  itag: number;
  codec: AudioCodec;
  container: 'm4a' | 'webm';
  bitrateKbps: number;
  sampleRate?: number;
  channels?: number;
  language?: string;
  isDefault: boolean;
  isDrc: boolean;
  estSizeBytes?: number;
}

export interface VideoInfo {
  id: string;
  url: string;
  title: string;
  author: string;
  channelId?: string;
  description: string;
  durationSec: number;
  viewCount?: number;
  uploadDate?: string;
  keywords: string[];
  thumbnails: Thumbnail[];
  isLive: boolean;
  isUpcoming: boolean;
  chapters: Chapter[];
  /** Normalised raw list. DRM, OTF and unplayable formats are already removed. */
  formats: MediaFormat[];
  /** Grouped, de-duplicated, best first. */
  qualities: QualityOption[];
  /** Best first. */
  audioQualities: AudioQualityOption[];
  /** Which extractor client produced the formats (diagnostics). */
  client?: string;
}

export interface PlaylistEntry {
  id: string;
  title: string;
  author?: string;
  durationSec?: number;
}

export interface PlaylistInfo {
  id: string;
  title: string;
  author?: string;
  entries: PlaylistEntry[];
}

export interface TimeRange {
  /** Seconds, or `HH:MM:SS(.ms)` / `MM:SS`. */
  start?: string | number;
  end?: string | number;
}

export interface DownloadOptions {
  /** Default `'video'`. */
  type?: MediaType;
  /** Default `'best'`. */
  quality?: QualitySelector;
  /** Throw instead of falling back to the nearest lower quality. */
  strict?: boolean;
  /** Prefer HDR streams when available. Default `false` (SDR preferred). */
  hdr?: boolean;
  /** Default mp4; incompatible codecs switch to mkv unless transcoding is allowed. */
  container?: Container;
  /** Video codec preference, best first. Overrides the per-container default. */
  codecPreference?: VideoCodec[];
  /** Re-encode instead of switching container when codecs are incompatible. Slow. */
  allowTranscode?: boolean;
  /** For `type: 'audio'`. Default `'m4a'`. */
  audioFormat?: AudioFormat;
  /** Bitrate used when transcoding audio (`mp3`, `m4a` from opus, ...). Default `'192k'`. */
  audioBitrate?: string;
  /** Audio language track id or name (e.g. `'en'`, `'de.3'`). Default: the original track. */
  audioLanguage?: string;

  videoItag?: number;

  audioItag?: number;

  range?: TimeRange;
  /** Default: current working directory. */
  outputDir?: string;
  /** Filename template without extension. Default: {title} [{id}]. Available tokens are listed in docs/API.md. */
  filename?: string;
  /** Replace an existing output file. Default `false` (throws `FileExistsError`). */
  overwrite?: boolean;
  /** Return early (result `skipped: true`) instead of throwing when the output already exists. */
  skipExisting?: boolean;
  /** Write title/artist/date/description/chapters into the file. Default `true`. */
  embedMetadata?: boolean;
  /** Embed the thumbnail as cover art where the container supports it. Default `true`. */
  embedThumbnail?: boolean;
  /** Bytes per HTTP range request. Default 10 MiB. */
  chunkSize?: number;
  /** Retries per chunk without progress. Default 5. */
  retries?: number;
  signal?: AbortSignal;
  /** Per-download progress callback (in addition to the `progress` event). */
  onProgress?: (event: ProgressEvent) => void;
}

export interface StreamOptions {
  type?: MediaType;
  quality?: QualitySelector;
  itag?: number;
  audioLanguage?: string;
  chunkSize?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface DownloadResult {
  path: string;
  /** True when `skipExisting` found the output already present; nothing was downloaded. */
  skipped?: boolean;
  sizeBytes: number;
  container: string;
  video?: MediaFormat;
  audio?: MediaFormat;
  info: VideoInfo;
  durationMs: number;
  warnings: string[];
}

export interface BatchItemResult {
  input: string;
  ok: boolean;
  result?: DownloadResult;
  error?: Error;
}

export type Stage = 'info' | 'video' | 'audio' | 'thumbnail' | 'merge' | 'convert' | 'done';

export interface ProgressEvent {
  videoId: string;
  stage: Stage;
  /** Bytes transferred. For ffmpeg stages (`merge`/`convert`) this is percent done, with `total` 100. */
  bytes: number;
  total?: number;
  /** 0–100. For ffmpeg stages this is media time processed / duration. */
  percent: number;
  speedBps?: number;
  etaSec?: number;
}

export interface WarningEvent {
  videoId?: string;
  code: string;
  message: string;
}

export interface RetryEvent {
  videoId?: string;
  stage: Stage;
  attempt: number;
  reason: string;
  delayMs: number;
}

export type TubePullEvents = {
  progress: [ProgressEvent];
  warning: [WarningEvent];
  retry: [RetryEvent];
};

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface PoTokenRequest {
  videoId: string;
  visitorData?: string;
  client: string;
}

/** Return a caller-provided PO token, or undefined to proceed without one. */
export type PoTokenProvider = (request: PoTokenRequest) => Promise<string | undefined> | string | undefined;

export interface TubePullOptions {
  /** Overrides the bundled session with a cookies.txt path or raw header. `false` disables it. */
  cookies?: string | false;
  /** HTTP(S) proxy URL, e.g. `http://user:pass@127.0.0.1:8080`. */
  proxy?: string;
  /** Explicit ffmpeg binary. Default: `TUBEPULL_FFMPEG_PATH`, then ffmpeg-static, then `PATH`. */
  ffmpegPath?: string;
  /** Static PO token (bound to the visitor data below). */
  poToken?: string;
  /** Visitor data the PO token was minted for. */
  visitorData?: string;
  /** Called per video when a PO token is needed. Takes precedence over `poToken`. */
  poTokenProvider?: PoTokenProvider;
  /** InnerTube clients to try, in order (e.g. `VISIONOS`, `TV`, `IOS`). Default: `DEFAULT_CLIENTS`. */
  clients?: string[];
  /** API pacing: 2 concurrent requests, 300 ms apart by default. A 429 pauses the instance. */
  requestPacing?: { maxConcurrent?: number; minIntervalMs?: number };
  /** Interface language, e.g. `'en'`. */
  lang?: string;
  /** Content region, e.g. `'US'`. */
  location?: string;
  /** Directory for the player-script cache. `false` disables persistence. */
  cacheDir?: string | false;
  /** Directory for temporary download files. Default: OS temp dir. */
  tempDir?: string;
  /** Custom fetch (takes precedence over `proxy`). */
  fetch?: typeof fetch;
  logger?: Logger;
  /** Replace the default youtubei.js engine; selection and downloads still use normalized formats. */
  extractor?: Extractor;
}
