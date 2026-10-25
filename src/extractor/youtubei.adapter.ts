import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type Innertube from 'youtubei.js';
import type * as YoutubeiNamespace from 'youtubei.js';
import { backoffDelay, sleep } from '../download/retry.js';
import {
  BotCheckError,
  ExtractorError,
  NetworkError,
  throwIfAborted,
  type TubePullError,
} from '../errors.js';
import type { Chapter, Logger, MediaFormat, PlaylistEntry, PlaylistInfo, Thumbnail } from '../types.js';
import { chaptersFromDescription } from '../utils/chapters.js';
import { RequestGovernor, governedFetch } from '../utils/governor.js';
import { isNThrottled, withRequestTimeout } from '../utils/http.js';
import { watchUrl } from '../utils/url.js';
import { cookieValue } from '../utils/cookies.js';
import { evaluatePlayerScript, type PlayerScript } from './evaluator.js';
import type { ExtractedVideo, Extractor, GetVideoOptions } from './Extractor.js';
import { dedupeFormats, normalizeFormat, type RawFormat } from './normalize.js';
import { mapPlayability, mapThrown, mostRelevantError } from './playability.js';
import {
  DIRECT_CLIENTS,
  fetchEmbedContext,
  playabilityReason,
  prerollWaitMs,
  requestPlayer,
  type DirectClient,
} from './player.js';
import type { PoTokenSource } from './poToken.js';

type YoutubeiModule = typeof YoutubeiNamespace;

/** Prefer clients with direct streams; refused clients move to the back on re-extraction. */
export const DEFAULT_CLIENTS = ['VISIONOS', 'TV', 'WEB_EMBEDDED', 'IOS', 'MWEB', 'WEB'];

const MAX_PLAYLIST_PAGES = 200;
const CPN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface YoutubeiExtractorOptions {
  cookie?: string;
  fetch?: typeof fetch;
  visitorData?: string;
  poTokens: PoTokenSource;
  clients?: string[];
  lang?: string;
  location?: string;
  /** Persistent player cache directory; undefined disables persistence. */
  cacheDir?: string;
  logger: Logger;
  /** Deadline for each InnerTube or player-script request. Default 30 s. */
  requestTimeoutMs?: number;
  /** Shared pacing for InnerTube and player requests. Default: 2 in flight, 300 ms apart. */
  governor?: RequestGovernor;
  /** Tests can replace session creation without contacting YouTube. */
  createSession?: (generateLocally: boolean) => Promise<Innertube>;
}

interface ClientPass {
  session: Innertube;
  best?: ExtractedVideo;
  fallback?: ExtractedVideo;
  errors: TubePullError[];
}

const INFO_RETRY_BACKOFF = { baseMs: 500, maxMs: 2_000 };
/** Cap session renewals at one per minute. */
const SESSION_RENEW_COOLDOWN_MS = 60_000;

let modulePromise: Promise<YoutubeiModule> | undefined;

/** Load lazily to keep CLI help and startup fast. */
async function loadYoutubei(): Promise<YoutubeiModule> {
  modulePromise ??= import('youtubei.js').then((mod) => {
    mod.Platform.shim.eval = (data, env) => evaluatePlayerScript(data as PlayerScript, env);
    mod.Log.setLevel(mod.Log.Level.NONE);
    return mod;
  });
  try {
    return await modulePromise;
  } catch (error) {
    modulePromise = undefined;
    throw new ExtractorError('Failed to load youtubei.js', { cause: error });
  }
}

/** Match the browser's playback nonce format. */
function createCpn(): string {
  const bytes = randomBytes(16);
  let cpn = '';
  for (const byte of bytes) cpn += CPN_ALPHABET[byte & 63];
  return cpn;
}

type VideoBasicInfo = Awaited<ReturnType<Innertube['getBasicInfo']>>['basic_info'];

function withoutEmpty(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && Number.isNaN(v)),
    ),
  );
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const asString = String(value);
  return asString === '[object Object]' ? '' : asString;
}

export class YoutubeiExtractor implements Extractor {
  readonly name = 'youtubei.js';
  readonly #options: YoutubeiExtractorOptions;
  readonly #clients: string[];
  #session: Promise<Innertube> | undefined;
  #current: Innertube | undefined;
  #lastRenewal = Number.NEGATIVE_INFINITY;
  readonly #governor: RequestGovernor;

  readonly #fetch: typeof fetch;
  /** Direct-client streams remain blocked until preroll ends. */
  readonly #playableAt = new WeakMap<object, number>();

