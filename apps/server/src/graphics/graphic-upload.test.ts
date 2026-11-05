import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRAPHIC_MESSAGES } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphicUploadError, isAttachable, receiveGraphicMessage } from './graphic-upload.js';

// The multipart body of a graphics message, streamed to a staging folder (GR1). Real temp folders.

let staging: string;

beforeEach(() => {
  staging = mkdtempSync(join(tmpdir(), 'studio-graphic-upload-'));
});

afterEach(() => {
  rmSync(staging, { recursive: true, force: true });
});

function request(fields: Record<string, string>, files: Record<string, string> = {}): Request {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  for (const [name, content] of Object.entries(files))
    body.append('files[]', new File([content], name));
  return new Request('http://localhost/api/graphics', { method: 'POST', body });
}

/**
 * The same body delivered in one piece, as a fast client on a real connection delivers a few files:
 * the parser meets the files one after the other before any of them has been written out.
 */
async function inOneChunk(source: Request): Promise<Request> {
  const bytes = new Uint8Array(await source.arrayBuffer());
  return new Request(source.url, {
    method: 'POST',
    headers: { 'content-type': source.headers.get('content-type') ?? '' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
}

/** A rejection as the error it is, or fails when the upload was taken. */
async function refused(upload: Promise<unknown>): Promise<GraphicUploadError> {
  try {
    await upload;
  } catch (error) {
    expect(error).toBeInstanceOf(GraphicUploadError);
    return error as GraphicUploadError;
  }
  throw new Error('the upload was taken');
}

describe('receiveGraphicMessage', () => {
  it('reads the fields and stages each file under a number, with its cleaned name and size', async () => {
    const received = await receiveGraphicMessage(
      request(
        { text: 'A pill', effort: ' high ' },
        { '../etc/shot.png': 'png', 'לוגו.svg': '<svg/>' },
      ),
      { stagingDir: staging },
    );

    expect(received).toMatchObject({ text: 'A pill', effort: 'high' });
    expect(received.files.map((file) => [file.name, file.size])).toEqual([
      ['shot.png', 3],
      ['לוגו.svg', 6],
    ]);
    expect(readFileSync(received.files[1]?.path as string, 'utf8')).toBe('<svg/>');
    expect(readdirSync(staging).sort()).toEqual(['0', '1']);
  });

  it('has no text or effort when the body has none, and skips a file input left empty', async () => {
    const body = new FormData();
    body.append('files[]', new File([], ''));

    const received = await receiveGraphicMessage(
      new Request('http://localhost/x', { method: 'POST', body }),
      { stagingDir: staging },
    );

    expect(received).toEqual({ text: null, effort: null, files: [] });
  });

  it('refuses a body that is not multipart with 400', async () => {
    const error = await refused(
      receiveGraphicMessage(
        new Request('http://localhost/x', { method: 'POST', body: '{"text":"x"}' }),
        { stagingDir: staging },
      ),
    );

    expect(error).toMatchObject({ status: 400, message: GRAPHIC_MESSAGES.badMessage });
  });

  it('refuses a text field beyond reading with 400', async () => {
    const error = await refused(
      receiveGraphicMessage(request({ text: 'x'.repeat(40_000) }), { stagingDir: staging }),
    );

    expect(error).toMatchObject({ status: 400, message: GRAPHIC_MESSAGES.textTooLong });
  });

  it('refuses a file of the wrong kind with 415', async () => {
    const error = await refused(
      receiveGraphicMessage(request({ text: 'x' }, { 'macro.exe': 'x' }), { stagingDir: staging }),
    );

    expect(error).toMatchObject({ status: 415, message: GRAPHIC_MESSAGES.badUploadType });
  });

  // Files big enough to arrive before the earlier ones have been written: the upload must still
  // end (it once waited for the writes of streams it had destroyed), and leave nothing running.
  it('ends a refusal with large files in flight: too many files, 413', async () => {
    const big = 'x'.repeat(30_000);
    const files = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`f${n}.png`, big]));

    const error = await Promise.race([
      refused(
        inOneChunk(request({ text: 'x' }, files)).then((one) =>
          receiveGraphicMessage(one, { stagingDir: staging }),
        ),
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('it hung')), 4_000)),
    ]);

    expect(error).toMatchObject({ status: 413, message: GRAPHIC_MESSAGES.tooManyFiles });
  });

  it('ends a refusal with large files in flight: over the limit together, 413', async () => {
    const big = 'x'.repeat(30_000);
    const files = Object.fromEntries([1, 2, 3, 4].map((n) => [`f${n}.mov`, big]));

    const error = await Promise.race([
      refused(
        inOneChunk(request({ text: 'x' }, files)).then((one) =>
          receiveGraphicMessage(one, { stagingDir: staging, maxBytes: 70_000 }),
        ),
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('it hung')), 4_000)),
    ]);

    expect(error).toMatchObject({ status: 413, message: GRAPHIC_MESSAGES.tooLarge });
  });

  it('takes the limit’s worth of files exactly', async () => {
    const received = await receiveGraphicMessage(
      request({ text: 'x' }, { 'a.png': 'a', 'b.png': 'b' }),
      { stagingDir: staging, maxFiles: 2, maxBytes: 2 },
    );

    expect(received.files).toHaveLength(2);
    expect(existsSync(join(staging, '1'))).toBe(true);
  });
});

describe('isAttachable', () => {
  it('takes images, videos, fonts and PDFs by their extension, in any case', () => {
    for (const name of [
      'a.png',
      'A.JPG',
      'a.webp',
      'a.svg',
      'a.mp4',
      'a.MOV',
      'a.ttf',
      'a.woff2',
      'a.pdf',
    ]) {
      expect(isAttachable(name, 'application/octet-stream'), name).toBe(true);
    }
  });

  it('takes a file by the type the browser gave it when its name says nothing', () => {
    expect(isAttachable('shot', 'image/png')).toBe(true);
    expect(isAttachable('clip', 'video/quicktime')).toBe(true);
    expect(isAttachable('face', 'font/ttf')).toBe(true);
    expect(isAttachable('doc', 'application/pdf')).toBe(true);
  });

  it('refuses the rest', () => {
    for (const [name, type] of [
      ['a.exe', 'application/x-msdownload'],
      ['a.zip', 'application/zip'],
      ['a.txt', 'text/plain'],
      ['a.html', 'text/html'],
      ['a', 'application/octet-stream'],
    ] as const) {
      expect(isAttachable(name, type), name).toBe(false);
    }
  });
});
