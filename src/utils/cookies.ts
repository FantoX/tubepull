import { readFile } from 'node:fs/promises';
import { InvalidArgumentError } from '../errors.js';

export interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
}

/** Netscape exports may prefix HttpOnly rows with #HttpOnly_. */
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

/** Ignore expired cookies and domains outside youtube.com. */
export function toYouTubeCookieHeader(cookies: NetscapeCookie[], nowSec = Date.now() / 1000): string {
  const seen = new Map<string, string>();
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    if (domain !== 'youtube.com' && !domain.endsWith('.youtube.com')) continue;
    if (cookie.expires > 0 && cookie.expires < nowSec) continue;
    seen.set(cookie.name, cookie.value);
  }
  return withSapisid([...seen].map(([name, value]) => `${name}=${value}`).join('; '));
}

export function cookieValue(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Use __Secure-3PAPISID when browser exports omit SAPISID. */
export function withSapisid(header: string): string {
  if (cookieValue(header, 'SAPISID')) return header;
  const fallback = cookieValue(header, '__Secure-3PAPISID');
  return fallback ? `${header}; SAPISID=${fallback}` : header;
}

/** Accept a Netscape cookie-file path or a raw Cookie header. */
export async function loadCookies(input: string): Promise<string> {
  const value = input.trim();
  const looksLikeHeader = /^[^\s=;/\\]+=[^;]*(;\s*[^\s=;]+=[^;]*)*;?$/.test(value) && !/\.txt$/i.test(value);
  if (looksLikeHeader) return withSapisid(value);

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
