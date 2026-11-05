// Runs the music script (Soundtrack plan, "The engine"): `node make-music.mjs <command> <edit dir> …`
// as a child of the engine, for Make another and Pick (MusicService) and for the fake runner's
// first music (fake-music.ts). The script itself is SD1's; this file only starts it, reads its one
// JSON line and stops it.
//
//   - the server's own node (`process.execPath`), the minimal environment of every child
//     (`childEnv`: no API keys; the script reads ElevenLabs' key from video-use's .env itself) plus
//     the server's own MUSIC_* settings (the test stub's MUSIC_API_BASE, MUSIC_FFMPEG …)
//   - cwd OUTSIDE the job folder: the script and the ElevenLabs helpers read ./.env from their cwd
//   - its own process group (detached), the whole tree stopped (SIGTERM, then SIGKILL) when the
//     caller aborts, the timeout runs out or the engine shuts down, like the voice transcriber's
//
// What it answers is the raw outcome; MusicService decides what it means for the owner.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { type MusicScriptLine, parseMusicScriptLine } from '@studio/shared';
import { childEnv } from '../pipeline/claude-command.js';
import { errorText, StopControl } from '../pipeline/claude-process.js';
import { ProcessTree } from '../pipeline/process-tree.js';
import { MUSIC_SCRIPT } from './music-assets.js';

/** One call of the script: its arguments after the script's path, and when to give up. */
export interface MusicScriptCall {
  /** `['make', '<edit dir>', '--again', …]`. */
  argv: readonly string[];
  /** Aborted to stop the call: the reason `'shutdown'` means the engine is stopping, anything else a cancel. */
  signal?: AbortSignal;
  /** The most the call may take, from the spawn, in ms. */
  timeoutMs: number;
}

/** How a call ended. */
export type MusicScriptOutcome =
  /** The script ran and exited; `line` is its answer (`null` when it printed none). */
  | {
      kind: 'ran';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      line: MusicScriptLine | null;
      stderr: string;
    }
  /** The caller's signal aborted it. */
  | { kind: 'stopped'; reason: 'cancel' | 'shutdown' }
  /** It ran out of time and was stopped. */
  | { kind: 'timed_out' }
  /** The process could not be started. */
  | { kind: 'not_started'; message: string };

/** Runs one call of the music script. Replaced in tests. */
export type MusicScriptRunner = (call: MusicScriptCall) => Promise<MusicScriptOutcome>;

export interface MusicScriptRunnerOptions {
  /** Default MUSIC_SCRIPT. */
  script?: string;
  /** The node that runs it. Default the server's own. */
  node?: string;
  /** Where the child runs: never a job folder. Default the OS temp folder. */
  cwd?: string;
  /** Default os.homedir(). */
  home?: string;
  /** Default process.env; only what childEnv keeps, and the MUSIC_* variables, reach the script. */
  env?: Record<string, string | undefined>;
  /** SIGTERM to SIGKILL, in ms. Default 3000. */
  killGraceMs?: number;
}

/** How much of the script's output is kept: its answer is the last line, errors the last lines of stderr. */
const STDOUT_KEPT = 64 * 1024;
const STDERR_KEPT = 4_000;
/** After the script and its tree are gone, how long its pipes get to finish. */
const PIPE_DRAIN_MS = 1_000;

/** An ElevenLabs key (`sk_…`) never reaches a message or a log. */
export function redactKeys(text: string): string {
  return text.replace(/sk_[A-Za-z0-9_-]{6,}/g, 'sk_…');
}

/**
 * The script's environment: the minimal one every child gets, with the server's own `MUSIC_*`
 * settings added (none of them holds a key).
 */
export function musicScriptEnv(
  home: string,
  env: Record<string, string | undefined>,
  runTag: string,
): Record<string, string> {
  const out = childEnv({ home, env, runTag });
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('MUSIC_') && value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

export function createMusicScriptRunner(options: MusicScriptRunnerOptions = {}): MusicScriptRunner {
  const script = options.script ?? MUSIC_SCRIPT;
  const node = options.node ?? process.execPath;
  const cwd = options.cwd ?? tmpdir();
  const home = options.home ?? homedir();
  const killGraceMs = options.killGraceMs ?? 3_000;

  return async (call) => {
    const { signal } = call;
    const abortOutcome = (): MusicScriptOutcome => ({
      kind: 'stopped',
      reason: signal?.reason === 'shutdown' ? 'shutdown' : 'cancel',
    });
    if (signal?.aborted) return abortOutcome();

    const runTag = `music-${randomUUID()}`;
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(node, [script, ...call.argv], {
        cwd,
        env: musicScriptEnv(home, options.env ?? process.env, runTag),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Some failures (an argument with a NUL character) are thrown here, not emitted as 'error'.
      return { kind: 'not_started', message: redactKeys(errorText(err)) };
    }

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-STDOUT_KEPT);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEPT);
    });
    const pipesClosed = Promise.all(
      [child.stdout, child.stderr].map(
        (pipe) =>
          new Promise<void>((done) => {
            pipe.once('close', () => done());
          }),
      ),
    );

    type Exit =
      | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
      | { kind: 'spawn_error'; error: Error };
    const exited = new Promise<Exit>((done) => {
      child.on('error', (error) => {
        if (child.pid === undefined) done({ kind: 'spawn_error', error });
      });
      child.once('exit', (code, exitSignal) => done({ kind: 'exit', code, signal: exitSignal }));
    });

    const control = new StopControl(killGraceMs);
    let tree: ProcessTree | null = null;
    if (child.pid !== undefined) {
      tree = new ProcessTree({ rootPid: child.pid, tag: runTag });
      control.attach(tree);
    }
    const onAbort = (): void =>
      control.request(signal?.reason === 'shutdown' ? 'stopped' : 'cancelled');
    // A listener added to an already-aborted signal never fires: register, then look.
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => control.request('timed_out'), call.timeoutMs);

    const exit = await exited;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);

    // The script is gone, its tree may not be (ffmpeg, curl). A stop under way finishes;
    // otherwise anything it left behind is stopped now.
    const pending = control.stopping;
    const stoppedBy = control.settle();
    if (tree !== null) await (pending ?? tree.terminate({ graceMs: killGraceMs }));
    let drainTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      pipesClosed,
      new Promise((done) => {
        drainTimer = setTimeout(done, PIPE_DRAIN_MS);
      }),
    ]);
    clearTimeout(drainTimer);
    child.stdout.destroy();
    child.stderr.destroy();

    if (exit.kind === 'spawn_error') {
      return { kind: 'not_started', message: redactKeys(exit.error.message) };
    }
    if (stoppedBy === 'timed_out') return { kind: 'timed_out' };
    if (stoppedBy === 'stopped') return { kind: 'stopped', reason: 'shutdown' };
    if (stoppedBy === 'cancelled') return { kind: 'stopped', reason: 'cancel' };
    return {
      kind: 'ran',
      exitCode: exit.code,
      signal: exit.signal,
      line: parseMusicScriptLine(stdout),
      stderr: redactKeys(stderr.trim()),
    };
  };
}