  constructor(options: YoutubeiExtractorOptions) {
    this.#options = options;
    this.#clients = options.clients?.length ? options.clients.map((c) => c.toUpperCase()) : DEFAULT_CLIENTS;
    this.#governor = options.governor ?? new RequestGovernor();
    this.#fetch = governedFetch(
      withRequestTimeout(options.fetch ?? globalThis.fetch, options.requestTimeoutMs),
      this.#governor,
    );
  }

  async #innertube(): Promise<Innertube> {
    this.#session ??= (async () => {
      const mod = await loadYoutubei();
      const { cookie, visitorData, poTokens, lang, location, cacheDir, logger } = this.#options;
      const timedFetch = this.#fetch;
      const create =
        this.#options.createSession ??
        ((generateLocally: boolean) =>
          mod.Innertube.create({
            cache: cacheDir ? new mod.UniversalCache(true, cacheDir) : undefined,
            // Cache the player script, not session data: stale visitor data triggers bot checks.

            enable_session_cache: false,
            generate_session_locally: generateLocally,
            retrieve_player: true,
            fetch: timedFetch,
            ...(cookie ? { cookie } : {}),
            ...(visitorData ? { visitor_data: visitorData } : {}),
            ...(poTokens.staticToken ? { po_token: poTokens.staticToken } : {}),
            ...(lang ? { lang } : {}),
            ...(location ? { location } : {}),
          }));
      try {
        // Prefer visitor data issued by YouTube over locally generated data.

        return (this.#current = await create(false));
      } catch (remoteError) {
        logger.debug(`remote session failed, using a local one: ${(remoteError as Error).message}`);
      }
      try {
        return (this.#current = await create(true));
      } catch (error) {
        const mapped = mapThrown(error);
        if (mapped instanceof NetworkError) throw mapped;
        throw new ExtractorError(`Could not start an InnerTube session: ${mapped.message}`, { cause: error });
      }
    })();
    try {
      return await this.#session;
    } catch (error) {
      this.#session = undefined;
      throw error;
    }
  }

  async describe(): Promise<Record<string, string>> {
    const mod = await loadYoutubei().catch(() => undefined);
    let version = 'unknown';
    try {
      version = (createRequire(import.meta.url)('youtubei.js/package.json') as { version: string }).version;
    } catch {
      // Version is informational only.
    }
    return {
      engine: this.name,
      'youtubei.js': mod ? version : 'not loadable',
      clients: this.#clients.join(','),
      cookies: this.#options.cookie ? 'yes' : 'no',
      'po token': this.#options.poTokens.configured ? 'configured' : 'none',
    };
  }

  async getVideo(videoId: string, options: GetVideoOptions = {}): Promise<ExtractedVideo> {
    const first = await this.#tryClients(videoId, options);
    if (first.best) return first.best;
    let { fallback, errors } = first;

    // Renew visitor data after session failures, never after rate limits.

    const sessionIssue = errors.some((e) => e.code === 'BOT_CHECK' || e.code === 'NETWORK');
    const rateLimited = errors.some((e) => e.code === 'RATE_LIMITED');
    if (!fallback && sessionIssue && !rateLimited && this.#renewSession(first.session)) {
      this.#options.logger.debug('every client failed; retrying with a fresh visitor session');
      const second = await this.#tryClients(videoId, options);
      if (second.best) return second.best;
      ({ fallback, errors } = second);
    }

    // Metadata is still useful (--list/--json); selection explains why nothing is downloadable.
    if (fallback) return fallback;
    const error = mostRelevantError(errors);
    // A bot check despite cookies can mean the exported session expired.
    if (error.code === 'BOT_CHECK' && this.#options.cookie) {
      throw new BotCheckError(`${error.message} (the cookies were treated as signed out)`, {
        ...(error.details ? { details: error.details } : {}),
        hint:
          'The cookies have expired or YouTube rotated them. Export fresh ones from a private (incognito) ' +
          'window: sign in, export cookies.txt, then close the window so the browser never rotates them.',
      });
    }
    throw error;
  }

  /** Reuse concurrent renewals; allow at most one fresh session per minute. */
  #renewSession(stale: Innertube): boolean {
    if (this.#current !== stale) return true;
    const now = Date.now();
    if (now - this.#lastRenewal < SESSION_RENEW_COOLDOWN_MS) return false;
    this.#lastRenewal = now;
    this.#current = undefined;
    this.#session = undefined;
    return true;
  }

  /** Keep throttled and SABR-only results while trying clients with direct streams. */
  async #tryClients(videoId: string, options: GetVideoOptions): Promise<ClientPass> {
    const { signal, excludeClients = [] } = options;
    const yt = await this.#innertube();
    const { logger, poTokens } = this.#options;
    const errors: TubePullError[] = [];
    let throttled: ExtractedVideo | undefined;
    let sabrOnly: ExtractedVideo | undefined;
    // Refused clients go last rather than away, so a transient refusal can still recover.
    const excluded = new Set(excludeClients.map((c) => c.toUpperCase()));
    const order = [
      ...this.#clients.filter((c) => !excluded.has(c)),
      ...this.#clients.filter((c) => excluded.has(c)),
    ];

    for (const client of order) {
      throwIfAborted(signal);
      const poToken = await poTokens.forVideo(
        { videoId, client, visitorData: yt.session.context.client.visitorData },
        (error) => logger.warn(`PO token provider failed: ${(error as Error).message}`),
      );

      let info: Awaited<ReturnType<Innertube['getBasicInfo']>>;
      try {
        info = await this.#basicInfo(yt, videoId, client, poToken, signal);
      } catch (error) {
        const mapped = mapThrown(error, signal);
        if (mapped.code === 'ABORTED') throw mapped;
        logger.debug(`client ${client}: ${mapped.message}`);
        errors.push(mapped);
        // Asking the remaining clients while rate-limited only extends the limit.
        if (mapped.code === 'RATE_LIMITED') break;
        continue;
      }

      const status = info.playability_status;
      const refusal = mapPlayability(status?.status, status?.reason);
      if (refusal) {
        logger.debug(`client ${client}: ${status?.status} ${status?.reason ?? ''}`);
        errors.push(refusal);
        if (refusal.code === 'RATE_LIMITED') break;
        continue;
      }

      let extracted: { video: ExtractedVideo; throttled: boolean };
      try {
        extracted = await this.#toExtracted(info, client, poToken);
      } catch (error) {
        const mapped = mapThrown(error, signal);
        if (mapped.code === 'ABORTED') throw mapped;
        logger.debug(`client ${client}: ${mapped.message}`);
        errors.push(mapped);
        continue;
      }
      const { video } = extracted;
      if (video.info.isLive) return { session: yt, best: video, errors };
      if (!video.info.formats.some((f) => f.url)) {
        logger.debug(`client ${client}: no direct URLs (SABR only)`);
        sabrOnly ??= video;
        continue;
      }
      if (extracted.throttled) {
        logger.debug(`client ${client}: stream URLs would be throttled (n parameter not solved)`);
        throttled ??= video;
        continue;
      }
      logger.debug(`client ${client}: ${video.info.formats.length} formats`);
      return { session: yt, best: video, errors };
    }

    if (throttled) {
      logger.warn(
        'Only throttled stream URLs were available (the YouTube player script may have changed); ' +
          'the download will be slow. Updating tubepull usually fixes this.',
      );
    }
    const fallback = throttled ?? sabrOnly;
    return fallback ? { session: yt, fallback, errors } : { session: yt, errors };
  }

  /** Retry transient network failures once before moving to another client. */
  async #basicInfo(
    yt: Innertube,
    videoId: string,
    client: string,
    poToken: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<Innertube['getBasicInfo']>>> {
    const direct = DIRECT_CLIENTS[client];
    for (let attempt = 1; ; attempt++) {
      try {
        if (direct) return await this.#directInfo(yt, direct, videoId, poToken, signal);
        return await yt.getBasicInfo(videoId, {
          client: client as never,
          ...(poToken ? { po_token: poToken } : {}),
        });
      } catch (error) {
        const mapped = mapThrown(error, signal);
        if (mapped.code !== 'NETWORK' || attempt > 1) throw mapped;
        this.#options.logger.debug(`client ${client}: ${mapped.message}; retrying`);
        await sleep(backoffDelay(attempt, INFO_RETRY_BACKOFF), signal);
      }
    }
  }

  /** Wrap direct-player responses in VideoInfo to reuse parsing and deciphering. */
  async #directInfo(
    yt: Innertube,
    client: DirectClient,
    videoId: string,
    poToken: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<Innertube['getBasicInfo']>>> {
    const mod = await loadYoutubei();
    const { cookie, lang, location } = this.#options;
    const embed = client.embedded ? await fetchEmbedContext(this.#fetch, videoId, signal) : undefined;
    const visitorData = embed?.visitorData ?? yt.session.context.client.visitorData;
    const sapisid = cookie ? cookieValue(cookie, 'SAPISID') : undefined;
    const response = await requestPlayer({
      fetch: this.#fetch,
      client,
      videoId,
      ...(visitorData ? { visitorData } : {}),
      ...(yt.session.player?.signature_timestamp
        ? { signatureTimestamp: yt.session.player.signature_timestamp }
        : {}),
      ...(poToken ? { poToken } : {}),
      ...(embed ? { embed } : {}),
      ...(cookie
        ? {
            auth: { cookie, ...(sapisid ? { authorization: await mod.Utils.generateSidAuth(sapisid) } : {}) },
          }
        : {}),
      ...(lang ? { lang } : {}),
      ...(location ? { location } : {}),
      ...(signal ? { signal } : {}),
    });
    const answeredAt = Date.now();
    const status = response.playabilityStatus as { status?: string } | undefined;
    if (status?.status !== 'OK') {
      const reason = playabilityReason(status);
      throw (
        mapPlayability(status?.status ?? 'ERROR', reason) ??
        new ExtractorError(`${client.name} returned no playability status`)
      );
    }
    const info = new mod.YT.VideoInfo(
      [{ success: true, status_code: 200, data: response } as never],
      yt.actions,
      createCpn(),
    );
    const prerollMs = prerollWaitMs(response);
    if (prerollMs > 0) {
      this.#playableAt.set(info, answeredAt + prerollMs);
      this.#options.logger.debug(
        `client ${client.name}: streams served after a ${(prerollMs / 1000).toFixed(1)}s enforced preroll`,
      );
    }
    return info;
  }

  /** TV omits metadata; fill it from WEB when available. */
  async #withWebMetadata(yt: Innertube, basic: VideoBasicInfo, client: string): Promise<VideoBasicInfo> {
    if (basic.title || !DIRECT_CLIENTS[client] || !basic.id) return basic;
    try {
      const web = await yt.getBasicInfo(basic.id, { client: 'WEB' });
      if (!web.basic_info.title) return basic;
      this.#options.logger.debug(`client ${client}: metadata from the WEB player`);
      return { ...withoutEmpty(basic), ...withoutEmpty(web.basic_info) } as VideoBasicInfo;
    } catch (error) {
      this.#options.logger.debug(`client ${client}: WEB metadata unavailable: ${(error as Error).message}`);
      return basic;
    }
  }

  async #toExtracted(
    info: Awaited<ReturnType<Innertube['getBasicInfo']>>,
    client: string,
    poToken: string | undefined,
  ): Promise<{ video: ExtractedVideo; throttled: boolean }> {
    const yt = await this.#innertube();
    const mod = await loadYoutubei();
    const basic = await this.#withWebMetadata(yt, info.basic_info, client);
    const streaming = info.streaming_data;
    const sabrAvailable = Boolean(streaming?.server_abr_streaming_url);
    const rawFormats = [...(streaming?.formats ?? []), ...(streaming?.adaptive_formats ?? [])];
    const cpn = createCpn();

    const formats: MediaFormat[] = [];
    let decipherFailures = 0;
    let decipherable = 0;
    let throttledUrls = 0;
    for (const raw of rawFormats) {
      let url: string | undefined;
      if (raw.url || raw.signature_cipher || raw.cipher) {
        decipherable++;
        try {
          const original =
            raw.url ?? new URLSearchParams(raw.signature_cipher ?? raw.cipher ?? '').get('url') ?? undefined;
          const deciphered = await raw.decipher(yt.session.player);
          if (isNThrottled(original, deciphered)) throttledUrls++;
          const u = new URL(deciphered);
          if (poToken && !u.searchParams.has('pot') && u.searchParams.get('sabr') !== '1') {
            u.searchParams.set('pot', poToken);
          }
          u.searchParams.set('cpn', cpn);
          url = u.toString();
        } catch (error) {
          decipherFailures++;
          this.#options.logger.debug(`itag ${raw.itag}: decipher failed: ${(error as Error).message}`);
        }
      }
      const format = normalizeFormat(raw as unknown as RawFormat, url, sabrAvailable);
      if (format) formats.push(format);
    }
    if (decipherable > 0 && decipherFailures === decipherable) {
      throw new ExtractorError(
        'Could not decipher any stream URL; the YouTube player script may have changed.',
      );
    }

    const id = basic.id ?? '';
    const durationSec = basic.duration ?? 0;
    const description = basic.short_description ?? '';
    const thumbnails: Thumbnail[] = (basic.thumbnail ?? [])
      .map((t) => ({ url: t.url, width: t.width, height: t.height }))
      .sort((a, b) => b.width * b.height - a.width * a.height);
    const chapters: Chapter[] = chaptersFromDescription(description, durationSec);
    const uploadDate = basic.publish_date ?? basic.upload_date ?? undefined;

    const result: ExtractedVideo = {
      info: {
        id,
        url: watchUrl(id),
        title: basic.title ?? id,
        author: basic.author ?? basic.channel?.name ?? '',
        description,
        durationSec,
        keywords: basic.keywords ?? [],
        thumbnails,
        isLive: Boolean(basic.is_live),
        isUpcoming: Boolean((basic as { is_upcoming?: boolean }).is_upcoming),
        chapters,
        formats: dedupeFormats(formats),
        client,
      },

      media: { headers: mediaHeaders(mod, client), rangeMode: 'query' },
    };
    const channelId = basic.channel_id ?? basic.channel?.id;
    if (channelId) result.info.channelId = channelId;
    if (Number.isFinite(basic.view_count)) result.info.viewCount = basic.view_count as number;
    if (uploadDate) result.info.uploadDate = uploadDate;
    const playableAt = this.#playableAt.get(info);
    if (playableAt) result.media.playableAt = playableAt;
    return { video: result, throttled: throttledUrls > 0 };
  }

  async getPlaylist(playlistId: string, signal?: AbortSignal): Promise<PlaylistInfo> {
    const yt = await this.#innertube();
    let page: Awaited<ReturnType<Innertube['getPlaylist']>>;
    try {
      page = await yt.getPlaylist(playlistId);
    } catch (error) {
      const mapped = mapThrown(error, signal);
      if (/^RD/.test(playlistId) && mapped.code !== 'ABORTED' && mapped.code !== 'NETWORK') {
        throw new ExtractorError(`Mixes (${playlistId}) cannot be listed.`, {
          cause: error,
          hint: 'Mixes are generated per viewer; download the individual videos instead.',
        });
      }
      throw mapped;
    }

    const entries: PlaylistEntry[] = [];
    const seen = new Set<string>();
    const collect = (items: readonly unknown[]) => {
      for (const item of items) {
        const entry = toPlaylistEntry(item);
        if (entry && !seen.has(entry.id)) {
          seen.add(entry.id);
          entries.push(entry);
        }
      }
    };
    collect(page.items);

    for (let pages = 1; page.has_continuation && pages < MAX_PLAYLIST_PAGES; pages++) {
      throwIfAborted(signal);
      try {
        page = await page.getContinuation();
      } catch (error) {
        throw mapThrown(error, signal);
      }
      collect(page.items);
    }

    const result: PlaylistInfo = { id: playlistId, title: text(page.info.title) || playlistId, entries };
    const author = text(page.info.author?.name);
    if (author) result.author = author;
    return result;
  }
}

