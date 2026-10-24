import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

//---- Section used for filesystem helpers ----

/**
 * This function is used for checking whether a path exists.
 */
export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * This function is used for the size of a file, or 0 when it does not exist.
 */
export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * This function is used for moving a file, falling back to copy+delete across devices (EXDEV),
 * which happens when the temp dir and output dir are on different drives.
 */
export async function moveFile(from: string, to: string, overwrite: boolean): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  if (overwrite) await rm(to, { force: true });
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM') throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/**
 * This function is used for removing a file or directory, ignoring errors (cleanup paths).
 */
export async function removeQuietly(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best effort: a locked file on Windows must not mask the real result.
  }
}

/**
 * This function is used for the per-platform cache directory
 * (`%LOCALAPPDATA%`, `~/Library/Caches`, `$XDG_CACHE_HOME`).
 */
export function defaultCacheDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'tubepull', 'cache');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'tubepull');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'tubepull');
}
