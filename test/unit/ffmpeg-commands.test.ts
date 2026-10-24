import { describe, expect, it } from 'vitest';
import {
  buildAudioArgs,
  buildChaptersMetadata,
  buildCoverArgs,
  buildMergeArgs,
} from '../../src/ffmpeg/commands.js';
import { parseProgressLine } from '../../src/ffmpeg/run.js';

const joined = (args: string[]) => args.join(' ');

describe('buildMergeArgs', () => {
  it('stream-copies video + audio into mp4 with faststart', () => {
    const args = buildMergeArgs({ video: 'v.mp4', audio: 'a.m4a', output: 'out.mp4', container: 'mp4' });
    expect(args).toEqual([
      '-y',
      '-i',
      'v.mp4',
      '-i',
      'a.m4a',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      'out.mp4',
    ]);
  });

  it('uses the matroska muxer for mkv and an optional audio map for muxed input', () => {
    const args = buildMergeArgs({ video: 'v.mp4', output: 'out.mkv', container: 'mkv' });
    expect(joined(args)).toContain('-map 0:a:0?');
    expect(args.slice(-3)).toEqual(['-f', 'matroska', 'out.mkv']);
  });

  it('seeks both inputs for a range and drops chapters', () => {
    const args = buildMergeArgs({
      video: 'v',
      audio: 'a',
      output: 'o',
      container: 'mp4',
      range: { startSec: 60, endSec: 150 },
      chaptersFile: 'c.txt',
    });
    expect(joined(args)).toContain(
      '-ss 00:01:00.000 -to 00:02:30.000 -i v -ss 00:01:00.000 -to 00:02:30.000 -i a',
    );
    expect(joined(args)).not.toContain('ffmetadata');
    expect(joined(args)).toContain('-avoid_negative_ts make_zero');
  });

  it('adds chapters, metadata and an attached cover for mp4', () => {
    const args = buildMergeArgs({
      video: 'v',
      audio: 'a',
      output: 'o',
      container: 'mp4',
      metadata: { title: 'T = x', artist: 'A', comment: '' },
      chaptersFile: 'c.txt',
      cover: 'cover.jpg',
    });
    const s = joined(args);
    expect(s).toContain('-f ffmetadata -i c.txt -i cover.jpg');
    expect(s).toContain('-map 0:v:0 -map 1:a:0 -map 3:v:0 -map_metadata 2 -map_chapters 2');
    expect(s).toContain('-c:v:1 mjpeg -disposition:v:1 attached_pic');
    expect(args).toContain('title=T = x');
    expect(s).not.toContain('comment=');
  });

  it('attaches the cover as a file in mkv and ignores it for webm', () => {
    expect(
      joined(buildMergeArgs({ video: 'v', audio: 'a', output: 'o', container: 'mkv', cover: 'c.jpg' })),
    ).toContain('-attach c.jpg -metadata:s:t mimetype=image/jpeg');
    expect(
      joined(buildMergeArgs({ video: 'v', audio: 'a', output: 'o', container: 'webm', cover: 'c.jpg' })),
    ).not.toContain('c.jpg');
  });

  it('re-encodes when asked', () => {
    expect(
      joined(
        buildMergeArgs({
          video: 'v',
          audio: 'a',
          output: 'o',
          container: 'mp4',
          transcodeVideo: true,
          transcodeAudio: true,
        }),
      ),
    ).toContain('-c:v:0 libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k');
    expect(
      joined(
        buildMergeArgs({ video: 'v', audio: 'a', output: 'o', container: 'webm', transcodeVideo: true }),
      ),
    ).toContain('-c:v:0 libvpx-vp9');
  });
});

describe('buildAudioArgs', () => {
  it('copies when the codec already matches', () => {
    expect(joined(buildAudioArgs({ input: 'a.m4a', output: 'o.m4a', format: 'm4a', transcode: false }))).toBe(
      '-y -i a.m4a -map 0:a:0 -vn -c:a copy -movflags +faststart -f ipod o.m4a',
    );
  });

  it('encodes mp3 with ID3v2.3, bitrate and cover', () => {
    const s = joined(
      buildAudioArgs({
        input: 'a.webm',
        output: 'o.mp3',
        format: 'mp3',
        transcode: true,
        bitrate: '320k',
        cover: 'c.jpg',
        metadata: { title: 'T' },
      }),
    );
    expect(s).toContain('-i a.webm -i c.jpg -map 0:a:0 -map 1:v:0 -c:a libmp3lame -b:a 320k');
    expect(s).toContain('-disposition:v:0 attached_pic');
    expect(s).toContain('-id3v2_version 3');
    expect(s).toContain('-metadata title=T');
    expect(s.endsWith('-f mp3 o.mp3')).toBe(true);
  });

  it('uses lossless encoders without a bitrate', () => {
    expect(joined(buildAudioArgs({ input: 'a', output: 'o', format: 'flac', transcode: true }))).toContain(
      '-c:a flac -f flac',
    );
    expect(joined(buildAudioArgs({ input: 'a', output: 'o', format: 'wav', transcode: true }))).toContain(
      '-c:a pcm_s16le -f wav',
    );
  });

  it('skips covers where the muxer cannot hold them', () => {
    expect(
      joined(buildAudioArgs({ input: 'a', output: 'o', format: 'opus', transcode: false, cover: 'c.jpg' })),
    ).not.toContain('c.jpg');
  });

  it('trims', () => {
    expect(
      joined(
        buildAudioArgs({ input: 'a', output: 'o', format: 'mp3', transcode: true, range: { startSec: 5 } }),
      ),
    ).toContain('-y -ss 00:00:05.000 -i a');
  });
});

describe('other builders', () => {
  it('converts covers to JPEG', () => {
    expect(buildCoverArgs('t.webp', 'c.jpg')).toEqual([
      '-y',
      '-i',
      't.webp',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-update',
      '1',
      '-f',
      'image2',
      'c.jpg',
    ]);
  });

  it('writes escaped ffmetadata chapters', () => {
    const text = buildChaptersMetadata(
      [
        { title: 'Intro', startSec: 0 },
        { title: 'A=B; #1', startSec: 61.5 },
      ],
      120,
      'My \\ title',
    );
    expect(text).toBe(
      [
        ';FFMETADATA1',
        'title=My \\\\ title',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=0',
        'END=61500',
        'title=Intro',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=61500',
        'END=120000',
        'title=A\\=B\\; \\#1',
        '',
      ].join('\n'),
    );
  });

  it('parses -progress lines', () => {
    expect(parseProgressLine('out_time_us=1500000')).toEqual({ outTimeSec: 1.5 });
    expect(parseProgressLine('out_time_ms=2000000')).toEqual({ outTimeSec: 2 });
    expect(parseProgressLine('out_time_us=N/A')).toEqual({});
    expect(parseProgressLine('progress=end')).toEqual({ end: true });
    expect(parseProgressLine('progress=continue')).toEqual({});
    expect(parseProgressLine('frame=12')).toEqual({});
  });
});
