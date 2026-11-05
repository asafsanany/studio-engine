// The voice-note transcriber (W6 · CVP-115): turns a recording (Chrome's audio/webm with Opus,
// Safari's audio/mp4) into text by itself, with video-use's own helper and no Claude run.
//
//   transcribeVoice      one helper run: <python> <transcribe.py> <audio> --edit-dir <outDir>
//                        [--language xx], in outDir, with the minimal environment (childEnv)
//   fakeTranscribeVoice  the same contract for STUDIO_RUNNER=fake, without a process or a network
//   createVoiceTranscriber  the queue around either: at most 2 jobs at a time, first in first out,
//                        2 minutes each at most, cancel by signal, stop() on shutdown
//
// It stands alone: it is outside the edit queue (QueueWorker), writes no run records (the Brief
// run's reaper would stop a transcription as a stale run) and is called by nothing yet; the
// review notes (W5) wire it in. The transcript JSON the helper writes under
// <outDir>/transcripts/<stem>.json doubles as the cache: a good one is read without a spawn.
//
// The ElevenLabs key stays in video-use's .env, where the helper reads it. childEnv leaves it out
// of the helper's environment, nothing here ever logs an environment, and every message built
// from the helper's stderr has `sk_…` strings redacted.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { expandHome } from '../config.js';
import { BRIEF_JSON_PATH } from './brief-step.js';
import { childEnv, TRANSCRIBE_PYTHON, TRANSCRIBE_SCRIPT, tildePath } from './claude-command.js';
import { errorText, type RunnerLogger, SILENT_LOGGER, StopControl } from './claude-process.js';
import { trimMessage } from './failure.js';
import { realSleep, type Sleep } from './fake-runner.js';
import { ProcessTree } from './process-tree.js';
import { normalizeLanguage, transcriptPathFor, transcriptText } from './voice-transcript.js';

export type TranscriberKind = 'real' | 'fake';

export interface VoiceJob {
  /** Absolute path of the recording (.webm, .m4a, ...). Its stem names the transcript file. */
  audioPath: string;
  /** Absolute folder passed as --edit-dir. W5 passes <job>/edit/review/voice. */
  outDir: string;
  /** ISO 639-1 code like "he". Anything else (null, '', 'HE', 'heb', 'he-IL') means auto-detect. */
  language?: string | null;
  /** Abort to cancel: a queued job is dropped, a running one has its process tree stopped. */
  signal?: AbortSignal;
}

export interface VoiceTranscript {
  /** The transcript's words, joined. Never empty. */
  text: string;
}

export const TRANSCRIPTION_ERROR_CODES = [
  'cancelled',
  'stopped',
  'timed_out',
  'no_speech',
  'failed',
] as const;
export type TranscriptionErrorCode = (typeof TRANSCRIPTION_ERROR_CODES)[number];

/** The only thing enqueue, transcribeVoice and fakeTranscribeVoice ever reject with. */
export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;

  constructor(code: TranscriptionErrorCode, message: string) {
    super(trimMessage(message));
    this.name = 'TranscriptionError';
    this.code = code;
  }
}

export const VOICE_CONCURRENCY = 2;
export const VOICE_TIMEOUT_MS = 120_000;
export const VOICE_KILL_GRACE_MS = 3_000;
export const FAKE_VOICE_MS = 1_000;
export const FAKE_VOICE_TEXT = '[voice note, fake transcript]';
export const FAKE_VOICE_FAIL_MARKER = '.fail-transcribe';

/** Share of the fake wait that goes by before an injected failure shows up (as in the fake runner). */
const FAILURE_AFTER = 0.4;
/** Seconds between the words of the fake transcript (as in fakeTranscript). */
const FAKE_WORD_SECONDS = 0.4;
/** How much of the helper's stderr is kept for the failure message. */
const STDERR_KEPT = 4_000;
/** After the helper and its tree are gone, how long its stderr pipe gets to finish. */
const STDERR_DRAIN_MS = 1_000;

const MESSAGES = {
  cancelled: 'The transcription was cancelled.',
  stopped: 'The transcription was stopped: the engine is shutting down.',
  silent: 'The voice note is silent.',
  noSpeech: 'No speech was heard in the voice note.',
  audioMissing: "The voice note's audio file is missing.",
  audioEmpty: "The voice note's audio file is empty.",
  notAbsolute: 'The audio path and the output folder must be absolute.',
  noKey: "No ElevenLabs key, so voice notes can't be transcribed. Run `pnpm run doctor`.",
  noOutput: 'The transcribe helper finished without writing a transcript.',
  injected: `Transcription failed: injected failure (${FAKE_VOICE_FAIL_MARKER})`,
} as const;

