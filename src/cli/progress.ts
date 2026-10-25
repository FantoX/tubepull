import cliProgress from 'cli-progress';
import pc from 'picocolors';
import type { ProgressEvent, Stage } from '../types.js';
import { formatBytes, formatSpeed } from '../utils/bytes.js';
import { formatDuration } from '../utils/time.js';

const STAGE_LABEL: Partial<Record<Stage, string>> = {
  video: 'video',
  audio: 'audio',
  merge: 'merge',
  convert: 'convert',
};
const BAR_WIDTH = 24;
const LINE_INTERVAL_MS = 5_000;
const TITLE_WIDTH = 28;

export interface ProgressView {
  /** `title` prefixes the line when several videos download at once. */
  update(event: ProgressEvent, title?: string): void;

  finish(videoId: string): void;
  /** Print a message without corrupting the bars. */
  log(message: string): void;
  stop(): void;
}

function describe(event: ProgressEvent): string {
  const pct = `${event.percent.toFixed(0).padStart(3)}%`;
  if (event.stage === 'merge' || event.stage === 'convert') return pct;
  const size = event.total
    ? `${formatBytes(event.bytes)}/${formatBytes(event.total)}`
    : formatBytes(event.bytes);
  const eta = event.etaSec !== undefined ? `ETA ${formatDuration(event.etaSec)}` : '';
  return [pct, size, formatSpeed(event.speedBps), eta].filter(Boolean).join('  ');
}

function shorten(title: string): string {
  const chars = [...title];
  return chars.length <= TITLE_WIDTH
    ? title.padEnd(TITLE_WIDTH)
    : `${chars.slice(0, TITLE_WIDTH - 1).join('')}…`;
}

function stageLabel(stage: Stage, title?: string): string {
  const name = (STAGE_LABEL[stage] ?? stage).padEnd(7);
  return title ? `${pc.dim(shorten(title))} ${name}` : name;
}

export function createBarView(): ProgressView {
  const multibar = new cliProgress.MultiBar(
    {
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: false,
      fps: 10,
      stream: process.stderr,
      format: (_options, params, payload: { label: string; text: string }) => {
        const filled = Math.round(Math.max(0, Math.min(1, params.progress)) * BAR_WIDTH);
        const bar = pc.cyan('█'.repeat(filled)) + pc.dim('░'.repeat(BAR_WIDTH - filled));
        return `${payload.label} ${bar} ${payload.text}`;
      },
    },
    cliProgress.Presets.shades_classic,
  );
  const bars = new Map<string, cliProgress.SingleBar>();

  return {
    update(event, title) {
      if (!STAGE_LABEL[event.stage]) return;
      const key = `${event.videoId}|${event.stage}`;
      const total = event.total ?? 100;
      const value = event.total ? event.bytes : event.percent;
      const payload = { label: stageLabel(event.stage, title), text: describe(event) };
      let bar = bars.get(key);
      if (!bar) {
        bar = multibar.create(total, Math.min(value, total), payload);
        bars.set(key, bar);
        return;
      }
      if (bar.getTotal() !== total) bar.setTotal(total);
      bar.update(Math.min(value, total), payload);
    },
    finish(videoId) {
      for (const [key, bar] of bars) {
        if (!key.startsWith(`${videoId}|`)) continue;
        multibar.remove(bar);
        bars.delete(key);
      }
    },
    log(message) {
      multibar.log(`${message}\n`);
    },
    stop() {
      multibar.stop();
    },
  };
}

/** Throttle non-interactive output; always print stage completion. */
export function createLineView(): ProgressView {
  const last = new Map<string, number>();
  const done = new Set<string>();
  return {
    update(event, title) {
      const key = `${event.videoId}|${event.stage}`;
      if (!STAGE_LABEL[event.stage] || done.has(key)) return;
      const now = Date.now();
      const complete = event.percent >= 100;
      if (!complete && now - (last.get(key) ?? 0) < LINE_INTERVAL_MS) return;
      last.set(key, now);
      if (complete) done.add(key);
      process.stderr.write(`${title ? `[${title}] ` : ''}${STAGE_LABEL[event.stage]}: ${describe(event)}\n`);
    },
    finish() {},
    log(message) {
      process.stderr.write(`${message}\n`);
    },
    stop() {},
  };
}
