import { describe, expect, it } from 'vitest';
import { parseFlags } from '../../src/cli/flags.js';
import { exitCodeFor, table, visibleLength } from '../../src/cli/output.js';
import { isNewer } from '../../src/cli/update.js';
import {
  AbortError,
  BotCheckError,
  FfmpegNotFoundError,
  InvalidArgumentError,
  NoSuitableFormatError,
  PrivateVideoError,
} from '../../src/errors.js';

describe('parseFlags', () => {
  it('maps flags to download options', () => {
    const s = parseFlags(
      {
        quality: 1080,
        container: 'MKV',
        output: './dl',
        filename: '{title}',
        itagVideo: '137',
        itagAudio: 140,
        start: 90,
        end: '2:30',
        lang: 'de',
        hdr: true,
        strict: true,
        allowTranscode: true,
        overwrite: true,
        embed: false,
        concurrency: '3',
      },
      {},
    );
    expect(s.download).toEqual({
      quality: '1080',
      container: 'mkv',
      outputDir: './dl',
      filename: '{title}',
      videoItag: 137,
      audioItag: 140,
      range: { start: '90', end: '2:30' },
      audioLanguage: 'de',
      hdr: true,
      strict: true,
      allowTranscode: true,
      overwrite: true,
      embedMetadata: false,
      embedThumbnail: false,
    });
    expect(s.concurrency).toBe(3);
    expect(s.selectionGiven).toBe(true);
  });

  it('treats --format as audio mode and normalises bitrate', () => {
    const s = parseFlags({ format: 'MP3', audioBitrate: 320 }, {});
    expect(s.download).toMatchObject({ type: 'audio', audioFormat: 'mp3', audioBitrate: '320k' });
  });

  it('a bare URL is not a selection (wizard continues from the quality step)', () => {
    expect(parseFlags({}, {}).selectionGiven).toBe(false);
    expect(parseFlags({ verbose: true, cookies: 'c.txt' }, {}).selectionGiven).toBe(false);
  });

  it('reads the proxy from the environment', () => {
    expect(parseFlags({}, { HTTPS_PROXY: 'http://proxy:8080' }).instance.proxy).toBe('http://proxy:8080');
    expect(
      parseFlags({ proxy: 'http://explicit:1' }, { HTTPS_PROXY: 'http://proxy:8080' }).instance.proxy,
    ).toBe('http://explicit:1');
  });

  it('splits clients', () => {
    expect(parseFlags({ client: 'ios, mweb' }, {}).instance.clients).toEqual(['ios', 'mweb']);
  });

  it('supports a user cookie override and explicitly anonymous playback', () => {
    expect(parseFlags({ cookies: 'my-cookies.txt' }, {}).instance.cookies).toBe('my-cookies.txt');
    const anonymous = parseFlags({ anonymous: true }, {});
    expect(anonymous.instance.cookies).toBe(false);
    expect(anonymous.selectionGiven).toBe(false);
    expect(parseFlags({}, {}).instance.cookies).toBeUndefined();
  });

  it.each([
    [{ quality: '1080x' }, /Invalid quality/],
    [{ format: 'aiff' }, /--format must be one of/],
    [{ container: 'avi' }, /--container must be one of/],
    [{ itagVideo: 'abc' }, /whole number/],
    [{ audioBitrate: 'loud' }, /--audio-bitrate/],
    [{ start: 'soon' }, /Invalid time/],
    [{ start: '2:00', end: '1:00' }, /must be after/],
    [{ concurrency: 0 }, /between 1 and 16/],
    [{ poToken: 'abc' }, /--visitor-data/],
    [{ anonymous: true, cookies: 'my-cookies.txt' }, /either --cookies or --anonymous/],
  ])('rejects %o', (raw, message) => {
    expect(() => parseFlags(raw, {})).toThrowError(message);
  });
});

describe('exit codes', () => {
  it.each([
    [new InvalidArgumentError('x'), 2],
    [new PrivateVideoError(), 3],
    [new NoSuitableFormatError('x'), 3],
    [new BotCheckError(), 4],
    [new FfmpegNotFoundError(), 5],
    [new AbortError(), 130],
    [Object.assign(new Error('Unknown option'), { name: 'CACError' }), 2],
    [new Error('other'), 1],
  ])('%s → %i', (error, code) => {
    expect(exitCodeFor(error)).toBe(code);
  });
});

describe('output helpers', () => {
  it('aligns tables ignoring ANSI codes', () => {
    expect(visibleLength('\u001b[31mred\u001b[39m')).toBe(3);
    expect(
      table([
        ['a', 'bb'],
        ['ccc', 'd'],
      ]),
    ).toBe('a    bb\nccc  d');
  });

  it('compares versions', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
    expect(isNewer('v2.0.0-rc.1', '1.0.0')).toBe(true);
  });
});
