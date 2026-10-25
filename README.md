<p align="center">
  <img src="https://raw.githubusercontent.com/FantoX/tubepull/main/docs/assets/banner.png" alt="tubepull: YouTube video and audio downloader for Node.js, as a CLI and a library" width="100%">
</p>

<p align="center">
  <b>Download YouTube video or audio at any available quality, from your terminal or your Node.js code.</b><br>
  Bundled ffmpeg · no Python · ESM, CommonJS and TypeScript
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tubepull"><img src="https://img.shields.io/npm/v/tubepull?color=0a84d6&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.12-339933?logo=node.js&logoColor=white" alt="Node.js 22.12 or newer">
  <img src="https://img.shields.io/badge/types-TypeScript-3178c6?logo=typescript&logoColor=white" alt="TypeScript types included">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555" alt="Windows, macOS and Linux">
  <img src="https://img.shields.io/badge/license-MIT-e5312d" alt="MIT license">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#command-line">Command line</a> ·
  <a href="#library">Library</a> ·
  <a href="#running-on-a-server-vps-vercel">VPS &amp; Vercel</a> ·
  <a href="https://github.com/FantoX/tubepull/blob/main/docs/API.md">API reference</a> ·
  <a href="https://github.com/FantoX/tubepull/blob/main/docs/CLI.md">CLI reference</a> ·
  <a href="https://github.com/FantoX/tubepull/blob/main/docs/TROUBLESHOOTING.md">Troubleshooting</a>
</p>

---

```bash
npx tubepull https://youtu.be/aqz-KE-bpKQ
```

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>🎯 Real quality list</h4>
      Shows what this particular video offers (<code>2160p60 HDR</code>, <code>1080p</code>, <code>133kbps opus</code>, …).
      Pick with <code>best</code>, <code>worst</code>, <code>1080p</code> or <code>720p60</code>. If a video doesn't have the
      quality you asked for, the nearest lower one is used.
    </td>
    <td width="50%" valign="top">
      <h4>🎬 Video and audio merged</h4>
      Joined by stream copy, without re-encoding. Codecs are matched to the container: mp4 by default, switching to
      mkv automatically when the codecs can't go into mp4.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>🎵 Audio only</h4>
      mp3, m4a, opus, flac, wav, or the original stream untouched, with cover art and tags embedded.
    </td>
    <td valign="top">
      <h4>🧙 Interactive wizard</h4>
      Run <code>tubepull</code> with nothing else and answer a few questions. Every choice is also a flag, for scripts.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>🛡️ Resilient downloads</h4>
      Chunked range requests, retries with backoff, URL refresh on expiry, resume, a switch to another client when a
      stream is refused, and cancellation that cleans up its temp files.
    </td>
    <td valign="top">
      <h4>🧰 Extras</h4>
      Trimming (<code>--start</code>/<code>--end</code>), metadata, chapters and cover art, and playlists with parallel
      downloads.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h4>📦 Batteries included</h4>
      ffmpeg is downloaded at install time by <code>ffmpeg-static</code>. You don't need Python, yt-dlp or a system ffmpeg.
    </td>
    <td valign="top">
      <h4>🧩 Any module system</h4>
      ESM, CommonJS and TypeScript, with full typings and typed errors that include a hint on what to try next.
    </td>
  </tr>
</table>

