import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type * as Undici from 'undici';
import {
  fetchMediaChunks,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_RETRIES,
  type MediaSource,
} from './download/chunked.js';
import { SpeedMeter, createThrottle } from './download/progress.js';
import { runQueue } from './download/queue.js';
import { downloadToFile } from './download/resume.js';
import {
  FfmpegNotFoundError,
  FileExistsError,
  InvalidArgumentError,
  InvalidUrlError,
  LiveStreamError,
  NetworkError,
  NoSuitableFormatError,
  isAbortLike,
  throwIfAborted,
} from './errors.js';
import type { ExtractedVideo, Extractor, MediaRequest } from './extractor/Extractor.js';
import { PoTokenSource } from './extractor/poToken.js';
import { YoutubeiExtractor } from './extractor/youtubei.adapter.js';
import {
  AUDIO_ENCODER,
  COVER_AUDIO_FORMATS,
  buildAudioArgs,
  buildChaptersMetadata,
  buildCoverArgs,
  buildMergeArgs,
  type ConvertFormat,
  type MetadataTags,
} from './ffmpeg/commands.js';
import { resolveFfmpeg, type ResolvedFfmpeg } from './ffmpeg/resolve.js';
import { probeFfmpeg, runFfmpeg } from './ffmpeg/run.js';
import { silentLogger } from './logger.js';
import { buildAudioQualities, buildQualities } from './selector/qualities.js';
import { selectFormats, type AudioPlan, type SelectionPlan, type VideoPlan } from './selector/select.js';
import type {
  BatchItemResult,
  DownloadOptions,
  DownloadResult,
  Logger,
  MediaFormat,
  PlaylistInfo,
  ProgressEvent,
  Stage,
  StreamOptions,
  TubePullEvents,
  TubePullOptions,
  VideoInfo,
} from './types.js';
import { loadCookies } from './utils/cookies.js';
import { renderTemplate } from './utils/filename.js';
import { defaultCacheDir, fileSize, moveFile, pathExists, removeQuietly } from './utils/fs.js';
import { resolveRange, type ResolvedRange } from './utils/time.js';
import { RequestGovernor } from './utils/governor.js';
import { urlExpiresAt } from './utils/http.js';
import { parseTarget, parseVideoId } from './utils/url.js';

//---- Section used for the public TubePull API ----

export const DEFAULT_FILENAME_TEMPLATE = '{title} [{id}]';
const PROGRESS_INTERVAL_MS = 100;
const THUMBNAIL_TIMEOUT_MS = 15_000;
/** Re-extract before downloading when stream URLs expire sooner than this. */
const URL_EXPIRY_MARGIN_MS = 5 * 60_000;
/** Cached extractions are reused this long at most (live/premiere state can change). */
const EXTRACTION_TTL_MS = 30 * 60_000;
const EXTRACTION_CACHE_SIZE = 64;

interface CachedExtraction {
  video: ExtractedVideo;
  at: number;
}

/**
 * This function is used for whether a cached extraction can be reused: young enough, and its stream
 * URLs valid for a few more minutes.
 */
function isFresh(entry: CachedExtraction, now = Date.now()): boolean {
  if (now - entry.at > EXTRACTION_TTL_MS) return false;
  const expiries = entry.video.info.formats
    .map((f) => urlExpiresAt(f.url))
    .filter((t): t is number => t !== undefined);
  return expiries.every((t) => t - now > URL_EXPIRY_MARGIN_MS);
}

/** A readable media stream with the format it carries. */
export type TubePullStream = Readable & { format: MediaFormat; info: VideoInfo };

/**
 * Download YouTube video or audio. Create with `await TubePull.create(options)`.
 *
 * Events: `progress` (per stage, ~10/s), `warning` (non-fatal notices), `retry` (network retries).
 */
