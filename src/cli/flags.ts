import { InvalidArgumentError } from '../errors.js';
import { parseQuality } from '../selector/select.js';
import type { AudioFormat, Container, DownloadOptions, QualitySelector, TubePullOptions } from '../types.js';
import { parseTime } from '../utils/time.js';

/** Raw options as cac hands them over (camelCased; numbers may arrive as numbers). */
export interface RawFlags {
  quality?: string | number;
  audio?: boolean;
  format?: string;
  audioBitrate?: string | number;
  container?: string;
  output?: string;
  filename?: string;
  itagVideo?: string | number;
  itagAudio?: string | number;
  start?: string | number;
  end?: string | number;
  lang?: string;
  hdr?: boolean;
  strict?: boolean;
  allowTranscode?: boolean;
  list?: boolean;
  json?: boolean;
  playlist?: boolean;
  concurrency?: string | number;
  cookies?: string;
  anonymous?: boolean;
  proxy?: string;
  poToken?: string;
  visitorData?: string;
  client?: string;
  overwrite?: boolean;
  skipExisting?: boolean;
  embed?: boolean;
  thumbnail?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

export interface CliSettings {
  download: DownloadOptions;
  instance: TubePullOptions;
  list: boolean;
  json: boolean;
  yes: boolean;
  verbose: boolean;
  playlist: boolean;
  concurrency: number;
  /** True when the user gave any option that pins down what to download. */
  selectionGiven: boolean;
}

const CONTAINERS: readonly Container[] = ['mp4', 'mkv', 'webm'];
const AUDIO_FORMATS: readonly AudioFormat[] = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'original'];

function str(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

function int(value: string | number | undefined, name: string): number | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s)) throw new InvalidArgumentError(`${name} must be a whole number, got "${s}".`);
  return Number(s);
}

export function parseFlags(raw: RawFlags, env: NodeJS.ProcessEnv = process.env): CliSettings {
  const download: DownloadOptions = {};
  const instance: TubePullOptions = {};

  const quality = str(raw.quality);
  if (quality !== undefined) {
    parseQuality(quality);
    download.quality = quality as QualitySelector;
  }

  const format = str(raw.format)?.toLowerCase();
  if (format !== undefined) {
    if (!AUDIO_FORMATS.includes(format as AudioFormat)) {
      throw new InvalidArgumentError(`--format must be one of ${AUDIO_FORMATS.join(', ')}.`);
    }
    download.audioFormat = format as AudioFormat;
  }
  if (raw.audio || format !== undefined) download.type = 'audio';

  const bitrate = str(raw.audioBitrate);
  if (bitrate !== undefined) {
    if (!/^\d{2,3}k?$/i.test(bitrate))
      throw new InvalidArgumentError('--audio-bitrate must look like 128k, 192k or 320k.');
    download.audioBitrate = /k$/i.test(bitrate) ? bitrate.toLowerCase() : `${bitrate}k`;
  }

  const container = str(raw.container)?.toLowerCase();
  if (container !== undefined) {
    if (!CONTAINERS.includes(container as Container)) {
      throw new InvalidArgumentError(`--container must be one of ${CONTAINERS.join(', ')}.`);
    }
    download.container = container as Container;
  }

  const output = str(raw.output);
  if (output !== undefined) download.outputDir = output;
  const filename = str(raw.filename);
  if (filename !== undefined) download.filename = filename;

  const videoItag = int(raw.itagVideo, '--itag-video');
  if (videoItag !== undefined) download.videoItag = videoItag;
  const audioItag = int(raw.itagAudio, '--itag-audio');
  if (audioItag !== undefined) download.audioItag = audioItag;

  const start = str(raw.start);
  const end = str(raw.end);
  const startSec = start === undefined ? undefined : parseTime(start);
  const endSec = end === undefined ? undefined : parseTime(end);
  if (startSec !== undefined && endSec !== undefined && endSec <= startSec) {
    throw new InvalidArgumentError(`--end (${end}) must be after --start (${start}).`);
  }
  if (start !== undefined || end !== undefined) {
    download.range = {};
    if (start !== undefined) download.range.start = start;
    if (end !== undefined) download.range.end = end;
  }

  const lang = str(raw.lang);
  if (lang !== undefined) download.audioLanguage = lang;
  if (raw.hdr) download.hdr = true;
  if (raw.strict) download.strict = true;
  if (raw.allowTranscode) download.allowTranscode = true;
  if (raw.overwrite) download.overwrite = true;
  if (raw.skipExisting) download.skipExisting = true;
  if (raw.embed === false) {
    download.embedMetadata = false;
    download.embedThumbnail = false;
  }
  if (raw.thumbnail === false) download.embedThumbnail = false;

  const concurrency = int(raw.concurrency, '--concurrency') ?? 2;
  if (concurrency < 1 || concurrency > 16)
    throw new InvalidArgumentError('--concurrency must be between 1 and 16.');

  const cookies = str(raw.cookies);
  if (raw.anonymous && cookies !== undefined)
    throw new InvalidArgumentError('Use either --cookies or --anonymous, not both.');
  if (raw.anonymous) instance.cookies = false;
  else if (cookies !== undefined) instance.cookies = cookies;
  const proxy = str(raw.proxy) ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (proxy) instance.proxy = proxy;
  const poToken = str(raw.poToken);
  if (poToken !== undefined) instance.poToken = poToken;
  const visitorData = str(raw.visitorData);
  if (visitorData !== undefined) instance.visitorData = visitorData;
  if (poToken !== undefined && visitorData === undefined) {
    throw new InvalidArgumentError('--po-token needs the --visitor-data it was minted for.');
  }
  const client = str(raw.client);
  if (client !== undefined)
    instance.clients = client
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

  const selectionGiven = [
    quality,
    format,
    container,
    output,
    filename,
    videoItag,
    audioItag,
    start,
    end,
    bitrate,
    raw.audio ? true : undefined,
  ].some((v) => v !== undefined);

  return {
    download,
    instance,
    list: Boolean(raw.list),
    json: Boolean(raw.json),
    yes: Boolean(raw.yes),
    verbose: Boolean(raw.verbose),
    playlist: Boolean(raw.playlist),
    concurrency,
    selectionGiven,
  };
}
