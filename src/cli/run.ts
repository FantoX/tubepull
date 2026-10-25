import path from 'node:path';
import pc from 'picocolors';
import { runQueue } from '../download/queue.js';
import { AbortError, InvalidArgumentError, InvalidUrlError } from '../errors.js';
import { TubePull } from '../TubePull.js';
import type { DownloadOptions, DownloadResult, PlaylistInfo, VideoInfo } from '../types.js';
import { formatBytes } from '../utils/bytes.js';
import { formatDuration } from '../utils/time.js';
import { parseTarget } from '../utils/url.js';
import { parseFlags, type CliSettings, type RawFlags } from './flags.js';
import {
  EXIT,
  createStderrLogger,
  exitCodeFor,
  info as say,
  isInteractiveTerminal,
  plural,
  printError,
  success,
  warn,
} from './output.js';
import { createBarView, createLineView, type ProgressView } from './progress.js';
import { infoToJson, renderFormatList, renderPlaylist, summaryLine } from './render.js';
import { askUrl, chooseBatchOptions, chooseDownloadOptions, offerOpenFolder, prompts } from './wizard.js';

interface Targets {
  videoIds: string[];
  playlists: PlaylistInfo[];
}

/** First interrupt cancels cleanly; the second forces exit. */
function installInterruptHandler(controller: AbortController): () => void {
  let presses = 0;
  const handler = () => {
    presses++;
    if (presses === 1) {
      process.stderr.write(`\n${pc.yellow('Cancelling… (press Ctrl+C again to force quit)')}\n`);
      controller.abort(new AbortError('Cancelled by user'));
    } else {
      process.exit(EXIT.CANCELLED);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

async function resolveTargets(
  yt: TubePull,
  urls: string[],
  settings: CliSettings,
  signal: AbortSignal,
): Promise<Targets> {
  const targets: Targets = { videoIds: [], playlists: [] };
  for (const url of urls) {
    const target = parseTarget(url);
    if (!target.videoId && !target.playlistId) throw new InvalidUrlError(url);
    if (target.playlistId && (!target.videoId || settings.playlist)) {
      const playlist = await yt.getPlaylist(target.playlistId, { signal });
      targets.playlists.push(playlist);
      targets.videoIds.push(...playlist.entries.map((e) => e.id));
    } else if (target.videoId) {
      targets.videoIds.push(target.videoId);
    }
  }
  targets.videoIds = [...new Set(targets.videoIds)];
  return targets;
}

async function withSpinner<T>(
  interactive: boolean,
  message: string,
  task: () => Promise<T>,
  done: (result: T) => string = () => message.replace(/…$/, ''),
): Promise<T> {
  if (!interactive) return task();
  const spin = prompts.spinner();
  spin.start(message);
  try {
    const result = await task();
    spin.stop(done(result));
    return result;
  } catch (error) {
    spin.error('Failed');
    throw error;
  }
}

function describeResult(result: DownloadResult): string {
  const tracks = [
    result.video
      ? `${result.video.qualityLabel ?? `${result.video.height}p`} ${result.video.vcodec?.split('.')[0] ?? ''}`.trim()
      : '',
    result.audio
      ? `${Math.round((result.audio.avgBitrate ?? result.audio.bitrate) / 1000)}k ${result.audio.acodec?.split('.')[0] ?? ''}`.trim()
      : '',
  ].filter(Boolean);
  return `${pc.bold(result.path)} ${pc.dim(`(${formatBytes(result.sizeBytes)}${tracks.length ? `, ${tracks.join(' + ')}` : ''})`)}`;
}

export async function runDownloadCommand(urls: string[], raw: RawFlags): Promise<number> {
  const settings = parseFlags(raw);
  const interactive = isInteractiveTerminal() && !settings.json && !settings.list && !settings.yes;
  const controller = new AbortController();
  const removeHandler = installInterruptHandler(controller);
  const { signal } = controller;

  try {
    if (urls.length === 0) {
      if (!interactive) {
        throw new InvalidArgumentError('Missing video URL.', {
          hint: 'Usage: tubepull <url> [options]. Run `tubepull` in a terminal for the interactive wizard.',
        });
      }
      prompts.intro(pc.inverse(' tubepull '));
      urls = [await askUrl()];
    }

    const yt = await TubePull.create({ ...settings.instance, logger: createStderrLogger(settings.verbose) });
    const targets = await withSpinner(
      interactive && urls.some((u) => parseTarget(u).playlistId),
      'Reading playlist…',
      () => resolveTargets(yt, urls, settings, signal),
      (found) => plural(found.videoIds.length, 'video'),
    );

    if (settings.json || settings.list) return await inspect(yt, targets, urls, settings, signal);
    if (targets.videoIds.length === 0) throw new InvalidArgumentError('The playlist is empty.');
    if (targets.videoIds.length === 1 && targets.playlists.length === 0) {
      return await downloadSingle(yt, targets.videoIds[0] as string, settings, interactive, signal);
    }
    return await downloadBatch(yt, targets, settings, interactive, signal);
  } catch (error) {
    printError(error, settings.verbose);
    return exitCodeFor(error);
  } finally {
    removeHandler();
  }
}

async function inspect(
  yt: TubePull,
  targets: Targets,
  urls: string[],
  settings: CliSettings,
  signal: AbortSignal,
): Promise<number> {
  const playlistVideoIds = new Set(targets.playlists.flatMap((p) => p.entries.map((e) => e.id)));
  const looseIds = targets.videoIds.filter((id) => !playlistVideoIds.has(id));
  const infos: VideoInfo[] = [];
  for (const id of looseIds) infos.push(await yt.getInfo(id, { signal }));

  if (settings.json) {
    const items: unknown[] = [...targets.playlists, ...infos];
    process.stdout.write(
      `${items.length === 1 && urls.length === 1 ? infoToJsonValue(items[0]) : JSON.stringify(items, null, 2)}\n`,
    );
    return EXIT.OK;
  }
  const blocks = [...targets.playlists.map(renderPlaylist), ...infos.map(renderFormatList)];
  process.stdout.write(`${blocks.join('\n\n')}\n`);
  return EXIT.OK;
}

function infoToJsonValue(item: unknown): string {
  return item && typeof item === 'object' && 'formats' in item
    ? infoToJson(item as VideoInfo)
    : JSON.stringify(item, null, 2);
}

async function downloadSingle(
  yt: TubePull,
  videoId: string,
  settings: CliSettings,
  interactive: boolean,
  signal: AbortSignal,
): Promise<number> {
  const info = await withSpinner(
    interactive,
    'Fetching video info…',
    () => yt.getInfo(videoId, { signal }),
    (found) => `${found.qualities.length} qualities, ${found.audioQualities.length} audio formats`,
  );
  let options: DownloadOptions = { ...settings.download };

  if (interactive && !settings.selectionGiven) {
    prompts.note(`${pc.bold(info.title)}\n${pc.dim(summaryLine(info))}`, 'Video');
    options = await chooseDownloadOptions(info, options);
  } else if (!interactive || settings.selectionGiven) {
    say(`${pc.bold(info.title)} ${pc.dim(`· ${summaryLine(info)}`)}`);
  }

  const view: ProgressView = isInteractiveTerminal() ? createBarView() : createLineView();
  const onWarning = (w: { message: string }) => view.log(`${pc.yellow('!')} ${pc.yellow(w.message)}`);
  const onRetry = (r: { stage: string; attempt: number; reason: string }) => {
    if (settings.verbose) view.log(pc.dim(`retry ${r.stage} #${r.attempt}: ${r.reason}`));
  };
  yt.on('warning', onWarning);
  yt.on('retry', onRetry);
  let result: DownloadResult;
  try {
    result = await yt.download(info, { ...options, signal, onProgress: (e) => view.update(e) });
  } finally {
    view.stop();
    yt.off('warning', onWarning);
    yt.off('retry', onRetry);
  }

  if (result.skipped) warn(`Already exists, skipped: ${result.path}`);
  else success(`Saved ${describeResult(result)} in ${formatDuration(result.durationMs / 1000)}`);
  process.stdout.write(`${result.path}\n`);
  if (interactive && !settings.selectionGiven) {
    await offerOpenFolder(path.dirname(result.path));
    prompts.outro('Done');
  }
  return EXIT.OK;
}

async function downloadBatch(
  yt: TubePull,
  targets: Targets,
  settings: CliSettings,
  interactive: boolean,
  signal: AbortSignal,
): Promise<number> {
  let options: DownloadOptions = { skipExisting: true, ...settings.download };
  if (interactive && !settings.selectionGiven)
    options = await chooseBatchOptions(targets.videoIds.length, options);
  for (const playlist of targets.playlists)
    say(`${pc.bold(playlist.title)} ${pc.dim(`· ${plural(playlist.entries.length, 'video')}`)}`);

  const view: ProgressView = isInteractiveTerminal() ? createBarView() : createLineView();
  const titles = new Map<string, string>();
  const onWarning = (w: { videoId?: string; message: string }) =>
    view.log(
      `${pc.yellow('!')} ${w.videoId ? pc.dim(`[${titles.get(w.videoId) ?? w.videoId}] `) : ''}${pc.yellow(w.message)}`,
    );
  yt.on('warning', onWarning);

  let failures: { id: string; error: unknown }[];
  try {
    const settled = await runQueue(
      targets.videoIds,
      settings.concurrency,
      async (id) => {
        const info = await yt.getInfo(id, { signal });
        titles.set(id, info.title);
        try {
          const result = await yt.download(info, {
            ...options,
            signal,
            onProgress: (e) => view.update(e, info.title),
          });
          view.finish(id);
          view.log(
            result.skipped
              ? `${pc.dim('–')} ${pc.dim(`skipped (exists): ${path.basename(result.path)}`)}`
              : `${pc.green('✔')} ${describeResult(result)}`,
          );
          return result;
        } catch (error) {
          view.finish(id);
          throw error;
        }
      },
      signal,
    );
    failures = settled
      .map((outcome, index) => ({ outcome, id: targets.videoIds[index] as string }))
      .filter((x) => !x.outcome.ok)
      .map((x) => ({ id: x.id, error: (x.outcome as { error: unknown }).error }));
  } finally {
    view.stop();
    yt.off('warning', onWarning);
  }

  const total = targets.videoIds.length;
  for (const { id, error } of failures) {
    process.stderr.write(`${pc.red('✖')} ${titles.get(id) ?? id} ${pc.dim(`(${id})`)}\n`);
    printError(error, settings.verbose);
  }
  const done = total - failures.length;
  (failures.length ? warn : success)(
    `${done}/${total} downloaded${failures.length ? `, ${failures.length} failed` : ''}`,
  );
  if (interactive && !settings.selectionGiven) prompts.outro('Done');
  return failures.length ? exitCodeFor(failures[0]?.error) : EXIT.OK;
}
