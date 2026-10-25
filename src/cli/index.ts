import { cac } from 'cac';
import pc from 'picocolors';
import pkg from '../../package.json' with { type: 'json' };
import { runDoctor } from './doctor.js';
import { parseFlags, type RawFlags } from './flags.js';
import { EXIT, exitCodeFor, printError } from './output.js';
import { runDownloadCommand } from './run.js';
import { checkForUpdate } from './update.js';

const DISCLAIMER =
  'For personal use with content you own, public-domain or Creative Commons material, or where you have\n' +
  "permission. Respect YouTube's Terms of Service and copyright law. Not affiliated with YouTube or Google.";

export async function main(argv: string[]): Promise<number> {
  const cli = cac('tubepull');
  let exitCode: number = EXIT.OK;

  cli
    .command('[...urls]', 'Download video or audio (interactive wizard when run without options)')
    .option('-q, --quality <quality>', 'best, worst, 2160p, 1080p, 720p60, ... (default: best)')
    .option('-a, --audio', 'Audio only')
    .option('-f, --format <format>', 'Audio format: mp3, m4a, opus, flac, wav, original (implies --audio)')
    .option('-b, --audio-bitrate <rate>', 'Bitrate when converting audio, e.g. 192k (default: 192k)')
    .option('-c, --container <container>', 'Video container: mp4, mkv, webm (default: mp4)')
    .option('-o, --output <dir>', 'Output folder (default: current folder)')
    .option('-n, --filename <template>', 'Filename template: {title} {id} {author} {height} {fps} {date} ...')
    .option('--itag-video <itag>', 'Exact video format (see --list)')
    .option('--itag-audio <itag>', 'Exact audio format (see --list)')
    .option('--start <time>', 'Trim start, e.g. 1:30 or 90')
    .option('--end <time>', 'Trim end, e.g. 2:45')
    .option('--lang <code>', 'Audio language track, e.g. en, de (multi-language videos)')
    .option('--hdr', 'Prefer HDR streams')
    .option('--strict', 'Fail instead of falling back to a lower quality')
    .option('--allow-transcode', 'Re-encode instead of switching to mkv when codecs do not fit the container')
    .option('--list', 'List available qualities and formats, then exit')
    .option('--json', 'Print video/playlist info as JSON, then exit')
    .option('--playlist', 'For links with both v= and list=, download the whole playlist')
    .option('--concurrency <n>', 'Parallel downloads for playlists/multiple links (default: 2)')
    .option('--cookies <file>', 'Override the built-in session with your own Netscape cookies.txt')
    .option('--anonymous', 'Disable the built-in session and use signed-out playback')
    .option('--proxy <url>', 'HTTP(S) proxy (default: HTTPS_PROXY / HTTP_PROXY)')
    .option('--po-token <token>', 'Proof-of-Origin token (requires --visitor-data)')
    .option('--visitor-data <data>', 'Visitor data the PO token was minted for')
    .option('--client <names>', 'InnerTube clients to try, comma-separated (advanced)')
    .option('--overwrite', 'Replace existing files')
    .option('--skip-existing', 'Skip videos whose output file already exists')
    .option('--no-embed', 'Do not embed metadata or thumbnail')
    .option('--no-thumbnail', 'Do not embed the thumbnail')
    .option('-y, --yes', 'Never prompt; use defaults for anything not given')
    .option('-v, --verbose', 'Verbose logging and full error details')
    .example('tubepull https://youtu.be/dQw4w9WgXcQ')
    .example('tubepull <url> -q 1080p -o ./downloads')
    .example('tubepull <url> -f mp3 -b 320k')
    .example('tubepull <url> --start 1:00 --end 2:30')
    .example('tubepull <playlist-url> -q 720p --concurrency 3')
    .example('tubepull <url> --list')
    .action(async (urls: string[], flags: RawFlags) => {
      exitCode = await runDownloadCommand(urls.map(String), flags);
    });

  cli
    .command('doctor', 'Check Node, ffmpeg, cache and YouTube connectivity (attach to bug reports)')
    .option('--offline', 'Skip network checks')
    .option('--cookies <file>', 'Cookies file to test with')
    .option('--anonymous', 'Test signed-out playback without the built-in session')
    .option('--proxy <url>', 'Proxy to test with')
    .action(async (flags: RawFlags & { offline?: boolean }) => {
      const { instance } = parseFlags({
        ...(flags.cookies ? { cookies: flags.cookies } : {}),
        ...(flags.anonymous ? { anonymous: true } : {}),
        ...(flags.proxy ? { proxy: flags.proxy } : {}),
      });
      exitCode = await runDoctor(pkg.version, instance, Boolean(flags.offline));
    });

  cli.help((sections) => [...sections, { title: 'Notice', body: pc.dim(DISCLAIMER) }]);
  cli.version(pkg.version, '--version');

  const updateNotice = checkForUpdate(pkg.name, pkg.version);
  try {
    cli.parse(argv, { run: false });
    if (cli.options.help || cli.options.version) return EXIT.OK;
    await cli.runMatchedCommand();
  } catch (error) {
    printError(error, Boolean(cli.options.verbose));
    return exitCodeFor(error);
  }
  const notice = await Promise.race([
    updateNotice,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 300).unref()),
  ]);
  if (notice) process.stderr.write(`\n${notice}\n`);
  return exitCode;
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    printError(error, true);
    process.exitCode = EXIT.GENERIC;
  },
);
