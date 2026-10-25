const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const MAX_BYTES = 200;

/** Cross-platform names, capped at 200 UTF-8 bytes without splitting a character. */
export function sanitizeFilename(input: string, replacement = '_'): string {
  let name = input
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(ILLEGAL_CHARS, replacement);

  name = name.replace(/\s+/g, ' ').trim();
  // Windows strips trailing dots/spaces, which would silently change the name.
  name = name.replace(/[. ]+$/, '');
  // Leading dots create hidden files on Unix.
  name = name.replace(/^\.+/, '');
  if (WINDOWS_RESERVED.test(name)) name = `${replacement}${name}`;
  name = truncateUtf8(name, MAX_BYTES).replace(/[. ]+$/, '');
  return name || 'download';
}

export function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let out = '';
  let bytes = 0;
  for (const char of input) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

export type TemplateValues = Record<string, string | number | undefined>;

/** Preserve unknown tokens; missing values become empty. */
export function renderTemplate(template: string, values: TemplateValues): string {
  const rendered = template.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => {
    if (!(key in values)) return match;
    const value = values[key];
    return value === undefined ? '' : String(value);
  });
  // Remove empty-token leftovers such as [] and ().
  const tidied = rendered
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return sanitizeFilename(tidied);
}
