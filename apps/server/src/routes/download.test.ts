import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition, decideRange, encodeRFC5987, resolveInside } from './download.js';

describe('decideRange', () => {
  const size = 1000;
  const partial = (start: number, end: number) => ({ kind: 'partial', range: { start, end } });

  it('sends the whole file when there is no Range header', () => {
    expect(decideRange(undefined, size)).toEqual({ kind: 'full' });
    expect(decideRange(null, size)).toEqual({ kind: 'full' });
  });

  it('reads first-last, first- and -suffix', () => {
    expect(decideRange('bytes=0-99', size)).toEqual(partial(0, 99));
    expect(decideRange('bytes=500-', size)).toEqual(partial(500, 999));
    expect(decideRange('bytes=-100', size)).toEqual(partial(900, 999));
    expect(decideRange('bytes=999-999', size)).toEqual(partial(999, 999));
  });

  it('cuts a last byte past the end back to the end of the file', () => {
    expect(decideRange('bytes=990-5000', size)).toEqual(partial(990, 999));
    expect(decideRange('bytes=0-99999999999999999999', size)).toEqual(partial(0, 999));
  });

  it('gives the whole file for a suffix longer than the file', () => {
    expect(decideRange('bytes=-5000', size)).toEqual(partial(0, 999));
  });

  it('tolerates case and spaces', () => {
    expect(decideRange('  Bytes = 10-19 ', size)).toEqual(partial(10, 19));
  });

  it('is unsatisfiable when it starts at or past the end', () => {
    expect(decideRange('bytes=1000-', size)).toEqual({ kind: 'unsatisfiable' });
    expect(decideRange('bytes=2000-3000', size)).toEqual({ kind: 'unsatisfiable' });
  });

  it('is unsatisfiable when it is backwards, empty or not a range', () => {
    for (const header of [
      'bytes=5-2',
      'bytes=-0',
      'bytes=-',
      'bytes=',
      'bytes=abc',
      'bytes=1-2-3',
    ]) {
      expect(decideRange(header, size), header).toEqual({ kind: 'unsatisfiable' });
    }
  });

  it('is unsatisfiable for any range of an empty file', () => {
    expect(decideRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(decideRange('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a unit it does not know and several ranges at once', () => {
    expect(decideRange('items=0-5', size)).toEqual({ kind: 'full' });
    expect(decideRange('bytes=0-5,10-15', size)).toEqual({ kind: 'full' });
  });
});

describe('encodeRFC5987', () => {
  it('encodes Hebrew as UTF-8 percent escapes', () => {
    expect(encodeRFC5987('תפריט אביב.mp4')).toBe(
      '%D7%AA%D7%A4%D7%A8%D7%99%D7%98%20%D7%90%D7%91%D7%99%D7%91.mp4',
    );
  });

  it("also escapes the characters encodeURIComponent leaves: ' ( ) *", () => {
    expect(encodeRFC5987("It's (a) *test*.mp4")).toBe('It%27s%20%28a%29%20%2Atest%2A.mp4');
  });

  it('does not throw on a lone surrogate', () => {
    expect(encodeRFC5987('a\ud800b')).toBe('a%EF%BF%BDb');
  });
});

describe('contentDisposition', () => {
  const decode = (header: string): string => {
    const match = /filename\*=UTF-8''([^;]+)/.exec(header);
    return decodeURIComponent(match?.[1] ?? '');
  };

  it('carries a plain name twice, once for each kind of client', () => {
    expect(contentDisposition('Spring menu.mp4')).toBe(
      `attachment; filename="Spring menu.mp4"; filename*=UTF-8''Spring%20menu.mp4`,
    );
  });

  it('keeps Hebrew intact in filename* and falls back to export.mp4 in filename', () => {
    const header = contentDisposition('תפריט אביב.mp4');

    expect(header).toBe(
      `attachment; filename="export.mp4"; filename*=UTF-8''%D7%AA%D7%A4%D7%A8%D7%99%D7%98%20%D7%90%D7%91%D7%99%D7%91.mp4`,
    );
    expect(decode(header)).toBe('תפריט אביב.mp4');
  });

  it('keeps the readable part of a mixed name in the fallback', () => {
    const header = contentDisposition('Café ☕ menu.mp4');

    expect(header).toContain('filename="Caf_ _ menu.mp4"');
    expect(decode(header)).toBe('Café ☕ menu.mp4');
  });

  it('never lets quotes, slashes or control characters break out of the header', () => {
    const header = contentDisposition('He said "hi"\r\n/../x\\y.mp4');

    expect(header).toBe(
      `attachment; filename="He said _hi____.._x_y.mp4"; filename*=UTF-8''He%20said%20%22hi%22___.._x_y.mp4`,
    );
    expect(header).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('resolveInside', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'studio-resolve-'));
    root = join(base, 'exports');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'Client'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'Client', 'Job.mp4'), 'x');
    writeFileSync(join(outside, 'secret.mp4'), 'x');
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(join(root, 'Client'), join(root, 'alias'));
  });

  afterAll(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('finds a file inside the folder', async () => {
    const path = await resolveInside(root, 'Client/Job.mp4');

    expect(path).toMatch(/Client\/Job\.mp4$/);
  });

  it('follows a symlink that stays inside', async () => {
    expect(await resolveInside(root, 'alias/Job.mp4')).not.toBeNull();
  });

  it('refuses .. , absolute names, symlinks that leave and the folder itself', async () => {
    expect(await resolveInside(root, '../outside/secret.mp4')).toBeNull();
    expect(await resolveInside(root, 'Client/../../outside/secret.mp4')).toBeNull();
    expect(await resolveInside(root, join(outside, 'secret.mp4'))).toBeNull();
    expect(await resolveInside(root, 'escape/secret.mp4')).toBeNull();
    expect(await resolveInside(root, '.')).toBeNull();
    expect(await resolveInside(root, '')).toBeNull();
  });

  it('answers null for a file that is not there or a name the file system refuses', async () => {
    expect(await resolveInside(root, 'Client/missing.mp4')).toBeNull();
    expect(await resolveInside(root, 'Client/Job\0.mp4')).toBeNull();
  });
});
