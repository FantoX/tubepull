import { NetworkError, isAbortLike, toAbortError } from '../errors.js';
import { isNetworkFailure } from '../extractor/playability.js';
import type { RangeMode } from '../extractor/Extractor.js';
import { backoffDelay, DEFAULT_BACKOFF, parseRetryAfter, sleep, type BackoffOptions } from './retry.js';

//---- Section used for chunked ranged HTTP ----

export const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
export const DEFAULT_RETRIES = 5;
const DEFAULT_MAX_REFRESHES = 3;
const DEFAULT_STALL_MS = 30_000;

export interface MediaSource {
  url: string;
  headers: Record<string, string>;
  rangeMode: RangeMode;
  contentLength?: number;
  /**
   * Re-extract after 403/410/404 (expired or refused URL). May return new headers too, when the fresh
   * URL comes from a different client.
   */
  refresh?: () => Promise<string | { url: string; headers?: Record<string, string> }>;
}

export interface RetryInfo {
  attempt: number;
  reason: string;
  delayMs: number;
}

export interface ChunkStreamOptions {
  source: MediaSource;
  /** First byte to fetch (resume offset). */
  start?: number;
  chunkSize?: number;
  /** Retries per chunk without progress. */
  retries?: number;
  maxRefreshes?: number;
  /** Abort a request that delivers no bytes for this long. */
  stallTimeoutMs?: number;
  backoff?: BackoffOptions;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onRetry?: (info: RetryInfo) => void;
  /** Called once the total size is known (immediately when the source declares it). */
  onTotal?: (total: number) => void;
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`HTTP ${status}`);
  }
}

class StallError extends Error {
  constructor(ms: number) {
    super(`no data received for ${Math.round(ms / 1000)}s`);
  }
}

class EmptyChunkError extends Error {
  constructor() {
    super('server returned an empty chunk');
  }
}

/**
 * This function is used for building the request for one byte range: googlevideo-style `range=` query
 * parameter, or a standard `Range` header.
 */
export function buildRangeRequest(
  source: Pick<MediaSource, 'headers' | 'rangeMode'>,
  url: string,
  start: number,
  end: number,
): { url: string; headers: Record<string, string> } {
  if (source.rangeMode === 'query') {
    const u = new URL(url);
    u.searchParams.set('range', `${start}-${end}`);
    return { url: u.toString(), headers: { ...source.headers } };
  }
  return { url, headers: { ...source.headers, Range: `bytes=${start}-${end}` } };
}

/**
 * This function is used for reading the total size from a `Content-Range: bytes a-b/total` header.
 */
