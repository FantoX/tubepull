# API

```ts
import { TubePull } from 'tubepull';
const yt = await TubePull.create(options);
```

## `TubePull.create(options?)`

Creates an instance. It loads the cookies file and validates the proxy up front, so a bad path fails here
instead of on the first download. Every option is optional.

When `cookies` is omitted, a bundled playback session is selected once for the instance. Supply your own
cookies to override it, or set `cookies: false` for signed-out playback. The bundled payload is obfuscated
with AES-256-GCM, but its key is included in the package: it is recoverable and can expire or be revoked.

| Option                    | Type                                         | Description                                                                                                                                                                 |
| ------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cookies`                 | `string \| false`                            | Override the bundled session with a Netscape `cookies.txt` path or raw header. `false` disables authentication. Expired and foreign-domain cookies are filtered from files. |
| `proxy`                   | `string`                                     | `http://` or `https://` proxy URL. Uses the optional `undici` dependency.                                                                                                   |
| `ffmpegPath`              | `string`                                     | Explicit ffmpeg binary. Otherwise tubepull tries `TUBEPULL_FFMPEG_PATH`, then ffmpeg-static, then `PATH`.                                                                   |
| `poToken` / `visitorData` | `string`                                     | A static Proof-of-Origin token and the visitor data it was minted for.                                                                                                      |
| `poTokenProvider`         | `(req) => string \| undefined \| Promise<…>` | Called for each video (`{ videoId, client, visitorData }`). Takes precedence over `poToken`.                                                                                |
| `requestPacing`           | `{ maxConcurrent?, minIntervalMs? }`         | Pacing of YouTube API requests for the instance. Default 2 in flight, 300 ms apart. A 429 pauses all of them.                                                               |
| `clients`                 | `string[]`                                   | InnerTube clients to try, in order. Default `DEFAULT_CLIENTS`: VISIONOS, TV, WEB_EMBEDDED, IOS, MWEB, WEB.                                                                  |
| `lang` / `location`       | `string`                                     | Interface language (`'en'`) and region (`'US'`).                                                                                                                            |
| `cacheDir`                | `string \| false`                            | Player-script cache. Default: the per-OS cache directory. `false` disables it.                                                                                              |
| `tempDir`                 | `string`                                     | Where temporary download files go. Default: the OS temp directory.                                                                                                          |
| `fetch`                   | `typeof fetch`                               | Custom fetch. Takes precedence over `proxy`.                                                                                                                                |
| `logger`                  | `Logger`                                     | `{ debug, info, warn, error }`. The library never writes to the console itself.                                                                                             |
| `extractor`               | `Extractor`                                  | Advanced: replaces the extraction engine (see below).                                                                                                                       |

## Methods

### `getInfo(url, { signal }?) → Promise<VideoInfo>`

Returns metadata (`id, title, author, durationSec, thumbnails, chapters, …`) and the normalised `formats`
list. DRM, segmented and unplayable formats are already removed. It also returns:

- `qualities`: one entry per available `(resolution, fps, HDR)` combination, best first.
  For example `{ label: '1080p60', height: 1080, fps: 60, hdr: false, codecs: ['av01','vp9','avc1'], itags, estSizeBytes }`.
- `audioQualities`: audio-only streams, best first. For example `{ label: '133kbps opus', itag: 251, … }`.

Accepts any YouTube URL form (watch, youtu.be, shorts, embed, live, music, nocookie) or a bare 11-character ID.

### `download(urlOrInfo, options?) → Promise<DownloadResult>`

| Option                    | Default                       | Description                                                                                                          |
| ------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `type`                    | `'video'`                     | `'video'` (merged with audio) or `'audio'`.                                                                          |
| `quality`                 | `'best'`                      | `'best'`, `'worst'`, `'1080p'`, `'720p60'`, `'4k'`. If the exact quality is missing, the nearest lower one is used.  |
| `strict`                  | `false`                       | Throw instead of falling back to a lower quality.                                                                    |
| `hdr`                     | `false`                       | Prefer HDR streams.                                                                                                  |
| `container`               | `'mp4'`                       | `'mp4'`, `'mkv'` or `'webm'`. Switches to mkv when the codecs can't be copied into the container.                    |
| `codecPreference`         | per container                 | For example `['av01', 'vp9', 'avc1']`.                                                                               |
| `allowTranscode`          | `false`                       | Re-encode (slow) instead of switching to mkv.                                                                        |
| `audioFormat`             | `'m4a'`                       | `'mp3'`, `'m4a'`, `'opus'`, `'flac'`, `'wav'`, or `'original'` (written untouched, no ffmpeg).                       |
| `audioBitrate`            | `'192k'`                      | Used when transcoding.                                                                                               |
| `audioLanguage`           | original track                | For multi-language videos, e.g. `'en'`, `'de'`, `'de.3'`.                                                            |
| `videoItag` / `audioItag` | —                             | Pick exact formats (see `info.formats` or `--list`).                                                                 |
| `range`                   | —                             | `{ start?: '1:00' \| 60, end?: '2:30' }`. Trims with stream copy, so cuts land on keyframes and may be slightly off. |
| `outputDir`               | `process.cwd()`               | Destination folder. It is created if needed.                                                                         |
| `filename`                | `'{title} [{id}]'`            | Template tokens: `{title} {id} {author} {channel} {height} {fps} {quality} {itag} {date} {container}`.               |
| `overwrite`               | `false`                       | Replace an existing file. Otherwise `FileExistsError` is thrown.                                                     |
| `skipExisting`            | `false`                       | Return `{ skipped: true }` when the output already exists.                                                           |
| `embedMetadata`           | `true`                        | Title, artist, date, description, URL, and chapters.                                                                 |
| `embedThumbnail`          | audio: `true`, video: `false` | Cover art. Supported in mp4, mkv, m4a, mp3 and flac.                                                                 |
| `chunkSize`               | 10 MiB                        | Size of each HTTP range request.                                                                                     |
| `retries`                 | `5`                           | Retries per chunk when no progress is being made.                                                                    |
| `signal`                  | —                             | `AbortSignal`. Aborting stops the HTTP requests and kills ffmpeg, and temp files are removed.                        |
| `onProgress`              | —                             | Per-download progress callback.                                                                                      |

