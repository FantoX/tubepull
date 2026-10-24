# tubepull

## 1.0.1 - 2026-10-25

- Normalize the CLI executable path in the npm package metadata.

## 1.0.0 - 2026-10-25

- Initial release: library (`TubePull`) and CLI (`tubepull`).
- Quality detection from real availability; `best` / `worst` / `NNNp[fps]` selectors with nearest-lower fallback.
- Video+audio merging by stream copy with codec ↔ container matching (mp4 → mkv switch, optional transcode).
- Audio to mp3 / m4a / opus / flac / wav / original; trimming; metadata, chapters and cover art.
- Chunked ranged downloads with retry, backoff, stall detection, URL refresh on 403, resume and cancellation.
- Bundled ffmpeg via ffmpeg-static with resolution chain and clear errors.
- Interactive wizard, scriptable flags, `--list`, `--json`, playlists with concurrency, `doctor`.
- ESM + CommonJS + TypeScript declarations.
- Extraction hardening: YouTube-issued visitor sessions (never cached), VISIONOS-first client order, fresh
  session after bot checks, one retry per client on network blips, 30 s request deadlines, throttled
  (unsolved `n`) URLs used only as a last resort, client switch + resume when a stream is refused (403),
  expired URLs refreshed before downloading.
- Request pacing (shared governor: 2 in flight, 300 ms apart, instance-wide pause on 429/Retry-After), extraction
  cache reused across getInfo/download/retries, session renewals capped at one a minute, `RATE_LIMITED` error.
- Audio sources ranked by codec efficiency (Opus preferred over AAC of similar bitrate).
