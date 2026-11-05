import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanFileName,
  freeStyleName,
  moveIntoStyle,
  numberedName,
  receiveUpload,
  StyleUploadError,
} from './style-upload.js';

let root: string;
let styleDir: string;
let stagingDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-style-upload-'));
  styleDir = join(root, '_Style');
  stagingDir = join(styleDir, '.upload-test');
  mkdirSync(stagingDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function form(files: Record<string, string>, mode?: string): Request {
  const body = new FormData();
  for (const [name, content] of Object.entries(files))
    body.append('files[]', new File([content], name));
  if (mode !== undefined) body.append('mode', mode);
  return new Request('http://localhost/upload', { method: 'POST', body });
}

describe('cleanFileName', () => {
  it('keeps an ordinary name as it is, in NFC', () => {
    expect(cleanFileName('Brand book.pdf')).toBe('Brand book.pdf');
    expect(cleanFileName('Cafe\u0301 logo.png')).toBe('Café logo.png');
  });

  it('drops folders, control characters and leading dots', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\me\\logo.png')).toBe('logo.png');
    expect(cleanFileName('a\nb.txt')).toBe('a b.txt');
    expect(cleanFileName('.hidden.txt')).toBe('hidden.txt');
    expect(cleanFileName('...')).toBe('file');
    expect(cleanFileName('')).toBe('file');
  });

  it('shortens a very long name, keeping its extension', () => {
    const name = cleanFileName(`${'é'.repeat(300)}.png`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith('é.png')).toBe(true);
  });
});

describe('a taken name', () => {
  it('gets " (1)" before its extension, then " (2)"', async () => {
    expect(numberedName('logo.png', 1)).toBe('logo (1).png');
    expect(numberedName('README', 2)).toBe('README (2)');
    expect(numberedName('archive.tar.gz', 1)).toBe('archive.tar (1).gz');

    expect(await freeStyleName(styleDir, 'logo.png')).toBe('logo.png');
    writeFileSync(join(styleDir, 'logo.png'), '');
    expect(await freeStyleName(styleDir, 'logo.png')).toBe('logo (1).png');
    writeFileSync(join(styleDir, 'logo (1).png'), '');
    expect(await freeStyleName(styleDir, 'logo.png')).toBe('logo (2).png');
  });

  it("is never one of the engine's own: style.md, style.md.new, kit", async () => {
    expect(await freeStyleName(styleDir, 'style.md')).toBe('style (1).md');
    expect(await freeStyleName(styleDir, 'Style.MD')).toBe('Style (1).MD');
    expect(await freeStyleName(styleDir, 'style.md.new')).toBe('style.md (1).new');
    expect(await freeStyleName(styleDir, 'kit')).toBe('kit (1)');
  });

  it('moves the staged files in under free names, telling who asked', async () => {
    writeFileSync(join(styleDir, 'logo.png'), 'old');
    writeFileSync(join(stagingDir, '0'), 'new logo');
    writeFileSync(join(stagingDir, '1'), 'second logo');
    const told: [string, number][] = [];

    const moved = await moveIntoStyle(
      [
        { name: 'logo.png', path: join(stagingDir, '0'), size: 8 },
        { name: 'logo.png', path: join(stagingDir, '1'), size: 11 },
      ],
      styleDir,
      (name, stat) => told.push([name, stat.size]),
    );

    expect(moved).toEqual([
      { name: 'logo (1).png', size: 8 },
      { name: 'logo (2).png', size: 11 },
    ]);
    expect(told).toEqual([
      ['logo (1).png', 8],
      ['logo (2).png', 11],
    ]);
    expect(readFileSync(join(styleDir, 'logo.png'), 'utf8')).toBe('old');
    expect(readFileSync(join(styleDir, 'logo (2).png'), 'utf8')).toBe('second logo');
    expect(readdirSync(stagingDir)).toEqual([]);
  });
});

describe('receiveUpload', () => {
  it('streams every file to the staging folder and reads the mode', async () => {
    const upload = await receiveUpload(
      form({ 'logo.png': 'png!', 'Café notes.txt': 'notes' }, 'replace'),
      {
        stagingDir,
        maxBytes: 1_000,
      },
    );
    expect(upload).toEqual({
      mode: 'replace',
      files: [
        { name: 'logo.png', path: join(stagingDir, '0'), size: 4 },
        { name: 'Café notes.txt', path: join(stagingDir, '1'), size: 5 },
      ],
    });
    expect(readFileSync(join(stagingDir, '1'), 'utf8')).toBe('notes');
  });

  it('stops at the limit with 413, every write finished', async () => {
    const big = 'x'.repeat(600);
    const failure = await receiveUpload(form({ 'a.bin': big, 'b.bin': big }), {
      stagingDir,
      maxBytes: 1_000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StyleUploadError);
    expect(failure).toMatchObject({ status: 413 });
  });

  it('refuses a body that is not multipart with 400', async () => {
    const request = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await expect(receiveUpload(request, { stagingDir, maxBytes: 1_000 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses a broken multipart body with 400', async () => {
    const request = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
      body: '--xyz\r\nContent-Disposition: form-data; name="files[]"; filename="a.txt"\r\n\r\nno end',
    });
    await expect(receiveUpload(request, { stagingDir, maxBytes: 1_000 })).rejects.toMatchObject({
      status: 400,
    });
  });
});
