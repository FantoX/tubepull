const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number | undefined, decimals = 1): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSec: number | undefined): string {
  if (bytesPerSec === undefined || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '-- /s';
  return `${formatBytes(bytesPerSec)}/s`;
}
