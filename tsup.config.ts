import { defineConfig } from 'tsup';

// Optional dependencies are not externalised by default; ffmpeg-static must stay a real package
// because it locates its binary relative to its own directory.
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
    external,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
