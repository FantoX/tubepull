import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type Innertube from 'youtubei.js';
import type * as YoutubeiNamespace from 'youtubei.js';
import { backoffDelay, sleep } from '../download/retry.js';
import { ExtractorError, NetworkError, throwIfAborted, type TubePullError } from '../errors.js';
import type { Chapter, Logger, MediaFormat, PlaylistEntry, PlaylistInfo, Thumbnail } from '../types.js';
import { chaptersFromDescription } from '../utils/chapters.js';
import { RequestGovernor, governedFetch } from '../utils/governor.js';
import { isNThrottled, withRequestTimeout } from '../utils/http.js';
import { watchUrl } from '../utils/url.js';
import { evaluatePlayerScript, type PlayerScript } from './evaluator.js';
import type { ExtractedVideo, Extractor, GetVideoOptions } from './Extractor.js';
import { dedupeFormats, normalizeFormat, type RawFormat } from './normalize.js';
import { mapPlayability, mapThrown, mostRelevantError } from './playability.js';
import type { PoTokenSource } from './poToken.js';

//---- Section used for the youtubei.js extractor ----

type YoutubeiModule = typeof YoutubeiNamespace;

/**
 * Clients tried in order until one returns formats with direct URLs. VISIONOS needs no PO token for its
 * streams; IOS, MWEB and ANDROID_VR return URLs that YouTube refuses (HTTP 403) without one, so they are
 * only fallbacks. A client whose streams are refused mid-download is skipped on re-extraction.
 */
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
  /** Builds an InnerTube session; `generateLocally` invents visitor data instead of asking YouTube. Tests replace it. */
  createSession?: (generateLocally: boolean) => Promise<Innertube>;
}

/** One pass over the clients: the first fully usable extraction, else the best fallback and the refusals. */
interface ClientPass {
  session: Innertube;
  best?: ExtractedVideo;
  fallback?: ExtractedVideo;
  errors: TubePullError[];
}

const INFO_RETRY_BACKOFF = { baseMs: 500, maxMs: 2_000 };
/** At most one fresh session per minute: renewing in a loop looks exactly like abuse. */
const SESSION_RENEW_COOLDOWN_MS = 60_000;

let modulePromise: Promise<YoutubeiModule> | undefined;

/**
 * This function is used for loading youtubei.js once (lazily, so CLI start-up and `--help` stay fast)
 * and installing the node:vm player-script evaluator and quiet logging.
 */
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

/**
 * This function is used for a client playback nonce, sent with media requests like the web player does.
 */
function createCpn(): string {
  const bytes = randomBytes(16);
  let cpn = '';
  for (const byte of bytes) cpn += CPN_ALPHABET[byte & 63];
  return cpn;
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

  constructor(options: YoutubeiExtractorOptions) {
    this.#options = options;
    this.#clients = options.clients?.length ? options.clients.map((c) => c.toUpperCase()) : DEFAULT_CLIENTS;
    this.#governor = options.governor ?? new RequestGovernor();
  }

  /**
   * This function is used for creating the InnerTube session once and sharing it between calls.
   */
  async #innertube(): Promise<Innertube> {
    this.#session ??= (async () => {
      const mod = await loadYoutubei();
      const {
        cookie,
        fetch: fetchFn,
        visitorData,
        poTokens,
        lang,
        location,
        cacheDir,
        logger,
        requestTimeoutMs,
      } = this.#options;
      // Every InnerTube/player request is paced by the shared governor; the deadline applies per attempt.
      const timedFetch = governedFetch(
        withRequestTimeout(fetchFn ?? globalThis.fetch, requestTimeoutMs),
        this.#governor,
      );
      const create =
        this.#options.createSession ??
        ((generateLocally: boolean) =>
          mod.Innertube.create({
            cache: cacheDir ? new mod.UniversalCache(true, cacheDir) : undefined,
            // Cache the player script only. A cached session outlives its welcome: YouTube bot-checks
            // stale or locally generated visitor data, and a fresh one costs a single request.
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
        // A visitor session issued by YouTube: locally invented visitor data gets bot-checked
        // (LOGIN_REQUIRED) by most clients.
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

  /**
   * This function is used for resolving a video through each configured client until one returns
   * downloadable formats, mapping refusals to typed errors.
   */
  async getVideo(videoId: string, options: GetVideoOptions = {}): Promise<ExtractedVideo> {
    const first = await this.#tryClients(videoId, options);
    if (first.best) return first.best;
    let { fallback, errors } = first;

    // Bot checks and dropped connections are usually tied to the session's visitor data, not the video:
    // one more pass with a fresh session often succeeds (long batch runs get their visitor flagged).
    // Never for rate limits: those are per network, and more requests only extend them.
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
    throw mostRelevantError(errors);
  }

  /**
   * This function is used for dropping the session so the next call starts a fresh one. Returns false
   * (no retry) when a renewal happened within the last minute; when a concurrent call already replaced
   * the session, the retry simply uses that one.
   */
  #renewSession(stale: Innertube): boolean {
    if (this.#current !== stale) return true;
    const now = Date.now();
    if (now - this.#lastRenewal < SESSION_RENEW_COOLDOWN_MS) return false;
    this.#lastRenewal = now;
    this.#current = undefined;
    this.#session = undefined;
    return true;
  }

  /**
   * This function is used for one pass over the clients. Throttled responses (unsolved `n`) and SABR-only
   * responses are kept as fallbacks while later clients get a chance to do better.
   */
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

  /**
   * This function is used for the player request of one client, retried once after a transient
   * network failure so a single dropped request does not skip the client.
   */
  async #basicInfo(
    yt: Innertube,
    videoId: string,
    client: string,
    poToken: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<Innertube['getBasicInfo']>>> {
    for (let attempt = 1; ; attempt++) {
      try {
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

  async #toExtracted(
    info: Awaited<ReturnType<Innertube['getBasicInfo']>>,
    client: string,
    poToken: string | undefined,
  ): Promise<{ video: ExtractedVideo; throttled: boolean }> {
    const yt = await this.#innertube();
    const mod = await loadYoutubei();
    const basic = info.basic_info;
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
      // youtubei.js's stream headers, plus the User-Agent of the client that signed the URLs.
      media: { headers: mediaHeaders(mod, client), rangeMode: 'query' },
    };
    const channelId = basic.channel_id ?? basic.channel?.id;
    if (channelId) result.info.channelId = channelId;
    if (basic.view_count !== undefined) result.info.viewCount = basic.view_count;
    if (uploadDate) result.info.uploadDate = uploadDate;
    return { video: result, throttled: throttledUrls > 0 };
  }

  /**
   * This function is used for listing every video in a playlist, following continuations.
   */
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

/**
 * This function is used for the headers of media requests: streams are fetched as the client that
 * signed them.
 */
function mediaHeaders(mod: YoutubeiModule, client: string): Record<string, string> {
  const clients = mod.Constants.CLIENTS as unknown as Record<string, { USER_AGENT?: string } | undefined>;
  const userAgent = clients[client]?.USER_AGENT;
  return { ...mod.Constants.STREAM_HEADERS, ...(userAgent ? { 'user-agent': userAgent } : {}) };
}

/**
 * This function is used for reading a video ID and title from the several playlist item node types
 * YouTube currently serves (classic rows, lockups, shorts).
 */
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
