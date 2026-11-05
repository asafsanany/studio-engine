// The music of a job (Soundtrack plan, "The engine"). Built only while the Soundtrack switch is on
// (engine.ts).
//
//   read(job)              the job's edit/music/music.json, parsed with the shared schema. No file
//                          is `null` (a job from before Soundtrack, or edited with the switch off);
//                          a file that cannot be read or does not fit is `null` too, with a log line,
//                          so a broken record shows as no music, never as an error page
//   view(job)              GET /api/jobs/:id/music: the record plus canMake, whyNot and rev, or
//                          `null` without a record. `rev` is edit/preview/music.mp3's modified time
//                          in whole ms (0 while there is none): the music script writes that file
//                          fresh on every make and pick, so the number changes with the music
//   makeAnother(job, ask)  POST /api/jobs/:id/music: 202 and the script runs in the background
//                          (`make --again [--ask "<words>"] --by you`)
//   pick(job, id)          PUT /api/jobs/:id/music/pick: runs `pick`, answers the new view (a
//                          version, off, the folder's or the series' music, or the song)
//
// Both spawn the music script (music-script.ts: the server's node, no keys, cwd outside the job
// folder, its process tree stopped on shutdown and when the job is cancelled or deleted). One call
// at a time per job; at most `maxMakes` makes at once overall (the rest wait their turn); a Pick is
// quick and does not wait for the others.
//
// Allowed only while the video waits for the owner's review (state `review`, so no run is active) and
// the job is not an episode; otherwise 409 with a plain reason, which is also what `canMake` and
// `whyNot` of the view say (MUSIC_MESSAGES). Make another needs a plan in the record and nothing
// else of it: a first make that failed (a plan, no versions, nothing picked) is allowed, and is how
// the music gets made once ElevenLabs works again. While a version is being made, or a pick is under
// way, Approve and Send notes are refused (`reviewBlock`), so neither the render nor a revise run
// starts with music that is about to change.
//
// Two or more formats (GN7, C64): the script writes only edit/preview/music.mp3, so once a Make
// another or a Pick has changed it the service copies it into every extra format's folder that
// exists (edit/preview-<id>/music.mp3, format-music.ts) before the page hears of it, and Review's
// second format plays the new track too. A job with one format is as it was.
//
// While a quick fix is queued or running for the job (QF3, `fixBlock`), Make another and Pick are
// refused with the fix's words too, since the fix is changing edit/preview/ (and the music service
// tells the page when that starts and ends, as `canMake` / `whyNot` change). The fix service waits
// the other way round while the music is being made.
//
// The page hears of every change as `job.music` on the bus: a make started, made or failed, a pick,
// the allowed/not-allowed flip when the job's state changes (`listen`), and after every edit or
// revise run ends (`afterRun`, which also logs the run's versions in the usage log).
//
// What the view adds to the record, because the script writes it only while it works:
//   making   the engine's own call as soon as it is asked for (the script writes `making` a moment
//            later); the record's `making` only counts while a run edits the job (the edit run
//            calls the script itself), so one a killed script left behind never shows as making
//   failure  none while a version is being made; a make that ended without the script's answer (it
//            crashed, timed out or could not start) shows as a failure of its own

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findMusicVersion,
  type Job,
  type JobMusicEvent,
  MUSIC_FILES,
  MUSIC_MESSAGES,
  type MusicFailure,
  type MusicPickId,
  type MusicRecord,
  type MusicVersionId,
  type MusicView,
  musicRecordSchema,
  musicStillBeingMade,
  nextVersionId,
} from '@studio/shared';
import type { EventBus } from '../events/bus.js';
import type { RunnerLogger } from '../pipeline/claude-process.js';
import { copyMusicToFormats } from './format-music.js';
import {
  createMusicScriptRunner,
  type MusicScriptOutcome,
  type MusicScriptRunner,
  redactKeys,
} from './music-script.js';
import type { MusicUsageLogger } from './music-usage.js';

/** What a Make another or a Pick came to: the new view, or the refusal to answer. */
export type MusicActionResult =
  | { ok: true; view: MusicView }
  | { ok: false; status: 404 | 409 | 500; error: string };

