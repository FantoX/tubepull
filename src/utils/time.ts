import { InvalidArgumentError } from '../errors.js';

//---- Section used for time parsing ----

/**
 * This function is used for parsing a time given as seconds (`90`, `"90.5"`) or a clock string
 * (`"1:30"`, `"01:01:30.250"`) into seconds.
 */
export function parseTime(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new InvalidArgumentError(`Invalid time: ${input}`);
    return input;
  }
  const value = input.trim();
  if (/^\d+(\.\d+)?s?$/.test(value)) return Number.parseFloat(value);

  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value);
  if (!match) throw new InvalidArgumentError(`Invalid time "${input}". Use seconds or HH:MM:SS.`);
  const [, h, m, s] = match;
  const minutes = Number(m);
  const seconds = Number(s);
  if (minutes >= 60 || seconds >= 60) throw new InvalidArgumentError(`Invalid time "${input}".`);
  return Number(h ?? 0) * 3600 + minutes * 60 + seconds;
}

/**
 * This function is used for formatting seconds as `H:MM:SS` (or `M:SS` under an hour).
 */
export function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '--:--';
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * This function is used for formatting seconds as an ffmpeg timestamp `HH:MM:SS.mmm`.
 */
export function toFfmpegTime(totalSec: number): string {
  const ms = Math.round(totalSec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(rest, 3)}`;
}

export interface ResolvedRange {
  startSec?: number;
  endSec?: number;
}

/**
 * This function is used for validating a user time range against the video duration.
 * Returns undefined when the range covers the whole video.
 */
export function resolveRange(
  range: { start?: string | number; end?: string | number } | undefined,
  durationSec: number,
): ResolvedRange | undefined {
  if (!range) return undefined;
  const startSec = range.start === undefined || range.start === '' ? undefined : parseTime(range.start);
  const endSec = range.end === undefined || range.end === '' ? undefined : parseTime(range.end);
  if (startSec !== undefined && endSec !== undefined && endSec <= startSec) {
    throw new InvalidArgumentError(`Range end (${endSec}s) must be after start (${startSec}s).`);
  }
  if (durationSec > 0 && startSec !== undefined && startSec >= durationSec) {
    throw new InvalidArgumentError(
      `Range start (${startSec}s) is beyond the video length (${durationSec}s).`,
    );
  }
  const effectiveStart = startSec && startSec > 0 ? startSec : undefined;
  const effectiveEnd =
    endSec !== undefined && (durationSec <= 0 || endSec < durationSec) ? endSec : undefined;
  if (effectiveStart === undefined && effectiveEnd === undefined) return undefined;
  const out: ResolvedRange = {};
  if (effectiveStart !== undefined) out.startSec = effectiveStart;
  if (effectiveEnd !== undefined) out.endSec = effectiveEnd;
  return out;
}
