//---- Section used for HTTP helpers ----

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * This function is used for giving every request through `fetchFn` a deadline, so a hung InnerTube or
 * player-script request fails (and is retried) instead of blocking forever. The caller's own signal
 * still works; a timeout surfaces as a `TimeoutError`, not as a user abort.
 */
export function withRequestTimeout(
  fetchFn: typeof fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): typeof fetch {
  const timed = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    return fetchFn(input, { ...init, signal });
  };
  return timed as typeof fetch;
}

/**
 * This function is used for reading when a googlevideo stream URL stops working (its `expire` parameter,
 * epoch seconds), or undefined when the URL does not say.
 */
export function urlExpiresAt(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const expire = Number(new URL(url).searchParams.get('expire'));
    return Number.isFinite(expire) && expire > 0 ? expire * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function is used for spotting a stream URL whose `n` parameter was not transformed by the player
 * script. YouTube throttles such URLs to a crawl, so they are only worth using as a last resort.
 */
export function isNThrottled(originalUrl: string | undefined, decipheredUrl: string): boolean {
  if (!originalUrl) return false;
  try {
    const before = new URL(originalUrl).searchParams.get('n');
    if (!before) return false;
    const after = new URL(decipheredUrl).searchParams.get('n');
    return !after || after === before || after.startsWith('enhanced_except');
  } catch {
    return false;
  }
}
