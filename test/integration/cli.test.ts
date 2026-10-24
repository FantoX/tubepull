import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Exercises the built CLI (run `npm run build` first; CI builds before testing). Offline paths only.
const cli = path.resolve(import.meta.dirname, '../../dist/cli.js');
const describeIfBuilt = existsSync(cli) ? describe : describe.skip;

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', TUBEPULL_NO_UPDATE_CHECK: '1', CI: '1' },
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describeIfBuilt('tubepull CLI', () => {
  it('prints the version', () => {
    const { code, stdout } = run('--version');
    expect(code).toBe(0);
    expect(stdout).toMatch(/^tubepull\/\d+\.\d+\.\d+/);
  });

  it('prints help with the disclaimer', () => {
    const { code, stdout } = run('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('--quality <quality>');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('Not affiliated with YouTube or Google');
  });

  it.each([
    [[], /Missing video URL/],
    [['not-a-url'], /Not a YouTube video or playlist URL/],
    [['--bogus'], /Unknown option/],
    [['-q', 'huge', 'dQw4w9WgXcQ'], /Invalid quality/],
    [['--start', '2:00', '--end', '1:00', 'dQw4w9WgXcQ'], /must be after/],
  ])('exits 2 for invalid input %j', (args, message) => {
    const { code, stderr } = run(...args);
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
  });

  it('runs doctor offline', () => {
    const { code, stdout } = run('doctor', '--offline');
    expect(stdout).toContain('ffmpeg');
    expect(stdout).toContain('youtubei.js');
    expect([0, 1]).toContain(code);
  });
});
