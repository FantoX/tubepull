import { describe, expect, it } from 'vitest';
import { renderFormatList, renderPlaylist, summaryLine } from '../../src/cli/render.js';
import { buildAudioQualities, buildQualities } from '../../src/selector/qualities.js';
import type { VideoInfo } from '../../src/types.js';
import { FULL_LIST, SABR_ONLY_LIST } from '../fixtures/formats.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function info(formats = FULL_LIST): VideoInfo {
  return {
    id: 'aqz-KE-bpKQ',
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    title: 'Big Buck Bunny',
    author: 'Blender',
    description: '',
    durationSec: 600,
    viewCount: 1234567,
    keywords: [],
    thumbnails: [],
    isLive: false,
    isUpcoming: false,
    chapters: [],
    formats,
    qualities: buildQualities(formats, 600),
    audioQualities: buildAudioQualities(formats, 600),
  };
}

describe('render', () => {
  it('summarises a video', () => {
    expect(plain(summaryLine(info()))).toBe('Blender · 10:00 · 1,234,567 views');
  });

  it('lists qualities, audio and every format', () => {
    const text = plain(renderFormatList(info()));
    if (process.env.SHOW_RENDER) console.log(text);
    expect(text).toContain('Video qualities');
    expect(text).toMatch(/2160p60 HDR\s+vp9\s+~/);
    expect(text).toMatch(/1080p60\s+av01, vp9, avc1\s+~/);
    expect(text).toMatch(/133kbps opus\s+itag 251\s+webm/);
    expect(text).toMatch(/\b137\s+video\s+mp4\s+avc1\.640028\s+1920x1080\s+30\s+3520k/);
    expect(text).toMatch(/\b18\s+muxed\s+mp4\s+avc1\.42001E\+mp4a\.40\.2/);
    expect(text).not.toContain('SABR-only');
  });

  it('warns when nothing is downloadable', () => {
    const text = plain(renderFormatList(info(SABR_ONLY_LIST)));
    expect(text).toContain('no URL');
    expect(text).toContain('SABR-only');
  });

  it('lists playlist entries', () => {
    const text = plain(
      renderPlaylist({
        id: 'PL1',
        title: 'Mix',
        author: 'Me',
        entries: [{ id: 'aaaaaaaaaaa', title: 'One', durationSec: 75 }],
      }),
    );
    expect(text).toContain('1 video · Me');
    expect(text).toMatch(/1\s+aaaaaaaaaaa\s+1:15\s+One/);
  });
});
