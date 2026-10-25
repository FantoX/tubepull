import {
  AgeRestrictedError,
  BotCheckError,
  ExtractorError,
  LiveStreamError,
  MembersOnlyError,
  NetworkError,
  PoTokenError,
  PrivateVideoError,
  RateLimitedError,
  RegionBlockedError,
  type TubePullError,
  VideoUnavailableError,
  isAbortLike,
  isTubePullError,
  toAbortError,
} from '../errors.js';

export function mapPlayability(
  status: string | undefined,
  reason: string | undefined,
): TubePullError | undefined {
  if (!status || status === 'OK') return undefined;
  const text = (reason ?? '').trim();
  const details = { status, reason: text };
  const message = text || `YouTube returned playability status ${status}`;

  if (/unusual traffic|automated queries|too many requests/i.test(text)) {
    return new RateLimitedError(message, { details });
  }
  if (/not a bot/i.test(text)) return new BotCheckError(message, { details });
  if (/po.?token|proof of origin/i.test(text)) return new PoTokenError(message, { details });
  if (/private/i.test(text)) return new PrivateVideoError(message, { details });
  if (/members|join this channel/i.test(text)) return new MembersOnlyError(message, { details });
  if (/confirm your age|age.?restrict|inappropriate for some users/i.test(text)) {
    return new AgeRestrictedError(message, { details });
  }
  if (/country|region|your location|geo/i.test(text)) return new RegionBlockedError(message, { details });
  if (status === 'LIVE_STREAM_OFFLINE' || /premiere|live event|scheduled|begins in|live stream/i.test(text)) {
    return new LiveStreamError(message, { details });
  }
  if (status === 'LOGIN_REQUIRED') {
    return new VideoUnavailableError(message, {
      details,
      hint: 'YouTube requires sign-in for this video; pass --cookies cookies.txt from a signed-in browser.',
    });
  }
  return new VideoUnavailableError(message, { details });
}

/** Most specific first: a definitive answer from one client beats a generic one from another. */
const PRIORITY = [
  'PRIVATE_VIDEO',
  'MEMBERS_ONLY',
  'AGE_RESTRICTED',
  'REGION_BLOCKED',
  'LIVE_STREAM',
  'BOT_CHECK',
  'RATE_LIMITED',
  'PO_TOKEN',
  'VIDEO_UNAVAILABLE',
  'NETWORK',
  'EXTRACTOR',
];

export function mostRelevantError(errors: TubePullError[]): TubePullError {
  const ranked = [...errors].sort((a, b) => rank(a.code) - rank(b.code));
  return ranked[0] ?? new ExtractorError('No extractor client returned video data.');
}

function rank(code: string): number {
  const index = PRIORITY.indexOf(code);
  return index === -1 ? PRIORITY.length : index;
}

export function mapThrown(error: unknown, signal?: AbortSignal): TubePullError {
  if (isTubePullError(error)) return error;
  if (signal?.aborted) return toAbortError(signal, error);
  const message = error instanceof Error ? error.message : String(error);
  // Not the caller's signal: a request deadline or a connection torn down mid-request. Retryable.
  if (isAbortLike(error))
    return new NetworkError(`Request timed out or was cut off: ${message}`, { cause: error });
  if (/\b429\b|too many requests|unusual traffic/i.test(message)) {
    return new RateLimitedError(`YouTube is rate-limiting requests: ${message}`, { cause: error });
  }
  if (/unavailable|not available|does not exist/i.test(message)) {
    return new VideoUnavailableError(message, { cause: error });
  }
  if (isNetworkFailure(error))
    return new NetworkError(`Network request failed: ${message}`, { cause: error });
  return new ExtractorError(message, { cause: error });
}

export function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TypeError' && /fetch failed|network/i.test(error.message)) return true;
  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
  return (
    typeof code === 'string' &&
    /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_.*)$/.test(
      code,
    )
  );
}
