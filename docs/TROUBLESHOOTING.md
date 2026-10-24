# Troubleshooting

Start with `tubepull doctor`. It checks Node, ffmpeg and its encoders, the cache and temp folders,
connectivity to YouTube, and a live metadata request. Add its output to bug reports.

## "YouTube asked to confirm you are not a bot" (`BOT_CHECK`, exit 4)

YouTube flags many datacenter, cloud, VPN and CI IP addresses. In order of effectiveness:

1. Run from a home connection, or use `--proxy` with a residential proxy.
2. Pass cookies from a signed-in browser: `--cookies cookies.txt`. Export them in Netscape format with a
   "cookies.txt" browser extension. A throwaway account is recommended, because YouTube can flag accounts used for automation.
3. Provide a PO token (see the next section).

## "YouTube is rate-limiting this network" (`RATE_LIMITED`, exit 4)

YouTube answered with HTTP 429 or its "unusual traffic" page. tubepull has already honoured `Retry-After`,
paused all its requests and retried a few times before telling you this.

- Wait. Limits usually lift within 15–60 minutes, and retrying sooner tends to extend them.
- Download less in parallel: `--concurrency 1` for playlists, or `requestPacing: { maxConcurrent: 1, minIntervalMs: 1000 }`
  in the library.
- A network that is limited constantly (common for datacenter and cloud IPs) needs a different network.
  tubepull does not rotate IPs or disguise its requests.

## HTTP 403 during download / "PO token required" (`NETWORK` / `PO_TOKEN`, exit 4)

Some clients (IOS, MWEB, ANDROID_VR) return stream URLs that YouTube refuses with 403 unless a Proof-of-Origin
token is attached. tubepull asks VISIONOS first because its streams don't need one. When a client's streams are
refused, tubepull re-extracts from another client and resumes the download. You only see this error once every
client has been refused. Run with `-v` to see which clients were tried.

- Update first: `npm i -g tubepull@latest`. YouTube changes clients, and fixes ship as patch releases.
- If `-v` shows `VISIONOS: LOGIN_REQUIRED Sign in to confirm you're not a bot`, your network is being bot-checked.
  Try cookies or another network (see the previous section).
- Pin clients: `--client VISIONOS`, or `--client VISIONOS,TV`.
- Supply a token: `--po-token <token> --visitor-data <visitor data>`, or `poTokenProvider` in the library.
  The token must be minted for that visitor data. The
  [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) explains how tokens work
  and lists tools that generate them. tubepull doesn't generate tokens itself.

## "Only streaming (SABR) formats" (`NO_SUITABLE_FORMAT`, exit 3)

Some clients get only SABR streaming formats, with no direct URLs. tubepull already tries several clients.
If every client gets SABR-only formats, try `--client`, cookies, or a PO token. `--list` shows `no URL` next to such formats.

## ffmpeg not found

`ffmpeg-static` downloads its binary in an install script. That step doesn't run when:

- scripts are disabled (`npm i --ignore-scripts`, `ignore-scripts=true` in `.npmrc`, or npm's `allowScripts` policy).
  Fix: `npm rebuild ffmpeg-static`, or `npm install-scripts approve ffmpeg-static` and reinstall.
- GitHub is blocked (corporate proxy, offline CI).
  Fix: set `FFMPEG_BINARIES_URL` to a mirror and reinstall, or point `TUBEPULL_FFMPEG_PATH` at an ffmpeg you have.
- `node_modules` was copied from another OS or CPU (Docker multi-arch, Electron packaging).
  Fix: run `npm ci` on the target platform. Never copy `node_modules` between operating systems.

On Linux and macOS, tubepull adds the exec permission to the binary if it is missing.

## "Cannot encode mp3 (libmp3lame missing)"

Some ffmpeg builds lack an encoder. tubepull then saves m4a instead and prints a warning.
To get mp3, use a full ffmpeg build through `TUBEPULL_FFMPEG_PATH`. `tubepull doctor` lists the missing encoders.

## "Saving as mkv instead"

The best stream at the quality you chose uses a codec that mp4 can't hold without re-encoding (VP9 or Opus).
Your options: accept mkv; choose a quality that has H.264/AV1; use `-c webm`; or use `--allow-transcode` (slow).

## Age-restricted, private, members-only (exit 3)

These need `--cookies` from an account that is allowed to watch the video. tubepull never bypasses access controls.

## Region-blocked

Use `--proxy` with an address in a region where the video is available.

## Live streams and premieres

Live recording isn't supported yet. Download the video once the stream has ended and YouTube has finished processing it.

## Playlists starting with `RD` (mixes)

Mixes are generated for each viewer and can't be listed. Download the individual videos instead.

## The download stalls or is slow

Chunks that stall for 30 seconds are retried automatically. Use `-v` to see the retries.
Persistent slowness usually means YouTube is throttling your IP; cookies or a different network help.
