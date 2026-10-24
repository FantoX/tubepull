// npx tsx examples/ts.ts <playlist-url>
import { TubePull, type BatchItemResult, type DownloadOptions } from 'tubepull';

const playlistUrl = process.argv[2] ?? 'https://www.youtube.com/playlist?list=PL...';

const options: DownloadOptions = {
  type: 'video',
  quality: '1080p', // nearest lower quality is used when a video has no 1080p
  container: 'mp4', // switches to mkv (with a warning) if codecs cannot be copied into mp4
  outputDir: './downloads',
  filename: '{author} - {title} [{id}]',
  skipExisting: true,
};

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

const yt = await TubePull.create({ cookies: process.env.COOKIES_FILE });
const results: BatchItemResult[] = await yt.downloadMany([playlistUrl], {
  ...options,
  concurrency: 3,
  signal: controller.signal,
  onItemDone: (item) =>
    console.log(item.ok ? `✔ ${item.result?.path}` : `✖ ${item.input}: ${item.error?.message}`),
});

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} downloaded`);
