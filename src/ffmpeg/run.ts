import { spawn } from 'node:child_process';
import { FfmpegError, FfmpegNotFoundError, toAbortError } from '../errors.js';

//---- Section used for running ffmpeg ----

export interface RunFfmpegOptions {
  /** Expected output duration, for percentage progress. */
  durationSec?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number, outTimeSec: number) => void;
}

const STDERR_LINES = 40;

/**
 * This function is used for reading one `key=value` line of ffmpeg's `-progress` output as seconds
 * processed (out_time_us; out_time_ms is also microseconds despite its name), or `end`.
 */
export function parseProgressLine(line: string): { outTimeSec?: number; end?: boolean } {
  const index = line.indexOf('=');
  if (index === -1) return {};
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim();
  if (key === 'progress') return value === 'end' ? { end: true } : {};
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const micros = Number(value);
    return Number.isFinite(micros) && micros >= 0 ? { outTimeSec: micros / 1_000_000 } : {};
  }
  return {};
}

/**
 * This function is used for running ffmpeg with an argument array (never a shell string, so paths with
 * spaces/unicode are safe), reporting progress, and killing the process when the signal aborts.
 */
export function runFfmpeg(binary: string, args: string[], options: RunFfmpegOptions = {}): Promise<void> {
  const { durationSec, signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(toAbortError(signal));

  const fullArgs = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-nostats',
    ...args,
  ];

  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, fullArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrLines: string[] = [];
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let aborted = false;
    let settled = false;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };

    const onAbort = () => {
      aborted = true;
      // ffmpeg has no child processes, so killing it is killing the tree.
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        const parsed = parseProgressLine(line);
        if (!onProgress) continue;
        if (parsed.end) onProgress(100, durationSec ?? 0);
        else if (parsed.outTimeSec !== undefined && durationSec && durationSec > 0) {
          onProgress(Math.min(100, (parsed.outTimeSec / durationSec) * 100), parsed.outTimeSec);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        stderrLines.push(line);
        if (stderrLines.length > STDERR_LINES) stderrLines.shift();
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        finish(
          new FfmpegNotFoundError(`Cannot execute ffmpeg at ${binary}: ${error.code}`, { cause: error }),
        );
      } else {
        finish(new FfmpegError(`Failed to start ffmpeg: ${error.message}`, { cause: error }));
      }
    });

    child.on('close', (code, closeSignal) => {
      if (stderrBuffer.trim()) stderrLines.push(stderrBuffer.trim());
      if (aborted) return finish(toAbortError(signal));
      if (code === 0) return finish();
      const tail = stderrLines.slice(-8).join('\n');
      finish(
        new FfmpegError(
          `ffmpeg exited with ${code === null ? `signal ${closeSignal}` : `code ${code}`}${tail ? `:\n${tail}` : ''}`,
          {
            details: { code, args: fullArgs, stderr: stderrLines.join('\n') },
          },
        ),
      );
    });
  });
}

/**
 * This function is used for capturing ffmpeg's stdout for informational commands (`-version`, `-encoders`).
 */
export function captureFfmpeg(binary: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new FfmpegNotFoundError(`Cannot execute ffmpeg at ${binary}`, { cause: error }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new FfmpegError(`ffmpeg ${args.join(' ')} exited with code ${code}`));
    });
  });
}

export interface FfmpegCapabilities {
  version: string;
  encoders: Set<string>;
}

const capabilityCache = new Map<string, Promise<FfmpegCapabilities>>();

/**
 * This function is used for reading ffmpeg's version and encoder list (cached per binary), so audio
 * conversion can fall back when an encoder such as libmp3lame is missing from a build.
 */
export function probeFfmpeg(binary: string): Promise<FfmpegCapabilities> {
  let cached = capabilityCache.get(binary);
  if (!cached) {
    cached = (async () => {
      const [versionOut, encodersOut] = await Promise.all([
        captureFfmpeg(binary, ['-version']),
        captureFfmpeg(binary, ['-encoders']),
      ]);
      const version = /ffmpeg version (\S+)/.exec(versionOut)?.[1] ?? 'unknown';
      const encoders = new Set<string>();
      for (const line of encodersOut.split(/\r?\n/)) {
        const match = /^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
        if (match?.[1]) encoders.add(match[1]);
      }
      return { version, encoders };
    })();
    cached.catch(() => capabilityCache.delete(binary));
    capabilityCache.set(binary, cached);
  }
  return cached;
}