/** Fetch media with the User-Agent of the client that signed its URL. */
function mediaHeaders(mod: YoutubeiModule, client: string): Record<string, string> {
  const clients = mod.Constants.CLIENTS as unknown as Record<string, { USER_AGENT?: string } | undefined>;
  const userAgent = DIRECT_CLIENTS[client]?.userAgent ?? clients[client]?.USER_AGENT;
  return { ...mod.Constants.STREAM_HEADERS, ...(userAgent ? { 'user-agent': userAgent } : {}) };
}

/** Accept classic, lockup, and Shorts playlist rows. */
export function toPlaylistEntry(item: unknown): PlaylistEntry | undefined {
  const node = item as Record<string, unknown> & { type?: string };
  switch (node.type) {
    case 'PlaylistVideo': {
      const id = node.id as string | undefined;
      if (!id || node.is_playable === false) return undefined;
      const entry: PlaylistEntry = { id, title: text(node.title) };
      const author = text((node.author as { name?: unknown } | undefined)?.name);
      if (author) entry.author = author;
      const seconds = (node.duration as { seconds?: number } | undefined)?.seconds;
      if (seconds) entry.durationSec = seconds;
      return entry;
    }
    case 'LockupView': {
      if (node.content_type !== 'VIDEO' || typeof node.content_id !== 'string') return undefined;
      const metadata = node.metadata as { title?: unknown } | null | undefined;
      return { id: node.content_id, title: text(metadata?.title) };
    }
    case 'ReelItem': {
      const id = node.id as string | undefined;
      return id ? { id, title: text(node.title) } : undefined;
    }
    case 'ShortsLockupView': {
      const endpoint = node.on_tap_endpoint as { payload?: { videoId?: string } } | undefined;
      const id = endpoint?.payload?.videoId;
      const overlay = node.overlay_metadata as { primary_text?: unknown } | undefined;
      return id ? { id, title: text(overlay?.primary_text) } : undefined;
    }
    default:
      return undefined;
  }
}
