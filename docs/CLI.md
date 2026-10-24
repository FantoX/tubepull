# CLI

```bash
npm i -g tubepull   # or: npx tubepull …
```

## Modes

| Invocation                        | Behaviour                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `tubepull`                        | Interactive wizard: link → video or audio → quality → container/format → folder → extras → download |
| `tubepull <url>`                  | Wizard from the quality step onward                                                                 |
| `tubepull <url> -q 1080p -o ./dl` | No prompts. Any selection flag turns the wizard off.                                                |
| `tubepull <url> --yes`            | No prompts; defaults for anything not given                                                         |
| `tubepull <url> --list`           | Print qualities and formats, then exit                                                              |
| `tubepull <url> --json`           | Print info as JSON to stdout, then exit                                                             |
| `tubepull <playlist-url>`         | Download the whole playlist (asks once for shared settings)                                         |
| `tubepull doctor`                 | Environment report for bug reports (`--offline` skips the network checks)                           |

Without a TTY (CI, pipes) the CLI never prompts, and progress is printed as plain lines every few seconds.
The saved file path goes to stdout; everything else goes to stderr, so `path=$(tubepull <url> -q 720p)` works.

## Flags

| Flag                                   | Description                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `-q, --quality <q>`                    | `best` (default), `worst`, `2160p`, `1080p`, `720p60`, `4k`. Falls back to the nearest lower quality                   |
| `-a, --audio`                          | Audio only                                                                                                             |
| `-f, --format <fmt>`                   | Audio format: `mp3`, `m4a`, `opus`, `flac`, `wav`, `original` (implies `--audio`)                                      |
| `-b, --audio-bitrate <rate>`           | Bitrate when converting, e.g. `128k`, `192k` (default), `320k`                                                         |
| `-c, --container <c>`                  | `mp4` (default), `mkv`, `webm`                                                                                         |
| `-o, --output <dir>`                   | Output folder (default: current folder)                                                                                |
| `-n, --filename <template>`            | Default `{title} [{id}]`. Tokens: `{title} {id} {author} {channel} {height} {fps} {quality} {itag} {date} {container}` |
| `--itag-video <n>`, `--itag-audio <n>` | Exact formats (see `--list`)                                                                                           |
| `--start <t>`, `--end <t>`             | Trim, e.g. `90`, `1:30`, `01:02:03.5`                                                                                  |
| `--lang <code>`                        | Audio track for multi-language videos, e.g. `en`, `de`                                                                 |
| `--hdr`                                | Prefer HDR streams                                                                                                     |
| `--strict`                             | Fail instead of falling back to a lower quality                                                                        |
| `--allow-transcode`                    | Re-encode instead of switching to mkv when codecs don't fit                                                            |
| `--list`, `--json`                     | Inspect only                                                                                                           |
| `--playlist`                           | For links with both `v=` and `list=`, download the playlist instead of the single video                                |
| `--concurrency <n>`                    | Parallel downloads for playlists or multiple links (default 2, max 16)                                                 |
| `--cookies <file>`                     | Netscape `cookies.txt`, for age-restricted, private or members-only videos                                             |
| `--proxy <url>`                        | HTTP(S) proxy (default: `HTTPS_PROXY` / `HTTP_PROXY`)                                                                  |
| `--po-token <t>`, `--visitor-data <d>` | Proof-of-Origin token and the visitor data it was minted for                                                           |
| `--client <names>`                     | InnerTube clients to try, comma-separated (advanced)                                                                   |
| `--overwrite` / `--skip-existing`      | What to do when the output file already exists (the default is to stop with an error)                                  |
| `--no-embed` / `--no-thumbnail`        | Don't embed metadata and thumbnail / don't embed the thumbnail only                                                    |
| `-y, --yes`                            | Never prompt                                                                                                           |
| `-v, --verbose`                        | Debug logs, retries, and full error causes                                                                             |
| `--version`, `-h, --help`              |                                                                                                                        |

## Exit codes

| Code | Meaning                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                               |
| 1    | Other error (file exists, extractor broke, …)                                                         |
| 2    | Invalid arguments or URL                                                                              |
| 3    | Video unavailable, private, age-restricted, region-blocked, members-only, live, or no suitable format |
| 4    | Network error, rate limit, bot check, or PO token required                                            |
| 5    | ffmpeg missing or failed                                                                              |
| 130  | Cancelled (Ctrl+C)                                                                                    |

For playlists, the exit code is 0 only when every video succeeded. Otherwise it is the code of the first failure.

## Ctrl+C

The first Ctrl+C cancels: HTTP requests stop, ffmpeg is killed, and temp files are deleted.
A second Ctrl+C exits immediately.

## Environment variables

| Variable                     | Effect                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| `TUBEPULL_FFMPEG_PATH`       | Use this ffmpeg instead of the bundled one                         |
| `FFMPEG_BINARIES_URL`        | Mirror that ffmpeg-static downloads its binary from during install |
| `HTTPS_PROXY` / `HTTP_PROXY` | Default proxy                                                      |
| `TUBEPULL_NO_UPDATE_CHECK=1` | Turn off the daily "newer version available" check                 |
| `NO_COLOR=1`                 | Plain output                                                       |
