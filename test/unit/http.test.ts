import { describe, expect, it } from 'vitest';
import { mapThrown } from '../../src/extractor/playability.js';
import { isNThrottled, urlExpiresAt, withRequestTimeout } from '../../src/utils/http.js';

const hangingFetch = ((_input: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  })) as unknown as typeof fetch;

describe('withRequestTimeout', () => {
  it('fails a hung request with a TimeoutError that maps to a retryable network error', async () => {
    const error = await withRequestTimeout(hangingFetch, 50)('https://example.com').catch((e: unknown) => e);
    expect((error as Error).name).toBe('TimeoutError');
    expect(mapThrown(error).code).toBe('NETWORK');
  });

  it("keeps the caller's own signal working, and that counts as a cancel", async () => {
    const controller = new AbortController();
    const pending = withRequestTimeout(hangingFetch, 10_000)('https://example.com', {
      signal: controller.signal,
    });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(mapThrown(error, controller.signal).code).toBe('ABORTED');
  });

  it('passes requests through untouched otherwise', async () => {
    let seen: RequestInit | undefined;
    const ok = (async (_input: unknown, init?: RequestInit) => {
      seen = init;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const response = await withRequestTimeout(ok)('https://example.com', {
      method: 'POST',
      headers: { a: '1' },
    });
    expect(await response.text()).toBe('ok');
    expect(seen?.method).toBe('POST');
    expect(seen?.headers).toEqual({ a: '1' });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('urlExpiresAt', () => {
  it('reads the expire parameter as epoch milliseconds', () => {
    expect(urlExpiresAt('https://r1.googlevideo.com/videoplayback?expire=1700000000&itag=140')).toBe(
      1_700_000_000_000,
    );
    expect(urlExpiresAt('https://r1.googlevideo.com/videoplayback?itag=140')).toBeUndefined();
    expect(urlExpiresAt('not a url')).toBeUndefined();
    expect(urlExpiresAt(undefined)).toBeUndefined();
  });
});

describe('isNThrottled', () => {
  const base = 'https://r1.googlevideo.com/videoplayback?itag=140';
  it('flags URLs whose n parameter was not transformed', () => {
    expect(isNThrottled(`${base}&n=abc`, `${base}&n=abc`)).toBe(true);
    expect(isNThrottled(`${base}&n=abc`, `${base}&n=enhanced_except_xyz`)).toBe(true);
    expect(isNThrottled(`${base}&n=abc`, base)).toBe(true);
  });

  it('accepts transformed or n-less URLs', () => {
    expect(isNThrottled(`${base}&n=abc`, `${base}&n=XyZ123`)).toBe(false);
    expect(isNThrottled(base, base)).toBe(false);
    expect(isNThrottled(undefined, base)).toBe(false);
  });
});
