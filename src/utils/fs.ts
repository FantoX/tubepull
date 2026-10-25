import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Missing files count as zero bytes. */
export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** Copy across devices when rename fails with EXDEV. */
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

export async function removeQuietly(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best effort: a locked file on Windows must not mask the real result.
  }
}

export function defaultCacheDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'tubepull', 'cache');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'tubepull');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'tubepull');
}
