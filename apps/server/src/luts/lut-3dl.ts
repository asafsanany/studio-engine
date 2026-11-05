// Turns a .3dl LUT into a .cube (LUTs plan, "Import": "a .3dl is converted to .cube on import, the
// wrapper only reads .cube"). OWNER: LU1.
//
// What a .3dl is (Autodesk Lustre / Flame, also DaVinci Resolve and Pomfort):
//   - optional header lines that start with a letter ("3DMESH", "Mesh 4 12", "LUT8", "gamma 1.0")
//     and `#` comments;
//   - the grid line: the input steps, `0 64 128 … 1023`; its length is the grid points per side;
//   - N³ rows of three integers (the output red, green, blue), 10 bit (0–1023), 12 bit (0–4095) or
//     16 bit (0–65535). A `Mesh <input bits> <output bits>` line names the output depth; without it
//     the depth is the smallest of those three that holds the largest value.
//   - The rows run red slowest and blue fastest in the Autodesk files, and blue slowest in some
//     other tools' files; a .cube wants red fastest. Which order a file has is not written in it,
//     so it is read from the colours: in almost every LUT the output red grows with the input red
//     and the output blue with the input blue, so the order under which that holds better wins
//     (red slowest on a tie, the Autodesk order).
//   - A file with no grid line (the rows start at once) is also accepted: the grid is the cube
//     root of the row count.
//
// The result is a .cube with LUT_3D_SIZE and N³ rows of 0..1 floats (red fastest) that
// lut-check.ts then checks like any other.

import { LUT_LIMITS, LUT_MESSAGES } from '@studio/shared';

/** The converted file, or the plain sentence for a .3dl that cannot be read (LUT_MESSAGES.bad3dl). */
export type Lut3dlConversion = { ok: true; cube: string } | { ok: false; error: string };

const FAIL: Lut3dlConversion = { ok: false, error: LUT_MESSAGES.bad3dl };

const INTEGER = /^[+-]?\d+$/;

/** The depths a .3dl is written in, smallest first. */
const DEPTH_MAXES = [1023, 4095, 65535] as const;

/** The 3 integers of a row, or `null` for a line that is not one. */
function parseRow(tokens: string[]): [number, number, number] | null {
  if (tokens.length !== 3) return null;
  const [r, g, b] = tokens;
  if (r === undefined || g === undefined || b === undefined) return null;
  if (!INTEGER.test(r) || !INTEGER.test(g) || !INTEGER.test(b)) return null;
  return [Number(r), Number(g), Number(b)];
}

/**
 * How well the rows fit "red slowest" or "blue slowest": the sum, over every row, of how far its
 * input red and its input blue are from the middle times how far the output red and the output
 * blue are. Higher is a better fit.
 */
function fit(
  rows: readonly (readonly [number, number, number])[],
  n: number,
  redSlowest: boolean,
  max: number,
): number {
  const mid = (n - 1) / 2;
  let total = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const slow = Math.floor(i / (n * n));
    const fast = i % n;
    const inR = redSlowest ? slow : fast;
    const inB = redSlowest ? fast : slow;
    total += (inR - mid) * (row[0] / max - 0.5) + (inB - mid) * (row[2] / max - 0.5);
  }
  return total;
}

/** Converts the text of a .3dl file into the text of a .cube file. */
export function convert3dlToCube(text: string): Lut3dlConversion {
  let outputBits: number | null = null;
  const numeric: string[][] = [];

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const first = tokens[0] ?? '';
    // A header line: its first word is not a number ("3DMESH" starts with a digit, "Mesh" does not).
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(first)) {
      if (first.toLowerCase() === 'mesh' && tokens.length >= 3) {
        const bits = Number(tokens[2]);
        if (Number.isInteger(bits) && bits >= 8 && bits <= 16) outputBits = bits;
      }
      continue; // 3DMESH, LUT8, gamma … : header lines that do not change the colours
    }
    numeric.push(tokens);
  }
  if (numeric.length === 0) return FAIL;

  // The grid line, if there is one.
  const head = numeric[0] ?? [];
  const rowsStart = (() => {
    if (head.length !== 3) return 1;
    // Three numbers are a row, unless a grid of 3 points leaves exactly 27 rows after it.
    return numeric.length === 28 ? 1 : 0;
  })();
  const gridPoints = rowsStart === 1 ? head : null;
  if (gridPoints !== null && !gridPoints.every((token) => INTEGER.test(token))) return FAIL;

  const dataLines = numeric.slice(rowsStart);
  const n =
    gridPoints === null ? Math.round(Math.cbrt(dataLines.length)) : (gridPoints as string[]).length;
  if (!Number.isInteger(n) || n < LUT_LIMITS.gridMin || n > LUT_LIMITS.gridMax) return FAIL;
  if (dataLines.length !== n * n * n) return FAIL;

  const rows: [number, number, number][] = [];
  let largest = 0;
  for (const tokens of dataLines) {
    const row = parseRow(tokens);
    if (row === null || row.some((value) => value < 0)) return FAIL;
    largest = Math.max(largest, row[0], row[1], row[2]);
    rows.push(row);
  }

  const max =
    outputBits !== null
      ? 2 ** outputBits - 1
      : (DEPTH_MAXES.find((depth) => largest <= depth) ?? Number.NaN);
  if (!Number.isFinite(max) || largest > max) return FAIL;

  const redSlowest = fit(rows, n, true, max) >= fit(rows, n, false, max);

  const out: string[] = [`LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  const value = (v: number): string => (v / max).toFixed(6);
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const index = redSlowest ? (r * n + g) * n + b : (b * n + g) * n + r;
        const row = rows[index];
        if (row === undefined) return FAIL;
        out.push(`${value(row[0])} ${value(row[1])} ${value(row[2])}`);
      }
    }
  }
  return { ok: true, cube: `${out.join('\n')}\n` };
}