function fail(code: TranscriptionErrorCode, message: string): TranscriptionError {
  return new TranscriptionError(code, message);
}

/** The error for an aborted signal: `stopped` when the queue is shutting down, else `cancelled`. */
function abortError(signal: AbortSignal): TranscriptionError {
  return signal.reason === 'stopped'
    ? fail('stopped', MESSAGES.stopped)
    : fail('cancelled', MESSAGES.cancelled);
}

/** An ElevenLabs key (`sk_…`) never reaches a message or a log. */
export function redactSecrets(text: string): string {
  return text.replace(/sk_[A-Za-z0-9_-]{6,}/g, 'sk_…');
}

/** <home>/Developer/video-use/.venv/bin/python and <home>/Developer/video-use/helpers/transcribe.py. */
export function voiceHelperPaths(home: string): { python: string; script: string } {
  return {
    python: expandHome(TRANSCRIBE_PYTHON, home),
    script: expandHome(TRANSCRIBE_SCRIPT, home),
  };
}

export interface TranscribeVoiceOptions {
  /** Default os.homedir(). */
  home?: string;
  /** Default process.env; only what childEnv keeps reaches the helper. */
  env?: Record<string, string | undefined>;
  /** Default voiceHelperPaths(home).python. */
  python?: string;
  /** Default voiceHelperPaths(home).script. */
  script?: string;
  /** Default VOICE_TIMEOUT_MS, counted from the spawn. */
  timeoutMs?: number;
  /** Default VOICE_KILL_GRACE_MS: SIGTERM, then SIGKILL. */
  killGraceMs?: number;
}

function requireAbsolute(job: VoiceJob): void {
  if (!(isAbsolute(job.audioPath) && isAbsolute(job.outDir))) {
    throw fail('failed', MESSAGES.notAbsolute);
  }
}

async function checkAudio(audioPath: string): Promise<void> {
  let size: number;
  try {
    const info = await stat(audioPath);
    if (!info.isFile()) throw fail('failed', MESSAGES.audioMissing);
    size = info.size;
  } catch (err) {
    if (err instanceof TranscriptionError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw fail(
      'failed',
      code === 'ENOENT' || code === 'ENOTDIR' ? MESSAGES.audioMissing : errorText(err),
    );
  }
  if (size === 0) throw fail('failed', MESSAGES.audioEmpty);
}

type TranscriptRead =
  | { state: 'missing' }
  | { state: 'invalid'; detail: string }
  | { state: 'ok'; text: string };

async function readTranscript(path: string): Promise<TranscriptRead> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', detail: errorText(err) };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { state: 'invalid', detail: errorText(err) };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { state: 'invalid', detail: 'not a Scribe transcript' };
  }
  return { state: 'ok', text: transcriptText(json) };
}

/** The transcript a previous run left, if it is a good one: its text, or the no-speech error. */
async function cachedTranscript(
  target: string,
  removeBroken: boolean,
): Promise<VoiceTranscript | null> {
  const cached = await readTranscript(target);
  if (cached.state === 'ok') {
    if (cached.text === '') throw fail('no_speech', MESSAGES.noSpeech);
    return { text: cached.text };
  }
  // The helper would call a broken file "cached" forever.
  if (cached.state === 'invalid' && removeBroken) await rm(target, { force: true });
  return null;
}

