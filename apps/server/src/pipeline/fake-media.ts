// ffmpeg for the fake runner (E7): finding it, and making the small test videos and stills the
// fake edit writes (`preview.mp4`, `final.mp4`, `verify/pass_N.jpg`).
//
// An ffmpeg process is started only while the run is not aborted, is killed when the signal fires
// (SIGTERM, then SIGKILL after a grace period), and the promise settles only after the process has
// exited. Output goes to a hidden `.partial` file next to the target and is renamed into place
// when ffmpeg succeeded, so a watcher never sees a half-written video under its real name.

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';

/** Where a GUI-launched agent (launchd) may find ffmpeg although its PATH is minimal. */
const FALLBACK_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of the ffmpeg executable, or `null` when there is none. A `bin` with a slash is
 * taken as a path; a bare name is looked up on PATH, then in the usual Homebrew locations (the
 * launchd agent has a short PATH).
 */
export async function resolveFfmpeg(
  bin = 'ffmpeg',
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const candidates = bin.includes('/')
    ? [bin]
    : [...(env.PATH ?? '').split(delimiter).filter((dir) => dir !== ''), ...FALLBACK_DIRS].map(
        (dir) => join(dir, bin),
      );
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** How one ffmpeg run ended. `aborted` means the signal fired and the process has exited. */
export type FfmpegResult =
  | { status: 'ok' }
  | { status: 'aborted' }
  | { status: 'failed'; message: string };

export interface FfmpegTools {
  /** The executable, as `resolveFfmpeg` found it. */
  bin: string;
  signal: AbortSignal;
  /** How long a process gets to exit after SIGTERM before it is killed with SIGKILL. */
  killGraceMs: number;
}

const STDERR_TAIL_CHARS = 600;

/** Runs ffmpeg with `args` and settles when the process has exited (or could not start). */
export function runFfmpeg(
  { bin, signal, killGraceMs }: FfmpegTools,
  args: readonly string[],
): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ status: 'aborted' });
      return;
    }

    const child = spawn(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });

    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let settled = false;
    const settle = (result: FfmpegResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    // A process that never started has no exit to wait for.
    child.once('error', (error) => {
      if (child.pid === undefined) {
        settle({ status: 'failed', message: `could not start ffmpeg: ${error.message}` });
      }
    });

    child.once('close', (code, exitSignal) => {
      if (signal.aborted) {
        settle({ status: 'aborted' });
      } else if (code === 0) {
        settle({ status: 'ok' });
      } else {
        const how =
          exitSignal === null ? `exited with code ${code}` : `was killed by ${exitSignal}`;
        const detail = stderr.trim();
        settle({ status: 'failed', message: `ffmpeg ${how}${detail === '' ? '' : `: ${detail}`}` });
      }
    });
  });
}

/** The video test patterns ffmpeg can generate on its own. */
export type TestPattern = 'testsrc' | 'testsrc2' | 'smptebars';

/** Portrait, small: cheap to make, and what a phone-first edit looks like. */
export const CLIP_WIDTH = 360;
export const CLIP_HEIGHT = 640;

/** `.name.partial` beside `target`: hidden, and not a name anything else would use. */
function partialPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.partial`);
}

// Runs ffmpeg into a partial file and moves it into place only when it succeeded.
async function produce(
  tools: FfmpegTools,
  target: string,
  buildArgs: (partial: string) => string[],
): Promise<FfmpegResult> {
  const partial = partialPathFor(target);
  await mkdir(dirname(target), { recursive: true });
  const result = await runFfmpeg(tools, buildArgs(partial));
  if (result.status === 'ok') {
    await rename(partial, target);
  } else {
    await rm(partial, { force: true });
  }
  return result;
}

export interface ClipOptions {
  seconds: number;
  pattern: TestPattern;
  /** Pitch of the sine tone, so the preview and the final sound different. */
  toneHz: number;
  /**
   * An audio file that is the clip's sound instead of the tone (Soundtrack: the final carries the
   * music that was picked, as a real render of the composition does). Without it the tone.
   */
  audioFile?: string;
}

/** Writes a short H.264/AAC portrait clip (a test pattern with a sine tone) to `target`. */
export function makeClip(
  tools: FfmpegTools,
  target: string,
  { seconds, pattern, toneHz, audioFile }: ClipOptions,
): Promise<FfmpegResult> {
  return produce(tools, target, (partial) => [
    '-f',
    'lavfi',
    '-i',
    `${pattern}=size=${CLIP_WIDTH}x${CLIP_HEIGHT}:rate=25:duration=${seconds}`,
    ...(audioFile === undefined
      ? ['-f', 'lavfi', '-i', `sine=frequency=${toneHz}:sample_rate=44100:duration=${seconds}`]
      : ['-i', audioFile]),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-shortest',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-y',
    partial,
  ]);
}

/** Writes one test-pattern frame as a JPEG to `target`. */
export function makeStill(
  tools: FfmpegTools,
  target: string,
  pattern: TestPattern,
): Promise<FfmpegResult> {
  return produce(tools, target, (partial) => [
    '-f',
    'lavfi',
    '-i',
    `${pattern}=size=${CLIP_WIDTH}x${CLIP_HEIGHT}:rate=1:duration=1`,
    '-frames:v',
    '1',
    '-update',
    '1',
    '-f',
    'image2',
    '-y',
    partial,
  ]);
}
