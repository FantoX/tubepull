import { describe, expect, it } from 'vitest';
import { evaluatePlayerScript } from '../../src/extractor/evaluator.js';
import { dedupeFormats, normalizeFormat, parseMime, type RawFormat } from '../../src/extractor/normalize.js';
import { mapPlayability, mapThrown, mostRelevantError } from '../../src/extractor/playability.js';
import { PoTokenSource } from '../../src/extractor/poToken.js';
import { toPlaylistEntry } from '../../src/extractor/youtubei.adapter.js';
import { AbortError, NetworkError, PrivateVideoError, VideoUnavailableError } from '../../src/errors.js';

const raw = (over: Partial<RawFormat>): RawFormat => ({
  itag: 137,
  mime_type: 'video/mp4; codecs="avc1.640028"',
  bitrate: 4_000_000,
  has_audio: false,
  has_video: true,
  ...over,
});

describe('parseMime', () => {
  it('splits type, subtype and codecs', () => {
    expect(parseMime('video/mp4; codecs="avc1.42001E, mp4a.40.2"')).toEqual({
      type: 'video',
      subtype: 'mp4',
      codecs: ['avc1.42001E', 'mp4a.40.2'],
    });
    expect(parseMime('audio/webm; codecs="opus"').codecs).toEqual(['opus']);
    expect(parseMime('video/webm').codecs).toEqual([]);
  });
});

