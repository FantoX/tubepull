import { InvalidUrlError } from '../errors.js';

//---- Section used for YouTube URL parsing ----

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'gaming.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Path prefixes whose next segment is the video ID. */
const ID_PATH_PREFIXES = ['shorts', 'embed', 'live', 'v', 'e', 'watch'];

export interface ParsedTarget {
  videoId?: string;
  playlistId?: string;
}

/**
 * This function is used for checking whether a string is a well-formed 11-character video ID.
 */
export function isVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

/**
 * This function is used for extracting the video and/or playlist ID from any YouTube URL form
 * (watch, youtu.be, shorts, embed, live, music, nocookie) or a bare video ID.
 * Returns an empty object when nothing is recognised.
 */
export function parseTarget(input: string): ParsedTarget {
  const raw = input.trim();
  if (VIDEO_ID.test(raw)) return { videoId: raw };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return {};
  }

  const host = url.hostname.toLowerCase();
  const result: ParsedTarget = {};

  const list = url.searchParams.get('list');
  if (list && PLAYLIST_ID.test(list)) result.playlistId = list;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (id && VIDEO_ID.test(id)) result.videoId = id;
    return result;
  }

  if (!YOUTUBE_HOSTS.has(host)) return {};

  const v = url.searchParams.get('v');
  if (v && VIDEO_ID.test(v)) {
    result.videoId = v;
    return result;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const [first, second] = segments;
  if (first && second && ID_PATH_PREFIXES.includes(first.toLowerCase()) && VIDEO_ID.test(second)) {
    result.videoId = second;
  }
  return result;
}

/**
 * This function is used for resolving a URL or bare ID to a video ID, throwing InvalidUrlError otherwise.
 */
export function parseVideoId(input: string): string {
  const { videoId } = parseTarget(input);
  if (!videoId) throw new InvalidUrlError(input);
  return videoId;
}

/**
 * This function is used for building the canonical watch URL for a video ID.
 */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
