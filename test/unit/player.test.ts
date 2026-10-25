import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../src/errors.js';
import {
  DIRECT_CLIENTS,
  fetchEmbedContext,
  playabilityReason,
  prerollWaitMs,
  readYtcfg,
  requestPlayer,
} from '../../src/extractor/player.js';
import { cookieValue, withSapisid } from '../../src/utils/cookies.js';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function fakeFetch(answer: (url: string) => Response) {
  const calls: Captured[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    return answer(url);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const OK = { playabilityStatus: { status: 'OK' } };

describe('direct player requests', () => {
  it('sends TV as a Tizen device with the signature timestamp', async () => {
    const { fetchFn, calls } = fakeFetch(() => Response.json(OK));
    await requestPlayer({
      fetch: fetchFn,
      client: DIRECT_CLIENTS.TV!,
      videoId: 'abcdefghijk',
      visitorData: 'VISITOR',
      signatureTimestamp: 20746,
    });
    const [call] = calls;
    expect(call?.url).toBe('https://www.youtube.com/youtubei/v1/player?prettyPrint=false');
    expect(call?.headers).toMatchObject({
      'x-youtube-client-name': '7',
      'x-goog-visitor-id': 'VISITOR',
      'user-agent': expect.stringContaining('Tizen') as unknown,
    });
    expect(call?.body).toMatchObject({
      context: {
        client: { clientName: 'TVHTML5', deviceMake: 'Samsung', osName: 'Tizen', visitorData: 'VISITOR' },
      },
      videoId: 'abcdefghijk',
      playbackContext: { contentPlaybackContext: { signatureTimestamp: 20746 } },
    });
    expect((call?.body?.context as Record<string, unknown>).thirdParty).toBeUndefined();
    expect(call?.body?.serviceIntegrityDimensions).toBeUndefined();
  });

  it('sends WEB_EMBEDDED with the embed host flags, a third-party page, a PO token and auth', async () => {
    const { fetchFn, calls } = fakeFetch(() => Response.json(OK));
    await requestPlayer({
      fetch: fetchFn,
      client: DIRECT_CLIENTS.WEB_EMBEDDED!,
      videoId: 'abcdefghijk',
      embed: { visitorData: 'EMBED_VISITOR', hostFlags: 'FLAGS' },
      visitorData: 'EMBED_VISITOR',
      poToken: 'POT',
      auth: { cookie: 'SAPISID=x', authorization: 'SAPISIDHASH 1_abc' },
    });
    const [call] = calls;
    expect(call?.body).toMatchObject({
      context: {
        client: { clientName: 'WEB_EMBEDDED_PLAYER' },
        thirdParty: { embedUrl: 'https://www.reddit.com/' },
      },
      playbackContext: { contentPlaybackContext: { encryptedHostFlags: 'FLAGS' } },
      serviceIntegrityDimensions: { poToken: 'POT' },
    });
    expect(call?.headers).toMatchObject({
      cookie: 'SAPISID=x',
      authorization: 'SAPISIDHASH 1_abc',
      'x-goog-authuser': '0',
    });
  });

  it('maps HTTP 429 to a rate limit', async () => {
    const { fetchFn } = fakeFetch(() => new Response('slow down', { status: 429 }));
    await expect(
      requestPlayer({ fetch: fetchFn, client: DIRECT_CLIENTS.TV!, videoId: 'abcdefghijk' }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('reads the embed page as a third-party site would load it', async () => {
    const page =
      '<script>ytcfg.set({"VISITOR_DATA":"Cgt2aXNpdG9y"});</script>' +
      '<script>ytcfg.set({"WEB_PLAYER_CONTEXT_CONFIGS":{"WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER":' +
      '{"encryptedHostFlags":"HOSTFLAGS"}}});</script>';
    const { fetchFn, calls } = fakeFetch(() => new Response(page));
    expect(await fetchEmbedContext(fetchFn, 'abcdefghijk')).toEqual({
      visitorData: 'Cgt2aXNpdG9y',
      hostFlags: 'HOSTFLAGS',
    });
    expect(calls[0]?.url).toBe('https://www.youtube.com/embed/abcdefghijk?html5=1');
    expect(calls[0]?.headers.referer).toBe('https://www.reddit.com/');
  });

  it('merges every ytcfg.set call and skips broken ones', () => {
    expect(readYtcfg('ytcfg.set({"A":1}); ytcfg.set({broken}); ytcfg.set({"B":"x","A":2});')).toEqual({
      A: 2,
      B: 'x',
    });
  });

  it('collects refusal text from the reason and the error screen', () => {
    expect(
      playabilityReason({
        reason: 'Sign in to confirm you’re not a bot',
        errorScreen: {
          playerErrorMessageRenderer: {
            reason: { simpleText: 'Sign in to confirm you’re not a bot' },
            subreason: { runs: [{ text: 'This helps protect ' }, { text: 'our community' }] },
          },
        },
      }),
    ).toBe('Sign in to confirm you’re not a bot This helps protect our community');
    expect(playabilityReason(undefined)).toBe('');
  });
});

describe('enforced preroll', () => {
  const placement = (kind: string, ad: Record<string, unknown>) => ({
    adPlacementRenderer: {
      config: { adPlacementConfig: { kind } },
      renderer: { instreamVideoAdRenderer: ad },
    },
  });

  it('waits for skippable ads until their skip offset, others for their full length', () => {
    expect(
      prerollWaitMs({
        adPlacements: [
          placement('AD_PLACEMENT_KIND_START', {
            skipOffsetMilliseconds: 5000,
            playerVars: 'length_seconds=30',
          }),
          placement('AD_PLACEMENT_KIND_START', { playerVars: 'length_seconds=6&x=1' }),
          placement('AD_PLACEMENT_KIND_MILLISECONDS', { playerVars: 'length_seconds=15' }),
        ],
      }),
    ).toBe(11_000);
  });

  it('counts before-content ad slots, including sequential layouts', () => {
    const ad = (seconds: number) => ({
      playerBytesAdLayoutRenderer: {
        renderingContent: { instreamVideoAdRenderer: { playerVars: `length_seconds=${seconds}` } },
      },
    });
    expect(
      prerollWaitMs({
        adSlots: [
          {
            adSlotRenderer: {
              adSlotMetadata: { triggerEvent: 'SLOT_TRIGGER_EVENT_BEFORE_CONTENT' },
              fulfillmentContent: {
                fulfilledLayout: {
                  playerBytesAdLayoutRenderer: {
                    renderingContent: {
                      playerBytesSequentialLayoutRenderer: { sequentialLayouts: [ad(4), ad(2)] },
                    },
                  },
                },
              },
            },
          },
          { adSlotRenderer: { adSlotMetadata: { triggerEvent: 'SLOT_TRIGGER_EVENT_LAYOUT_ID_ENTERED' } } },
        ],
      }),
    ).toBe(6_000);
  });

  it('is zero without ads', () => {
    expect(prerollWaitMs({ playabilityStatus: { status: 'OK' } })).toBe(0);
  });
});

describe('SAPISID fallback', () => {
  it('adds SAPISID from __Secure-3PAPISID when an export lacks it', () => {
    expect(withSapisid('SID=a; __Secure-3PAPISID=xyz')).toBe('SID=a; __Secure-3PAPISID=xyz; SAPISID=xyz');
    expect(withSapisid('SAPISID=keep; __Secure-3PAPISID=other')).toBe(
      'SAPISID=keep; __Secure-3PAPISID=other',
    );
    expect(withSapisid('SID=a')).toBe('SID=a');
  });

  it('reads one cookie value by exact name', () => {
    expect(cookieValue('A=1; SAPISID=s=1; __Secure-3PAPISID=t', 'SAPISID')).toBe('s=1');
    expect(cookieValue('A=1', 'SAPISID')).toBeUndefined();
  });
});