/** Why the helper failed, from its exit and what it wrote to stderr. */
function helperFailure(
  code: number | null,
  exitSignal: NodeJS.Signals | null,
  stderr: string,
): TranscriptionError {
  if (stderr.includes('ELEVENLABS_API_KEY not found')) return fail('failed', MESSAGES.noKey);
  if (/ is silent \(peak/.test(stderr)) return fail('no_speech', MESSAGES.silent);
  const lines = stderr.split('\n').filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  const detail =
    last !== undefined
      ? redactSecrets(last.trim())
      : exitSignal !== null
        ? `was killed by ${exitSignal}`
        : `exited with code ${code}`;
  return fail('failed', `The transcribe helper failed: ${detail}`);
}

/** The outcome of waiting for the helper process. */
type HelperExit =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawn_error'; error: Error };

/** One transcription with video-use's helper. Rejects only with a TranscriptionError. */
export async function transcribeVoice(
  job: VoiceJob,
  options: TranscribeVoiceOptions = {},
): Promise<VoiceTranscript> {
  const home = options.home ?? homedir();
  const defaults = voiceHelperPaths(home);
  const python = options.python ?? defaults.python;
  const script = options.script ?? defaults.script;
  const timeoutMs = options.timeoutMs ?? VOICE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? VOICE_KILL_GRACE_MS;
  const { signal } = job;

  if (signal?.aborted) throw abortError(signal);
  requireAbsolute(job);
  await checkAudio(job.audioPath);

  const target = transcriptPathFor(job.audioPath, job.outDir);
  const cached = await cachedTranscript(target, true);
  if (cached !== null) return cached;

  try {
    await access(python, constants.X_OK);
  } catch {
    throw fail(
      'failed',
      `video-use's Python was not found at ${tildePath(python, home)}. Run \`pnpm run doctor\`.`,
    );
  }
  try {
    await access(script, constants.R_OK);
  } catch {
    throw fail(
      'failed',
      `video-use's transcribe helper was not found at ${tildePath(script, home)}. Run \`pnpm run doctor\`.`,
    );
  }
  await mkdir(job.outDir, { recursive: true });
  if (signal?.aborted) throw abortError(signal);

  const language = normalizeLanguage(job.language);
  const args = [
    script,
    job.audioPath,
    '--edit-dir',
    job.outDir,
    ...(language === null ? [] : ['--language', language]),
  ];
  const runTag = `voice-${randomUUID()}`;
  // Its own process group (so the whole tree can be signalled), run in outDir: the helper also
  // reads ./.env from its working directory, so never the job folder.
  const couldNotStart = (reason: string): TranscriptionError =>
    fail(
      'failed',
      `The transcribe helper failed: could not start ${tildePath(python, home)}: ${reason}`,
    );
  let child: ChildProcessByStdio<null, null, Readable>;
  try {
    child = spawn(python, args, {
      cwd: job.outDir,
      env: childEnv({ home, env: options.env ?? process.env, runTag }),
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    // Some failures (a file that is not a program) are thrown here, not emitted as 'error'.
    throw couldNotStart(errorText(err));
  }

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEPT);
  });
  const stderrClosed = new Promise<void>((done) => {
    child.stderr.once('close', () => done());
  });
  const exited = new Promise<HelperExit>((done) => {
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
  const onAbort = (): void => {
    if (signal) control.request(signal.reason === 'stopped' ? 'stopped' : 'cancelled');
  };
  // A listener added to an already-aborted signal never fires: register, then look.
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => control.request('timed_out'), timeoutMs);

  const exit = await exited;
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);

  // The helper is gone, its tree may not be (ffmpeg). A stop under way finishes; otherwise
  // anything it left behind is stopped now. Only then does the job end.
  const pending = control.stopping;
  const stoppedBy = control.settle();
  if (tree !== null) await (pending ?? tree.terminate({ graceMs: killGraceMs }));
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    stderrClosed,
    new Promise((done) => {
      drainTimer = setTimeout(done, STDERR_DRAIN_MS);
    }),
  ]);
  clearTimeout(drainTimer);
  child.stderr.destroy();

  if (exit.kind === 'spawn_error') throw couldNotStart(exit.error.message);
  if (stoppedBy === 'timed_out') {
    throw fail('timed_out', `Transcribing took longer than ${Math.ceil(timeoutMs / 1000)} s.`);
  }
  if (stoppedBy === 'stopped') throw fail('stopped', MESSAGES.stopped);
  if (stoppedBy === 'cancelled') throw fail('cancelled', MESSAGES.cancelled);
  if (exit.code !== 0) throw helperFailure(exit.code, exit.signal, stderr);

  const written = await readTranscript(target);
  switch (written.state) {
    case 'missing':
      throw fail('failed', MESSAGES.noOutput);
    case 'invalid':
      await rm(target, { force: true });
      throw fail('failed', `The transcript could not be read: ${written.detail}`);
    case 'ok':
      if (written.text === '') throw fail('no_speech', MESSAGES.noSpeech);
      return { text: written.text };
  }
}

export interface FakeTranscribeOptions {
  /** How much faster than the default one second to go: a finite number above 0. */
  speed?: number;
  /** Replaces the waiting, for tests. */
  sleep?: Sleep;
}

