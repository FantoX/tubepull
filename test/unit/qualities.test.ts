import { describe, expect, it } from 'vitest';
import {
  buildAudioQualities,
  buildQualities,
  estimateSize,
  fpsBucket,
  qualityHeight,
  qualityLabel,
} from '../../src/selector/qualities.js';
import { FULL_LIST, MULTI_LANGUAGE_LIST, SABR_ONLY_LIST, SHORTS_LIST } from '../fixtures/formats.js';

describe('quality helpers', () => {
  it('labels qualities', () => {
    expect(qualityLabel(1080, 60, false)).toBe('1080p60');
    expect(qualityLabel(720, 30, false)).toBe('720p');
    expect(qualityLabel(2160, 60, true)).toBe('2160p60 HDR');
  });

  it('buckets frame rates', () => {
    expect(fpsBucket(24)).toBe(30);
    expect(fpsBucket(25)).toBe(30);
    expect(fpsBucket(29.97)).toBe(30);
    expect(fpsBucket(50)).toBe(50);
    expect(fpsBucket(59.94)).toBe(60);
    expect(fpsBucket(undefined)).toBe(30);
  });

  it('uses the label or the short side for the p value', () => {
    expect(qualityHeight(SHORTS_LIST[0]!)).toBe(1080);
    expect(qualityHeight({ ...SHORTS_LIST[0]!, qualityLabel: undefined })).toBe(1080);
  });

  it('estimates size from length, else bitrate × duration', () => {
    expect(
      estimateSize(
        { itag: 1, kind: 'audio', container: 'm4a', mimeType: '', bitrate: 8000, contentLength: 42 },
        10,
      ),
    ).toBe(42);
    expect(estimateSize({ itag: 1, kind: 'audio', container: 'm4a', mimeType: '', bitrate: 8000 }, 10)).toBe(
      10_000,
    );
    expect(
      estimateSize({ itag: 1, kind: 'audio', container: 'm4a', mimeType: '', bitrate: 8000 }, 0),
    ).toBeUndefined();
  });
});

describe('buildQualities', () => {
  const qualities = buildQualities(FULL_LIST, 600);

  it('groups by height, fps and HDR, best first', () => {
    expect(qualities.map((q) => q.label)).toEqual([
      '2160p60 HDR',
      '2160p60',
      '2160p',
      '1440p60 HDR',
      '1440p60',
      '1440p',
      '1080p60 HDR',
      '1080p60',
      '1080p',
      '720p60',
      '720p',
      '480p',
      '360p',
      '240p',
      '144p',
    ]);
  });

  it('lists codecs per quality (AV1, VP9, H.264 order)', () => {
    expect(qualities.find((q) => q.label === '1080p60')?.codecs).toEqual(['av01', 'vp9', 'avc1']);
    expect(qualities.find((q) => q.label === '2160p')?.codecs).toEqual(['vp9']);
  });

  it('merges the muxed 360p into the 360p group without adding audio twice', () => {
    const q360 = qualities.find((q) => q.label === '360p');
    expect(q360?.itags).toContain(18);
  });

  it('estimates sizes including audio', () => {
    const q = qualities.find((x) => x.label === '1080p60');
    // Largest stream in the group (itag 299: 4.8 Mbps avg × 600 s) + best audio (itag 251: 133 kbps × 600 s).
    expect(q?.estSizeBytes).toBe(360_000_000 + 9_975_000);
  });

  it('still lists qualities for SABR-only responses (for --list)', () => {
    expect(buildQualities(SABR_ONLY_LIST, 600).length).toBe(qualities.length);
  });

  it('labels portrait videos by their short side', () => {
    expect(buildQualities(SHORTS_LIST, 30).map((q) => q.label)).toEqual(['1080p', '720p']);
  });
});

describe('buildAudioQualities', () => {
  it('orders non-DRC by bitrate and labels codecs', () => {
    const list = buildAudioQualities(FULL_LIST, 600);
    expect(list[0]).toMatchObject({ itag: 251, codec: 'opus', isDrc: false, label: '133kbps opus' });
    expect(list.at(-1)?.isDrc).toBe(true);
    expect(list.find((a) => a.itag === 140 && !a.isDrc)?.label).toBe('124kbps aac');
  });

  it('names language tracks for multi-language videos', () => {
    const list = buildAudioQualities(MULTI_LANGUAGE_LIST, 600);
    expect(list[0]?.isDefault).toBe(true);
    expect(list.some((a) => a.label.includes('German'))).toBe(true);
  });
});