export interface MusicService {
  /** The job's music.json, or `null` (none, or one that cannot be read: logged). */
  read(job: Job): Promise<MusicRecord | null>;
  /** The answer of GET /api/jobs/:id/music: `null` for a job without music.json. */
  view(job: Job): Promise<MusicView | null>;
  /** Make another, with the owner's words or without. The make runs in the background. */
  makeAnother(job: Job, ask?: string): Promise<MusicActionResult>;
  /** Pick a version, or off for No music. */
  pick(job: Job, id: MusicPickId): Promise<MusicActionResult>;
  /** The version the engine is making for the job right now, or `null`. */
  makingVersion(jobId: string): MusicVersionId | null;
  /** Why Approve and Send notes must wait (a version is being made, a pick is under way), or `null`. For the review service. */
  reviewBlock(jobId: string): string | null;
  /** Stops what the engine runs for the job (it was cancelled or deleted). Resolves once nothing is left. */
  stopJob(jobId: string): Promise<void>;
  /**
   * An edit or revise run of the job has ended: logs the versions it made in the usage log and
   * tells the page the job's music (a run may have made, picked or recorded music). Never rejects.
   */
  afterRun(job: Job): Promise<void>;
  /**
   * Follows the bus: stops the job's music when it is deleted or cancelled, and tells the page the
   * job's music when a change of the job's state changes what it may do. Returns the stop function.
   */
  listen(bus: Pick<EventBus, 'subscribe'>): () => void;
  /** Shutdown: no new calls, and what runs is stopped. */
  stop(): Promise<void>;
}

export type MusicLogger = Pick<RunnerLogger, 'warn'> &
  Partial<Pick<RunnerLogger, 'info' | 'error'>>;

export interface MusicServiceOptions {
  /** Config.inboxPath: a job's folder is <inboxPath>/<job.relPath>. */
  inboxPath: string;
  logger: MusicLogger;
  /** The job as it is now (a make ends long after the request). Default: the job the request gave. */
  jobs?: { get(id: string): Job | null };
  /** Tells the page: `job.music`. Default: nobody. */
  publish?: (event: JobMusicEvent) => void;
  /** Runs the music script. Default: the real one (music-script.ts), run in the OS temp folder. */
  run?: MusicScriptRunner;
  /** Makes the music with the script's fake path (a tone, no network): the fake runner's engine. Default off. */
  fake?: boolean;
  /**
   * Why Make another and Pick must wait for this job though the music itself is free, or `null`:
   * a quick fix is queued or running and is changing edit/preview/ (quick fixes, QF3). Asked from
   * memory. Default: never.
   */
  fixBlock?: (jobId: string) => string | null;
  /** Logs the versions that were made in the usage log. Default: nothing. */
  usage?: MusicUsageLogger;
  /** Most makes at once, overall. Default 2. */
  maxMakes?: number;
  /** The most a make may take, in ms. Default 5 minutes (the script itself gives up after about 4). */
  makeTimeoutMs?: number;
  /** The most a pick may take, in ms. Default 60 s. */
  pickTimeoutMs?: number;
  /** For the time a make started. Default `() => new Date()`. */
  clock?: () => Date;
}

/** A job's edit/ folder. */
export function editDirOf(inboxPath: string, job: Pick<Job, 'relPath'>): string {
  return join(inboxPath, job.relPath, 'edit');
}

export const MAX_MAKES = 2;
export const MAKE_TIMEOUT_MS = 5 * 60_000;
export const PICK_TIMEOUT_MS = 60_000;

