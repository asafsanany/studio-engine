import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LUT_LIMITS, LUT_MESSAGES } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLutFile, checkLutText, createFfmpegLutProver, prepareLutText } from './lut-check.js';
import { hasFfmpeg, IDENTITY, make3dl, makeCube, SWIRL } from './lut-test-utils.js';

const check = (name: string, text: string) => checkLutText(name, text, Buffer.byteLength(text));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-lut-check-'));
  dirs.push(dir);
  return dir;
}

describe('checkLutText: a .cube', () => {
  it('accepts a good file and answers its grid and the kind its name suggests', () => {
    expect(check('Golden Hour.cube', makeCube(5, SWIRL))).toEqual({
      ok: true,
      size: 5,
      kindGuess: 'look',
    });
    expect(check('S-Log3 to Rec709.cube', makeCube(3))).toEqual({
      ok: true,
      size: 3,
      kindGuess: 'camera',
    });
  });

  it('accepts the smallest and the largest grid', () => {
    expect(check('a.cube', makeCube(2))).toMatchObject({ ok: true, size: 2 });
    expect(check('a.cube', `LUT_3D_SIZE 129\n${'0 0 0\n'.repeat(129 ** 3)}`)).toMatchObject({
      ok: true,
      size: 129,
    });
  });

  it('allows a TITLE, comments, blank lines, CRLF line ends and a byte order mark', () => {
    const body = makeCube(4, SWIRL, { title: 'My "quoted" title', eol: '\r\n' });
    expect(check('a.cube', body)).toMatchObject({ ok: true, size: 4 });
    expect(check('a.cube', `﻿${body}`)).toMatchObject({ ok: true, size: 4 });
    expect(
      check('a.cube', `\n\n  # note\n${makeCube(2, IDENTITY, { title: null })}\n\n`),
    ).toMatchObject({
      ok: true,
    });
  });

  it('reads a file with old Mac line ends (a lone CR)', () => {
    expect(check('a.cube', makeCube(3, IDENTITY, { eol: '\r' }))).toMatchObject({ ok: true });
  });

  it('allows DOMAIN_MIN 0 0 0 and DOMAIN_MAX 1 1 1, and the same as numbers with decimals', () => {
    const header = ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1.0 1.0 1.0'];
    expect(check('a.cube', makeCube(3, IDENTITY, { header }))).toMatchObject({ ok: true });
  });

  it('refuses another DOMAIN_MIN / DOMAIN_MAX with the reason', () => {
    for (const header of [
      ['DOMAIN_MIN -0.1 -0.1 -0.1'],
      ['DOMAIN_MAX 2 2 2'],
      ['DOMAIN_MAX 1 1'],
      ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 0.5 1 1'],
    ]) {
      expect(check('a.cube', makeCube(2, IDENTITY, { header }))).toEqual({
        ok: false,
        error: LUT_MESSAGES.badDomain,
      });
    }
  });

  it('refuses a file with no LUT_3D_SIZE line', () => {
    expect(check('a.cube', 'TITLE "x"\n0 0 0\n')).toEqual({
      ok: false,
      error: LUT_MESSAGES.badRows,
    });
    expect(check('a.cube', '# nothing here\nTITLE "x"\n')).toEqual({
      ok: false,
      error: LUT_MESSAGES.noSize,
    });
    expect(check('a.cube', '')).toEqual({ ok: false, error: LUT_MESSAGES.noSize });
  });

  it('calls a LUT_1D_SIZE file "a 1D LUT"', () => {
    const oneD = 'LUT_1D_SIZE 4\n0 0 0\n0.3 0.3 0.3\n0.6 0.6 0.6\n1 1 1\n';
    expect(check('a.cube', oneD)).toEqual({ ok: false, error: LUT_MESSAGES.oneD });
    expect(check('a.cube', 'LUT_1D_SIZE 4\n')).toEqual({ ok: false, error: LUT_MESSAGES.oneD });
  });

  it('refuses a grid outside 2 to 129 or one that is not a whole number', () => {
    for (const size of ['1', '0', '130', '2.5', 'x', '-3']) {
      expect(check('a.cube', `LUT_3D_SIZE ${size}\n0 0 0\n`)).toEqual({
        ok: false,
        error: LUT_MESSAGES.badGrid,
      });
    }
    expect(check('a.cube', 'LUT_3D_SIZE\n')).toEqual({ ok: false, error: LUT_MESSAGES.badGrid });
  });

  it('refuses a file with too few or too many rows', () => {
    const rows = makeCube(3, IDENTITY).trimEnd().split('\n');
    expect(check('a.cube', `${rows.slice(0, -1).join('\n')}\n`)).toEqual({
      ok: false,
      error: LUT_MESSAGES.badRows,
    });
    expect(check('a.cube', `${rows.join('\n')}\n0 0 0\n`)).toEqual({
      ok: false,
      error: LUT_MESSAGES.badRows,
    });
  });

  it('refuses a row that is not three finite numbers', () => {
    const rows = makeCube(2, IDENTITY).trimEnd().split('\n');
    const last = rows.length - 1;
    for (const bad of [
      '0.1 NaN 0.2',
      'nan nan nan',
      '0.1 inf 0.2',
      '1e999 0 0',
      '0x10 0 0',
      '0.1 0.2',
      '0.1 0.2 0.3 0.4',
      '0.1,0.2,0.3',
      '0.1 0.2 abc',
    ]) {
      const edited = [...rows.slice(0, last), bad];
      expect(check('a.cube', `${edited.join('\n')}\n`), bad).toEqual({
        ok: false,
        error: LUT_MESSAGES.badRows,
      });
    }
  });

  it('accepts numbers written with a sign, an exponent or a bare dot', () => {
    const rows = ['LUT_3D_SIZE 2', ...Array.from({ length: 8 }, () => '+.5 -0.0 1e-3')];
    expect(check('a.cube', `${rows.join('\n')}\n`)).toMatchObject({ ok: true, size: 2 });
  });

  it('refuses a data row before the size', () => {
    expect(check('a.cube', `0 0 0\n${makeCube(2)}`)).toEqual({
      ok: false,
      error: LUT_MESSAGES.badRows,
    });
  });
});

