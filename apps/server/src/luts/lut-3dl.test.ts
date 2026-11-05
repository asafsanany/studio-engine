import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LUT_MESSAGES } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { convert3dlToCube } from './lut-3dl.js';
import { checkLutText } from './lut-check.js';
import { cubeRows, hasFfmpeg, make3dl, makeCube, SWIRL, TINT } from './lut-test-utils.js';

function convert(text: string): string {
  const result = convert3dlToCube(text);
  if (!result.ok) throw new Error(result.error);
  return result.cube;
}

describe('convert3dlToCube', () => {
  it('writes a .cube with the grid, the full range and 0..1 values', () => {
    const cube = convert(make3dl(3, TINT));
    expect(cube).toContain('LUT_3D_SIZE 3');
    expect(cube).toContain('DOMAIN_MIN 0 0 0');
    expect(cube).toContain('DOMAIN_MAX 1 1 1');
    expect(cubeRows(cube)).toHaveLength(27);
    expect(checkLutText('a.cube', cube, cube.length)).toMatchObject({ ok: true, size: 3 });
  });

  it('puts red fastest, from a file that has red slowest (the Autodesk order)', () => {
    // 3 points; TINT: out = (1 - b, r, g²). Red is the file's slowest channel.
    const rows = cubeRows(convert(make3dl(3, TINT, { slowest: 'red' })));
    const expected = cubeRows(makeCube(3, TINT));
    expect(rows).toHaveLength(27);
    rows.forEach((row, i) => {
      row.forEach((value, c) => {
        expect(value).toBeCloseTo(expected[i]?.[c] ?? Number.NaN, 2);
      });
    });
  });

  it('puts red fastest, from a file that has blue slowest too', () => {
    const rows = cubeRows(convert(make3dl(3, TINT, { slowest: 'blue' })));
    const expected = cubeRows(makeCube(3, TINT));
    rows.forEach((row, i) => {
      row.forEach((value, c) => {
        expect(value).toBeCloseTo(expected[i]?.[c] ?? Number.NaN, 2);
      });
    });
  });

  it('gives the same .cube whichever order the file had, on a 17-point LUT', () => {
    const a = cubeRows(convert(make3dl(17, TINT, { slowest: 'red' })));
    const b = cubeRows(convert(make3dl(17, TINT, { slowest: 'blue' })));
    expect(a).toEqual(b);
  });

  it('takes the Autodesk order (red slowest) when the colours do not say which it is', () => {
    // SWIRL feeds no output channel from its own input, so nothing in the file tells the orders apart.
    const rows = cubeRows(convert(make3dl(3, SWIRL, { slowest: 'red' })));
    const expected = cubeRows(makeCube(3, SWIRL));
    rows.forEach((row, i) => {
      row.forEach((value, c) => {
        expect(value).toBeCloseTo(expected[i]?.[c] ?? Number.NaN, 2);
      });
    });
  });

  it('scales 10-bit values by 1023 and 12-bit values by 4095', () => {
    const ten = cubeRows(convert(make3dl(2, () => [1, 0.5, 0], { bits: 10 })));
    expect(ten[0]?.[0]).toBe(1);
    expect(ten[0]?.[1]).toBeCloseTo(512 / 1023, 5);
    const twelve = cubeRows(convert(make3dl(2, () => [1, 0.5, 0], { bits: 12 })));
    expect(twelve[0]?.[0]).toBe(1);
    expect(twelve[0]?.[1]).toBeCloseTo(2048 / 4095, 5);
    const sixteen = cubeRows(convert(make3dl(2, () => [1, 0.25, 0], { bits: 16 })));
    expect(sixteen[0]?.[1]).toBeCloseTo(16384 / 65535, 5);
  });

  it('keeps a 10-bit file whose largest value is under 1023 at the 10-bit scale', () => {
    const cube = convert(
      '0 1023\n0 0 0\n0 0 500\n0 500 0\n0 500 500\n500 0 0\n500 0 500\n500 500 0\n500 500 500\n',
    );
    const max = Math.max(...cubeRows(cube).flat());
    expect(max).toBeCloseTo(500 / 1023, 5);
  });

  it('reads a Mesh header for the output depth, and skips header words and comments', () => {
    const text = `# made by a test\n3DMESH\nMesh 1 12\nLUT8\ngamma 1.0\n${make3dl(2, () => [1, 0.5, 0], { bits: 12 })}`;
    const rows = cubeRows(convert(text));
    expect(rows[0]?.[0]).toBe(1);
    expect(rows[0]?.[1]).toBeCloseTo(2048 / 4095, 5);
  });

  it('takes a file with no grid line: the grid is the cube root of the rows', () => {
    const cube = convert(make3dl(4, TINT, { grid: false }));
    expect(cube).toContain('LUT_3D_SIZE 4');
    expect(cubeRows(cube)).toHaveLength(64);
  });

  it('takes CRLF line ends and tabs', () => {
    const text = make3dl(3, TINT).replace(/ /g, '\t').replace(/\n/g, '\r\n');
    expect(convert(text)).toContain('LUT_3D_SIZE 3');
  });

  it('refuses what is not a .3dl, with the .3dl sentence', () => {
    const bad = { ok: false, error: LUT_MESSAGES.bad3dl };
    expect(convert3dlToCube('')).toEqual(bad);
    expect(convert3dlToCube('# only a comment\n')).toEqual(bad);
    expect(convert3dlToCube('Mesh 4 12\n')).toEqual(bad);
    // too few rows, too many rows
    const text = make3dl(3, TINT);
    expect(convert3dlToCube(text.split('\n').slice(0, -3).join('\n'))).toEqual(bad);
    expect(convert3dlToCube(`${text}1 2 3\n`)).toEqual(bad);
    // rows that are not three integers
    expect(convert3dlToCube(text.replace(/\n(\d+) /, '\n0.5 '))).toEqual(bad);
    expect(convert3dlToCube(text.replace(/\n(\d+) (\d+) (\d+)\n$/, '\n$1 $2\n'))).toEqual(bad);
    // a grid of one point
    expect(convert3dlToCube('0\n1 2 3\n')).toEqual(bad);
    // a negative value, a value above 16 bit
    expect(convert3dlToCube(text.replace(/\n(\d+) /, '\n-5 '))).toEqual(bad);
    expect(convert3dlToCube(make3dl(2, () => [1, 1, 1], { bits: 17 }))).toEqual(bad);
  });
});

