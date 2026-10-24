import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../src/cli/output.js';
import { AbortError, RateLimitedError } from '../../src/errors.js';
import { mapPlayability, mapThrown } from '../../src/extractor/playability.js';
import { RequestGovernor, governedFetch } from '../../src/utils/governor.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RequestGovernor', () => {
  it('limits requests in flight', async () => {
    const governor = new RequestGovernor({ maxConcurrent: 2, minIntervalMs: 0 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        governor.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick(20);
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('spaces request starts', async () => {
    const governor = new RequestGovernor({ maxConcurrent: 4, minIntervalMs: 40 });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, () => governor.run(async () => void starts.push(Date.now()))),
    );
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number));
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(35);
  });

  it('holds every caller during a cooldown, and never shortens one', async () => {
    const governor = new RequestGovernor({ maxConcurrent: 4, minIntervalMs: 0 });
    governor.pause(150);
    governor.pause(10);
    expect(governor.cooldownRemaining).toBeGreaterThan(100);
    const started = Date.now();
    await Promise.all([governor.run(async () => {}), governor.run(async () => {})]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('releases the slot when a task throws, and honours abort while queued', async () => {
    const governor = new RequestGovernor({ maxConcurrent: 1, minIntervalMs: 0 });
    await expect(governor.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await governor.run(async () => 'next')).toBe('next');

    const controller = new AbortController();
    const blocker = governor.run(() => tick(100));
    const queued = governor.run(async () => 'never', controller.signal);
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(AbortError);
    await blocker;
    expect(await governor.run(async () => 'free')).toBe('free');
  });
});

describe('governedFetch', () => {
  function scripted(statuses: { status: number; retryAfter?: string }[]) {
    const seen: number[] = [];
    const fetchFn = (async () => {
      const next = statuses[Math.min(seen.length, statuses.length - 1)] as {
        status: number;
        retryAfter?: string;
      };
      seen.push(Date.now());
      return new Response('x', {
        status: next.status,
        headers: next.retryAfter ? { 'retry-after': next.retryAfter } : {},
      });
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  }

  it('waits out Retry-After on 429 and pauses the whole instance', async () => {
    const governor = new RequestGovernor({ maxConcurrent: 2, minIntervalMs: 0 });
    const { fetchFn, seen } = scripted([{ status: 429, retryAfter: '0.2' }, { status: 200 }]);
    const response = await governedFetch(fetchFn, governor)('https://www.youtube.com/youtubei/v1/player');
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect((seen[1] as number) - (seen[0] as number)).toBeGreaterThanOrEqual(190);
  });

  it('hands the throttled response back after a few attempts', async () => {
    const governor = new RequestGovernor({ maxConcurrent: 1, minIntervalMs: 0 });
    const { fetchFn, seen } = scripted([{ status: 503, retryAfter: '0' }]);
    const response = await governedFetch(fetchFn, governor)('https://www.youtube.com/');
    expect(response.status).toBe(503);
    expect(seen).toHaveLength(4);
  });

  it('passes ordinary errors and statuses straight through', async () => {
    const governor = new RequestGovernor({ minIntervalMs: 0 });
    const { fetchFn, seen } = scripted([{ status: 404 }]);
    expect((await governedFetch(fetchFn, governor)('https://www.youtube.com/')).status).toBe(404);
    expect(seen).toHaveLength(1);
  });
});

describe('rate-limit classification', () => {
  it('maps YouTube rate-limit answers to RATE_LIMITED (exit 4), separate from bot checks', () => {
    expect(mapPlayability('LOGIN_REQUIRED', 'Our systems have detected unusual traffic')?.code).toBe(
      'RATE_LIMITED',
    );
    expect(mapPlayability('LOGIN_REQUIRED', 'Sign in to confirm you’re not a bot')?.code).toBe('BOT_CHECK');
    expect(mapThrown(new Error('Request to /player failed with status code 429')).code).toBe('RATE_LIMITED');
    expect(mapThrown(new Error('itag 1429 missing')).code).toBe('EXTRACTOR');
    expect(exitCodeFor(new RateLimitedError())).toBe(4);
  });
});
