// The static check of a LUT file (LUTs plan, "Import"). OWNER: LU1.
//
// No ffmpeg: the extension is .cube or .3dl; the file is text and at most 40 MB; a .cube has
// LUT_3D_SIZE N (2 to 129; a LUT_1D_SIZE file is "a 1D LUT"), then exactly N³ data lines of three
// finite numbers, with an optional TITLE and DOMAIN_MIN/DOMAIN_MAX (0..1 only; anything else is
// refused with the reason). A .3dl (first line: the grid points; values 0–1023 or 0–4095) is
// converted to a .cube (lut-3dl.ts) and then checked. Every verdict is one plain sentence from
// LUT_MESSAGES. The final proof, one ffmpeg run (lut3d on a 16×16 test image) so a file ffmpeg
// cannot read never gets in, is the {@link LutProver}; the import runs it, the check does not.

import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { LUT_LIMITS, LUT_MESSAGES, type LutKind, lutKindGuess } from '@studio/shared';
import { convert3dlToCube } from './lut-3dl.js';

/** The verdict on one file: its grid points and the kind its name suggests, or why it is not a LUT. */
export type LutCheck =
  | { ok: true; size: number; kindGuess: LutKind }
  | { ok: false; error: string };

/** The check, and for a good file the text of the .cube to keep (a converted .3dl's, else the file's own). */
export type PreparedLut =
  | { ok: true; size: number; kindGuess: LutKind; cube: string }
  | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A number as .cube writes it: `0.5`, `-1`, `1e-3`, `.25`. Never `nan`, `inf` or hex. */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** DOMAIN_MIN / DOMAIN_MAX (and the INPUT_RANGE keywords) may only say 0 0 0 and 1 1 1. */
function isRange(tokens: readonly string[], value: number): boolean {
  return (
    tokens.length === 3 && tokens.every((token) => NUMBER.test(token) && Number(token) === value)
  );
}

/** The parts of a .cube the check needs, checked line by line without splitting the whole text. */
function checkCube(text: string): { ok: true; size: number } | { ok: false; error: string } {
  let size: number | null = null;
  let oneD = false;
  let rows = 0;
  let expected = 0;

  let start = 0;
  const end = text.length;
  while (start <= end) {
    let stop = text.indexOf('\n', start);
    if (stop === -1) stop = end;
    const line = text.slice(start, stop).trim();
    start = stop + 1;
    if (line === '' || line.startsWith('#')) continue;

    const first = line.charCodeAt(0);
    const isLetter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
    if (isLetter) {
      const tokens = line.split(/\s+/);
      const keyword = (tokens[0] ?? '').toUpperCase();
      const args = tokens.slice(1);
      switch (keyword) {
        case 'LUT_3D_SIZE': {
          if (args.length !== 1 || !/^\d+$/.test(args[0] ?? '')) return fail(LUT_MESSAGES.badGrid);
          const n = Number(args[0]);
          if (n < LUT_LIMITS.gridMin || n > LUT_LIMITS.gridMax) return fail(LUT_MESSAGES.badGrid);
          size = n;
          expected = n * n * n;
          break;
        }
        case 'LUT_1D_SIZE':
          oneD = true;
          break;
        case 'DOMAIN_MIN':
          if (!isRange(args, 0)) return fail(LUT_MESSAGES.badDomain);
          break;
        case 'DOMAIN_MAX':
          if (!isRange(args, 1)) return fail(LUT_MESSAGES.badDomain);
          break;
        case 'LUT_3D_INPUT_RANGE':
        case 'LUT_1D_INPUT_RANGE':
          // Resolve's pair "min max": only 0 and 1.
          if (args.length !== 2 || Number(args[0]) !== 0 || Number(args[1]) !== 1) {
            return fail(LUT_MESSAGES.badDomain);
          }
          break;
        default:
          break; // TITLE and any keyword this check does not know
      }
      continue;
    }

    // A data line.
    if (size === null) return fail(oneD ? LUT_MESSAGES.oneD : LUT_MESSAGES.badRows);
    rows += 1;
    if (rows > expected) return fail(LUT_MESSAGES.badRows);
    const tokens = line.split(/\s+/);
    if (tokens.length !== 3) return fail(LUT_MESSAGES.badRows);
    for (const token of tokens) {
      if (!NUMBER.test(token) || !Number.isFinite(Number(token))) {
        return fail(LUT_MESSAGES.badRows);
      }
    }
  }

  if (size === null) return fail(oneD ? LUT_MESSAGES.oneD : LUT_MESSAGES.noSize);
  if (rows !== expected) return fail(LUT_MESSAGES.badRows);
  return { ok: true, size };
}