describe('normalizeFormat', () => {
  it('normalises a video-only format', () => {
    const f = normalizeFormat(
      raw({
        width: 1920,
        height: 1080,
        fps: 30,
        quality_label: '1080p',
        content_length: 123,
        average_bitrate: 3_000_000,
      }),
      'https://x/v',
      false,
    );
    expect(f).toMatchObject({
      itag: 137,
      kind: 'video',
      container: 'mp4',
      vcodec: 'avc1.640028',
      width: 1920,
      height: 1080,
      fps: 30,
      contentLength: 123,
      avgBitrate: 3_000_000,
      url: 'https://x/v',
    });
    expect(f?.acodec).toBeUndefined();
  });

  it('marks audio mp4 as m4a and keeps track details', () => {
    const f = normalizeFormat(
      raw({
        itag: 140,
        mime_type: 'audio/mp4; codecs="mp4a.40.2"',
        has_audio: true,
        has_video: false,
        audio_sample_rate: 44100,
        audio_channels: 2,
        is_drc: true,
        audio_track: { id: 'en.4', display_name: 'English original', audio_is_default: true },
      }),
      'u',
      false,
    );
    expect(f).toMatchObject({
      kind: 'audio',
      container: 'm4a',
      acodec: 'mp4a.40.2',
      isDrc: true,
      audioSampleRate: 44100,
    });
    expect(f?.audioTrack).toEqual({ id: 'en.4', name: 'English original', isDefault: true });
  });

  it('splits muxed codecs', () => {
    const f = normalizeFormat(
      raw({ itag: 18, mime_type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', has_audio: true }),
      'u',
      false,
    );
    expect(f).toMatchObject({ kind: 'muxed', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2' });
  });

  it('detects HDR from colour info or label', () => {
    const pq = normalizeFormat(
      raw({ color_info: { transfer_characteristics: 'COLOR_TRANSFER_CHARACTERISTICS_SMPTEST2084' } }),
      'u',
      false,
    );
    const hlg = normalizeFormat(raw({ quality_label: '2160p60 HDR' }), 'u', false);
    expect(pq?.hdr).toBe(true);
    expect(hlg?.hdr).toBe(true);
    expect(normalizeFormat(raw({}), 'u', false)?.hdr).toBeUndefined();
  });

  it('drops DRM, OTF, text and unknown containers', () => {
    expect(normalizeFormat(raw({ drm_families: ['WIDEVINE'] }), 'u', false)).toBeUndefined();
    expect(normalizeFormat(raw({ is_type_otf: true }), 'u', false)).toBeUndefined();
    expect(normalizeFormat(raw({ has_video: false, has_text: true }), 'u', false)).toBeUndefined();
    expect(normalizeFormat(raw({ mime_type: 'video/3gpp; codecs="mp4v.20.3"' }), 'u', false)).toBeUndefined();
  });

  it('marks SABR-only formats', () => {
    expect(normalizeFormat(raw({}), undefined, true)).toMatchObject({ sabr: true });
    expect(normalizeFormat(raw({}), undefined, false)?.sabr).toBeUndefined();
  });

  it('dedupes identical itags, keeping the downloadable one', () => {
    const a = normalizeFormat(raw({}), undefined, true)!;
    const b = normalizeFormat(raw({}), 'u', false)!;
    expect(dedupeFormats([a, b])).toEqual([b]);
  });
});

describe('evaluatePlayerScript', () => {
  const script = {
    output:
      'function process(n, sp, s) { return { n: n.split("").reverse().join(""), sig: s ? s + "!" : undefined }; }',
    exported: [],
  };

  it('runs the transform in a sandbox and returns a plain object', () => {
    const result = evaluatePlayerScript(script, { n: 'abc', sig: 'xyz', sp: 'sig' });
    expect(result).toEqual({ n: 'cba', sig: 'xyz!' });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('has no access to Node globals', () => {
    const probe = {
      output: 'function process() { return { n: typeof require + "," + typeof process.exit }; }',
      exported: [],
    };
    expect(evaluatePlayerScript(probe, {}).n).toBe('undefined,undefined');
  });

  it('times out runaway scripts', () => {
    const loop = { output: 'function process() { for (;;) {} }', exported: [] };
    expect(() => evaluatePlayerScript(loop, {}, 50)).toThrowError(/timed out/);
  });
});

describe('mapPlayability', () => {
  it.each([
    ['OK', undefined, undefined],
    [undefined, undefined, undefined],
    ['LOGIN_REQUIRED', 'Sign in to confirm you’re not a bot', 'BOT_CHECK'],
    ['LOGIN_REQUIRED', 'This video is private', 'PRIVATE_VIDEO'],
    ['LOGIN_REQUIRED', 'Sign in to confirm your age', 'AGE_RESTRICTED'],
    ['UNPLAYABLE', 'Join this channel to get access to members-only content like this video', 'MEMBERS_ONLY'],
    ['UNPLAYABLE', 'The uploader has not made this video available in your country', 'REGION_BLOCKED'],
    ['LIVE_STREAM_OFFLINE', 'Premieres in 2 hours', 'LIVE_STREAM'],
    ['ERROR', 'Video unavailable', 'VIDEO_UNAVAILABLE'],
    ['LOGIN_REQUIRED', '', 'VIDEO_UNAVAILABLE'],
  ])('%s / %s → %s', (status, reason, code) => {
    expect(mapPlayability(status, reason)?.code).toBe(code);
  });

  it('chooses the most specific error across clients', () => {
    const chosen = mostRelevantError([
      new VideoUnavailableError(),
      new NetworkError('x'),
      new PrivateVideoError(),
    ]);
    expect(chosen.code).toBe('PRIVATE_VIDEO');
    expect(mostRelevantError([]).code).toBe('EXTRACTOR');
  });

  it('classifies thrown errors', () => {
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(mapThrown(fetchFailed).code).toBe('NETWORK');
    expect(mapThrown(new Error('This video is unavailable')).code).toBe('VIDEO_UNAVAILABLE');
    expect(mapThrown(new Error('weird parser change')).code).toBe('EXTRACTOR');
    expect(mapThrown(new AbortError()).code).toBe('ABORTED');
    const controller = new AbortController();
    controller.abort();
    expect(mapThrown(new Error('x'), controller.signal).code).toBe('ABORTED');
  });
});

describe('PoTokenSource', () => {
  it('prefers the provider, falls back to the static token, and survives provider errors', async () => {
    const errors: unknown[] = [];
    const request = { videoId: 'v', client: 'WEB' };
    expect(await new PoTokenSource({}).forVideo(request, (e) => errors.push(e))).toBeUndefined();
    expect(await new PoTokenSource({ poToken: ' tok ' }).forVideo(request, () => {})).toBe('tok');
    expect(
      await new PoTokenSource({ poToken: 'static', poTokenProvider: () => 'dynamic' }).forVideo(
        request,
        () => {},
      ),
    ).toBe('dynamic');
    const failing = new PoTokenSource({
      poToken: 'static',
      poTokenProvider: () => {
        throw new Error('boom');
      },
    });
    expect(await failing.forVideo(request, (e) => errors.push(e))).toBe('static');
    expect(errors).toHaveLength(1);
    expect(failing.configured).toBe(true);
  });
});

describe('toPlaylistEntry', () => {
  it('reads every playlist node type', () => {
    expect(
      toPlaylistEntry({
        type: 'PlaylistVideo',
        id: 'aaaaaaaaaaa',
        title: 'One',
        author: { name: 'Ch' },
        duration: { seconds: 61 },
      }),
    ).toEqual({ id: 'aaaaaaaaaaa', title: 'One', author: 'Ch', durationSec: 61 });
    expect(toPlaylistEntry({ type: 'PlaylistVideo', id: 'x', is_playable: false })).toBeUndefined();
    expect(
      toPlaylistEntry({
        type: 'LockupView',
        content_type: 'VIDEO',
        content_id: 'bbbbbbbbbbb',
        metadata: { title: 'Two' },
      }),
    ).toEqual({
      id: 'bbbbbbbbbbb',
      title: 'Two',
    });
    expect(
      toPlaylistEntry({ type: 'LockupView', content_type: 'PLAYLIST', content_id: 'PL' }),
    ).toBeUndefined();
    expect(toPlaylistEntry({ type: 'ReelItem', id: 'ccccccccccc', title: 'Three' })).toEqual({
      id: 'ccccccccccc',
      title: 'Three',
    });
    expect(
      toPlaylistEntry({
        type: 'ShortsLockupView',
        on_tap_endpoint: { payload: { videoId: 'ddddddddddd' } },
        overlay_metadata: { primary_text: 'Four' },
      }),
    ).toEqual({ id: 'ddddddddddd', title: 'Four' });
    expect(toPlaylistEntry({ type: 'ContinuationItem' })).toBeUndefined();
  });
});
