import { readFile } from 'node:fs/promises';
import { InvalidArgumentError } from '../errors.js';

//---- Section used for cookie loading ----

export interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
}

/**
 * This function is used for parsing a Netscape/Mozilla `cookies.txt` file (as exported by browser
 * extensions and yt-dlp). `#HttpOnly_` prefixed lines are kept; comments and malformed lines are skipped.
 */
export function parseNetscapeCookies(text: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, flag, path, secure, expires, name, ...valueParts] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      ...string[],
    ];
    cookies.push({
      domain,
      includeSubdomains: flag.toUpperCase() === 'TRUE',
      path,
      secure: secure.toUpperCase() === 'TRUE',
      expires: Number(expires) || 0,
      name,
      value: valueParts.join('\t'),
    });
  }
  return cookies;
}

/**
 * This function is used for building a `Cookie` header for youtube.com from parsed cookies,
 * dropping expired ones and cookies for other domains.
 */
export function toYouTubeCookieHeader(cookies: NetscapeCookie[], nowSec = Date.now() / 1000): string {
  const seen = new Map<string, string>();
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    if (domain !== 'youtube.com' && !domain.endsWith('.youtube.com')) continue;
    if (cookie.expires > 0 && cookie.expires < nowSec) continue;
    seen.set(cookie.name, cookie.value);
  }
  return [...seen].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * This function is used for resolving the `cookies` option: a path to a cookies.txt file, or a raw
 * `name=value; ...` header string.
 */
export async function loadCookies(input: string): Promise<string> {
  const value = input.trim();
  const looksLikeHeader = /^[^\s=;/\\]+=[^;]*(;\s*[^\s=;]+=[^;]*)*;?$/.test(value) && !/\.txt$/i.test(value);
  if (looksLikeHeader) return value;

  let text: string;
  try {
    text = await readFile(value, 'utf8');
  } catch (cause) {
    throw new InvalidArgumentError(`Cannot read cookies file: ${value}`, {
      cause,
      hint: 'Export cookies in Netscape format (cookies.txt) from a browser extension.',
    });
  }
  const header = toYouTubeCookieHeader(parseNetscapeCookies(text));
  if (!header) {
    throw new InvalidArgumentError(`No unexpired youtube.com cookies found in ${value}`, {
      hint: 'Export cookies while signed in to youtube.com, in Netscape format.',
    });
  }
  return header;
}