describe('checkLutText: the file itself', () => {
  it('refuses another extension, whatever it holds', () => {
    expect(check('a.txt', makeCube(2))).toEqual({ ok: false, error: LUT_MESSAGES.badExtension });
    expect(check('a.mp4', 'xx')).toEqual({ ok: false, error: LUT_MESSAGES.badExtension });
    expect(check('cube', makeCube(2))).toEqual({ ok: false, error: LUT_MESSAGES.badExtension });
  });

  it('takes an upper-case extension', () => {
    expect(check('A.CUBE', makeCube(2))).toMatchObject({ ok: true });
  });

  it('refuses a file over 40 MB without reading it, and one that is not text', () => {
    expect(checkLutText('a.cube', makeCube(2), LUT_LIMITS.fileMaxBytes + 1)).toEqual({
      ok: false,
      error: LUT_MESSAGES.tooLarge,
    });
    expect(check('a.cube', `${makeCube(2)}\u0000\u0001`)).toEqual({
      ok: false,
      error: LUT_MESSAGES.notText,
    });
  });
});

describe('checkLutText: a .3dl', () => {
  it('converts it, then checks the result', () => {
    expect(check('a.3dl', make3dl(17, SWIRL))).toEqual({ ok: true, size: 17, kindGuess: 'look' });
    expect(check('a.3dl', make3dl(5, SWIRL, { bits: 12 }))).toMatchObject({ ok: true, size: 5 });
  });

  it('refuses a .3dl it cannot read with the .3dl sentence', () => {
    expect(check('a.3dl', 'hello\n')).toEqual({ ok: false, error: LUT_MESSAGES.bad3dl });
    expect(check('a.3dl', '0 64 128\n1 2 3\n')).toEqual({ ok: false, error: LUT_MESSAGES.bad3dl });
  });

  it('hands the .cube to keep: a .cube’s own text, a .3dl’s converted one', () => {
    const cube = makeCube(3, SWIRL);
    const kept = prepareLutText('a.cube', cube, cube.length);
    expect(kept).toMatchObject({ ok: true, cube });
    const converted = prepareLutText('a.3dl', make3dl(3, SWIRL), 10);
    expect(converted.ok && converted.cube.startsWith('LUT_3D_SIZE 3')).toBe(true);
  });
});

describe('checkLutFile', () => {
  it('reads the file and checks it', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'good.cube'), makeCube(3));
    writeFileSync(join(dir, 'bad.cube'), 'LUT_3D_SIZE 3\n');
    expect(await checkLutFile(join(dir, 'good.cube'), 'good.cube')).toMatchObject({
      ok: true,
      size: 3,
    });
    expect(await checkLutFile(join(dir, 'bad.cube'), 'bad.cube')).toEqual({
      ok: false,
      error: LUT_MESSAGES.badRows,
    });
    expect(await checkLutFile(join(dir, 'good.cube'), 'good.png')).toEqual({
      ok: false,
      error: LUT_MESSAGES.badExtension,
    });
  });
});

describe.skipIf(!hasFfmpeg())('createFfmpegLutProver (ffmpeg)', () => {
  const prove = createFfmpegLutProver('ffmpeg');

  it('passes a good file, whatever its name holds', async () => {
    const dir = tempDir();
    for (const name of ["it's a name, with: odd [chars];.cube", 'plain.cube', 'ünï cøde.cube']) {
      writeFileSync(join(dir, name), makeCube(5, SWIRL));
      expect(await prove(join(dir, name)), name).toBeNull();
    }
  });

  it('refuses a file ffmpeg cannot read with the sentence', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'broken.cube'), 'LUT_3D_SIZE 3\n0 0 0\n');
    expect(await prove(join(dir, 'broken.cube'))).toBe(LUT_MESSAGES.ffmpegRefused);
    expect(await prove(join(dir, 'missing.cube'))).toBe(LUT_MESSAGES.ffmpegRefused);
  });

  it('refuses when ffmpeg itself is not there', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.cube'), makeCube(2));
    expect(await createFfmpegLutProver(join(dir, 'no-such-ffmpeg'))(join(dir, 'a.cube'))).toBe(
      LUT_MESSAGES.ffmpegRefused,
    );
  });
});
