import { describe, expect, it } from 'vitest';
import { isVideoId, parseTarget, parseVideoId, watchUrl } from '../../src/utils/url.js';
import { InvalidUrlError } from '../../src/errors.js';

const ID = 'dQw4w9WgXcQ';

describe('parseTarget', () => {
  it.each([
    [ID],
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=42s`],
    [`http://m.youtube.com/watch?feature=share&v=${ID}`],
    [`www.youtube.com/watch?v=${ID}`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abcdef&t=10`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}?start=5`],
    [`https://www.youtube.com/live/${ID}?feature=share`],
    [`https://www.youtube.com/v/${ID}`],
    [`https://music.youtube.com/watch?v=${ID}&feature=share`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
    [`  https://youtu.be/${ID}  `],
  ])('finds the video id in %s', (input) => {
    expect(parseTarget(input).videoId).toBe(ID);
  });

  it('reads playlist ids, with or without a video', () => {
    expect(parseTarget('https://www.youtube.com/playlist?list=PLabcdefghijKLMNOP')).toEqual({
      playlistId: 'PLabcdefghijKLMNOP',
    });
    expect(parseTarget(`https://www.youtube.com/watch?v=${ID}&list=PLabcdefghij`)).toEqual({
      videoId: ID,
      playlistId: 'PLabcdefghij',
    });
    expect(parseTarget(`https://youtu.be/${ID}?list=OLAK5uy_abc`)).toEqual({
      videoId: ID,
      playlistId: 'OLAK5uy_abc',
    });
  });

  it.each([
    'https://vimeo.com/123456',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@channel',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'not a url at all',
    'dQw4w9WgXc',
    '',
  ])('rejects %s', (input) => {
    expect(parseTarget(input).videoId).toBeUndefined();
  });
});

describe('parseVideoId', () => {
  it('returns the id or throws a typed error', () => {
    expect(parseVideoId(`https://youtu.be/${ID}`)).toBe(ID);
    expect(() => parseVideoId('https://example.com')).toThrowError(InvalidUrlError);
  });

  it('validates ids and builds watch urls', () => {
    expect(isVideoId(ID)).toBe(true);
    expect(isVideoId('abc')).toBe(false);
    expect(watchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });
});
