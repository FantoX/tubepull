import { describe, expect, it } from 'vitest';
import {
  audioCodecFamily,
  isAudioCopyCompatible,
  isVideoCopyCompatible,
  videoCodecFamily,
} from '../../src/selector/compat.js';

describe('codec families', () => {
  it.each([
    ['avc1.640028', 'avc1'],
    ['avc3.4d401f', 'avc1'],
    ['vp9', 'vp9'],
    ['vp09.02.51.10.01.09.16.09.00', 'vp9'],
    ['av01.0.13M.08', 'av01'],
    ['hev1.1.6.L93.B0', 'other'],
    [undefined, 'other'],
  ])('video %s → %s', (input, family) => {
    expect(videoCodecFamily(input)).toBe(family);
  });

  it.each([
    ['mp4a.40.2', 'mp4a'],
    ['mp4a.40.5', 'mp4a'],
    ['opus', 'opus'],
    ['ec-3', 'ec-3'],
    ['ac-3', 'ac-3'],
    ['vorbis', 'other'],
  ])('audio %s → %s', (input, family) => {
    expect(audioCodecFamily(input)).toBe(family);
  });
});

describe('copy matrix', () => {
  it('mp4 takes H.264/AV1 and AAC, not VP9/Opus', () => {
    expect(isVideoCopyCompatible('mp4', 'avc1')).toBe(true);
    expect(isVideoCopyCompatible('mp4', 'av01')).toBe(true);
    expect(isVideoCopyCompatible('mp4', 'vp9')).toBe(false);
    expect(isAudioCopyCompatible('mp4', 'mp4a')).toBe(true);
    expect(isAudioCopyCompatible('mp4', 'opus')).toBe(false);
  });

  it('webm takes VP9/AV1 and Opus only', () => {
    expect(isVideoCopyCompatible('webm', 'vp9')).toBe(true);
    expect(isVideoCopyCompatible('webm', 'avc1')).toBe(false);
    expect(isAudioCopyCompatible('webm', 'opus')).toBe(true);
    expect(isAudioCopyCompatible('webm', 'mp4a')).toBe(false);
  });

  it('mkv takes everything', () => {
    for (const codec of ['avc1', 'vp9', 'av01', 'other'] as const)
      expect(isVideoCopyCompatible('mkv', codec)).toBe(true);
    for (const codec of ['mp4a', 'opus', 'other'] as const)
      expect(isAudioCopyCompatible('mkv', codec)).toBe(true);
  });
});
