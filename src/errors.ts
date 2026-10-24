//---- Section used for typed errors ----

export type ErrorCode =
  | 'INVALID_URL'
  | 'INVALID_ARGUMENT'
  | 'VIDEO_UNAVAILABLE'
  | 'AGE_RESTRICTED'
  | 'PRIVATE_VIDEO'
  | 'REGION_BLOCKED'
  | 'MEMBERS_ONLY'
  | 'LIVE_STREAM'
  | 'BOT_CHECK'
  | 'RATE_LIMITED'
  | 'PO_TOKEN'
  | 'NO_SUITABLE_FORMAT'
  | 'FFMPEG_NOT_FOUND'
  | 'FFMPEG_FAILED'
  | 'NETWORK'
  | 'FILE_EXISTS'
  | 'EXTRACTOR'
  | 'ABORTED';

export interface TubePullErrorOptions {
  hint?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

/** Base class of every error thrown by tubepull. Check `code` rather than `instanceof` across module systems. */
export class TubePullError extends Error {
  readonly code: ErrorCode;
  /** Actionable advice for the user. */
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: TubePullErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.details !== undefined) this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
    };
  }
}

export class InvalidUrlError extends TubePullError {
  constructor(input: string, options: TubePullErrorOptions = {}) {
    super('INVALID_URL', `Not a YouTube video or playlist URL/ID: ${input}`, {
      hint: 'Pass a youtube.com / youtu.be link or an 11-character video ID.',
      ...options,
    });
  }
}

export class InvalidArgumentError extends TubePullError {
  constructor(message: string, options: TubePullErrorOptions = {}) {
    super('INVALID_ARGUMENT', message, options);
  }
}

export class VideoUnavailableError extends TubePullError {
  constructor(message = 'Video unavailable', options: TubePullErrorOptions = {}) {
    super('VIDEO_UNAVAILABLE', message, {
      hint: 'Check the link in a browser; the video may have been removed.',
      ...options,
    });
  }
}

export class AgeRestrictedError extends TubePullError {
  constructor(message = 'Video is age-restricted', options: TubePullErrorOptions = {}) {
    super('AGE_RESTRICTED', message, {
      hint: 'Pass cookies from a signed-in, age-verified account (--cookies cookies.txt).',
      ...options,
    });
  }
}

export class PrivateVideoError extends TubePullError {
  constructor(message = 'Video is private', options: TubePullErrorOptions = {}) {
    super('PRIVATE_VIDEO', message, {
      hint: 'Private videos need cookies from an account that has access (--cookies cookies.txt).',
      ...options,
    });
  }
}

export class RegionBlockedError extends TubePullError {
  constructor(message = 'Video is not available in your region', options: TubePullErrorOptions = {}) {
    super('REGION_BLOCKED', message, {
      hint: 'Try a proxy in a region where the video is available (--proxy).',
      ...options,
    });
  }
}

export class MembersOnlyError extends TubePullError {
  constructor(message = 'Video is for channel members only', options: TubePullErrorOptions = {}) {
    super('MEMBERS_ONLY', message, {
      hint: 'Members-only content needs cookies from a member account (--cookies cookies.txt).',
      ...options,
    });
  }
}

export class LiveStreamError extends TubePullError {
  constructor(message = 'Live streams are not supported yet', options: TubePullErrorOptions = {}) {
    super('LIVE_STREAM', message, {
      hint: 'Wait until the stream has ended and been processed, then try again.',
      ...options,
    });
  }
}

export class BotCheckError extends TubePullError {
  constructor(message = 'YouTube asked to confirm you are not a bot', options: TubePullErrorOptions = {}) {
    super('BOT_CHECK', message, {
      hint:
        'YouTube is challenging this network (datacenter and VPN IPs often are). Wait and retry later, or use ' +
        'another network. Signed-in cookies (--cookies) or a PO token (--po-token) can also help.',
      ...options,
    });
  }
}

