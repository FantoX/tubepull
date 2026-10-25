export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Keep request timeouts distinct from the caller's abort signal. */
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

/** The expire query parameter is epoch seconds. */
export function urlExpiresAt(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const expire = Number(new URL(url).searchParams.get('expire'));
    return Number.isFinite(expire) && expire > 0 ? expire * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** An unchanged n parameter indicates a throttled URL. */
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