export class TubePull extends EventEmitter<TubePullEvents> {
  readonly #options: TubePullOptions;
  readonly #logger: Logger;
  readonly #media = new WeakMap<VideoInfo, MediaRequest>();
  readonly #activeTempDirs = new Set<string>();
  readonly #extractions = new Map<string, CachedExtraction>();
  #ready: Promise<{ extractor: Extractor; fetch: typeof fetch }> | undefined;
  #ffmpeg: Promise<ResolvedFfmpeg> | undefined;

  constructor(options: TubePullOptions = {}) {
    super();
    this.#options = { ...options };
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * This function is used for creating an instance and validating cookies/proxy up front, so a bad
   * cookies path fails here rather than on the first download.
   */
  static async create(options: TubePullOptions = {}): Promise<TubePull> {
    const instance = new TubePull(options);
    await instance.#init();
    return instance;
  }

  #init(): Promise<{ extractor: Extractor; fetch: typeof fetch }> {
    this.#ready ??= (async () => {
      const options = this.#options;
      const fetchFn =
        options.fetch ?? (options.proxy ? await createProxyFetch(options.proxy) : globalThis.fetch);
      if (options.extractor) return { extractor: options.extractor, fetch: fetchFn };
      const cookie = options.cookies ? await loadCookies(options.cookies) : undefined;
      const cacheDir = options.cacheDir === false ? undefined : (options.cacheDir ?? defaultCacheDir());
      if (cacheDir) await mkdir(cacheDir, { recursive: true }).catch(() => undefined);
      const extractor = new YoutubeiExtractor({
        poTokens: new PoTokenSource(options),
        logger: this.#logger,
        governor: new RequestGovernor(options.requestPacing),
        ...(cookie ? { cookie } : {}),
        ...(options.fetch || options.proxy ? { fetch: fetchFn } : {}),
        ...(options.visitorData ? { visitorData: options.visitorData } : {}),
        ...(options.clients ? { clients: options.clients } : {}),
        ...(options.lang ? { lang: options.lang } : {}),
        ...(options.location ? { location: options.location } : {}),
        ...(cacheDir ? { cacheDir } : {}),
      });
      return { extractor, fetch: fetchFn };
    })();
    this.#ready.catch(() => {
      this.#ready = undefined;
    });
    return this.#ready;
  }

  /**
   * This function is used for locating ffmpeg (cached). Exposed for diagnostics.
   */
  resolveFfmpeg(): Promise<ResolvedFfmpeg> {
    this.#ffmpeg ??= resolveFfmpeg(this.#options.ffmpegPath);
    this.#ffmpeg.catch(() => {
      this.#ffmpeg = undefined;
    });
    return this.#ffmpeg;
  }

  /**
   * This function is used for extractor details (engine version, clients) for diagnostics.
   */
  async describeExtractor(): Promise<Record<string, string>> {
    const { extractor } = await this.#init();
    return extractor.describe();
  }

  //---- Section used for inspection ----

  /**
   * This function is used for fetching metadata, the normalised format list, and the qualities that
   * are actually available for a video.
   */
  async getInfo(input: string, options: { signal?: AbortSignal } = {}): Promise<VideoInfo> {
    const target = parseTarget(input);
    if (!target.videoId) {
      if (target.playlistId) {
        throw new InvalidArgumentError(`This is a playlist link, not a video: ${input}`, {
          hint: 'Use getPlaylist() or downloadMany() for playlists.',
        });
      }
      throw new InvalidUrlError(input);
    }
    return this.#toInfo(await this.#extract(target.videoId, options.signal));
  }

  /**
   * This function is used for listing a playlist's videos from a playlist URL or ID.
   */
  async getPlaylist(input: string, options: { signal?: AbortSignal } = {}): Promise<PlaylistInfo> {
    const raw = input.trim();
    const playlistId =
      parseTarget(raw).playlistId ?? (/^(PL|OL|UU|FL|RD|LL)[A-Za-z0-9_-]+$/.test(raw) ? raw : undefined);
    if (!playlistId)
      throw new InvalidUrlError(input, { hint: 'Pass a playlist link (with list=...) or a playlist ID.' });
    const { extractor } = await this.#init();
    return extractor.getPlaylist(playlistId, options.signal);
  }

  /**
   * Extraction with a short-lived cache: getInfo → download, --list → download and batch retries reuse
   * one answer while its stream URLs stay valid, instead of asking YouTube again. A refresh after a
   * refused stream (`excludeClients`) always goes to YouTube.
   */
  async #extract(videoId: string, signal?: AbortSignal, excludeClients?: string[]): Promise<ExtractedVideo> {
    throwIfAborted(signal);
    const { extractor } = await this.#init();
    if (!excludeClients?.length) {
      const cached = this.#extractions.get(videoId);
      if (cached && isFresh(cached)) return cached.video;
    }
    const video = await extractor.getVideo(videoId, { signal, excludeClients });
    this.#extractions.delete(videoId);
    this.#extractions.set(videoId, { video, at: Date.now() });
    while (this.#extractions.size > EXTRACTION_CACHE_SIZE) {
      this.#extractions.delete(this.#extractions.keys().next().value as string);
    }
    return video;
  }

  #toInfo(extracted: ExtractedVideo): VideoInfo {
    const { info: base } = extracted;
    // Callers get their own copies, so mutating a result cannot corrupt the cache.
    const formats = base.formats.map((f) => ({ ...f }));
    const info: VideoInfo = {
      ...base,
      formats,
      chapters: base.chapters.map((c) => ({ ...c })),
      thumbnails: base.thumbnails.map((t) => ({ ...t })),
      keywords: [...base.keywords],
      qualities: buildQualities(formats, base.durationSec),
      audioQualities: buildAudioQualities(formats, base.durationSec),
    };
    this.#media.set(info, extracted.media);
    return info;
  }

  /**
   * Media request details for an info object. Re-extracts when the object did not come from this
   * instance, or when its stream URLs expire within a few minutes (they last about six hours).
   */
  async #mediaFor(info: VideoInfo, signal?: AbortSignal): Promise<{ info: VideoInfo; media: MediaRequest }> {
    const media = this.#media.get(info);
    const expiries = info.formats.map((f) => urlExpiresAt(f.url)).filter((t): t is number => t !== undefined);
    const expiresAt = expiries.length ? Math.min(...expiries) : Number.POSITIVE_INFINITY;
    if (media && expiresAt - Date.now() > URL_EXPIRY_MARGIN_MS) return { info, media };
    if (media) this.#logger.debug(`stream URLs for ${info.id} expire soon; extracting fresh ones`);
    const fresh = this.#toInfo(await this.#extract(parseVideoId(info.id), signal));
    return { info: fresh, media: this.#media.get(fresh) as MediaRequest };
  }

  //---- Section used for downloading ----

  /**
   * This function is used for downloading one video (merged video+audio) or its audio, at the
   * requested quality and format, into `outputDir`.
   */
  async download(input: string | VideoInfo, options: DownloadOptions = {}): Promise<DownloadResult> {
    const started = Date.now();
    const { signal } = options;
    let info = typeof input === 'string' ? await this.getInfo(input, { signal }) : input;
    if (info.isLive || info.isUpcoming) {
      throw new LiveStreamError(
        info.isUpcoming ? 'This live stream or premiere has not started yet' : undefined,
      );
    }
    const media = await this.#mediaFor(info, signal);
    info = media.info;

    let plan = selectFormats(info.formats, options);
    const range = resolveRange(options.range, info.durationSec);
    const needsFfmpeg = plan.kind === 'video' || !plan.passthrough || range !== undefined;
    const ffmpeg = needsFfmpeg ? await this.resolveFfmpeg() : undefined;
    if (ffmpeg) plan = await this.#ensureEncoders(plan, ffmpeg, info, options);

    const warnings = [...plan.warnings];
    for (const message of warnings) this.emit('warning', { videoId: info.id, code: 'SELECTION', message });

    const ext =
      plan.kind === 'video'
        ? plan.container
        : range && plan.passthrough
          ? plan.ext === 'webm'
            ? 'opus'
            : 'm4a'
          : plan.ext;
    const outputPath = this.#outputPath(info, plan, ext, options);
    if (await pathExists(outputPath)) {
      if (options.skipExisting) {
        return this.#result(info, plan, outputPath, ext, await fileSize(outputPath), started, warnings, true);
      }
      if (!options.overwrite) throw new FileExistsError(outputPath);
    }

    const tempDir = await this.#createTempDir(info, plan, ext);
    try {
      const report = this.#progressReporter(info.id, options);
      const tracks: { format: MediaFormat; stage: Stage; file: string }[] = [];
      if (plan.kind === 'video') {
        tracks.push({
          format: plan.video,
          stage: 'video',
          file: path.join(tempDir, `video.${plan.video.container}`),
        });
        if (plan.audio)
          tracks.push({
            format: plan.audio,
            stage: 'audio',
            file: path.join(tempDir, `audio.${plan.audio.container}`),
          });
      } else {
        tracks.push({
          format: plan.audio,
          stage: 'audio',
          file: path.join(tempDir, `audio.${plan.audio.container}`),
        });
      }
      await this.#downloadTracks(info, media.media, tracks, options, report);

      let finalTemp: string;
      if (plan.kind === 'audio' && plan.passthrough && !range) {
        finalTemp = (tracks[0] as { file: string }).file;
      } else {
        finalTemp = path.join(tempDir, `output.${ext}`);
        await this.#runFfmpegStep(
          info,
          plan,
          tracks,
          finalTemp,
          ext,
          range,
          tempDir,
          options,
          report,
          warnings,
        );
      }

      throwIfAborted(signal);
      if (!options.overwrite && (await pathExists(outputPath))) throw new FileExistsError(outputPath);
      await moveFile(finalTemp, outputPath, Boolean(options.overwrite));
      const size = (await stat(outputPath)).size;
      report('done', size, size, true);
      return this.#result(info, plan, outputPath, ext, size, started, warnings, false);
    } finally {
      this.#activeTempDirs.delete(tempDir);
      await removeQuietly(tempDir);
    }
  }

  /**
   * This function is used for downloading several videos and/or playlists with bounded concurrency.
   * Playlist links are expanded; failures are reported per item instead of stopping the batch.
   */
  async downloadMany(
    inputs: string[],
    options: DownloadOptions & { concurrency?: number; onItemDone?: (item: BatchItemResult) => void } = {},
  ): Promise<BatchItemResult[]> {
    const { concurrency = 2, onItemDone, ...downloadOptions } = options;
    const ids: { input: string; id: string }[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      const target = parseTarget(input);
      const videoIds = target.videoId
        ? [target.videoId]
        : target.playlistId
          ? (await this.getPlaylist(input, { signal: downloadOptions.signal })).entries.map((e) => e.id)
          : [];
      if (videoIds.length === 0) throw new InvalidUrlError(input);
      for (const id of videoIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push({ input: target.videoId ? input : id, id });
      }
    }

    const settled = await runQueue(
      ids,
      concurrency,
      async ({ id }) => this.download(id, downloadOptions),
      downloadOptions.signal,
    );
    return settled.map((outcome, index) => {
      const input = (ids[index] as { input: string }).input;
      const item: BatchItemResult = outcome.ok
        ? { input, ok: true, result: outcome.value }
        : {
            input,
            ok: false,
            error: outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)),
          };
      onItemDone?.(item);
      return item;
    });
  }

  /**
   * This function is used for streaming a single format (audio-only or a combined low-quality
   * progressive stream) without ffmpeg.
   */
  async stream(input: string | VideoInfo, options: StreamOptions = {}): Promise<TubePullStream> {
    const { signal } = options;
    const initial = typeof input === 'string' ? await this.getInfo(input, { signal }) : input;
    const { info, media } = await this.#mediaFor(initial, signal);
    let format: MediaFormat;
    if (options.itag !== undefined) {
      const found = info.formats.find((f) => f.itag === options.itag && f.url);
      if (!found) throw new InvalidArgumentError(`itag ${options.itag} is not available for streaming.`);
      format = found;
    } else if ((options.type ?? 'audio') === 'audio') {
      const plan = selectFormats(info.formats, {
        type: 'audio',
        audioFormat: 'original',
        ...(options.audioLanguage ? { audioLanguage: options.audioLanguage } : {}),
      });
      format = plan.audio as MediaFormat;
    } else {
      const muxed = info.formats.filter((f) => f.kind === 'muxed' && f.url);
      if (muxed.length === 0) {
        throw new NoSuitableFormatError(
          'No combined (progressive) video stream is available for this video.',
          {
            hint: 'Use download() to fetch and merge separate video and audio streams.',
          },
        );
      }
      const plan = selectFormats(muxed, {
        type: 'video',
        quality: options.quality ?? 'best',
        container: 'mkv',
      }) as VideoPlan;
      format = plan.video;
    }

    const { fetch: fetchFn } = await this.#init();
    const generator = fetchMediaChunks({
      source: this.#mediaSource(info, media, format, signal),
      chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      retries: options.retries ?? DEFAULT_RETRIES,
      fetch: fetchFn,
      ...(signal ? { signal } : {}),
      onRetry: (r) =>
        this.emit('retry', { videoId: info.id, stage: format.kind === 'audio' ? 'audio' : 'video', ...r }),
    });
    const readable = Readable.from(generator, { objectMode: false });
    return Object.assign(readable, { format, info });
  }

  //---- Section used for download internals ----

  /** Falls back to m4a when the ffmpeg build lacks the encoder for the requested audio format. */
  async #ensureEncoders(
    plan: SelectionPlan,
    ffmpeg: ResolvedFfmpeg,
    info: VideoInfo,
    options: DownloadOptions,
  ): Promise<SelectionPlan> {
    const needsVideoEncoder = plan.kind === 'video' && plan.transcodeVideo;
    const needsAudioEncoder = plan.kind === 'audio' && plan.transcode;
    if (!needsVideoEncoder && !needsAudioEncoder) return plan;
    const { encoders } = await probeFfmpeg(ffmpeg.path);

    if (plan.kind === 'video') {
      const encoder = plan.container === 'webm' ? 'libvpx-vp9' : 'libx264';
      if (!encoders.has(encoder)) {
        throw new FfmpegNotFoundError(
          `This ffmpeg build has no ${encoder} encoder, required for transcoding.`,
          {
            hint: 'Drop --allow-transcode (the output will be mkv), or point TUBEPULL_FFMPEG_PATH to a full ffmpeg build.',
          },
        );
      }
      return plan;
    }
    const format = plan.format as ConvertFormat;
    if (encoders.has(AUDIO_ENCODER[format])) return plan;
    const fallback = selectFormats(info.formats, { ...options, type: 'audio', audioFormat: 'm4a' });
    fallback.warnings.unshift(
      `This ffmpeg build cannot encode ${format} (${AUDIO_ENCODER[format]} missing); saving as m4a.`,
    );
    return fallback;
  }

  #outputPath(info: VideoInfo, plan: SelectionPlan, ext: string, options: DownloadOptions): string {
    const video = plan.kind === 'video' ? plan.video : undefined;
    const name = renderTemplate(options.filename ?? DEFAULT_FILENAME_TEMPLATE, {
      title: info.title,
      id: info.id,
      author: info.author,
      channel: info.author,
      height: video?.height !== undefined ? Math.min(video.height, video.width ?? video.height) : undefined,
      fps: video?.fps,
      quality:
        video?.qualityLabel ??
        (plan.kind === 'audio'
          ? `${Math.round((plan.audio.avgBitrate ?? plan.audio.bitrate) / 1000)}kbps`
          : undefined),
      itag: video?.itag ?? plan.audio?.itag,
      date: info.uploadDate?.slice(0, 10),
      container: ext,
    });
    return path.resolve(options.outputDir ?? process.cwd(), `${name}.${ext}`);
  }

  async #createTempDir(info: VideoInfo, plan: SelectionPlan, ext: string): Promise<string> {
    const itags = plan.kind === 'video' ? [plan.video.itag, plan.audio?.itag] : [plan.audio.itag];
    const key = createHash('sha1')
      .update(`${itags.join(',')}|${ext}`)
      .digest('hex')
      .slice(0, 8);
    const root = this.#options.tempDir ?? os.tmpdir();
    let dir = path.join(root, `tubepull-${info.id}-${key}`);
    // Two concurrent downloads of the same thing in this process must not share files.
    if (this.#activeTempDirs.has(dir)) dir = `${dir}-${process.pid}-${Date.now()}`;
    this.#activeTempDirs.add(dir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  #mediaSource(info: VideoInfo, media: MediaRequest, format: MediaFormat, signal?: AbortSignal): MediaSource {
    if (!format.url) throw new NetworkError(`itag ${format.itag} has no direct URL`);
    // A refused stream usually means YouTube wants something this client cannot provide (e.g. a PO
    // token), so the refresh re-extracts with that client tried last.
    const refused: string[] = [];
    let client = info.client;
    const source: MediaSource = {
      url: format.url,
      headers: media.headers,
      rangeMode: media.rangeMode,
      refresh: async () => {
        if (client && !refused.includes(client)) refused.push(client);
        this.#logger.debug(
          `refreshing itag ${format.itag} (refused clients: ${refused.join(', ') || 'none'})`,
        );
        const fresh = await this.#extract(info.id, signal, refused);
        client = fresh.info.client;
        const match = fresh.info.formats.find(
          (f) =>
            f.itag === format.itag &&
            f.audioTrack?.id === format.audioTrack?.id &&
            Boolean(f.isDrc) === Boolean(format.isDrc) &&
            f.url,
        );
        if (!match?.url) throw new NetworkError(`itag ${format.itag} is no longer offered for ${info.id}`);
        // Resuming mid-file is only safe when the bytes are the same encode.
        const differs =
          (match.contentLength && format.contentLength && match.contentLength !== format.contentLength) ||
          (match.lastModified && format.lastModified && match.lastModified !== format.lastModified);
        if (differs)
          throw new NetworkError(`itag ${format.itag} changed on YouTube's side; retry the download`);
        this.#logger.debug(`itag ${format.itag} now served via client ${client ?? '?'}`);
        return { url: match.url, headers: fresh.media.headers };
      },
    };
    if (format.contentLength) source.contentLength = format.contentLength;
    return source;
  }

  async #downloadTracks(
    info: VideoInfo,
    media: MediaRequest,
    tracks: { format: MediaFormat; stage: Stage; file: string }[],
    options: DownloadOptions,
    report: ProgressReporter,
  ): Promise<void> {
    const { fetch: fetchFn } = await this.#init();
    // If one track fails, stop the other one instead of letting it run to completion.
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

    const outcomes = await Promise.allSettled(
      tracks.map(async ({ format, stage, file }) => {
        try {
          await downloadToFile({
            file,
            identity: `${info.id}:${format.itag}:${format.audioTrack?.id ?? ''}:${format.lastModified ?? ''}:${format.contentLength ?? ''}`,
            source: this.#mediaSource(info, media, format, signal),
            chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
            retries: options.retries ?? DEFAULT_RETRIES,
            fetch: fetchFn,
            signal,
            onProgress: (bytes, total) => report(stage, bytes, total),
            onRetry: (r) => {
              this.#logger.debug(`${stage} retry ${r.attempt}: ${r.reason}`);
              this.emit('retry', { videoId: info.id, stage, ...r });
            },
          });
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      }),
    );
    const failures = outcomes
      .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
      .map((o) => o.reason as unknown);
    if (failures.length) {
      throwIfAborted(options.signal);
      // Prefer the root cause over the sibling that was cancelled because of it.
      throw failures.find((e) => !isAbortLike(e)) ?? failures[0];
    }
  }

  async #runFfmpegStep(
    info: VideoInfo,
    plan: SelectionPlan,
    tracks: { format: MediaFormat; stage: Stage; file: string }[],
    output: string,
    ext: string,
    range: ResolvedRange | undefined,
    tempDir: string,
    options: DownloadOptions,
    report: ProgressReporter,
    warnings: string[],
  ): Promise<void> {
    const ffmpeg = await this.resolveFfmpeg();
    const embedMetadata = options.embedMetadata ?? true;
    const metadata: MetadataTags | undefined = embedMetadata ? this.#metadataTags(info, ext) : undefined;
    const chaptersFile =
      embedMetadata && info.chapters.length > 0 && !range ? path.join(tempDir, 'chapters.txt') : undefined;
    if (chaptersFile)
      await writeFile(
        chaptersFile,
        buildChaptersMetadata(info.chapters, info.durationSec, info.title),
        'utf8',
      );

    const wantsCover = options.embedThumbnail ?? plan.kind === 'audio';
    const coverSupported =
      plan.kind === 'video'
        ? plan.container === 'mp4' || plan.container === 'mkv'
        : COVER_AUDIO_FORMATS.has(ext as ConvertFormat);
    const cover =
      wantsCover && coverSupported
        ? await this.#prepareCover(info, ffmpeg, tempDir, options, warnings)
        : undefined;

    const outDuration = (range?.endSec ?? info.durationSec) - (range?.startSec ?? 0);
    let args: string[];
    let stage: Stage;
    if (plan.kind === 'video') {
      const [videoTrack, audioTrack] = tracks;
      stage = 'merge';
      args = buildMergeArgs({
        video: (videoTrack as { file: string }).file,
        ...(audioTrack ? { audio: audioTrack.file } : {}),
        output,
        container: plan.container,
        transcodeVideo: plan.transcodeVideo,
        transcodeAudio: plan.transcodeAudio,
        ...(range ? { range } : {}),
        ...(metadata ? { metadata } : {}),
        ...(chaptersFile ? { chaptersFile } : {}),
        ...(cover ? { cover } : {}),
      });
    } else {
      stage = 'convert';
      const audioPlan = plan as AudioPlan;
      const format: ConvertFormat = audioPlan.passthrough
        ? (ext as ConvertFormat)
        : (audioPlan.format as ConvertFormat);
      args = buildAudioArgs({
        input: (tracks[0] as { file: string }).file,
        output,
        format,
        transcode: audioPlan.passthrough ? false : audioPlan.transcode,
        bitrate: options.audioBitrate ?? '192k',
        ...(range ? { range } : {}),
        ...(metadata ? { metadata } : {}),
        ...(chaptersFile ? { chaptersFile } : {}),
        ...(cover ? { cover } : {}),
      });
    }
    this.#logger.debug(`ffmpeg ${args.join(' ')}`);
    report(stage, 0, undefined, true);
    await runFfmpeg(ffmpeg.path, args, {
      durationSec: outDuration > 0 ? outDuration : info.durationSec,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (percent) => report(stage, percent, 100),
    });
    report(stage, 100, 100, true);
  }

  #metadataTags(info: VideoInfo, ext: string): MetadataTags {
    const tags: MetadataTags = { title: info.title, artist: info.author, comment: info.url };
    if (info.uploadDate) tags.date = info.uploadDate.slice(0, 10);
    // Long descriptions are fine in mp4/mkv/m4a atoms; ID3/Vorbis players show them poorly.
    if (info.description && (ext === 'mp4' || ext === 'mkv' || ext === 'm4a'))
      tags.description = info.description;
    if (ext === 'mp4' || ext === 'm4a') tags.purl = info.url;
    return tags;
  }

  /** Downloads the largest thumbnail and converts it to JPEG. Failures only produce a warning. */
  async #prepareCover(
    info: VideoInfo,
    ffmpeg: ResolvedFfmpeg,
    tempDir: string,
    options: DownloadOptions,
    warnings: string[],
  ): Promise<string | undefined> {
    const thumbnail = info.thumbnails.find((t) => !/webp/i.test(t.url)) ??
      info.thumbnails[0] ?? { url: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` };
    const raw = path.join(tempDir, 'thumbnail.img');
    const cover = path.join(tempDir, 'cover.jpg');
    try {
      const { fetch: fetchFn } = await this.#init();
      const timeout = AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await fetchFn(thumbnail.url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(raw, new Uint8Array(await response.arrayBuffer()));
      await runFfmpeg(
        ffmpeg.path,
        buildCoverArgs(raw, cover),
        options.signal ? { signal: options.signal } : {},
      );
      return cover;
    } catch (error) {
      throwIfAborted(options.signal);
      const message = `Could not embed thumbnail: ${(error as Error).message}`;
      warnings.push(message);
      this.emit('warning', { videoId: info.id, code: 'THUMBNAIL', message });
      return undefined;
    }
  }

  #progressReporter(videoId: string, options: DownloadOptions): ProgressReporter {
    const meters = new Map<Stage, SpeedMeter>();
    const throttles = new Map<Stage, (force?: boolean) => boolean>();
    return (stage, bytes, total, force = false) => {
      let meter = meters.get(stage);
      if (!meter) meters.set(stage, (meter = new SpeedMeter()));
      let throttle = throttles.get(stage);
      if (!throttle) throttles.set(stage, (throttle = createThrottle(PROGRESS_INTERVAL_MS)));
      const isTransfer = stage === 'video' || stage === 'audio';
      if (isTransfer) meter.record(bytes);
      const complete = total !== undefined && bytes >= total;
      if (!throttle(force || complete)) return;
      const event: ProgressEvent = {
        videoId,
        stage,
        bytes,
        percent: total ? Math.min(100, (bytes / total) * 100) : 0,
      };
      if (total !== undefined) event.total = total;
      if (isTransfer) {
        const speed = meter.speed;
        if (speed !== undefined) event.speedBps = speed;
        const eta = meter.eta(total, bytes);
        if (eta !== undefined) event.etaSec = eta;
      }
      this.emit('progress', event);
      try {
        options.onProgress?.(event);
      } catch (error) {
        this.#logger.warn(`onProgress callback threw: ${(error as Error).message}`);
      }
    };
  }

  #result(
    info: VideoInfo,
    plan: SelectionPlan,
    outputPath: string,
    ext: string,
    size: number,
    started: number,
    warnings: string[],
    skipped: boolean,
  ): DownloadResult {
    const result: DownloadResult = {
      path: outputPath,
      sizeBytes: size,
      container: ext,
      info,
      durationMs: Date.now() - started,
      warnings,
    };
    if (skipped) result.skipped = true;
    if (plan.kind === 'video') {
      result.video = plan.video;
      if (plan.audio) result.audio = plan.audio;
    } else {
      result.audio = plan.audio;
    }
    return result;
  }
}

type ProgressReporter = (stage: Stage, bytes: number, total: number | undefined, force?: boolean) => void;

/**
 * This function is used for a fetch that routes through an HTTP(S) proxy using undici's ProxyAgent
 * (undici's own fetch, so the dispatcher always matches the client).
 */
async function createProxyFetch(proxy: string): Promise<typeof fetch> {
  try {
    new URL(proxy);
  } catch {
    throw new InvalidArgumentError(`Invalid proxy URL: ${proxy}`);
  }
  if (!/^https?:/i.test(proxy)) {
    throw new InvalidArgumentError(`Unsupported proxy protocol in ${proxy}; use http:// or https://.`);
  }
  let undici: typeof Undici;
  try {
    undici = await import('undici');
  } catch (cause) {
    throw new InvalidArgumentError('Proxy support needs the optional "undici" package: npm i undici', {
      cause,
    });
  }
  const dispatcher = new undici.ProxyAgent(proxy);
  const proxied = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undici.fetch(
      input as never,
      { ...(init as object), dispatcher } as never,
    ) as unknown as Promise<Response>;
  return proxied as typeof fetch;
}
