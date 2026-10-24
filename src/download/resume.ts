import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { NetworkError } from '../errors.js';
import { fileSize, moveFile } from '../utils/fs.js';
import { fetchMediaChunks, type ChunkStreamOptions } from './chunked.js';

//---- Section used for resumable file downloads ----

export interface FileDownloadOptions extends Omit<ChunkStreamOptions, 'start' | 'onTotal'> {
  /** Final path. Bytes go to `<file>.part` and are renamed on completion. */
  file: string;
  /**
   * Identity of the remote content (e.g. video id + itag + last-modified + size). A leftover `.part`
   * is only resumed when it was written for the same identity.
   */
  identity?: string;
  onProgress?: (bytes: number, total: number | undefined) => void;
}

export interface FileDownloadResult {
  path: string;
  bytes: number;
}

/**
 * This function is used for downloading a media source to a file with resume: an existing `.part`
 * for the same content continues from its last byte, and in-process retries never re-download
 * bytes already written.
 */
export async function downloadToFile(options: FileDownloadOptions): Promise<FileDownloadResult> {
  const { file, identity, onProgress, ...chunkOptions } = options;
  const part = `${file}.part`;
  const sidecar = `${file}.part.json`;
  const declaredTotal = chunkOptions.source.contentLength;

  let offset = await fileSize(part);
  if (offset > 0) {
    const previous = await readFile(sidecar, 'utf8').then(
      (text) => (JSON.parse(text) as { identity?: string }).identity,
      () => undefined,
    );
    const sameContent = identity !== undefined && previous === identity;
    if (!sameContent || (declaredTotal !== undefined && offset > declaredTotal)) {
      await rm(part, { force: true });
      offset = 0;
    }
  }
  if (identity !== undefined) await writeFile(sidecar, JSON.stringify({ identity }), 'utf8');

  let total = declaredTotal;
  onProgress?.(offset, total);

  if (total === undefined || offset < total) {
    const handle = await open(part, 'a');
    try {
      for await (const piece of fetchMediaChunks({
        ...chunkOptions,
        start: offset,
        onTotal: (t) => {
          total = t;
        },
      })) {
        await handle.write(piece);
        offset += piece.byteLength;
        onProgress?.(offset, total);
      }
    } finally {
      await handle.close();
    }
  }

  const written = await fileSize(part);
  if (total !== undefined && written !== total) {
    throw new NetworkError(`Downloaded size ${written} does not match expected ${total} bytes`, {
      details: { written, expected: total },
    });
  }
  await moveFile(part, file, true);
  await rm(sidecar, { force: true });
  return { path: file, bytes: written };
}
