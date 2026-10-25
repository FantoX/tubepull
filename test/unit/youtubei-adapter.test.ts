import { describe, expect, it } from 'vitest';
import { PoTokenSource } from '../../src/extractor/poToken.js';
import { YoutubeiExtractor } from '../../src/extractor/youtubei.adapter.js';
import type { Logger } from '../../src/types.js';

type Outcome = 'ok' | 'throttled' | 'bot' | 'network' | 'sabr' | 'unavailable' | 'ratelimited';

const STREAM = 'https://rr1---sn.googlevideo.com/videoplayback?itag=140&expire=9999999999';

function playerResponse(outcome: Outcome) {
  if (outcome === 'bot') {
    return {
      playability_status: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' },
    };
  }
  if (outcome === 'unavailable')
    return { playability_status: { status: 'ERROR', reason: 'Video unavailable' } };
  if (outcome === 'ratelimited') {
    return {
      playability_status: { status: 'LOGIN_REQUIRED', reason: 'Our systems have detected unusual traffic' },
    };
  }
  const raw = {
    itag: 140,
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 130_000,
    has_audio: true,
    has_video: false,
    ...(outcome === 'sabr' ? {} : { url: `${STREAM}&n=original` }),
    // A solved n parameter changes; a throttled one comes back untouched.
    decipher: async () => `${STREAM}&n=${outcome === 'throttled' ? 'original' : 'solved'}`,
  };
  return {
    playability_status: { status: 'OK' },
    streaming_data: {
      adaptive_formats: [raw],
      ...(outcome === 'sabr' ? { server_abr_streaming_url: 'https://sabr' } : {}),
    },
    basic_info: { id: 'abcdefghijk', title: 'T', duration: 10, author: 'A' },
  };
}

interface FakeSession {
  calls: string[];
  session: { context: { client: { visitorData: string } }; player: object };
  getBasicInfo(id: string, options: { client: string }): Promise<unknown>;
}

/** One fake session per `plans` entry; each maps client → outcomes in call order. */
function harness(plans: Record<string, Outcome[]>[], { failRemote = false } = {}) {
  const sessions: FakeSession[] = [];
  const created: boolean[] = [];
  const warnings: string[] = [];
  const logger: Logger = { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} };

  const createSession = async (generateLocally: boolean) => {
    created.push(generateLocally);
    if (failRemote && !generateLocally) throw new TypeError('fetch failed');
    const plan = plans[sessions.length] ?? plans.at(-1) ?? {};
    const counters = new Map<string, number>();
    const fake: FakeSession = {
      calls: [],
      session: { context: { client: { visitorData: `visitor-${sessions.length}` } }, player: {} },
      async getBasicInfo(_id, { client }) {
        fake.calls.push(client);
        const n = counters.get(client) ?? 0;
        counters.set(client, n + 1);
        const outcomes = plan[client] ?? ['unavailable'];
        const outcome = outcomes[Math.min(n, outcomes.length - 1)] as Outcome;
        if (outcome === 'network')
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        return playerResponse(outcome);
      },
    };
    sessions.push(fake);
    return fake as never;
  };

  const extractor = new YoutubeiExtractor({
    poTokens: new PoTokenSource({}),
    logger,
    clients: ['VISIONOS', 'MWEB', 'IOS'],
    createSession,
  });
  return { extractor, sessions, created, warnings };
}

