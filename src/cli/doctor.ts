import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { AUDIO_ENCODER } from '../ffmpeg/commands.js';
import { probeFfmpeg } from '../ffmpeg/run.js';
import { isTubePullError } from '../errors.js';
import { TubePull } from '../TubePull.js';
import type { TubePullOptions } from '../types.js';
import { defaultCacheDir } from '../utils/fs.js';
import { table } from './output.js';

//---- Section used for `tubepull doctor` ----

/** A stable, short, public video used for the live extraction check. */
const PROBE_VIDEO = 'jNQXAC9IVRw';

type Status = 'ok' | 'warn' | 'fail';

const MARK: Record<Status, string> = { ok: pc.green('✔'), warn: pc.yellow('!'), fail: pc.red('✖') };

/**
 * This function is used for printing environment diagnostics (for bug reports) and returning the
 * exit code: 0 when downloads should work, 1 otherwise.
 */
export async function runDoctor(
  version: string,
  instance: TubePullOptions,
  offline: boolean,
): Promise<number> {
  const rows: string[][] = [];
  let failed = false;
  const add = (status: Status, name: string, detail: string) => {
    if (status === 'fail') failed = true;
    rows.push([MARK[status], name, detail]);
  };

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add(
    major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'fail',
    'node',
    `${process.version} (needs >= 22.12)`,
  );
  add('ok', 'tubepull', version);
  add('ok', 'platform', `${process.platform} ${process.arch} (${os.release()})`);

  const yt = new TubePull(instance);
  try {
    const ffmpeg = await yt.resolveFfmpeg();
    add('ok', 'ffmpeg', `${ffmpeg.path} (${ffmpeg.source})`);
    const caps = await probeFfmpeg(ffmpeg.path);
    add('ok', 'ffmpeg version', caps.version);
    const wanted = [...new Set([...Object.values(AUDIO_ENCODER), 'libx264', 'libvpx-vp9'])];
    const missing = wanted.filter((e) => !caps.encoders.has(e));
    add(
      missing.length ? 'warn' : 'ok',
      'encoders',
      missing.length ? `missing: ${missing.join(', ')}` : wanted.join(', '),
    );
  } catch (error) {
    add(
      'fail',
      'ffmpeg',
      isTubePullError(error) ? `${error.message}\n  → ${error.hint ?? ''}` : String(error),
    );
  }

  const cacheDir = instance.cacheDir === false ? 'disabled' : (instance.cacheDir ?? defaultCacheDir());
  add('ok', 'cache dir', cacheDir);
  try {
    const dir = await mkdtemp(path.join(instance.tempDir ?? os.tmpdir(), 'tubepull-doctor-'));
    await rm(dir, { recursive: true, force: true });
    add('ok', 'temp dir', instance.tempDir ?? os.tmpdir());
  } catch (error) {
    add('fail', 'temp dir', `not writable: ${(error as Error).message}`);
  }

  try {
    const details = await yt.describeExtractor();
    for (const [key, value] of Object.entries(details)) add('ok', key, value);
  } catch (error) {
    add('fail', 'extractor', (error as Error).message);
  }

  if (!offline) {
    try {
      const response = await fetch('https://www.youtube.com/generate_204', {
        signal: AbortSignal.timeout(8_000),
      });
      add(response.status === 204 ? 'ok' : 'warn', 'youtube.com', `HTTP ${response.status}`);
    } catch (error) {
      add('fail', 'youtube.com', `unreachable: ${(error as Error).message}`);
    }
    try {
      const info = await yt.getInfo(PROBE_VIDEO, { signal: AbortSignal.timeout(30_000) });
      const direct = info.formats.filter((f) => f.url).length;
      add(
        direct ? 'ok' : 'warn',
        'extraction',
        `${info.formats.length} formats, ${direct} with direct URLs (client ${info.client ?? '?'})`,
      );
    } catch (error) {
      const code = isTubePullError(error) ? ` [${error.code}]` : '';
      add('fail', 'extraction', `${(error as Error).message}${code}`);
    }
  }

  process.stdout.write(`${table(rows)}\n`);
  return failed ? 1 : 0;
}
