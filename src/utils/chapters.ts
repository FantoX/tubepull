import type { Chapter } from '../types.js';

//---- Section used for chapter detection ----

// "0:00 Intro", "00:00 - Intro", "1:02:03 Part", "(0:00) Intro", "Intro 0:00" is not supported by YouTube either.
const LINE = /^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*(?:[-–—:|•.]\s*)?(.+?)\s*$/;

/**
 * This function is used for reading chapters from a video description using YouTube's own rules:
 * at least three timestamps, the first at 0:00, ascending order.
 */
export function chaptersFromDescription(description: string, durationSec = 0): Chapter[] {
  const chapters: Chapter[] = [];
  for (const line of description.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, stamp, title] = match;
    if (!stamp || !title) continue;
    const parts = stamp.split(':').map(Number);
    const startSec = parts.reduce((acc, n) => acc * 60 + n, 0);
    const previous = chapters.at(-1);
    if (previous && startSec <= previous.startSec) continue;
    if (durationSec > 0 && startSec >= durationSec) continue;
    chapters.push({ title: title.trim(), startSec });
  }
  if (chapters.length < 3 || chapters[0]?.startSec !== 0) return [];
  return chapters;
}