describe.skipIf(!hasFfmpeg())('convert3dlToCube against ffmpeg', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The picture ffmpeg makes with the converted .cube must be the picture it makes with the .cube
  // the LUT was written from, to the rounding of 10-bit values. (ffmpeg's own .3dl reader is no
  // reference: it takes only 17 points and scales the values its own way.)
  it.each(['red', 'blue'] as const)(
    'makes the original picture from a file with %s slowest',
    (slowest) => {
      dir = mkdtempSync(join(tmpdir(), 'studio-lut-3dl-'));
      const raw = (args: string[]): Buffer =>
        execFileSync(
          'ffmpeg',
          ['-v', 'error', ...args, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
          {
            cwd: dir,
            maxBuffer: 1 << 24,
          },
        );
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=96x96:d=1:r=1',
        '-frames:v',
        '1',
        join(dir, 'source.png'),
      ]);
      writeFileSync(join(dir, 'truth.cube'), makeCube(17, TINT));
      writeFileSync(join(dir, 'converted.cube'), convert(make3dl(17, TINT, { slowest })));
      const through = (file: string): Buffer =>
        raw(['-i', 'source.png', '-vf', `lut3d=file=${file}:interp=tetrahedral`]);
      const truth = through('truth.cube');
      const converted = through('converted.cube');
      expect(converted).toHaveLength(truth.length);
      let worst = 0;
      for (let i = 0; i < truth.length; i += 1) {
        worst = Math.max(worst, Math.abs((converted[i] ?? 0) - (truth[i] ?? 0)));
      }
      expect(worst).toBeLessThanOrEqual(1);
      // the LUT does change the picture, so this is not two untouched copies
      expect(Buffer.compare(raw(['-i', 'source.png']), truth)).not.toBe(0);
    },
  );
});