describe('YoutubeiExtractor client and session handling', () => {
  it('uses the first client that returns solved stream URLs, with its User-Agent', async () => {
    const { extractor, sessions } = harness([{ VISIONOS: ['ok'] }]);
    const video = await extractor.getVideo('abcdefghijk');
    expect(video.info.client).toBe('VISIONOS');
    expect(video.info.formats[0]?.url).toContain('n=solved');
    expect(video.info.formats[0]?.url).toContain('cpn=');
    expect(video.media.headers['user-agent']).toMatch(/Macintosh/);
    expect(sessions[0]?.calls).toEqual(['VISIONOS']);
  });

  it('asks YouTube for a real session and only falls back to a local one when that fails', async () => {
    const ok = harness([{ VISIONOS: ['ok'] }]);
    await ok.extractor.getVideo('abcdefghijk');
    expect(ok.created).toEqual([false]);

    const offline = harness([{ VISIONOS: ['ok'] }], { failRemote: true });
    await offline.extractor.getVideo('abcdefghijk');
    expect(offline.created).toEqual([false, true]);
  });

  it('renews the visitor session once when every client is bot-checked', async () => {
    const { extractor, sessions, created } = harness([
      { VISIONOS: ['bot'], MWEB: ['bot'], IOS: ['bot'] },
      { VISIONOS: ['ok'] },
    ]);
    const video = await extractor.getVideo('abcdefghijk');
    expect(video.info.client).toBe('VISIONOS');
    expect(sessions).toHaveLength(2);
    expect(created).toEqual([false, false]);
  });

  it('gives up with BOT_CHECK when the fresh session is bot-checked too', async () => {
    const { extractor, sessions } = harness([{ VISIONOS: ['bot'], MWEB: ['bot'], IOS: ['bot'] }]);
    await expect(extractor.getVideo('abcdefghijk')).rejects.toMatchObject({ code: 'BOT_CHECK' });
    expect(sessions).toHaveLength(2);
  });

  it('does not renew the session for definitive answers like "unavailable"', async () => {
    const { extractor, sessions } = harness([{}]);
    await expect(extractor.getVideo('abcdefghijk')).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
    expect(sessions).toHaveLength(1);
  });

  it('retries a client once after a transient network failure', async () => {
    const { extractor, sessions } = harness([{ VISIONOS: ['network', 'ok'] }]);
    const video = await extractor.getVideo('abcdefghijk');
    expect(video.info.client).toBe('VISIONOS');
    expect(sessions[0]?.calls).toEqual(['VISIONOS', 'VISIONOS']);
  });

  it('prefers a later client over throttled URLs, and uses throttled ones only as a last resort', async () => {
    const better = harness([{ VISIONOS: ['throttled'], MWEB: ['ok'] }]);
    expect((await better.extractor.getVideo('abcdefghijk')).info.client).toBe('MWEB');

    const onlyThrottled = harness([{ VISIONOS: ['throttled'], MWEB: ['sabr'] }]);
    const video = await onlyThrottled.extractor.getVideo('abcdefghijk');
    expect(video.info.client).toBe('VISIONOS');
    expect(video.info.formats[0]?.url).toBeDefined();
    expect(onlyThrottled.warnings.join(' ')).toMatch(/throttled/);
  });

  it('returns SABR-only metadata when nothing better exists', async () => {
    const { extractor } = harness([{ VISIONOS: ['sabr'] }]);
    const video = await extractor.getVideo('abcdefghijk');
    expect(video.info.formats[0]?.url).toBeUndefined();
    expect(video.info.formats[0]?.sabr).toBe(true);
  });

  it('stops asking further clients once rate-limited, and does not renew the session', async () => {
    const { extractor, sessions } = harness([{ VISIONOS: ['ratelimited'], MWEB: ['ok'] }]);
    await expect(extractor.getVideo('abcdefghijk')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.calls).toEqual(['VISIONOS']);
  });

  it('renews the session at most once a minute', async () => {
    const { extractor, sessions } = harness([{ VISIONOS: ['bot'], MWEB: ['bot'], IOS: ['bot'] }]);
    await expect(extractor.getVideo('abcdefghijk')).rejects.toMatchObject({ code: 'BOT_CHECK' });
    expect(sessions).toHaveLength(2);
    await expect(extractor.getVideo('abcdefghijk')).rejects.toMatchObject({ code: 'BOT_CHECK' });
    expect(sessions).toHaveLength(2);
  });

  it('tries refused clients last', async () => {
    const { extractor, sessions } = harness([{ VISIONOS: ['ok'], MWEB: ['ok'] }]);
    const video = await extractor.getVideo('abcdefghijk', { excludeClients: ['visionos'] });
    expect(video.info.client).toBe('MWEB');
    expect(sessions[0]?.calls).toEqual(['MWEB']);
  });
});
