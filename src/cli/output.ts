import pc from 'picocolors';
import { isTubePullError, type ErrorCode } from '../errors.js';
import type { Logger } from '../types.js';

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  INVALID_ARGS: 2,
  UNAVAILABLE: 3,
  NETWORK: 4,
  FFMPEG: 5,
  CANCELLED: 130,
} as const;

const EXIT_BY_CODE: Partial<Record<ErrorCode, number>> = {
  INVALID_URL: EXIT.INVALID_ARGS,
  INVALID_ARGUMENT: EXIT.INVALID_ARGS,
  VIDEO_UNAVAILABLE: EXIT.UNAVAILABLE,
  AGE_RESTRICTED: EXIT.UNAVAILABLE,
  PRIVATE_VIDEO: EXIT.UNAVAILABLE,
  REGION_BLOCKED: EXIT.UNAVAILABLE,
  MEMBERS_ONLY: EXIT.UNAVAILABLE,
  LIVE_STREAM: EXIT.UNAVAILABLE,
  NO_SUITABLE_FORMAT: EXIT.UNAVAILABLE,
  NETWORK: EXIT.NETWORK,
  BOT_CHECK: EXIT.NETWORK,
  RATE_LIMITED: EXIT.NETWORK,
  PO_TOKEN: EXIT.NETWORK,
  FFMPEG_NOT_FOUND: EXIT.FFMPEG,
  FFMPEG_FAILED: EXIT.FFMPEG,
  ABORTED: EXIT.CANCELLED,
};

export function exitCodeFor(error: unknown): number {
  if (isTubePullError(error)) return EXIT_BY_CODE[error.code] ?? EXIT.GENERIC;
  if (error instanceof Error && error.name === 'CACError') return EXIT.INVALID_ARGS;
  return EXIT.GENERIC;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI;
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function success(message: string): void {
  process.stderr.write(`${pc.green('✔')} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${pc.yellow('!')} ${pc.yellow(message)}\n`);
}

export function printError(error: unknown, verbose: boolean): void {
  if (isTubePullError(error, 'ABORTED')) {
    process.stderr.write(`${pc.yellow('Cancelled.')}\n`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${pc.red('✖')} ${pc.red(message)}\n`);
  if (isTubePullError(error) && error.hint) process.stderr.write(`  ${pc.dim('→')} ${error.hint}\n`);
  if (!verbose) {
    if (error instanceof Error && error.name === 'CACError')
      process.stderr.write(pc.dim('  Run tubepull --help for usage.\n'));
    else if (!isTubePullError(error) || error.code === 'EXTRACTOR')
      process.stderr.write(pc.dim('  Run with --verbose for details.\n'));
    return;
  }
  let cause: unknown = error;
  while (cause instanceof Error) {
    if (cause.stack) process.stderr.write(`${pc.dim(cause.stack)}\n`);
    cause = cause.cause;
    if (cause !== undefined) process.stderr.write(pc.dim('Caused by:\n'));
  }
  if (cause !== undefined && !(cause instanceof Error)) process.stderr.write(`${pc.dim(String(cause))}\n`);
}

export function createStderrLogger(verbose: boolean): Logger {
  const write = (level: string, message: string, args: unknown[]) => {
    const extra = args.length
      ? ` ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`
      : '';
    process.stderr.write(pc.dim(`[${level}] ${message}${extra}\n`));
  };
  return {
    debug: (m, ...a) => verbose && write('debug', m, a),
    info: (m, ...a) => verbose && write('info', m, a),
    warn: (m, ...a) => write('warn', m, a),
    error: (m, ...a) => write('error', m, a),
  };
}

export function visibleLength(value: string): number {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '').length;
}

export function table(rows: string[][], gap = 2): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))));
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell + ' '.repeat((widths[i] ?? 0) - visibleLength(cell) + gap),
        )
        .join('')
        .trimEnd(),
    )
    .join('\n');
}
