import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { defaultCacheDir } from '../utils/fs.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1_500;

/** Compare numeric versions, ignoring prerelease labels. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((n) => Number(n) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Cache daily; failures stay silent and requests time out after 1.5 seconds. */
export async function checkForUpdate(name: string, current: string): Promise<string | undefined> {
  if (process.env.TUBEPULL_NO_UPDATE_CHECK || process.env.CI || !process.stderr.isTTY) return undefined;
  const stateFile = path.join(defaultCacheDir(), 'update-check.json');
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')) as {
      checkedAt?: number;
      latest?: string;
    };
    let latest = state.latest;
    if (!state.checkedAt || Date.now() - state.checkedAt > CHECK_INTERVAL_MS) {
      const response = await fetch(`https://registry.npmjs.org/${name}/latest`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) latest = ((await response.json()) as { version?: string }).version;
      await mkdir(path.dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify({ checkedAt: Date.now(), latest }), 'utf8');
    }
    if (latest && isNewer(latest, current)) {
      return `${pc.yellow('Update available')} ${pc.dim(current)} → ${pc.green(latest)}  ${pc.dim(`npm i -g ${name}`)}`;
    }
  } catch {
    // Offline or registry unreachable: stay quiet.
  }
  return undefined;
}
