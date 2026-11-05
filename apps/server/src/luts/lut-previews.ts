// The graded test stills of the LUTs page (LUTs plan, "Previews"). OWNER: LU2.
//
// After = the test frame run through `ffmpeg -vf lut3d=file=…:interp=tetrahedral`, a JPEG at
// 396×704, cached in `<data>/lut-previews/<key>/<frame>-after.jpg` where the key is the LUT's id (or
// the built-in slug) plus the first 8 of the file's sha256 (see {@link lutPreviewKey}). For a
// Camera LUT the before is the frame's -log twin and the after is the plain frame (the real LUT is
// not applied to a non-log photo; the pane says so): those need no ffmpeg. The Cinematic look is
// made from the file `grade_batch.py --bake-look` writes (luts/lut-builtin.ts), not a second copy
// of the wrapper's numbers.
//
// A still is made on the first request, concurrent requests share one run, and an import starts
// its three stills right away (`warm`); the built-ins are warmed after boot at low priority. At most
// two ffmpeg runs go at a time and each has 20 seconds. A failure is logged, and the caller (the
// route) answers a plain sentence; nothing is thrown at the page. With the fake engine
// (`runner: fake`) the after is the before frame, copied (luts/fake-lut-previews.ts), so tests and
// e2e need no ffmpeg (the same idea as createGraphicRunner).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import type { LutFrame, LutKind, LutPreviewSide } from '@studio/shared';
import type { Config } from '../config.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { createFakeLutPreviews } from './fake-lut-previews.js';
import { lutFrameFile } from './lut-frames.js';
import { createQueuedPreviews, type StillPriority } from './lut-still-queue.js';

/** What a still is made from: a LUT of Yours or a built-in row. */
export interface PreviewSource {
  /** A LUT's id, or a built-in slug. */
  key: string;
  kind: LutKind;
  /**
   * The .cube file to run. For the Cinematic look this is the chain baked into one file
   * (`BuiltInLuts.cubeFile`). `null` when there is none: the "after" of such a source cannot be made.
   */
  cubePath: string | null;
  /** `'cinematic'` for the wrapper's look chain (its `cubePath` is the baked file), `null` for the rest. */
  look: 'cinematic' | null;
  /** Of the .cube file (a built-in row's is read from the skill); `null` when it is not known. */
  sha256: string | null;
}

export interface LutPreviews {
  /**
   * The JPEG of `source` on `frame`, `side` (before or after): made now if it is not cached, shared
   * with a run already making it. Answers the file's path, or rejects when it cannot be made (the
   * reason is logged).
   */
  still(source: PreviewSource, frame: LutFrame, side: LutPreviewSide): Promise<string>;
  /** Starts making the three "after" stills in the background. Never throws. */
  warm(source: PreviewSource): void;
}

/** `<data>/lut-previews`: where the cache is. */
export function lutPreviewsRoot(dataDir: string): string {
  return join(dataDir, 'lut-previews');
}

/**
 * The cache folder's name of a LUT: its key and the first 8 of its file's sha256, so a changed file
 * never shows an old still ("cinematic-look" when the file is not known).
 */
export function lutPreviewKey(key: string, sha256: string | null): string {
  return sha256 === null ? `${key}-look` : `${key}-${sha256.slice(0, 8)}`;
}

/** The still's file in the cache: `<data>/lut-previews/<key>/<frame>-<side>.jpg`. */
export function lutPreviewPath(
  dataDir: string,
  source: Pick<PreviewSource, 'key' | 'sha256'>,
  frame: LutFrame,
  side: LutPreviewSide,
): string {
  return join(
    lutPreviewsRoot(dataDir),
    lutPreviewKey(source.key, source.sha256),
    `${frame}-${side}.jpg`,
  );
}

export { lutPreviewVersion } from './lut-preview-version.js';

// --- a file's hash, remembered ---------------------------------------------------------------------

const hashed = new Map<string, { signature: string; sha256: Promise<string> }>();

