import { describe, expect, it } from 'vitest';
import { selectFormats, parseQuality, type AudioPlan, type VideoPlan } from '../../src/selector/select.js';
import {
  FULL_LIST,
  MULTI_LANGUAGE_LIST,
  MUXED_18,
  SABR_ONLY_LIST,
  SHORTS_LIST,
  VP9_TOP_LIST,
} from '../fixtures/formats.js';
import type { MediaFormat } from '../../src/types.js';

const video = (formats: MediaFormat[], options: Parameters<typeof selectFormats>[1] = {}) =>
  selectFormats(formats, { type: 'video', ...options }) as VideoPlan;
const audio = (formats: MediaFormat[], options: Parameters<typeof selectFormats>[1] = {}) =>
  selectFormats(formats, { type: 'audio', ...options }) as AudioPlan;

describe('parseQuality', () => {
  it.each([
    ['best', { kind: 'best' }],
    [undefined, { kind: 'best' }],
    ['WORST', { kind: 'worst' }],
    ['1080p', { kind: 'height', height: 1080 }],
    ['1080', { kind: 'height', height: 1080 }],
    ['720p60', { kind: 'height', height: 720, fps: 60 }],
    ['4k', { kind: 'height', height: 2160 }],
    ['8K', { kind: 'height', height: 4320 }],
  ])('parses %s', (input, expected) => {
    expect(parseQuality(input)).toEqual(expected);
  });

  it.each(['1080x', 'p1080', '108060', 'hd720', ''])('rejects %s', (input) => {
    if (input === '') expect(parseQuality(input)).toEqual({ kind: 'best' });
    else expect(() => parseQuality(input)).toThrowError(/Invalid quality/);
  });
});

describe('selectFormats — video', () => {
  it('best → highest SDR resolution and fps, AV1 copied into mp4 with AAC audio', () => {
    const plan = video(FULL_LIST);
    expect(plan.video.itag).toBe(401);
    expect(plan.audio?.itag).toBe(140);
    expect(plan.audio?.isDrc).toBeUndefined();
    expect(plan.container).toBe('mp4');
    expect(plan.transcodeVideo).toBe(false);
    expect(plan.warnings).toEqual([]);
  });

  it('1080p prefers H.264 at the highest frame rate for mp4', () => {
    const plan = video(FULL_LIST, { quality: '1080p' });
    expect(plan.video.itag).toBe(299);
    expect(plan.container).toBe('mp4');
  });

  it('1080p30 picks the 30 fps stream', () => {
    expect(video(FULL_LIST, { quality: '1080p30' }).video.itag).toBe(137);
  });

  it('720p60 in webm uses VP9 + Opus', () => {
    const plan = video(FULL_LIST, { quality: '720p60', container: 'webm' });
    expect(plan.video.itag).toBe(302);
    expect(plan.audio?.itag).toBe(251);
    expect(plan.container).toBe('webm');
  });

  it('mkv prefers VP9 and the best audio (Opus)', () => {
    const plan = video(FULL_LIST, { quality: '1080p', container: 'mkv' });
    expect(plan.video.itag).toBe(303);
    expect(plan.audio?.itag).toBe(251);
  });

  it('VP9-only top quality switches mp4 → mkv with a warning, and then takes Opus', () => {
    const plan = video(VP9_TOP_LIST);
    expect(plan.video.itag).toBe(315);
    expect(plan.container).toBe('mkv');
    expect(plan.audio?.itag).toBe(251);
    expect(plan.warnings.join(' ')).toMatch(/vp9 video cannot be copied into mp4/);
  });

  it('allowTranscode keeps mp4 and re-encodes', () => {
    const plan = video(VP9_TOP_LIST, { allowTranscode: true });
    expect(plan.container).toBe('mp4');
    expect(plan.transcodeVideo).toBe(true);
    expect(plan.audio?.itag).toBe(140);
    expect(plan.transcodeAudio).toBe(false);
  });

  it('falls back to the nearest lower height with a warning', () => {
    const plan = video(FULL_LIST, { quality: '900p' });
    expect(plan.video.height).toBe(720);
    expect(plan.warnings[0]).toMatch(/900p is not available; using 720p/);
  });

  it('strict refuses a missing height', () => {
    expect(() => video(FULL_LIST, { quality: '900p', strict: true })).toThrowError(/900p is not available/);
  });

  it('strict refuses a missing frame rate; non-strict falls back to a lower one', () => {
    expect(() => video(FULL_LIST, { quality: '480p60', strict: true })).toThrowError(
      /480p60 is not available/,
    );
    const plan = video(FULL_LIST, { quality: '480p60' });
    expect(plan.video.height).toBe(480);
    expect(plan.warnings[0]).toMatch(/using 480p/);
  });

  it('a height below every option takes the lowest available', () => {
    expect(video(FULL_LIST, { quality: '100p' }).video.height).toBe(144);
  });

  it('worst takes the lowest height and frame rate', () => {
    const plan = video(FULL_LIST, { quality: 'worst' });
    expect(plan.video.height).toBe(144);
    expect(plan.video.fps).toBe(30);
  });

  it('hdr selects HDR streams and switches to mkv for VP9.2', () => {
    const plan = video(FULL_LIST, { hdr: true });
    expect(plan.video.itag).toBe(337);
    expect(plan.video.hdr).toBe(true);
    expect(plan.container).toBe('mkv');
  });

  it('hdr without HDR streams warns and uses SDR', () => {
    const plan = video(
      FULL_LIST.filter((f) => !f.hdr),
      { hdr: true },
    );
    expect(plan.video.hdr).toBeFalsy();
    expect(plan.warnings).toContain('No HDR streams available; using SDR.');
  });

  it('honours explicit itags', () => {
    const plan = video(FULL_LIST, { videoItag: 137, audioItag: 251 });
    expect(plan.video.itag).toBe(137);
    expect(plan.audio?.itag).toBe(251);
    expect(plan.container).toBe('mkv');
  });

  it('reports available itags for an unknown itag', () => {
    expect(() => video(FULL_LIST, { videoItag: 9999 })).toThrowError(
      /itag 9999 is not available. Available itags: 18, 160/,
    );
  });

  it('rejects an audio itag as the video itag', () => {
    expect(() => video(FULL_LIST, { videoItag: 140 })).toThrowError(/audio-only/);
  });

  it('uses a muxed format alone when no adaptive video exists', () => {
    const plan = video([MUXED_18]);
    expect(plan.video.itag).toBe(18);
    expect(plan.audio).toBeUndefined();
    expect(plan.container).toBe('mp4');
  });

  it('labels portrait shorts by their short side', () => {
    const plan = video(SHORTS_LIST, { quality: '1080p' });
    expect(plan.video.height).toBe(1920);
    expect(plan.warnings).toEqual([]);
  });

  it('codecPreference overrides the container default', () => {
    expect(video(FULL_LIST, { quality: '1080p', codecPreference: ['av01'] }).video.itag).toBe(399);
  });

  it('explains SABR-only responses', () => {
    expect(() => video(SABR_ONLY_LIST)).toThrowError(/SABR/);
  });
});

