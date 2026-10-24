import type { Logger } from './types.js';

//---- Section used for library logging ----

/** Logger that drops everything. The library never writes to the console on its own. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