/**
 * The sha256 of a file, remembered while its size and modified time stay the same (the built-in
 * LUTs are ~1 MB each and asked about on every list). Rejects when the file cannot be read.
 */
export async function fileSha256(path: string): Promise<string> {
  const info = await stat(path);
  const signature = `${info.size}:${info.mtimeMs}`;
  const known = hashed.get(path);
  if (known !== undefined && known.signature === signature) return known.sha256;
  const sha256 = new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
  hashed.set(path, { signature, sha256 });
  sha256.catch(() => hashed.delete(path));
  return sha256;
}

// --- the makers ----------------------------------------------------------------------------------

export interface LutPreviewsOptions {
  /** `<data>`, whose `lut-previews/` is the cache. */
  dataDir: string;
  /** The ffmpeg to run for the real maker. Default `ffmpeg`. */
  ffmpegBin?: string;
  /** Where failures are logged. Default: nowhere. */
  logger?: WorkerLogger;
  /** How long one ffmpeg run may take. Default 20 s. */
  timeoutMs?: number;
  /** How many ffmpeg runs go at a time. Default 2. */
  concurrency?: number;
}

/**
 * The real maker for `claude`, the fake one for `fake` (as createGraphicRunner picks the graphic
 * run).
 */
export function createLutPreviews(
  config: Pick<Config, 'runner' | 'dataDir'>,
  options: Partial<LutPreviewsOptions> = {},
): LutPreviews {
  if (config.runner === 'fake') {
    return createFakeLutPreviews({ dataDir: config.dataDir, logger: options.logger });
  }
  return createRealLutPreviews({ dataDir: config.dataDir, ...options });
}

const ffmpegFailure = (code: number | null, stderr: string): Error =>
  new Error(`ffmpeg failed (${code ?? 'killed'}): ${stderr.trim().slice(-400)}`);

/**
 * Runs `ffmpegBin args` in `cwd`; kills it after `timeoutMs`. Background runs are niced. (Also used
 * by the paused-frame look in Review, luts/review-frames.ts.)
 */
export function runFfmpeg(
  ffmpegBin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  priority: StillPriority,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    if (priority === 'background' && child.pid !== undefined) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // Not allowed or already gone: it just runs at the normal priority.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // Do not wait for the pipes to close: a grandchild could keep them open.
      reject(new Error(`ffmpeg took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(ffmpegFailure(code, stderr));
    });
  });
}

/**
 * The ffmpeg maker. The LUT file is copied to a generated name next to the run, so no file name of
 * The owner's ever reaches a filter string (as the wrapper's `lut_filter` does); the frame goes in as
 * `-i`, which takes any path.
 */
export function createRealLutPreviews(options: LutPreviewsOptions): LutPreviews {
  const { dataDir, ffmpegBin = 'ffmpeg', logger, timeoutMs = 20_000, concurrency = 2 } = options;
  return createQueuedPreviews({
    concurrency,
    logger,
    pathFor: (source, frame, side) => lutPreviewPath(dataDir, source, frame, side),
    make: async (source, frame, outPath, priority) => {
      if (source.cubePath === null) throw new Error('the LUT has no file to run');
      const scratchRoot = join(lutPreviewsRoot(dataDir), '.work');
      await mkdir(scratchRoot, { recursive: true });
      const work = await mkdtemp(join(scratchRoot, 'run-'));
      try {
        await copyFile(source.cubePath, join(work, 'lut.cube'), constants.COPYFILE_FICLONE);
        await runFfmpeg(
          ffmpegBin,
          [
            '-v',
            'error',
            '-y',
            '-i',
            lutFrameFile(frame, 'after', source.kind),
            '-vf',
            'lut3d=file=lut.cube:interp=tetrahedral',
            '-frames:v',
            '1',
            '-q:v',
            '3',
            'out.jpg',
          ],
          work,
          timeoutMs,
          priority,
        );
        await rename(join(work, 'out.jpg'), outPath);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  });
}
