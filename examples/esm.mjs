// node examples/esm.mjs <url>
import { TubePull, formatBytes, isTubePullError } from 'tubepull';

const url = process.argv[2] ?? 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const yt = await TubePull.create();

const info = await yt.getInfo(url);
console.log(`${info.title} — ${info.author}`);
console.log('Qualities:', info.qualities.map((q) => q.label).join(', '));

yt.on('progress', (p) => process.stdout.write(`\r${p.stage.padEnd(6)} ${p.percent.toFixed(1)}%   `));
yt.on('warning', (w) => console.warn(`\n${w.message}`));

try {
  const video = await yt.download(info, { quality: '720p', outputDir: './downloads' });
  console.log(`\nSaved ${video.path} (${formatBytes(video.sizeBytes)})`);

  const audio = await yt.download(info, {
    type: 'audio',
    audioFormat: 'mp3',
    audioBitrate: '192k',
    outputDir: './downloads',
  });
  console.log(`Saved ${audio.path}`);
} catch (error) {
  if (isTubePullError(error)) console.error(`\n${error.code}: ${error.message}\n→ ${error.hint ?? ''}`);
  else throw error;
}
