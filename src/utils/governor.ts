import { toAbortError } from '../errors.js';
import { backoffDelay, parseRetryAfter, sleep } from '../download/retry.js';

export interface GovernorOptions {
  maxConcurrent?: number;
  /** Minimum gap between the starts of two requests. */
  minIntervalMs?: number;
  now?: () => number;
}

export const DEFAULT_GOVERNOR: Required<Omit<GovernorOptions, 'now'>> = {
  maxConcurrent: 2,
  minIntervalMs: 300,
};

/** Share concurrency, spacing, and cooldowns across one instance. */
export class RequestGovernor {
  readonly #maxConcurrent: number;
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  #active = 0;
  #nextStart = 0;
  #cooldownUntil = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(options: GovernorOptions = {}) {
    this.#maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_GOVERNOR.maxConcurrent);
    this.#minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_GOVERNOR.minIntervalMs);
    this.#now = options.now ?? Date.now;
  }

  /** Milliseconds until the shared cooldown ends (0 when none). */
  get cooldownRemaining(): number {
    return Math.max(0, this.#cooldownUntil - this.#now());
  }

  /** A shorter pause must not shorten the active cooldown. */
  pause(ms: number): void {
    this.#cooldownUntil = Math.max(this.#cooldownUntil, this.#now() + ms);
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }

  async #acquire(signal?: AbortSignal): Promise<void> {
    while (this.#active >= this.#maxConcurrent) {
      if (signal?.aborted) throw toAbortError(signal);
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          const index = this.#waiting.indexOf(wake);
          if (index !== -1) this.#waiting.splice(index, 1);
          resolve();
        };
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        this.#waiting.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.#active++;
    try {
      for (;;) {
        const now = this.#now();
        const wait = Math.max(this.#cooldownUntil - now, this.#nextStart - now);
        if (wait <= 0) break;
        await sleep(wait, signal);
      }
    } catch (error) {
      this.#active--;
      this.#waiting.shift()?.();
      throw error;
    }
    this.#nextStart = this.#now() + this.#minIntervalMs;
  }
}

const THROTTLE_STATUSES = new Set([429, 503]);
const MAX_THROTTLE_RETRIES = 3;
const THROTTLE_BACKOFF = { baseMs: 2_000, maxMs: 60_000 };

/** Retry 429/503 with an instance-wide cooldown; return the final response when retries run out. */
export function governedFetch(fetchFn: typeof fetch, governor: RequestGovernor): typeof fetch {
  const governed = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    for (let attempt = 1; ; attempt++) {
      const response = await governor.run(() => fetchFn(input, init), signal ?? undefined);
      if (!THROTTLE_STATUSES.has(response.status) || attempt > MAX_THROTTLE_RETRIES) return response;
      const delay =
        parseRetryAfter(response.headers.get('retry-after')) ?? backoffDelay(attempt, THROTTLE_BACKOFF);
      await response.body?.cancel().catch(() => {});
      governor.pause(Math.min(delay, THROTTLE_BACKOFF.maxMs));
    }
  };
  return governed as typeof fetch;
}
