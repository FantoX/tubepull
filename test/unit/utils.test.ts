import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatBytes, formatSpeed } from '../../src/utils/bytes.js';
import { chaptersFromDescription } from '../../src/utils/chapters.js';
import { loadCookies, parseNetscapeCookies, toYouTubeCookieHeader } from '../../src/utils/cookies.js';
import { renderTemplate, sanitizeFilename, truncateUtf8 } from '../../src/utils/filename.js';
import { formatDuration, parseTime, resolveRange, toFfmpegTime } from '../../src/utils/time.js';

describe('sanitizeFilename', () => {
  it('replaces characters illegal on Windows', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('removes control characters and collapses whitespace', () => {
    expect(sanitizeFilename('line1\nline2\t\tend\u0000x')).toBe('line1 line2 end_x');
  });

  it('avoids reserved device names and trailing dots/spaces', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFilename('title... ')).toBe('title');
    expect(sanitizeFilename('...hidden')).toBe('hidden');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('   ')).toBe('download');
    expect(sanitizeFilename('...')).toBe('download');
  });

  it('caps the UTF-8 length at 200 bytes without splitting characters', () => {
    const name = sanitizeFilename('😀'.repeat(100));
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(200);
    expect(name).toBe('😀'.repeat(50));
    expect(truncateUtf8('héllo', 2)).toBe('h');
  });
});

describe('renderTemplate', () => {
  it('fills tokens and sanitises', () => {
    expect(renderTemplate('{title} [{id}] {height}p', { title: 'A/B: test', id: 'abc', height: 1080 })).toBe(
      'A_B_ test [abc] 1080p',
    );
  });

  it('tidies empty tokens and keeps unknown ones', () => {
    expect(renderTemplate('{title} [{missing}] ({author})', { title: 'T', author: undefined })).toBe(
      'T [{missing}]',
    );
    expect(renderTemplate('{title} [{id}]', { title: 'T', id: undefined })).toBe('T');
  });
});

describe('time', () => {
  it.each([
    [90, 90],
    ['90', 90],
    ['90.5', 90.5],
    ['90s', 90],
    ['1:30', 90],
    ['01:01:30', 3690],
    ['0:00:01.250', 1.25],
  ])('parseTime(%s) = %s', (input, expected) => {
    expect(parseTime(input)).toBe(expected);
  });

  it.each(['abc', '1:60', '1:2:3:4', '-5', ''])('parseTime rejects %s', (input) => {
    expect(() => parseTime(input)).toThrowError();
  });

  it('formats durations and ffmpeg timestamps', () => {
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(3690)).toBe('1:01:30');
    expect(formatDuration(Number.NaN)).toBe('--:--');
    expect(toFfmpegTime(3690.25)).toBe('01:01:30.250');
  });

  it('resolves ranges against the duration', () => {
    expect(resolveRange(undefined, 100)).toBeUndefined();
    expect(resolveRange({ start: 0, end: 100 }, 100)).toBeUndefined();
    expect(resolveRange({ start: '0:10' }, 100)).toEqual({ startSec: 10 });
    expect(resolveRange({ end: 50 }, 100)).toEqual({ endSec: 50 });
    expect(resolveRange({ start: 10, end: 200 }, 100)).toEqual({ startSec: 10 });
    expect(() => resolveRange({ start: 50, end: 10 }, 100)).toThrowError(/must be after/);
    expect(() => resolveRange({ start: 150 }, 100)).toThrowError(/beyond/);
  });
});

describe('bytes', () => {
  it('formats sizes and speeds', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(undefined)).toBe('?');
    expect(formatSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s');
    expect(formatSpeed(0)).toBe('-- /s');
  });
});

describe('chaptersFromDescription', () => {
  it('reads chapters following YouTube rules', () => {
    const description =
      'Intro text\n0:00 Intro\n1:30 - Part one\n(10:05) Part two\n1:02:03 Finale\nLink: http://x';
    expect(chaptersFromDescription(description, 4000)).toEqual([
      { title: 'Intro', startSec: 0 },
      { title: 'Part one', startSec: 90 },
      { title: 'Part two', startSec: 605 },
      { title: 'Finale', startSec: 3723 },
    ]);
  });

  it('requires three chapters starting at 0:00', () => {
    expect(chaptersFromDescription('0:00 a\n1:00 b')).toEqual([]);
    expect(chaptersFromDescription('0:10 a\n1:00 b\n2:00 c')).toEqual([]);
  });

  it('drops out-of-order and out-of-range timestamps', () => {
    expect(
      chaptersFromDescription('0:00 a\n2:00 b\n1:00 x\n3:00 c\n99:00 z', 600).map((c) => c.title),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('cookies', () => {
  const file = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tf6=40000000',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t9999999999\tSID\tabc=def',
    '.youtube.com\tTRUE\t/\tTRUE\t1\tEXPIRED\tx',
    '.google.com\tTRUE\t/\tTRUE\t0\tNID\tother',
    'malformed line',
  ].join('\n');

  it('parses Netscape files including HttpOnly lines', () => {
    const cookies = parseNetscapeCookies(file);
    expect(cookies.map((c) => c.name)).toEqual(['PREF', 'SID', 'EXPIRED', 'NID']);
    expect(cookies[1]?.value).toBe('abc=def');
  });

  it('builds a youtube.com header without expired or foreign cookies', () => {
    expect(toYouTubeCookieHeader(parseNetscapeCookies(file), 1000)).toBe('PREF=f6=40000000; SID=abc=def');
  });

  describe('loadCookies', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tubepull-cookies-'));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('reads a file', async () => {
      const cookiesPath = path.join(dir, 'cookies.txt');
      await writeFile(cookiesPath, file);
      expect(await loadCookies(cookiesPath)).toContain('SID=abc=def');
    });

    it('passes a raw header through', async () => {
      expect(await loadCookies('SID=abc; HSID=def')).toBe('SID=abc; HSID=def');
    });

    it('fails clearly for missing files and files without youtube cookies', async () => {
      await expect(loadCookies(path.join(dir, 'missing.txt'))).rejects.toThrowError(
        /Cannot read cookies file/,
      );
      const empty = path.join(dir, 'empty.txt');
      await writeFile(empty, '.google.com\tTRUE\t/\tTRUE\t0\tNID\tother');
      await expect(loadCookies(empty)).rejects.toThrowError(/No unexpired youtube.com cookies/);
    });
  });
});
