// node examples/cjs.cjs <url>
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { TubePull } = require('tubepull');

async function main() {
  const url = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const yt = await TubePull.create();

  const stream = await yt.stream(url, { type: 'audio' });
  const ext = stream.format.container === 'webm' ? 'webm' : 'm4a';
  await pipeline(stream, createWriteStream(`audio.${ext}`));
  console.log(`Wrote audio.${ext} (itag ${stream.format.itag})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
