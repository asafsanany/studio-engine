// Downloads the file of a DM item (a reel's video, a photo, a sound) from Instagram's CDN. The
// links are signed, so nothing else is sent with them (never the key). The file is written beside
// its final name and moved over it once it is whole.

import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DmFile } from '@studio/shared';
import type { FetchLike } from './graph.js';

/** The biggest file kept. */
export const DM_FILE_MAX_BYTES = 500 * 1024 * 1024;

/** How long one download may take. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** The type of a file whose server said only `application/octet-stream`, by its first bytes. */
export function sniffType(head: Buffer): string | null {
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    return brand.startsWith('M4A')
      ? 'audio/mp4'
      : brand === 'qt  '
        ? 'video/quicktime'
        : 'video/mp4';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === '\x89PNG') return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF') {
    const kind = head.subarray(8, 12).toString('latin1');
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
  }
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return null;
}

async function headOf(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Downloads `url` into `dir` as `<baseName>.<extension of its type>`. Throws an Error with a plain
 * line when the server refuses, answers with a page instead of a file, or the file is too big.
 */
export async function downloadDmFile(
  url: string,
  dir: string,
  baseName: string,
  fetchImpl: FetchLike,
): Promise<DmFile> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Couldn't download it: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok || response.body === null) {
    throw new Error(`Instagram's file server answered ${response.status}.`);
  }
  let type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('text/') || type.includes('json')) {
    throw new Error('Instagram sent a page instead of the file.');
  }
  if (Number(response.headers.get('content-length') ?? 0) > DM_FILE_MAX_BYTES) {
    throw new Error('The file is over 500 MB.');
  }

  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${baseName}.part`);
  let written = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      written += chunk.length;
      if (written > DM_FILE_MAX_BYTES) done(new Error('The file is over 500 MB.'));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      limit,
      createWriteStream(temp),
    );
    const { size } = await stat(temp);
    if (size === 0) throw new Error('Instagram sent an empty file.');
    if (EXTENSIONS[type] === undefined) type = sniffType(await headOf(temp)) ?? type;
    const name = `${baseName}.${EXTENSIONS[type] ?? 'bin'}`;
    await rename(temp, join(dir, name));
    return { name, contentType: type === '' ? 'application/octet-stream' : type, bytes: size };
  } catch (err) {
    await rm(temp, { force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}