`DownloadResult`: `{ path, sizeBytes, container, video?, audio?, info, durationMs, warnings, skipped? }`.

How a download runs: the video and audio tracks download in parallel into a temp folder
(`tubepull-<id>-<hash>`), ffmpeg merges or converts them, and the result is moved into place.
The temp folder is always removed afterwards.

### `stream(urlOrInfo, { type?, quality?, itag?, audioLanguage?, signal? }) → Promise<Readable & { format, info }>`

Streams a single format without ffmpeg. With the default `type: 'audio'` you get the best audio as served.
`type: 'video'` gives a combined (progressive) stream, which YouTube serves only at low quality.

### `getPlaylist(urlOrId) → Promise<PlaylistInfo>`

Returns `{ id, title, author?, entries: [{ id, title, author?, durationSec? }] }` and follows continuation pages.

### `downloadMany(inputs, { concurrency = 2, onItemDone, ...downloadOptions }) → Promise<BatchItemResult[]>`

Downloads several video URLs, IDs and playlist links. Playlist links are expanded and duplicate videos are skipped.
A failure in one item doesn't stop the others; each result is `{ input, ok, result?, error? }`.

### `resolveFfmpeg()` / `describeExtractor()`

These report which ffmpeg binary will be used and where it came from (`{ path, source }`), and the extractor's
versions and settings. `tubepull doctor` uses both.

## Events

```ts
yt.on('progress', (e: ProgressEvent) => {}); // { videoId, stage, bytes, total?, percent, speedBps?, etaSec? }
yt.on('warning', (w) => {}); // { videoId?, code, message } — e.g. quality fallback, container switch
yt.on('retry', (r) => {}); // { videoId?, stage, attempt, reason, delayMs }
```

`stage` is one of `video`, `audio`, `merge`, `convert` or `done`. Events are throttled to about 10 per second.

## Errors

All errors extend `TubePullError` and have `code`, `message` and `hint`. Check them with `isTubePullError(err, code?)`.
That check works across the ESM and CJS copies of the package, which `instanceof` doesn't.

| Class                                                                                                                                                    | `code`                                             | CLI exit |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------- |
| `InvalidUrlError`, `InvalidArgumentError`                                                                                                                | `INVALID_URL`, `INVALID_ARGUMENT`                  | 2        |
| `VideoUnavailableError`, `PrivateVideoError`, `AgeRestrictedError`, `RegionBlockedError`, `MembersOnlyError`, `LiveStreamError`, `NoSuitableFormatError` | …                                                  | 3        |
| `NetworkError`, `BotCheckError`, `RateLimitedError`, `PoTokenError`                                                                                      | `NETWORK`, `BOT_CHECK`, `RATE_LIMITED`, `PO_TOKEN` | 4        |
| `FfmpegNotFoundError`, `FfmpegError`                                                                                                                     | `FFMPEG_NOT_FOUND`, `FFMPEG_FAILED`                | 5        |
| `FileExistsError`, `ExtractorError`                                                                                                                      | `FILE_EXISTS`, `EXTRACTOR`                         | 1        |
| `AbortError`                                                                                                                                             | `ABORTED`                                          | 130      |

## Custom extraction engine

YouTube-specific code sits behind one interface. To use another engine, pass `extractor`:

```ts
interface Extractor {
  readonly name: string;
  getVideo(videoId: string, signal?: AbortSignal): Promise<ExtractedVideo>; // info + { headers, rangeMode }
  getPlaylist(playlistId: string, signal?: AbortSignal): Promise<PlaylistInfo>;
  describe(): Promise<Record<string, string>>;
}
```

Selection, downloading, ffmpeg processing and the CLI then work unchanged.
