import pc from 'picocolors';
import { formatVideoCodec } from '../selector/compat.js';
import { estimateSize } from '../selector/qualities.js';
import type { PlaylistInfo, VideoInfo } from '../types.js';
import { formatBytes } from '../utils/bytes.js';
import { formatDuration } from '../utils/time.js';
import { plural, table } from './output.js';

//---- Section used for rendering info, lists and JSON ----

/**
 * This function is used for the one-line summary under a title: channel · duration · views.
 */
export function summaryLine(info: VideoInfo): string {
  const parts = [info.author, formatDuration(info.durationSec)];
  if (info.viewCount !== undefined) parts.push(`${info.viewCount.toLocaleString('en-US')} views`);
  if (info.isLive) parts.push(pc.red('LIVE'));
  return parts.filter(Boolean).join(' · ');
}

/**
 * This function is used for the `--list` view: qualities, audio options and the raw itag table.
 */
export function renderFormatList(info: VideoInfo): string {
  const out: string[] = [];
  out.push(pc.bold(info.title), pc.dim(`${summaryLine(info)} · ${info.id}`), '');

  if (info.qualities.length) {
    out.push(pc.bold('Video qualities'));
    out.push(
      table(
        info.qualities.map((q) => [
          `  ${pc.cyan(q.label)}`,
          q.codecs.join(', '),
          q.estSizeBytes ? `~${formatBytes(q.estSizeBytes)}` : '',
        ]),
      ),
      '',
    );
  }
  if (info.audioQualities.length) {
    out.push(pc.bold('Audio'));
    out.push(
      table(
        info.audioQualities.map((a) => [
          `  ${pc.cyan(a.label)}`,
          `itag ${a.itag}`,
          a.container,
          a.estSizeBytes ? `~${formatBytes(a.estSizeBytes)}` : '',
        ]),
      ),
      '',
    );
  }

  const rows = [
    ['  itag', 'kind', 'ext', 'codec', 'resolution', 'fps', 'bitrate', 'size', ''].map((h) => pc.dim(h)),
  ];
  const sorted = [...info.formats].sort(
    (a, b) =>
      (a.kind === 'audio' ? 1 : 0) - (b.kind === 'audio' ? 1 : 0) ||
      (b.height ?? 0) - (a.height ?? 0) ||
      b.bitrate - a.bitrate,
  );
  for (const f of sorted) {
    const codec =
      f.kind === 'audio'
        ? (f.acodec ?? '')
        : `${f.vcodec ?? ''}${f.kind === 'muxed' ? `+${f.acodec ?? ''}` : ''}`;
    const notes = [
      f.hdr ? 'HDR' : '',
      f.isDrc ? 'DRC' : '',
      f.audioTrack ? f.audioTrack.name : '',
      f.url ? '' : pc.yellow('no URL'),
    ]
      .filter(Boolean)
      .join(' ');
    rows.push([
      `  ${f.itag}`,
      f.kind,
      f.container,
      codec || formatVideoCodec(f),
      f.width && f.height ? `${f.width}x${f.height}` : '',
      f.fps ? String(f.fps) : '',
      `${Math.round((f.avgBitrate ?? f.bitrate) / 1000)}k`,
      formatBytes(estimateSize(f, info.durationSec)),
      notes,
    ]);
  }
  out.push(pc.bold('Formats'), table(rows));
  if (info.formats.length && info.formats.every((f) => !f.url)) {
    out.push(
      '',
      pc.yellow('No format has a direct URL (SABR-only); downloads will fail for this video right now.'),
    );
  }
  return out.join('\n');
}

/**
 * This function is used for the `--json` view of a video (stable, machine-readable).
 */
export function infoToJson(info: VideoInfo): string {
  return JSON.stringify(info, null, 2);
}

/**
 * This function is used for listing a playlist's entries.
 */
export function renderPlaylist(playlist: PlaylistInfo): string {
  const rows = playlist.entries.map((e, i) => [
    pc.dim(String(i + 1).padStart(3)),
    e.id,
    e.durationSec ? formatDuration(e.durationSec) : '',
    e.title,
  ]);
  return [
    pc.bold(playlist.title),
    pc.dim(`${plural(playlist.entries.length, 'video')}${playlist.author ? ` · ${playlist.author}` : ''}`),
    '',
    table(rows),
  ].join('\n');
}