> [!NOTE]
> tubepull is a downloader that bundles several tools into one package. It talks to YouTube through the maintained
> [youtubei.js](https://github.com/LuanRT/YouTube.js) InnerTube client. When YouTube changes something, the fix usually
> arrives as a youtubei.js update followed by a tubepull patch release.

## Install

```bash
npm i -g tubepull     # command line
npm i tubepull        # library
```

| Requirement | Details                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js     | 22.12 or newer                                                                                                                                                                                                                                     |
| OS          | Windows, macOS, Linux                                                                                                                                                                                                                              |
| ffmpeg      | Downloaded automatically by [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) during install. If that step was skipped, see [Troubleshooting](https://github.com/FantoX/tubepull/blob/main/docs/TROUBLESHOOTING.md#ffmpeg-not-found). |

## Command line

```bash
tubepull                                  # interactive wizard
tubepull <url> -q 1080p -o ./downloads     # video
tubepull <url> -f mp3                     # audio
tubepull <url> -f mp3 --cookies ./cookies.txt
tubepull <url> --list                     # available qualities
tubepull <playlist-url> -q 720p --concurrency 3
tubepull doctor                          # diagnostics
```

Run `tubepull` without arguments to choose a link, format and destination interactively. Add `--yes` to
skip prompts. Normal playlists support `--playlist`; YouTube Mix links download only the selected video.

All flags, trimming, JSON output and exit codes: **[CLI reference](https://github.com/FantoX/tubepull/blob/main/docs/CLI.md)**.

## Library

Create an instance with the defaults; no cookie file is needed for this example.

```js
import { TubePull } from 'tubepull';

const yt = await TubePull.create();
const info = await yt.getInfo('https://youtu.be/aqz-KE-bpKQ');
console.log(info.qualities.map((q) => q.label));

await yt.download(info, { quality: '1080p', outputDir: './downloads' });
await yt.download(info, { type: 'audio', audioFormat: 'mp3', outputDir: './downloads' });
```

CommonJS: `const { TubePull } = require('tubepull')`. Errors expose a `code` and an actionable `hint`.

To override the default session, supply your own Netscape `cookies.txt` file:

```js
import { TubePull } from 'tubepull';

const yt = await TubePull.create({ cookies: './cookies.txt' });
await yt.download('https://youtu.be/aqz-KE-bpKQ', { type: 'audio', audioFormat: 'mp3' });
```

Or set `YT_COOKIES` to a raw Cookie header (`name=value; name2=value2`) or a cookie-file path:

```js
import { TubePull } from 'tubepull';

const yt = await TubePull.create({ cookies: process.env.YT_COOKIES });
await yt.download('https://youtu.be/aqz-KE-bpKQ', { type: 'audio', audioFormat: 'mp3' });
```

Streaming, progress events and advanced options: **[API reference](https://github.com/FantoX/tubepull/blob/main/docs/API.md)** and
**[Runnable examples](https://github.com/FantoX/tubepull/tree/main/examples)**.

## Quality and containers

| Output        | Video codecs copied | Audio codecs copied | Otherwise                                            |
| ------------- | ------------------- | ------------------- | ---------------------------------------------------- |
| mp4 (default) | H.264, AV1          | AAC                 | switches to mkv, or re-encodes with `allowTranscode` |
| webm          | VP9, AV1            | Opus                | switches to mkv, or re-encodes                       |
| mkv           | anything            | anything            | —                                                    |

HDR streams are used only when you ask for them (`hdr: true` / `--hdr`), because SDR screens display HDR video washed
out. When converting audio, Opus counts as a better source than AAC of similar bitrate, because it is the more
efficient codec.

## How it stays reliable

tubepull tries multiple playback clients, waits out required prerolls, and refreshes expired or refused stream
URLs. Downloads resume from the last received byte when the replacement stream matches the original.

- API requests share a limit of 2 in flight, at least 300 ms apart.
- Valid extraction results are reused across inspection, downloads and retries.
- Rate limits pause requests for the instance; session renewals are capped at once a minute.

## Running on a server (VPS, Vercel)

Use the same CLI or library calls on a VPS, and reuse one `TubePull` instance per process. The default session
requires no manual cookie export or environment-variable setup.

On serverless hosts, use a Node.js runtime and `stream()` to pipe audio without ffmpeg. Use `cacheDir: false`
or a writable cache directory. Merged video downloads need ffmpeg and writable temporary storage.

Sessions can expire and networks can be blocked. Run `tubepull doctor` if playback fails; custom cookies, proxies
and signed-out mode are covered in the [API reference](https://github.com/FantoX/tubepull/blob/main/docs/API.md)
and [Troubleshooting](https://github.com/FantoX/tubepull/blob/main/docs/TROUBLESHOOTING.md).

## Documentation

| Document                                                                                | What's in it                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [API reference](https://github.com/FantoX/tubepull/blob/main/docs/API.md)               | `TubePull` options, methods, events, types, errors, custom engines |
| [CLI reference](https://github.com/FantoX/tubepull/blob/main/docs/CLI.md)               | Modes, every flag, exit codes, environment variables               |
| [Troubleshooting](https://github.com/FantoX/tubepull/blob/main/docs/TROUBLESHOOTING.md) | Bot checks, rate limits, 403s, ffmpeg, containers, access errors   |
| [Examples](https://github.com/FantoX/tubepull/tree/main/examples)                       | ESM, CommonJS and TypeScript (playlist with concurrency)           |
| [Changelog](https://github.com/FantoX/tubepull/blob/main/CHANGELOG.md)                  | What changed in each release                                       |

## Legal

> [!WARNING]
> Use tubepull only for content you own, public-domain or Creative Commons material, or content you have permission to
> download. Downloading other content may violate YouTube's Terms of Service and copyright law where you live.
> tubepull does not circumvent DRM and is not affiliated with, endorsed by, or sponsored by YouTube or Google.

tubepull is [MIT licensed](https://github.com/FantoX/tubepull/blob/main/LICENSE). The ffmpeg binaries that `ffmpeg-static` downloads are GPL-licensed builds, and
`ffmpeg-static` itself is GPL-3.0-or-later. It is installed as a separate (optional) dependency, and no ffmpeg binary
is shipped inside the tubepull package. To use your own LGPL or system build, set `TUBEPULL_FFMPEG_PATH`.
