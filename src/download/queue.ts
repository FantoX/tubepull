import { throwIfAborted } from '../errors.js';

//---- Section used for bounded concurrency ----

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * This function is used for running `worker` over `items` with at most `concurrency` in flight,
 * returning settled results in input order. One failure does not stop the others; an abort does.
 */
export async function runQueue<I, T>(
  items: readonly I[],
  concurrency: number,
  worker: (item: I, index: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<Settled<T>[]> {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const results = new Array<Settled<T>>(items.length);
  let next = 0;

  const lane = async () => {
    for (;;) {
      throwIfAborted(signal);
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index] as I, index) };
      } catch (error) {
        throwIfAborted(signal);
        results[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