describe('selectFormats — audio', () => {
  it('m4a copies the best AAC stream (non-DRC)', () => {
    const plan = audio(FULL_LIST, { audioFormat: 'm4a' });
    expect(plan.audio.itag).toBe(140);
    expect(plan.audio.isDrc).toBeUndefined();
    expect(plan.transcode).toBe(false);
    expect(plan.ext).toBe('m4a');
  });

  it('defaults to m4a', () => {
    expect(audio(FULL_LIST).format).toBe('m4a');
  });

  it('opus copies the best Opus stream', () => {
    const plan = audio(FULL_LIST, { audioFormat: 'opus' });
    expect(plan.audio.itag).toBe(251);
    expect(plan.transcode).toBe(false);
    expect(plan.ext).toBe('opus');
  });

  it('mp3 transcodes from the highest-bitrate source', () => {
    const plan = audio(FULL_LIST, { audioFormat: 'mp3' });
    expect(plan.audio.itag).toBe(251);
    expect(plan.transcode).toBe(true);
    expect(plan.ext).toBe('mp3');
  });

  it('ranks Opus above AAC of similar bitrate (codec efficiency), but not above much higher AAC', () => {
    const similar = FULL_LIST.filter((f) => f.kind === 'audio' && !f.isDrc).map((f) =>
      f.itag === 140 ? { ...f, avgBitrate: 130_000 } : f.itag === 251 ? { ...f, avgBitrate: 127_000 } : f,
    );
    expect(audio(similar, { audioFormat: 'mp3' }).audio.itag).toBe(251);
    const muchHigherAac = similar.map((f) => (f.itag === 140 ? { ...f, avgBitrate: 256_000 } : f));
    expect(audio(muchHigherAac, { audioFormat: 'mp3' }).audio.itag).toBe(140);
  });

  it('original passes the file through untouched', () => {
    const plan = audio(FULL_LIST, { audioFormat: 'original' });
    expect(plan.passthrough).toBe(true);
    expect(plan.ext).toBe('webm');
  });

  it('picks the default language track, or the requested one', () => {
    expect(audio(MULTI_LANGUAGE_LIST, { audioFormat: 'm4a' }).audio.audioTrack?.id).toBe('en.4');
    expect(audio(MULTI_LANGUAGE_LIST, { audioFormat: 'm4a', audioLanguage: 'de' }).audio.audioTrack?.id).toBe(
      'de.3',
    );
    expect(
      audio(MULTI_LANGUAGE_LIST, { audioFormat: 'm4a', audioLanguage: 'German' }).audio.audioTrack?.id,
    ).toBe('de.3');
  });

  it('warns and uses the default track for an unknown language', () => {
    const plan = audio(MULTI_LANGUAGE_LIST, { audioLanguage: 'fr' });
    expect(plan.audio.audioTrack?.id).toBe('en.4');
    expect(plan.warnings[0]).toMatch(/"fr" not found \(available: en.4, de.3\)/);
  });

  it('the language choice also applies to video downloads', () => {
    const plan = video(MULTI_LANGUAGE_LIST, { audioLanguage: 'de' });
    expect(plan.audio?.audioTrack?.id).toBe('de.3');
  });

  it('extracts audio from a muxed stream when no audio-only stream exists', () => {
    const plan = audio([MUXED_18], { audioFormat: 'mp3' });
    expect(plan.audio.itag).toBe(18);
    expect(plan.transcode).toBe(true);
    expect(plan.warnings[0]).toMatch(/extracting audio/);
  });

  it('original from a muxed stream becomes an m4a copy', () => {
    const plan = audio([MUXED_18], { audioFormat: 'original' });
    expect(plan.passthrough).toBe(false);
    expect(plan.ext).toBe('m4a');
    expect(plan.transcode).toBe(false);
  });

  it('rejects an unknown audio format', () => {
    expect(() => audio(FULL_LIST, { audioFormat: 'aiff' as never })).toThrowError(/Unknown audio format/);
  });
});