/** What the engine is running for a job: a make, or a pick. */
interface Active {
  kind: 'make' | 'pick';
  /** The version being made, or the pick. */
  id: string;
  ask: string | null;
  startedAt: string;
  controller: AbortController;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Why Make another and Pick are not allowed now, or `null`: the job is an episode (the series
 * brings the music), it is not waiting for review, a version is being made, a pick is under way, or
 * (Make another only, `needsPlan`) there is no plan to make another version from.
 */
export function whyNotMake(
  job: Pick<Job, 'state' | 'seriesId'>,
  record: Pick<MusicRecord, 'plan'> | null,
  active: Pick<Active, 'kind' | 'id'> | null,
  { needsPlan = true }: { needsPlan?: boolean } = {},
): string | null {
  if (job.seriesId !== null) return MUSIC_MESSAGES.episode;
  if (job.state !== 'review') return MUSIC_MESSAGES.notInReview;
  if (active?.kind === 'make') return musicStillBeingMade(active.id);
  if (active !== null) return MUSIC_MESSAGES.busy;
  if (needsPlan && record?.plan == null) return MUSIC_MESSAGES.noPlan;
  return null;
}

/**
 * Whether the record has `id` to pick: No music, a version it made, the folder's / the series'
 * music it brought (to put back after No music), or the song that was got for the video (Songs:
 * the record's `song`, which stays in the list while a version is picked instead).
 */
export function hasPick(
  record: Pick<MusicRecord, 'source' | 'file' | 'versions' | 'song'>,
  id: MusicPickId,
): boolean {
  if (id === 'off') return true;
  if (id === 'file') return record.source === 'supplied' && record.file !== null;
  if (id === 'series') return record.source === 'series' && record.file !== null;
  if (id === 'song') return record.song !== null;
  return findMusicVersion(record, id) !== null;
}

/** At most `max` at a time; the rest wait their turn, and a waiter whose signal aborts leaves the line. */
class Limiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** Resolves true once there is room, false when `signal` aborted first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = (): void => {
        signal.removeEventListener('abort', leave);
        this.running += 1;
        resolve(true);
      };
      const leave = (): void => {
        const at = this.waiting.indexOf(grant);
        if (at !== -1) this.waiting.splice(at, 1);
        resolve(false);
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', leave, { once: true });
    });
  }

  release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}

