import type { Logger } from './types.js';

/** Keep the library silent unless a logger is supplied. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
