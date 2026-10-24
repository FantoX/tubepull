import { describe, expect, it } from 'vitest';
import { buildRangeRequest, parseContentRangeTotal } from '../../src/download/chunked.js';
import { SpeedMeter, createThrottle } from '../../src/download/progress.js';
import { runQueue } from '../../src/download/queue.js';
import { backoffDelay, parseRetryAfter, sleep } from '../../src/download/retry.js';
import { AbortError } from '../../src/errors.js';

describe('backoffDelay', () => {
  it('grows exponentially with jitter and caps', () => {
    const opts = { baseMs: 100, maxMs: 1000 };
    expect(backoffDelay(1, opts, () => 0)).toBe(50);
    expect(backoffDelay(1, opts, () => 1)).toBe(100);
    expect(backoffDelay(3, opts, () => 1)).toBe(400);
    expect(backoffDelay(10, opts, () => 1)).toBe(1000);
    expect(backoffDelay(10, opts, () => 0)).toBe(500);
  });

  it('parses Retry-After', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('nonsense')).toBeUndefined();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
  });

  it('sleep rejects with AbortError when aborted', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });
});

describe('range requests', () => {
  it('uses a query parameter or a header', () => {
    expect(buildRangeRequest({ headers: { a: '1' }, rangeMode: 'query' }, 'https://h/v?x=1', 0, 99)).toEqual({
      url: 'https://h/v?x=1&range=0-99',
      headers: { a: '1' },
    });
    expect(buildRangeRequest({ headers: {}, rangeMode: 'header' }, 'https://h/v', 100, 199)).toEqual({
      url: 'https://h/v',
      headers: { Range: 'bytes=100-199' },
    });
  });

  it('replaces an existing range parameter', () => {
    expect(buildRangeRequest({ headers: {}, rangeMode: 'query' }, 'https://h/v?range=0-1', 5, 9).url).toBe(
      'https://h/v?range=5-9',
    );
  });

  it('reads Content-Range totals', () => {
    expect(parseContentRangeTotal('bytes 0-99/12345')).toBe(12345);
    expect(parseContentRangeTotal('bytes 0-99/*')).toBeUndefined();
    expect(parseContentRangeTotal(null)).toBeUndefined();
  });
});

describe('SpeedMeter and throttle', () => {
  it('computes speed over a sliding window and ETA', () => {
    let now = 0;
    const meter = new SpeedMeter(() => now);
    meter.record(0);
    expect(meter.speed).toBeUndefined();
    now = 1000;
    meter.record(1000);
    expect(meter.speed).toBe(1000);
    expect(meter.eta(5000, 1000)).toBe(4);
    now = 10_000;
    meter.record(10_000);
    now = 11_000;
    meter.record(20_000);
    expect(meter.speed).toBeGreaterThan(1000);
  });

  it('throttles but lets forced calls through', () => {
    let now = 0;
    const throttle = createThrottle(100, () => now);
    expect(throttle()).toBe(true);
    now = 50;
    expect(throttle()).toBe(false);
    expect(throttle(true)).toBe(true);
    now = 200;
    expect(throttle()).toBe(true);
  });
});

describe('runQueue', () => {
  it('respects the concurrency limit and keeps input order', async () => {
    let active = 0;
    let peak = 0;
    const results = await runQueue([30, 10, 20, 5, 15], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(peak).toBe(2);
    expect(results.map((r) => (r.ok ? r.value : -1))).toEqual([0, 1, 2, 3, 4]);
  });

  it('isolates failures', async () => {
    const results = await runQueue([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error('bad');
      return n;
    });
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    const pending = runQueue(
      [1, 2, 3, 4],
      1,
      async (n) => {
        if (n === 2) controller.abort();
        return n;
      },
      controller.signal,
    );
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });
});