/**
 * Checks the text of a LUT file named `fileName` (the extension decides .cube or .3dl; a .3dl is
 * converted first) and, for a good one, answers the .cube text to keep. `bytes` is the file's size,
 * for the 40 MB limit.
 */
export function prepareLutText(fileName: string, text: string, bytes: number): PreparedLut {
  const extension = extname(fileName).toLowerCase();
  if (extension !== '.cube' && extension !== '.3dl') return fail(LUT_MESSAGES.badExtension);
  if (bytes > LUT_LIMITS.fileMaxBytes) return fail(LUT_MESSAGES.tooLarge);
  if (text.includes('\u0000')) return fail(LUT_MESSAGES.notText);

  // A file with old Mac line ends (a lone CR) is read like any other.
  let cube = text.includes('\n') || !text.includes('\r') ? text : text.replace(/\r/g, '\n');
  if (extension === '.3dl') {
    const converted = convert3dlToCube(cube);
    if (!converted.ok) return converted;
    cube = converted.cube;
  }
  const verdict = checkCube(cube.charCodeAt(0) === 0xfeff ? cube.slice(1) : cube);
  if (!verdict.ok) return verdict;
  return { ok: true, size: verdict.size, kindGuess: lutKindGuess(fileName), cube };
}

/**
 * Checks the text of a LUT file named `fileName` (the extension decides .cube or .3dl; a .3dl is
 * converted first). `bytes` is the file's size, for the 40 MB limit.
 */
export function checkLutText(fileName: string, text: string, bytes: number): LutCheck {
  const prepared = prepareLutText(fileName, text, bytes);
  return prepared.ok ? { ok: true, size: prepared.size, kindGuess: prepared.kindGuess } : prepared;
}

/** Reads the file at `path` (named `fileName`) and checks it: not text and too large are verdicts. */
export async function checkLutFile(path: string, fileName: string): Promise<LutCheck> {
  const prepared = await prepareLutFile(path, fileName);
  return prepared.ok ? { ok: true, size: prepared.size, kindGuess: prepared.kindGuess } : prepared;
}

/** {@link prepareLutText} of the file at `path`; a file over the limit is never read. */
export async function prepareLutFile(path: string, fileName: string): Promise<PreparedLut> {
  const extension = extname(fileName).toLowerCase();
  if (extension !== '.cube' && extension !== '.3dl') return fail(LUT_MESSAGES.badExtension);
  const { size: bytes } = await stat(path);
  if (bytes > LUT_LIMITS.fileMaxBytes) return fail(LUT_MESSAGES.tooLarge);
  const buffer = await readFile(path);
  return prepareLutText(fileName, buffer.toString('utf8'), bytes);
}

/**
 * The final proof: ffmpeg's lut3d on a 16×16 test image with the file at `cubePath`. Answers
 * `null` when it works, or the sentence to show (LUT_MESSAGES.ffmpegRefused). Tests pass a fake.
 */
export type LutProver = (cubePath: string) => Promise<string | null>;

const execFileAsync = promisify(execFile);

/**
 * The real prover: runs `ffmpegBin` on a 16×16 grey image. The file is copied to `lut.cube` in a
 * temporary folder first and read from there, because a name with a quote, a colon or a comma
 * cannot be put in a filter graph safely.
 */
export function createFfmpegLutProver(ffmpegBin: string): LutProver {
  return async (cubePath) => {
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'studio-lut-proof-'));
      await copyFile(cubePath, join(dir, 'lut.cube'));
      await execFileAsync(
        ffmpegBin,
        [
          '-v',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          'color=c=0x808080:s=16x16:r=1:d=1',
          '-vf',
          'lut3d=file=lut.cube:interp=tetrahedral',
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
        { cwd: dir, timeout: 30_000 },
      );
      return null;
    } catch {
      return LUT_MESSAGES.ffmpegRefused;
    } finally {
      if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
