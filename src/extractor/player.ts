import { ExtractorError, NetworkError, RateLimitedError } from '../errors.js';

/** Direct presets track yt-dlp; YouTube rejects stale versions and incomplete device context. */
export interface DirectClient {
  name: string;
  nameId: number;
  version: string;
  userAgent: string;
  context?: Record<string, string>;
  /** Plays only with the visitor data and host flags of an embed page on a third-party site. */
  embedded?: boolean;
}

const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';

const EMBED_HOST = 'https://www.reddit.com/';

export const DIRECT_CLIENTS: Readonly<Record<string, DirectClient>> = {
  TV: {
    name: 'TVHTML5',
    nameId: 7,
    version: '5.20260707',
    userAgent:
      'Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1',
    context: { deviceMake: 'Samsung', deviceModel: 'UKS9800', osName: 'Tizen', osVersion: '2.4.0' },
  },
  WEB_EMBEDDED: {
    name: 'WEB_EMBEDDED_PLAYER',
    nameId: 56,
    version: '2.20260708.00.00',
    userAgent: SAFARI_UA,
    embedded: true,
  },
};

export interface EmbedContext {
  visitorData?: string;
  hostFlags?: string;
}

export interface PlayerRequest {
  fetch: typeof fetch;
  client: DirectClient;
  videoId: string;
  visitorData?: string;
  /** From the player script; the TV client answers "page needs to be reloaded" without it. */
  signatureTimestamp?: number;
  poToken?: string;
  embed?: EmbedContext;
  /** `Cookie` header and the matching `Authorization` value, for a signed-in request. */
  auth?: { cookie: string; authorization?: string };
  lang?: string;
  location?: string;
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

/** Merge all JSON ytcfg.set calls; ignore non-JSON calls. */
export function readYtcfg(page: string): Json {
  const merged: Json = {};
  for (const [, body] of page.matchAll(/ytcfg\.set\s*\(\s*(\{.+?\})\s*\)\s*;/gs)) {
    try {
      const parsed: unknown = JSON.parse(body ?? '');
      if (parsed && typeof parsed === 'object') Object.assign(merged, parsed);
    } catch {
      // Not every ytcfg.set call carries JSON.
    }
  }
  return merged;
}

/** Embedded playback needs visitor data and host flags from its embed page. */
export async function fetchEmbedContext(
  fetchFn: typeof fetch,
  videoId: string,
  signal?: AbortSignal,
): Promise<EmbedContext> {
  const response = await fetchFn(`${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(videoId)}?html5=1`, {
    headers: { 'user-agent': CHROME_UA, referer: EMBED_HOST },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw httpError(response.status, 'YouTube embed page');
  const config = readYtcfg(await response.text());
  const contexts = config.WEB_PLAYER_CONTEXT_CONFIGS as Record<string, Json> | undefined;
  const embedded = contexts?.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER;
  const context: EmbedContext = {};
  if (typeof config.VISITOR_DATA === 'string') context.visitorData = config.VISITOR_DATA;
  if (typeof embedded?.encryptedHostFlags === 'string') context.hostFlags = embedded.encryptedHostFlags;
  return context;
}

export async function requestPlayer(request: PlayerRequest): Promise<Json> {
  const { client, visitorData, embed, auth } = request;
  const body = {
    context: {
      client: {
        clientName: client.name,
        clientVersion: client.version,
        ...client.context,
        userAgent: client.userAgent,
        hl: request.lang ?? 'en',
        gl: request.location ?? 'US',
        utcOffsetMinutes: 0,
        ...(visitorData ? { visitorData } : {}),
      },
      ...(client.embedded ? { thirdParty: { embedUrl: EMBED_HOST } } : {}),
    },
    videoId: request.videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
        ...(request.signatureTimestamp ? { signatureTimestamp: request.signatureTimestamp } : {}),
        ...(embed?.hostFlags ? { encryptedHostFlags: embed.hostFlags } : {}),
      },
    },
    ...(request.poToken ? { serviceIntegrityDimensions: { poToken: request.poToken } } : {}),
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': client.userAgent,
    'x-youtube-client-name': String(client.nameId),
    'x-youtube-client-version': client.version,
    origin: YOUTUBE_ORIGIN,
    ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
  };
  if (auth) {
    headers.cookie = auth.cookie;
    if (auth.authorization) {
      headers.authorization = auth.authorization;
      headers['x-goog-authuser'] = '0';
      headers['x-origin'] = YOUTUBE_ORIGIN;
    }
  }

  const response = await request.fetch(`${YOUTUBE_ORIGIN}/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!response.ok) throw httpError(response.status, `YouTube ${client.name} player`);
  const json: unknown = await response.json();
  if (!json || typeof json !== 'object')
    throw new ExtractorError(`YouTube ${client.name} player returned no object`);
  return json as Json;
}

/** Some clients put the useful refusal text on the nested error screen. */
export function playabilityReason(status: unknown): string {
  const s = (status ?? {}) as Json;
  const screen = ((s.errorScreen as Json | undefined)?.playerErrorMessageRenderer ?? {}) as Json;
  const messages = Array.isArray(s.messages) ? s.messages : [];
  const parts = [s.reason, screen.reason, screen.subreason, ...messages].map(readText).filter(Boolean);
  return [...new Set(parts)].join(' ');
}

/** Stream URLs stay blocked until preroll finishes; a skip offset can shorten the wait. */
export function prerollWaitMs(response: Json): number {
  const ads: unknown[] = [];
  for (const placement of list(response.adPlacements)) {
    const renderer = dig(placement, 'adPlacementRenderer');
    if (dig(renderer, 'config', 'adPlacementConfig', 'kind') !== 'AD_PLACEMENT_KIND_START') continue;
    ads.push(dig(renderer, 'renderer', 'instreamVideoAdRenderer'));
  }
  for (const slot of list(response.adSlots)) {
    const renderer = dig(slot, 'adSlotRenderer');
    if (dig(renderer, 'adSlotMetadata', 'triggerEvent') !== 'SLOT_TRIGGER_EVENT_BEFORE_CONTENT') continue;
    const content = dig(
      renderer,
      'fulfillmentContent',
      'fulfilledLayout',
      'playerBytesAdLayoutRenderer',
      'renderingContent',
    );
    ads.push(dig(content, 'instreamVideoAdRenderer'));
    for (const layout of list(dig(content, 'playerBytesSequentialLayoutRenderer', 'sequentialLayouts'))) {
      ads.push(dig(layout, 'playerBytesAdLayoutRenderer', 'renderingContent', 'instreamVideoAdRenderer'));
    }
  }
  let waitMs = 0;
  for (const ad of ads) {
    const skip = Number(dig(ad, 'skipOffsetMilliseconds'));
    if (skip > 0) {
      waitMs += skip;
      continue;
    }
    const vars = dig(ad, 'playerVars');
    const seconds = typeof vars === 'string' ? Number(new URLSearchParams(vars).get('length_seconds')) : 0;
    if (seconds > 0) waitMs += seconds * 1000;
  }
  return waitMs;
}

function dig(value: unknown, ...path: string[]): unknown {
  let node = value;
  for (const key of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Json)[key];
  }
  return node;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as { simpleText?: unknown; runs?: { text?: unknown }[] };
  if (typeof node.simpleText === 'string') return node.simpleText;
  return Array.isArray(node.runs)
    ? node.runs.map((run) => (typeof run.text === 'string' ? run.text : '')).join('')
    : '';
}

function httpError(status: number, what: string): Error {
  const message = `${what} answered HTTP ${status}`;
  if (status === 429) return new RateLimitedError(message);
  return status >= 500 ? new NetworkError(message) : new ExtractorError(message);
}
