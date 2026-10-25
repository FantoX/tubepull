import { describe, expect, it, vi } from 'vitest';
import { TubePull } from '../../src/TubePull.js';
import { bundledCookies } from '../../src/utils/bundled-cookies.js';
import { cookieValue } from '../../src/utils/cookies.js';

vi.mock('../../src/extractor/youtubei.adapter.js', () => ({
  YoutubeiExtractor: class {
    constructor(private options: { cookie?: string }) {}
    async describe() {
      return { cookie: this.options.cookie ?? '' };
    }
  },
}));

describe('bundled session', () => {
  it('decodes a usable cookie header without embedded control characters', () => {
    const header = bundledCookies();
    expect(Boolean(cookieValue(header, 'SID'))).toBe(true);
    expect(Boolean(cookieValue(header, 'SAPISID'))).toBe(true);
    expect(/[\r\n\0]/.test(header)).toBe(false);
  });

  it('passes the default session to the extractor', async () => {
    const yt = await TubePull.create({ cacheDir: false });
    const details = await yt.describeExtractor();
    expect(Boolean(cookieValue(details.cookie!, 'SAPISID'))).toBe(true);
  });

  it('uses explicit user cookies in place of the default session', async () => {
    const header = 'SID=user-session; SAPISID=user-signature';
    const yt = await TubePull.create({ cookies: header, cacheDir: false });
    expect((await yt.describeExtractor()).cookie === header).toBe(true);
  });

  it.each([false, ''] as const)('supports signed-out playback with cookies=%j', async (cookies) => {
    const yt = await TubePull.create({ cookies, cacheDir: false });
    expect((await yt.describeExtractor()).cookie === '').toBe(true);
  });

  it('reports an invalid user cookie path instead of silently using the default', async () => {
    await expect(
      TubePull.create({ cookies: 'test/.tmp/no-such-session-cookies.txt', cacheDir: false }),
    ).rejects.toThrow(/Cannot read cookies file/);
  });
});