export function parseContentRangeTotal(value: string | null): number | undefined {
  const match = /\/(\d+)\s*$/.exec(value ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * This function is used for streaming a media file as ~10 MiB ranged requests. Each chunk is retried
 * with backoff on network errors, stalls and 5xx/429; a 403/410 refreshes the URL. Bytes are yielded
 * exactly once and in order, so callers can append them to a file or pipe them on.
 */
export async function* fetchMediaChunks(
  options: ChunkStreamOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
  const {
    source,
    chunkSize = DEFAULT_CHUNK_SIZE,
    retries = DEFAULT_RETRIES,
    maxRefreshes = DEFAULT_MAX_REFRESHES,
    stallTimeoutMs = DEFAULT_STALL_MS,
    backoff = DEFAULT_BACKOFF,
    signal,
    onRetry,
    onTotal,
  } = options;
  const fetchFn = options.fetch ?? fetch;

  let offset = options.start ?? 0;
  let total = source.contentLength;
  if (total !== undefined) onTotal?.(total);
  let url = source.url;
  let request: Pick<MediaSource, 'headers' | 'rangeMode'> = {
    headers: source.headers,
    rangeMode: source.rangeMode,
  };
  let attempt = 0;
  let refreshes = 0;

  while (total === undefined || offset < total) {
    if (signal?.aborted) throw toAbortError(signal);
    const end = total === undefined ? offset + chunkSize - 1 : Math.min(offset + chunkSize, total) - 1;
    const requestController = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, requestController.signal])
      : requestController.signal;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => requestController.abort(new StallError(stallTimeoutMs)), stallTimeoutMs);
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let receivedThisChunk = 0;
    const chunkStart = offset;

    // The outer try/finally also runs when the consumer stops iterating early (generator return()).
    try {
      try {
        const range = buildRangeRequest(request, url, offset, end);
        armStall();
        const response = await fetchFn(range.url, {
          headers: range.headers,
          signal: requestSignal,
          redirect: 'follow',
        });

        if (response.status !== 200 && response.status !== 206) {
          await response.body?.cancel().catch(() => {});
          throw new HttpStatusError(response.status, parseRetryAfter(response.headers.get('retry-after')));
        }
        // A server that ignores Range sends the whole file from byte 0.
        const wholeBody = source.rangeMode === 'header' && response.status === 200;
        if (total === undefined) {
          const declared = wholeBody
            ? Number(response.headers.get('content-length')) || undefined
            : parseContentRangeTotal(response.headers.get('content-range'));
          if (declared !== undefined) {
            total = declared;
            onTotal?.(total);
          }
        }

        let skip = wholeBody ? offset : 0;
        const expected = wholeBody ? Number.POSITIVE_INFINITY : end - offset + 1;
        if (!response.body) throw new EmptyChunkError();
        reader = response.body.getReader();

        for (;;) {
          armStall();
          const { value, done } = await reader.read();
          if (done) break;
          let piece = value;
          if (skip > 0) {
            const dropped = Math.min(skip, piece.byteLength);
            skip -= dropped;
            piece = piece.subarray(dropped);
          }
          const room = expected - receivedThisChunk;
          if (piece.byteLength > room) piece = piece.subarray(0, room);
          if (piece.byteLength === 0) {
            if (room <= 0) break;
            continue;
          }
          receivedThisChunk += piece.byteLength;
          offset += piece.byteLength;
          attempt = 0;
          yield piece;
        }
        clearTimeout(stallTimer);

        if (wholeBody) {
          total ??= offset;
          if (offset >= total) return;
        }
        if (receivedThisChunk === 0) throw new EmptyChunkError();
        // Unknown size and a short chunk: that was the end of the file.
        if (total === undefined && receivedThisChunk < end - chunkStart + 1) return;
        // Otherwise loop: a short chunk simply continues from the new offset.
      } catch (error) {
        clearTimeout(stallTimer);
        reader?.cancel().catch(() => {});
        reader = undefined;
        if (signal?.aborted) throw toAbortError(signal, error);

        const stalled = requestSignal.reason instanceof StallError ? requestSignal.reason : undefined;
        const cause = stalled ?? error;

        if (cause instanceof HttpStatusError) {
          if (cause.status === 416 && total === undefined && offset > 0) return; // read past the end
          if ((cause.status === 403 || cause.status === 410 || cause.status === 404) && source.refresh) {
            if (refreshes >= maxRefreshes) {
              throw new NetworkError(
                `Media request kept failing with HTTP ${cause.status} after refreshing the URL`,
                {
                  cause,
                  details: { status: cause.status },
                  hint:
                    'YouTube refused the stream for every client tried. Try --cookies cookies.txt, a PO token ' +
                    '(--po-token/--visitor-data), or another network; see docs/TROUBLESHOOTING.md.',
                },
              );
            }
            refreshes++;
            onRetry?.({ attempt: refreshes, reason: `HTTP ${cause.status}, refreshing URL`, delayMs: 0 });
            const fresh = await source.refresh();
            if (typeof fresh === 'string') url = fresh;
            else {
              url = fresh.url;
              if (fresh.headers) request = { ...request, headers: fresh.headers };
            }
            continue;
          }
          if (!isRetryableStatus(cause.status)) {
            throw new NetworkError(`Media request failed with HTTP ${cause.status}`, {
              cause,
              details: { status: cause.status },
            });
          }
        } else if (
          !(cause instanceof StallError) &&
          !(cause instanceof EmptyChunkError) &&
          !isRetryableIo(cause)
        ) {
          throw cause;
        }

        attempt++;
        const reason = cause instanceof Error ? cause.message : String(cause);
        if (attempt > retries) {
          throw new NetworkError(`Download failed after ${retries} retries: ${reason}`, { cause });
        }
        const retryAfter = cause instanceof HttpStatusError ? cause.retryAfterMs : undefined;
        const delayMs = Math.min(retryAfter ?? backoffDelay(attempt, backoff), 60_000);
        onRetry?.({ attempt, reason, delayMs });
        await sleep(delayMs, signal);
      }
    } finally {
      clearTimeout(stallTimer);
      reader?.cancel().catch(() => {});
    }
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableIo(error: unknown): boolean {
  if (isAbortLike(error)) return true; // request-level timeout, not the user's signal
  if (isNetworkFailure(error)) return true;
  // undici reports a socket closed mid-body as "TypeError: terminated".
  return error instanceof Error && /terminated|socket|premature|aborted|ECONNRESET/i.test(error.message);
}
