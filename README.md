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
tubepull                                   # interactive wizard
tubepull <url>                             # wizard from the quality step
tubepull <url> -q 1080p -o ./downloads     # no prompts
tubepull <url> -f mp3 -b 320k              # audio only, as mp3
tubepull <url> --start 1:00 --end 2:30     # trim
tubepull <url> --list                      # available qualities and formats
tubepull <url> --json                      # machine-readable info
tubepull <playlist-url> -q 720p --concurrency 3
tubepull doctor                            # environment check, for bug reports
```

<details open>
<summary><b>Example: a full interactive session</b></summary>

<br>

Run `tubepull` with no arguments, paste a link, and answer a few questions:

```text
$ tubepull
┌   tubepull
│
◇  Paste a YouTube link
│  https://www.youtube.com/watch?v=VeUiVCb7ZmQ&list=RDVeUiVCb7ZmQ&start_radio=1
│
◇  1 video
│
◇  6 qualities, 5 audio formats
│
◇  Video ──────────────────────────────────────────────────────────────────────────────╮
│                                                                                      │
│  NSYNC - Bye Bye Bye (Music Video) Deadpool & Wolverine Opening Scene Soundtrack MV  │
│  The Wizard · 3:21 · 18,077,568 views                                                │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────╯
│
◇  What do you want?
│  Video
│
◇  Quality
│  1080p
│
◇  Container
│  mp4
│
◇  Save to folder
│  C:\Users\you\Videos
│
◇  Filename
│  {title} [{id}]
│
◇  Extras (space to toggle, enter to confirm)
│  Embed metadata
audio   ████████████████████████ 100%  3.1 MB/3.1 MB  1.2 MB/s  ETA 0:00
video   ████████████████████████ 100%  32.5 MB/32.5 MB  3.7 MB/s  ETA 0:00
merge   ████████████████████████ 100%
✔ Saved C:\Users\you\Videos\NSYNC - Bye Bye Bye (Music Video) Deadpool & Wolverine Opening Scene Soundtrack MV [VeUiVCb7ZmQ].mp4 (35.7 MB, 1080p avc1 + 130k mp4a) in 0:10
C:\Users\you\Videos\NSYNC - Bye Bye Bye (Music Video) Deadpool & Wolverine Opening Scene Soundtrack MV [VeUiVCb7ZmQ].mp4
│
◇  Open the folder?
│  No
│
└  Done
```

The link above contains both a video and a Mix (`list=RD…`), so tubepull downloads just the video. Mixes are
generated per viewer and can't be listed; for links to regular playlists, `--playlist` downloads the whole list.
The video and audio tracks download in parallel, ffmpeg then merges them without re-encoding, and the last line on
stdout is the saved file's path, so scripts can capture it.

</details>

All flags, exit codes and environment variables: **[docs/CLI.md](https://github.com/FantoX/tubepull/blob/main/docs/CLI.md)**.

## Library

```ts
import { TubePull } from 'tubepull'; // or: const { TubePull } = require('tubepull');

const yt = await TubePull.create();

const info = await yt.getInfo('https://youtu.be/aqz-KE-bpKQ');
console.log(
  info.title,
  info.qualities.map((q) => q.label),
); // ['2160p60', '1440p60', '1080p60', ...]

yt.on('progress', (p) => console.log(p.stage, p.percent.toFixed(1)));

await yt.download(info, { quality: '1080p', outputDir: './downloads' }); // merged mp4
await yt.download(info, { type: 'audio', audioFormat: 'mp3', audioBitrate: '192k' });
await yt.download(info, { videoItag: 137, audioItag: 140, range: { start: '1:00', end: '2:30' } });

const stream = await yt.stream(info, { type: 'audio' }); // Readable, no ffmpeg
```

Every error is a `TubePullError` with a stable `code` and a `hint` that says what to try next:

```ts
import { isTubePullError } from 'tubepull';

try {
  await yt.download(url);
} catch (error) {
  if (isTubePullError(error, 'RATE_LIMITED')) console.log(error.hint); // "Wait before retrying …"
}
```

Options, events, types and errors: **[docs/API.md](https://github.com/FantoX/tubepull/blob/main/docs/API.md)** · Runnable examples: **[examples/](https://github.com/FantoX/tubepull/tree/main/examples)**

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

tubepull starts every run with a fresh visitor session issued by YouTube and asks the VISIONOS client first, whose
streams need no Proof-of-Origin (PO) token. If YouTube refuses a client's streams partway through a download,
tubepull gets the same stream from another client and carries on from the same byte.

It also behaves like a considerate client, which is what keeps it from tripping rate limits:

- No more than 2 requests to YouTube's API are in flight at once, spaced at least 300 ms apart (`requestPacing` to
  adjust).
- One extraction per video is reused across getInfo, download and retries while its URLs stay valid.
- An HTTP 429 or `Retry-After` pauses every request of the instance, instead of retrying into the limit.
- A rate-limit answer stops it from asking further clients, and fresh sessions are capped at one a minute.

> [!IMPORTANT]
> tubepull does not rotate IPs or disguise itself. If YouTube has blocked a network, which happens to many datacenter,
> VPN and cloud IPs, waiting or another network is the answer. When nothing works, tubepull tells you what to try:
> `--cookies cookies.txt` (exported from a signed-in browser), `--proxy http://…`, or
> `--po-token <token> --visitor-data <data>`. Details: [docs/TROUBLESHOOTING.md](https://github.com/FantoX/tubepull/blob/main/docs/TROUBLESHOOTING.md).

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