export class RateLimitedError extends TubePullError {
  constructor(message = 'YouTube is rate-limiting this network', options: TubePullErrorOptions = {}) {
    super('RATE_LIMITED', message, {
      hint:
        'Wait before retrying (limits usually lift within 15-60 minutes) and lower --concurrency. ' +
        'tubepull already paces its requests and honours Retry-After.',
      ...options,
    });
  }
}

export class PoTokenError extends TubePullError {
  constructor(message = 'A Proof-of-Origin token is required', options: TubePullErrorOptions = {}) {
    super('PO_TOKEN', message, {
      hint: 'Provide --po-token and --visitor-data, or a poTokenProvider. See docs/TROUBLESHOOTING.md.',
      ...options,
    });
  }
}

export class NoSuitableFormatError extends TubePullError {
  constructor(message: string, options: TubePullErrorOptions = {}) {
    super('NO_SUITABLE_FORMAT', message, {
      hint: 'Run with --list to see the qualities and formats available for this video.',
      ...options,
    });
  }
}

export class FfmpegNotFoundError extends TubePullError {
  constructor(message = 'ffmpeg binary not found', options: TubePullErrorOptions = {}) {
    super('FFMPEG_NOT_FOUND', message, {
      hint:
        'Reinstall so ffmpeg-static can fetch its binary (npm rebuild ffmpeg-static), ' +
        'or set TUBEPULL_FFMPEG_PATH to an ffmpeg executable, or install ffmpeg on PATH.',
      ...options,
    });
  }
}

export class FfmpegError extends TubePullError {
  constructor(message: string, options: TubePullErrorOptions = {}) {
    super('FFMPEG_FAILED', message, {
      hint: 'Re-run with --verbose and include the ffmpeg output when reporting an issue.',
      ...options,
    });
  }
}

export class NetworkError extends TubePullError {
  constructor(message: string, options: TubePullErrorOptions = {}) {
    super('NETWORK', message, {
      hint: 'Check your connection. If it keeps failing, YouTube may be rate-limiting this IP; try --proxy or --cookies.',
      ...options,
    });
  }
}

export class FileExistsError extends TubePullError {
  constructor(path: string, options: TubePullErrorOptions = {}) {
    super('FILE_EXISTS', `Output file already exists: ${path}`, {
      hint: 'Pass overwrite: true (--overwrite) or choose another filename.',
      details: { path },
      ...options,
    });
  }
}

export class ExtractorError extends TubePullError {
  constructor(message: string, options: TubePullErrorOptions = {}) {
    super('EXTRACTOR', message, {
      hint: 'YouTube may have changed something. Update tubepull (npm i tubepull@latest) and run `tubepull doctor`.',
      ...options,
    });
  }
}

export class AbortError extends TubePullError {
  constructor(message = 'The operation was aborted', options: TubePullErrorOptions = {}) {
    super('ABORTED', message, options);
  }
}

/**
 * This function is used for checking whether a value is a tubepull error, optionally of a given code.
 * Works across ESM/CJS copies of the package, unlike `instanceof`.
 */
export function isTubePullError(value: unknown, code?: ErrorCode): value is TubePullError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; name?: unknown };
  if (typeof candidate.code !== 'string' || typeof candidate.name !== 'string') return false;
  if (!(value instanceof Error)) return false;
  return code === undefined ? true : candidate.code === code;
}

/**
 * This function is used for turning a DOM-style abort (or our own) into a typed AbortError.
 */
export function toAbortError(signal?: AbortSignal, cause?: unknown): AbortError {
  const reason: unknown = signal?.reason ?? cause;
  if (isTubePullError(reason, 'ABORTED')) return reason as AbortError;
  return new AbortError(undefined, reason === undefined ? {} : { cause: reason });
}

/**
 * This function is used for throwing a typed AbortError when a signal has fired.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw toAbortError(signal);
}

/**
 * This function is used for recognising abort errors from fetch, timers and our own code.
 */
export function isAbortLike(error: unknown): boolean {
  if (isTubePullError(error, 'ABORTED')) return true;
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
