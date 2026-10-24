import { constants } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { FfmpegNotFoundError } from '../errors.js';

//---- Section used for locating the ffmpeg binary ----

export type FfmpegSource = 'option' | 'env' | 'ffmpeg-static' | 'path';

export interface ResolvedFfmpeg {
  path: string;
  source: FfmpegSource;
}

export const FFMPEG_ENV = 'TUBEPULL_FFMPEG_PATH';

/**
 * This function is used for checking a candidate binary exists and is executable, fixing a missing
 * exec bit on Linux/macOS (lost when node_modules is copied around).
 */
export async function ensureExecutable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    try {
      await chmod(file, 0o755);
      await access(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * This function is used for finding an executable on PATH (honouring PATHEXT on Windows).
 */
export async function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"(.*)"$/, '$1'), command + ext.toLowerCase());
      if (await ensureExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * This function is used for the path ffmpeg-static would provide, or undefined if the package or its
 * binary is missing (e.g. install scripts were skipped).
 */
export async function ffmpegStaticPath(): Promise<string | undefined> {
  try {
    const mod = (await import('ffmpeg-static')) as { default?: unknown };
    const value = mod.default;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function is used for resolving ffmpeg in priority order: explicit option, `TUBEPULL_FFMPEG_PATH`,
 * the bundled ffmpeg-static binary, then `ffmpeg` on PATH.
 */
export async function resolveFfmpeg(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedFfmpeg> {
  if (explicit) {
    if (await ensureExecutable(explicit)) return { path: explicit, source: 'option' };
    throw new FfmpegNotFoundError(`ffmpegPath does not point to an executable: ${explicit}`);
  }
  const fromEnv = env[FFMPEG_ENV];
  if (fromEnv) {
    if (await ensureExecutable(fromEnv)) return { path: fromEnv, source: 'env' };
    throw new FfmpegNotFoundError(`${FFMPEG_ENV} does not point to an executable: ${fromEnv}`);
  }

  const bundled = await ffmpegStaticPath();
  if (bundled && (await ensureExecutable(bundled))) return { path: bundled, source: 'ffmpeg-static' };

  const onPath = await findOnPath('ffmpeg', env);
  if (onPath) return { path: onPath, source: 'path' };

  const message = bundled
    ? `The bundled ffmpeg binary is missing (${bundled}); its download step probably did not run.`
    : 'ffmpeg not found: ffmpeg-static is not installed and no ffmpeg is on PATH.';
  throw new FfmpegNotFoundError(message, {
    details: { bundled },
    hint:
      'Run `npm rebuild ffmpeg-static` (allow its install script; behind a proxy set FFMPEG_BINARIES_URL to a mirror), ' +
      `or set ${FFMPEG_ENV} to an ffmpeg executable, or install ffmpeg on PATH.`,
  });
}
