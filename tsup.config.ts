import { defineConfig } from 'tsup';

// Keep ffmpeg-static external: it resolves its binary relative to its package directory.
const external = ['youtubei.js', 'ffmpeg-static', 'undici'];

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node22',
    platform: 'node',
    shims: true,
    splitting: false,
    treeshake: true,
    minify: true,
    keepNames: true,
    external,
  },
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'node22',
    platform: 'node',
    splitting: false,
    minify: true,
    keepNames: true,
    external,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
