//---- Section used for transfer speed and throttling ----

const WINDOW_MS = 5_000;

/**
 * Sliding-window speed meter: speed over the last few seconds, so the ETA reacts to throttling
 * without jumping around on every packet.
 */
export class SpeedMeter {
  readonly #samples: { t: number; bytes: number }[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Record the absolute byte count at the current time. */
  record(bytes: number): void {
    const t = this.#now();
    this.#samples.push({ t, bytes });
    while (this.#samples.length > 2 && (this.#samples[0] as { t: number }).t < t - WINDOW_MS)
      this.#samples.shift();
  }

  /** Bytes per second, or undefined until there is enough data. */
  get speed(): number | undefined {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (!first || !last || last.t - first.t < 250) return undefined;
    return ((last.bytes - first.bytes) * 1000) / (last.t - first.t);
  }

  /** Seconds remaining for `total`, or undefined. */
  eta(total: number | undefined, bytes: number): number | undefined {
    const speed = this.speed;
    if (!total || !speed || speed <= 0) return undefined;
    return Math.max(0, (total - bytes) / speed);
  }
}

/**
 * This function is used for limiting how often a callback fires (progress events ~10/s), while always
 * letting a forced/final call through.
 */
export function createThrottle(
  intervalMs: number,
  now: () => number = Date.now,
): (force?: boolean) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (force = false) => {
    const t = now();
    if (!force && t - last < intervalMs) return false;
    last = t;
    return true;
  };
}