export function createMusicService({
  inboxPath,
  logger,
  jobs,
  publish,
  run = createMusicScriptRunner(),
  fake = false,
  fixBlock,
  usage,
  maxMakes = MAX_MAKES,
  makeTimeoutMs = MAKE_TIMEOUT_MS,
  pickTimeoutMs = PICK_TIMEOUT_MS,
  clock = () => new Date(),
}: MusicServiceOptions): MusicService {
  const active = new Map<string, Active>();
  /** What each running call ends with, so `stopJob` and `stop` can wait for it. */
  const running = new Map<string, Promise<void>>();
  /** Makes that ended without the script's answer, by job: shown as the failure until the next make. */
  const lost = new Map<string, MusicFailure>();
  const limiter = new Limiter(maxMakes);
  let stopped = false;

  async function read(job: Job): Promise<MusicRecord | null> {
    const path = join(editDirOf(inboxPath, job), MUSIC_FILES.record);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return null;
      logger.warn(
        { err, jobId: job.id, path },
        'could not read music.json; the job shows no music',
      );
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      logger.warn({ err, jobId: job.id, path }, 'music.json is not JSON; the job shows no music');
      return null;
    }
    const parsed = musicRecordSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn(
        { jobId: job.id, path, issues: parsed.error.issues.slice(0, 5) },
        'music.json does not fit the contract; the job shows no music',
      );
      return null;
    }
    return parsed.data;
  }

  /** edit/preview/music.mp3's modified time in whole ms, 0 while there is none. */
  async function rev(job: Job): Promise<number> {
    try {
      const info = await stat(join(editDirOf(inboxPath, job), MUSIC_FILES.preview));
      return Math.max(0, Math.floor(info.mtimeMs));
    } catch {
      return 0;
    }
  }

  async function view(job: Job): Promise<MusicView | null> {
    const record = await read(job);
    if (record === null) return null;
    const call = active.get(job.id) ?? null;
    const whyNot = whyNotMake(job, record, call) ?? fixBlock?.(job.id) ?? null;
    const making =
      call?.kind === 'make'
        ? { id: call.id as MusicVersionId, ask: call.ask, startedAt: call.startedAt }
        : job.state === 'editing'
          ? record.making
          : null;
    return {
      ...record,
      making,
      failure: making !== null ? null : (record.failure ?? lost.get(job.id) ?? null),
      canMake: whyNot === null,
      whyNot,
      rev: await rev(job),
    };
  }

  /** The job as it is now, or `null` once it is gone. */
  function current(job: Job): Job | null {
    return jobs === undefined ? job : jobs.get(job.id);
  }

  /** Tells the page the job's music as it is now. Never rejects. */
  async function announce(job: Job): Promise<void> {
    try {
      const now = current(job);
      if (now === null) return;
      publish?.({ type: 'job.music', jobId: now.id, music: await view(now) });
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'could not tell the page the job’s music');
    }
  }

  function failureOf(entry: Active, code: MusicFailure['code'], message: string): MusicFailure {
    return {
      id: entry.id as MusicVersionId,
      code,
      message: redactKeys(message),
      at: clock().toISOString(),
    };
  }

  /** Takes the job for a call. Synchronous, so two requests cannot both pass the guard. */
  function claim(job: Job, entry: Active): void {
    active.set(job.id, entry);
  }

  /** Starts a claimed call's work, and remembers it so `stopJob` and `stop` can wait for it. */
  function launch(job: Job, entry: Active, work: () => Promise<void>): Promise<void> {
    const done: Promise<void> = work().finally(() => {
      if (active.get(job.id) === entry) active.delete(job.id);
      if (running.get(job.id) === done) running.delete(job.id);
    });
    running.set(job.id, done);
    return done;
  }

  /** The script's outcome; a runner that throws (it should not) is a script that could not start. */
  async function runScript(call: Parameters<MusicScriptRunner>[0]): Promise<MusicScriptOutcome> {
    try {
      return await run(call);
    } catch (err) {
      return {
        kind: 'not_started',
        message: redactKeys(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  function scriptArgs(job: Job, command: string[], extra: string[] = []): string[] {
    return [
      command[0] as string,
      editDirOf(inboxPath, job),
      ...command.slice(1),
      ...extra,
      ...(fake ? ['--fake'] : []),
    ];
  }

  /**
   * What a call that has no answer from the script comes to, in the owner's words: it took too long, it
   * could not be started, or it stopped without printing its line. `null` when the script answered
   * (its failure is in music.json and its own words are in the line) or the call was stopped.
   */
  function lostFailure(entry: Active, outcome: MusicScriptOutcome): MusicFailure | null {
    switch (outcome.kind) {
      case 'stopped':
        return null;
      case 'timed_out':
        return failureOf(entry, 'down', 'Making the music took too long. Try again.');
      case 'not_started':
        return failureOf(
          entry,
          'failed',
          `The music script could not be started: ${outcome.message}`,
        );
      case 'ran': {
        if (outcome.line !== null) return null;
        const last = outcome.stderr
          .split('\n')
          .filter((line) => line.trim() !== '')
          .at(-1);
        const detail = last === undefined ? '' : ` (${last.slice(0, 200)})`;
        return failureOf(entry, 'failed', `The music script stopped without an answer${detail}.`);
      }
    }
  }

  /** Puts edit/preview/music.mp3 into the other formats' folders (two or more formats only). Never rejects. */
  async function mirrorToFormats(job: Job): Promise<void> {
    await copyMusicToFormats(editDirOf(inboxPath, job), job.formats, logger, job.id);
  }

  /** The background half of Make another. */
  async function runMake(job: Job, entry: Active): Promise<void> {
    const { signal } = entry.controller;
    let outcome: MusicScriptOutcome;
    if (await limiter.acquire(signal)) {
      try {
        outcome = await runScript({
          argv: scriptArgs(
            job,
            ['make', '--again'],
            [...(entry.ask === null ? [] : ['--ask', entry.ask]), '--by', 'you'],
          ),
          signal,
          timeoutMs: makeTimeoutMs,
        });
      } finally {
        limiter.release();
      }
    } else {
      outcome = { kind: 'stopped', reason: signal.reason === 'shutdown' ? 'shutdown' : 'cancel' };
    }

    // The call is over: the view says so from here on.
    if (active.get(job.id) === entry) active.delete(job.id);
    const failure = lostFailure(entry, outcome);
    if (failure === null) lost.delete(job.id);
    else lost.set(job.id, failure);
    if (outcome.kind === 'stopped') {
      logger.info?.({ jobId: job.id, version: entry.id, reason: outcome.reason }, 'music stopped');
      if (outcome.reason === 'shutdown') return;
    } else if (failure !== null) {
      logger.warn({ jobId: job.id, version: entry.id, code: failure.code }, failure.message);
    } else if (outcome.kind === 'ran' && outcome.line?.ok === false) {
      logger.warn(
        { jobId: job.id, version: entry.id, code: outcome.line.code },
        redactKeys(outcome.line.message),
      );
    }

    const now = current(job);
    if (now === null) return;
    if (outcome.kind === 'ran' && outcome.line?.ok === true) await mirrorToFormats(now);
    try {
      const record = await read(now);
      if (record !== null) await usage?.(now, record);
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'could not log the usage of the music');
    }
    await announce(now);
  }

  async function makeAnother(job: Job, ask?: string): Promise<MusicActionResult> {
    if (stopped) return { ok: false, status: 409, error: MUSIC_MESSAGES.stopping };
    const record = await read(job);
    // From here to `claim` nothing waits, so two requests cannot both pass.
    const refusal =
      whyNotMake(job, record, active.get(job.id) ?? null) ?? fixBlock?.(job.id) ?? null;
    if (refusal !== null) return { ok: false, status: 409, error: refusal };

    const words = ask?.replaceAll('\0', '').trim();
    const entry: Active = {
      kind: 'make',
      id: nextVersionId(record),
      ask: words === undefined || words === '' ? null : words,
      startedAt: clock().toISOString(),
      controller: new AbortController(),
    };
    lost.delete(job.id);
    claim(job, entry);
    try {
      const answer = await view(job);
      if (answer === null) {
        // The record vanished between the check and now: nothing to make from.
        if (active.get(job.id) === entry) active.delete(job.id);
        return { ok: false, status: 409, error: MUSIC_MESSAGES.noPlan };
      }
      // Told before the work starts, so the page never hears "made" and then "making".
      publish?.({ type: 'job.music', jobId: job.id, music: answer });
      return { ok: true, view: answer };
    } finally {
      if (active.get(job.id) === entry) {
        void launch(job, entry, () => runMake(job, entry)).catch((err: unknown) => {
          logger.error?.({ err, jobId: job.id }, 'making music failed unexpectedly');
        });
      }
    }
  }

  async function pick(job: Job, id: MusicPickId): Promise<MusicActionResult> {
    if (stopped) return { ok: false, status: 409, error: MUSIC_MESSAGES.stopping };
    const record = await read(job);
    const refusal =
      whyNotMake(job, record, active.get(job.id) ?? null, { needsPlan: false }) ??
      fixBlock?.(job.id) ??
      null;
    if (refusal !== null) return { ok: false, status: 409, error: refusal };
    if (record === null || !hasPick(record, id)) {
      return { ok: false, status: 404, error: MUSIC_MESSAGES.noSuchVersion };
    }
    if (record.picked === id) {
      const same = await view(job);
      return same === null
        ? { ok: false, status: 404, error: MUSIC_MESSAGES.noSuchVersion }
        : { ok: true, view: same };
    }

    const entry: Active = {
      kind: 'pick',
      id,
      ask: null,
      startedAt: clock().toISOString(),
      controller: new AbortController(),
    };
    const result: { outcome: MusicScriptOutcome } = {
      outcome: { kind: 'stopped', reason: 'cancel' },
    };
    claim(job, entry);
    await launch(job, entry, async () => {
      result.outcome = await runScript({
        argv: scriptArgs(job, ['pick', id]),
        signal: entry.controller.signal,
        timeoutMs: pickTimeoutMs,
      });
    });
    const { outcome } = result;

    if (outcome.kind === 'ran' && outcome.line?.ok === true) {
      const now = current(job) ?? job;
      await mirrorToFormats(now);
      const answer = await view(now);
      if (answer === null) return { ok: false, status: 404, error: MUSIC_MESSAGES.noSuchVersion };
      await announce(now);
      return { ok: true, view: answer };
    }
    if (outcome.kind === 'ran' && outcome.line?.ok === false) {
      // The script's own words (it says what is missing); the record is as it was.
      return { ok: false, status: 409, error: redactKeys(outcome.line.message) };
    }
    if (outcome.kind === 'stopped') {
      return { ok: false, status: 409, error: 'The music was not changed.' };
    }
    const failure = lostFailure(entry, outcome);
    logger.warn({ jobId: job.id, pick: id, outcome: outcome.kind }, 'could not pick the music');
    return { ok: false, status: 500, error: failure?.message ?? 'The music could not be changed.' };
  }

  async function stopJob(jobId: string): Promise<void> {
    const entry = active.get(jobId);
    if (entry !== undefined && !entry.controller.signal.aborted) entry.controller.abort('cancel');
    await running.get(jobId);
  }

  async function afterRun(job: Job): Promise<void> {
    try {
      const now = current(job);
      if (now === null) return;
      // A run's own makes and picks are the news now.
      lost.delete(now.id);
      const record = await read(now);
      if (record !== null) await usage?.(now, record);
      await announce(now);
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'could not look at the music a run left');
    }
  }

  function listen(bus: Pick<EventBus, 'subscribe'>): () => void {
    // What each job was last seen as: a change of state or series changes what it may do.
    const seen = new Map<string, string>();
    const quietly = (job: string, work: Promise<unknown>): void => {
      work.catch((err: unknown) => {
        logger.warn({ err, jobId: job }, 'could not follow a change of the job’s music');
      });
    };
    // Jobs a quick fix was holding the music back for when last looked at (QF3).
    const fixBlocked = new Set<string>();
    return bus.subscribe((event) => {
      if (event.type === 'job.remove') {
        seen.delete(event.id);
        lost.delete(event.id);
        fixBlocked.delete(event.id);
        quietly(event.id, stopJob(event.id));
        return;
      }
      if (event.type === 'job.fix' && fixBlock !== undefined) {
        // A fix starting or ending changes whether Make another and Pick are allowed (`canMake`, `whyNot`).
        const blocked = fixBlock(event.jobId) !== null;
        if (blocked === fixBlocked.has(event.jobId)) return;
        if (blocked) fixBlocked.add(event.jobId);
        else fixBlocked.delete(event.jobId);
        const job = jobs?.get(event.jobId);
        if (job === null || job === undefined) return;
        quietly(
          job.id,
          view(job).then((music) => {
            if (music !== null) publish?.({ type: 'job.music', jobId: job.id, music });
          }),
        );
        return;
      }
      if (event.type !== 'job.upsert') return;
      const { job } = event;
      if (job.state === 'cancelled') quietly(job.id, stopJob(job.id));
      const key = `${job.state}|${job.seriesId ?? ''}`;
      const before = seen.get(job.id);
      seen.set(job.id, key);
      if (before === undefined || before === key) return;
      quietly(
        job.id,
        view(job).then((music) => {
          if (music !== null) publish?.({ type: 'job.music', jobId: job.id, music });
        }),
      );
    });
  }

  async function stop(): Promise<void> {
    stopped = true;
    for (const entry of active.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort('shutdown');
    }
    await Promise.all([...running.values()]);
  }

  return {
    read,
    view,
    makeAnother,
    pick,
    makingVersion: (jobId) => {
      const call = active.get(jobId);
      return call?.kind === 'make' ? (call.id as MusicVersionId) : null;
    },
    reviewBlock: (jobId) => {
      const call = active.get(jobId);
      if (call === undefined) return null;
      return call.kind === 'make' ? musicStillBeingMade(call.id) : MUSIC_MESSAGES.busy;
    },
    stopJob,
    afterRun,
    listen,
    stop,
  };
}
