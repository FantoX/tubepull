// Packs the library, installs the tarball into a throwaway project and verifies that ESM, CommonJS and
// TypeScript (node16 + bundler resolution) consumers work, and that the `tubepull` bin runs.
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (command, cwd) =>
  execSync(command, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

const packed = JSON.parse(run('npm pack --json --silent', root));
const tarball = path.join(root, packed[0].filename);
console.log(
  `packed ${packed[0].filename} (${packed[0].entryCount} files, ${(packed[0].size / 1024).toFixed(0)} KB)`,
);
const unexpected = packed[0].files
  .map((f) => f.path)
  // Only built code, typings and the docs users need; source maps and everything else stay out.
  .filter(
    (p) => !/^(dist\/[^/]+\.(js|cjs|d\.ts|d\.cts)|README\.md|LICENSE|CHANGELOG\.md|package\.json)$/.test(p),
  );
if (unexpected.length) throw new Error(`unexpected files in tarball: ${unexpected.join(', ')}`);

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubepull-smoke-'));
try {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true }, null, 2));
  run(`npm install --no-audit --no-fund --loglevel=error "${tarball}" typescript@6 @types/node@22`, dir);

  writeFileSync(
    path.join(dir, 'esm.mjs'),
    `import { TubePull, parseVideoId, NoSuitableFormatError, isTubePullError } from 'tubepull';
const yt = await TubePull.create({ cacheDir: false });
if (parseVideoId('https://youtu.be/dQw4w9WgXcQ') !== 'dQw4w9WgXcQ') throw new Error('parseVideoId');
if (!isTubePullError(new NoSuitableFormatError('x'))) throw new Error('errors');
const ff = await yt.resolveFfmpeg();
console.log('esm ok, ffmpeg from', ff.source);
`,
  );
  writeFileSync(
    path.join(dir, 'cjs.cjs'),
    `const { TubePull, parseVideoId, selectFormats } = require('tubepull');
(async () => {
  const yt = await TubePull.create({ cacheDir: false });
  if (typeof yt.download !== 'function' || typeof selectFormats !== 'function') throw new Error('exports');
  if (parseVideoId('dQw4w9WgXcQ') !== 'dQw4w9WgXcQ') throw new Error('parseVideoId');
  // The extractor loads ESM-only youtubei.js through a dynamic import, which must work from CJS.
  console.log('cjs ok,', (await yt.describeExtractor())['youtubei.js']);
})().catch((e) => { console.error(e); process.exit(1); });
`,
  );
  writeFileSync(
    path.join(dir, 'consumer.ts'),
    `import { TubePull, type DownloadOptions, type VideoInfo, type ProgressEvent } from 'tubepull';
const options: DownloadOptions = { type: 'audio', audioFormat: 'mp3', quality: '1080p60' };
export async function demo(url: string): Promise<VideoInfo> {
  const yt = await TubePull.create();
  yt.on('progress', (p: ProgressEvent) => p.percent.toFixed(1));
  await yt.download(url, options);
  return yt.getInfo(url);
}
`,
  );
  for (const [moduleKind, resolution] of [
    ['node16', 'node16'],
    ['esnext', 'bundler'],
  ]) {
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: moduleKind,
          moduleResolution: resolution,
          target: 'es2022',
          types: ['node'],
        },
        files: ['consumer.ts'],
      }),
    );
    run('npx tsc -p tsconfig.json', dir);
    console.log(`ts ok (moduleResolution ${resolution})`);
  }

  process.stdout.write(run('node esm.mjs', dir));
  process.stdout.write(run('node cjs.cjs', dir));
  const version = run('npx tubepull --version', dir).trim();
  console.log('bin ok:', version);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
