// Test helpers for the LUT tests: small LUT files made in memory (import: LU1), and a stand-in
// colour-grade skill folder with preview helpers (previews and built-ins: LU2). Not imported by the
// engine.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_LUTS } from '@studio/shared';

/** What a LUT does to one colour: input and output are 0..1. */
export type LutFn = (r: number, g: number, b: number) => [number, number, number];

/** The colour as it is: out = in. */
export const IDENTITY: LutFn = (r, g, b) => [r, g, b];

/** A LUT that treats the three channels differently, so a wrong row order cannot hide. */
export const SWIRL: LutFn = (r, g, b) => [1 - b, r, g * g];

/** Like most real LUTs, each output channel follows its own input, so a row order can be read from it. */
export const TINT: LutFn = (r, g, b) => [r * 0.9 + 0.05, g ** 0.8, b * 0.7 + r * 0.2];

/** The text of a .cube of `n` points per side, red varying fastest (the .cube order). */
export function makeCube(
  n: number,
  fn: LutFn = IDENTITY,
  options: { title?: string | null; eol?: string; header?: string[] } = {},
): string {
  const eol = options.eol ?? '\n';
  const lines: string[] = [];
  if (options.title !== null) lines.push(`TITLE "${options.title ?? 'Test LUT'}"`);
  lines.push('# made by a test');
  lines.push(...(options.header ?? []));
  lines.push(`LUT_3D_SIZE ${n}`);
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const [x, y, z] = fn(r / (n - 1), g / (n - 1), b / (n - 1));
        lines.push(`${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`);
      }
    }
  }
  return `${lines.join(eol)}${eol}`;
}

/**
 * The text of a .3dl of `n` points per side with `bits`-bit values. `slowest` is the channel that
 * varies slowest: Autodesk's files have red slowest (blue fastest).
 */
export function make3dl(
  n: number,
  fn: LutFn,
  options: { bits?: number; slowest?: 'red' | 'blue'; head?: string[]; grid?: boolean } = {},
): string {
  const bits = options.bits ?? 10;
  const max = 2 ** bits - 1;
  const lines: string[] = [...(options.head ?? [])];
  if (options.grid !== false) {
    lines.push(Array.from({ length: n }, (_, i) => Math.round((i * 1023) / (n - 1))).join(' '));
  }
  const row = (r: number, g: number, b: number): string => {
    const [x, y, z] = fn(r / (n - 1), g / (n - 1), b / (n - 1));
    return [x, y, z].map((v) => Math.round(v * max)).join(' ');
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      for (let k = 0; k < n; k += 1) {
        lines.push(options.slowest === 'blue' ? row(k, j, i) : row(i, j, k));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The numbers of a .cube's data lines, in file order (for asserting what a conversion wrote). */
export function cubeRows(text: string): [number, number, number][] {
  return text
    .split(/\r?\n/)
    .filter((line) => /^[-+.\d]/.test(line))
    .map((line) => line.split(/\s+/).map(Number) as [number, number, number]);
}

let ffmpegFound: boolean | undefined;

/** Whether `ffmpeg` runs here (the tests that use it are skipped where it does not). */
export function hasFfmpeg(): boolean {
  if (ffmpegFound === undefined) {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      ffmpegFound = true;
    } catch {
      ffmpegFound = false;
    }
  }
  return ffmpegFound;
}

/** A .cube whose row for (r, g, b) in 0..1 is `fn(r, g, b)`, red varying fastest. */
export function cubeText(
  size: number,
  fn: (r: number, g: number, b: number) => [number, number, number],
): string {
  const lines = ['TITLE "test"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const out = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        lines.push(out.map((value) => value.toFixed(6)).join(' '));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export const identity = (r: number, g: number, b: number): [number, number, number] => [r, g, b];
export const invert = (r: number, g: number, b: number): [number, number, number] => [
  1 - r,
  1 - g,
  1 - b,
];

/**
 * A stand-in colour-grade skill in `dir`: every file the 19 built-in rows name (each a 17-point cube
 * that scales the colours a little differently), and film_contrast_80 and golden_warm, which the
 * cinematic look reads. Returns `dir`.
 */
export function writeFakeSkill(dir: string, skip: readonly string[] = []): string {
  const luts = join(dir, 'correction_luts');
  mkdirSync(luts, { recursive: true });
  const files = new Set([
    'film_contrast_80.cube',
    'golden_warm.cube',
    ...BUILTIN_LUTS.flatMap((row) => row.files),
  ]);
  let n = 0;
  for (const file of files) {
    n += 1;
    if (skip.includes(file)) continue;
    const scale = 0.7 + (n % 7) * 0.05;
    writeFileSync(
      join(luts, file),
      cubeText(17, (r, g, b) => [Math.min(1, r * scale), g, Math.min(1, b * (2 - scale))]),
    );
  }
  return dir;
}

/** Whether `command --version` runs: tests that need it skip with a reason when it does not. */
export function hasCommand(command: string, versionFlag = '-version'): boolean {
  return spawnSync(command, [versionFlag], { stdio: 'ignore' }).status === 0;
}

/** The pixel size of a JPEG, read from its start-of-frame marker. */
export function jpegSize(bytes: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('not a JPEG marker');
    const marker = bytes[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('no start-of-frame marker');
}
