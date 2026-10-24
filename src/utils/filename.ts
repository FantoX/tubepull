//---- Section used for filename safety ----

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// Illegal on Windows, plus control characters; '/' is illegal everywhere.
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const MAX_BYTES = 200;

/**
 * This function is used for turning arbitrary text (video titles) into a filename that is valid on
 * Windows, macOS and Linux: illegal characters replaced, reserved names avoided, trailing dots/spaces
 * trimmed and the UTF-8 length capped at 200 bytes without splitting a character.
 */
export function sanitizeFilename(input: string, replacement = '_'): string {
  // Line breaks and tabs in titles read best as spaces; other control characters are replaced.
  let name = input
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(ILLEGAL_CHARS, replacement);
  // Collapse whitespace runs (titles often contain newlines/tabs).
  name = name.replace(/\s+/g, ' ').trim();
  // Windows strips trailing dots/spaces, which would silently change the name.
  name = name.replace(/[. ]+$/, '');
  // Leading dots create hidden files on Unix.
  name = name.replace(/^\.+/, '');
  if (WINDOWS_RESERVED.test(name)) name = `${replacement}${name}`;
  name = truncateUtf8(name, MAX_BYTES).replace(/[. ]+$/, '');
  return name || 'download';
}

/**
 * This function is used for capping a string's UTF-8 byte length without cutting a code point in half.
 */
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

/**
 * This function is used for expanding a `{token}` filename template. Unknown tokens are left as-is,
 * missing values become empty, and the result is sanitised.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const rendered = template.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => {
    if (!(key in values)) return match;
    const value = values[key];
    return value === undefined ? '' : String(value);
  });
  // Tidy artefacts of empty tokens, e.g. "Title [] 1080p" or "Title ()".
  const tidied = rendered
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return sanitizeFilename(tidied);
}