function assertSpeed(speed: number): void {
  if (!(Number.isFinite(speed) && speed > 0)) {
    throw new RangeError(`The fake transcriber's speed must be a number above 0 (got ${speed}).`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
}

/** A Scribe-shaped transcript of FAKE_VOICE_TEXT (like fakeTranscript, fake-content.ts). */
function fakeScribeJson(): object {
  const words = FAKE_VOICE_TEXT.split(' ').map((text, position) => {
    const start = Math.round((0.2 + position * FAKE_WORD_SECONDS) * 100) / 100;
    return {
      text,
      start,
      end: Math.round((start + FAKE_WORD_SECONDS - 0.06) * 100) / 100,
      type: 'word',
      speaker_id: 'speaker_0',
    };
  });
  return {
    language_code: 'eng',
    language_probability: 1,
    text: FAKE_VOICE_TEXT,
    words,
    fake: true,
  };
}

/**
 * The fake transcription: after about a second (divided by `speed`) the text is
 * FAKE_VOICE_TEXT, written to <outDir>/transcripts/<stem>.json like the real one. A
 * `.fail-transcribe` file in outDir makes it fail instead. Rejects only with a TranscriptionError.
 */
export async function fakeTranscribeVoice(
  job: VoiceJob,
  { speed = 1, sleep = realSleep }: FakeTranscribeOptions = {},
): Promise<VoiceTranscript> {
  assertSpeed(speed);
  const { signal } = job;
  const idle = signal ?? new AbortController().signal;
  if (signal?.aborted) throw abortError(signal);
  requireAbsolute(job);
  await checkAudio(job.audioPath);

  const target = transcriptPathFor(job.audioPath, job.outDir);
  const cached = await cachedTranscript(target, false);
  if (cached !== null) return cached;

  if (await exists(join(job.outDir, FAKE_VOICE_FAIL_MARKER))) {
    await sleep((FAKE_VOICE_MS * FAILURE_AFTER) / speed, idle);
    if (signal?.aborted) throw abortError(signal);
    throw fail('failed', MESSAGES.injected);
  }
  await sleep(FAKE_VOICE_MS / speed, idle);
  if (signal?.aborted) throw abortError(signal);

  await writeAtomic(target, JSON.stringify(fakeScribeJson(), null, 2));
  const written = await readTranscript(target);
  if (written.state === 'invalid') {
    throw fail('failed', `The transcript could not be read: ${written.detail}`);
  }
  if (written.state === 'missing' || written.text === '') {
    throw fail('failed', MESSAGES.noOutput);
  }
  return { text: written.text };
}

export interface VoiceTranscriberOptions extends TranscribeVoiceOptions, FakeTranscribeOptions {
  kind: TranscriberKind;
  /** Default VOICE_CONCURRENCY; a whole number >= 1, else RangeError. */
  concurrency?: number;
  /** Default SILENT_LOGGER. */
  logger?: RunnerLogger;
}

export interface VoiceTranscriber {
  readonly kind: TranscriberKind;
  /** Queues the job (first in, first out) and resolves with its text. Rejects only with a TranscriptionError. */
  enqueue(job: VoiceJob): Promise<VoiceTranscript>;
  /** Engine shutdown: stops running jobs, rejects queued ones, refuses new ones. Resolves once no helper is left. Idempotent. */
  stop(): Promise<void>;
}

interface Entry {
  readonly job: VoiceJob;
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<VoiceTranscript>;
  /** Settles when the entry is done, whatever the outcome. Never rejects. */
  readonly finished: Promise<void>;
  state: 'waiting' | 'running' | 'done';
  resolve(transcript: VoiceTranscript): void;
  reject(error: TranscriptionError): void;
  settleFinished(): void;
  /** Takes the caller's abort listener off its signal. */
  detach(): void;
}

/**
 * The queue around the real or the fake transcription. At most `concurrency` jobs run at a time,
 * the rest wait in order; a job for a recording that is already queued or running shares that
 * job's result (one helper, one upload).
 */
export function createVoiceTranscriber(options: VoiceTranscriberOptions): VoiceTranscriber {
  const { kind, logger = SILENT_LOGGER, sleep } = options;
  const concurrency = options.concurrency ?? VOICE_CONCURRENCY;
  const speed = options.speed ?? 1;
  if (!(Number.isInteger(concurrency) && concurrency >= 1)) {
    throw new RangeError(
      `The voice transcriber's concurrency must be a whole number of 1 or more (got ${concurrency}).`,
    );
  }
  assertSpeed(speed);
  const helperOptions: TranscribeVoiceOptions = {
    home: options.home,
    env: options.env,
    python: options.python,
    script: options.script,
    timeoutMs: options.timeoutMs,
    killGraceMs: options.killGraceMs,
  };

  const waiting: Entry[] = [];
  const running = new Set<Entry>();
  const inFlight = new Map<string, Entry>();
  let stopped = false;

  function log(entry: Entry, error: TranscriptionError | null, startedAt: number): void {
    const audio = basename(entry.job.audioPath);
    if (error === null) {
      logger.info(
        {
          audio,
          language: normalizeLanguage(entry.job.language) ?? 'auto',
          ms: Date.now() - startedAt,
        },
        'voice note transcribed',
      );
    } else if (error.code === 'cancelled' || error.code === 'stopped') {
      logger.info({ audio, code: error.code }, 'voice note transcription stopped');
    } else {
      logger.warn({ audio, code: error.code, error: error.message }, 'voice note not transcribed');
    }
  }

  function finish(
    entry: Entry,
    outcome: { ok: true; transcript: VoiceTranscript } | { ok: false; error: TranscriptionError },
    startedAt = Date.now(),
  ): void {
    if (entry.state === 'done') return;
    entry.state = 'done';
    entry.detach();
    if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
    log(entry, outcome.ok ? null : outcome.error, startedAt);
    if (outcome.ok) entry.resolve(outcome.transcript);
    else entry.reject(outcome.error);
    entry.settleFinished();
  }

  function start(entry: Entry): void {
    entry.state = 'running';
    running.add(entry);
    const startedAt = Date.now();
    const job: VoiceJob = { ...entry.job, signal: entry.controller.signal };
    const run =
      kind === 'real'
        ? transcribeVoice(job, helperOptions)
        : fakeTranscribeVoice(job, { speed, sleep });
    // Two-argument then: a rejection must never end up unhandled.
    run.then(
      (transcript) => {
        running.delete(entry);
        finish(entry, { ok: true, transcript }, startedAt);
        pump();
      },
      (err: unknown) => {
        running.delete(entry);
        let error: TranscriptionError;
        if (err instanceof TranscriptionError) {
          error = err;
        } else {
          error = fail('failed', errorText(err));
          logger.error(
            { audio: basename(entry.job.audioPath), error: error.message },
            'voice note transcription crashed',
          );
        }
        finish(entry, { ok: false, error }, startedAt);
        pump();
      },
    );
  }

  function pump(): void {
    while (!stopped && running.size < concurrency) {
      const next = waiting.shift();
      if (next === undefined) return;
      start(next);
    }
  }

  function enqueue(job: VoiceJob): Promise<VoiceTranscript> {
    if (stopped) return Promise.reject(fail('stopped', MESSAGES.stopped));
    if (job.signal?.aborted) return Promise.reject(fail('cancelled', MESSAGES.cancelled));

    const key = transcriptPathFor(resolve(job.audioPath), resolve(job.outDir));
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing.promise;

    let resolveEntry!: Entry['resolve'];
    let rejectEntry!: Entry['reject'];
    const promise = new Promise<VoiceTranscript>((res, rej) => {
      resolveEntry = res;
      rejectEntry = rej;
    });
    let settleFinished!: () => void;
    const finished = new Promise<void>((done) => {
      settleFinished = done;
    });
    const onAbort = (): void => {
      if (entry.state === 'waiting') {
        waiting.splice(waiting.indexOf(entry), 1);
        finish(entry, { ok: false, error: fail('cancelled', MESSAGES.cancelled) });
      } else if (entry.state === 'running') {
        entry.controller.abort('cancelled');
      }
    };
    const entry: Entry = {
      job,
      key,
      controller: new AbortController(),
      promise,
      finished,
      state: 'waiting',
      resolve: resolveEntry,
      reject: rejectEntry,
      settleFinished,
      detach: () => job.signal?.removeEventListener('abort', onAbort),
    };
    // The caller's signal was checked above and nothing has run since: no abort can be missed.
    job.signal?.addEventListener('abort', onAbort, { once: true });
    waiting.push(entry);
    inFlight.set(key, entry);
    pump();
    return promise;
  }

  async function stop(): Promise<void> {
    stopped = true;
    for (const entry of waiting.splice(0)) {
      finish(entry, { ok: false, error: fail('stopped', MESSAGES.stopped) });
    }
    const active = [...running];
    for (const entry of active) entry.controller.abort('stopped');
    await Promise.all(active.map((entry) => entry.finished));
  }

  return { kind, enqueue, stop };
}

/** edit/brief.json's `language` when it is a two-letter code, else null. Never throws. */
export async function briefLanguage(jobDir: string): Promise<string | null> {
  try {
    const brief: unknown = JSON.parse(await readFile(join(jobDir, BRIEF_JSON_PATH), 'utf8'));
    if (typeof brief !== 'object' || brief === null) return null;
    return normalizeLanguage((brief as { language?: unknown }).language);
  } catch {
    return null;
  }
}
