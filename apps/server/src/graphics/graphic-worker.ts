// The queue of graphic runs (Graphics plan, "The queue"). OWNER: GR1.
//
//   - In memory, with the database rows as the truth. It runs beside the edits and never waits
//     for them.
//   - At most GRAPHIC_LIMITS.runsAtOnce runs at once, and one per graphic.
//   - Before a run: work/ is reset from the newest version, index.html and vendor/gsap.min.js are
//     written, _Fonts is copied into fonts/. Each change of step updates the row and publishes.
//   - After a run that exits 0 and passes the check: work/ becomes versions/vN/, the message is
//     done with about.reply, the graphic gets the version and about.json's fields (and its name
//     on v1 while it is still "New graphic …", which renames the folder).
//   - Stop aborts the run (its process tree); the row becomes stopped, work/ is left as it is.
//   - Boot (`start`): every row left making becomes failed with graphicStoppedByEngineMessage, and
//     the Claude processes a crashed engine left running are stopped (`reapRuns`) before the first
//     run is taken. Shutdown (`stop`) stops the runs the same way.
//
//   enqueue(graphic, message)          the claude row is `making` (the service made it)
//     ─▶ its turn: row startedAt, step 0 ─▶ prepareWork ─▶ runner.run (steps ─▶ row + event)
//     ─▶ the run ended ─▶ stopped / failed (timed out, the run's error)
//     ─▶ about.json written anew ─▶ checkGraphicWork ─▶ v1 names the graphic ─▶ versions/vN/
//     ─▶ row done (reply), graphic version + about.json's fields ─▶ graphic.changed

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanGraphicName,
  freeGraphicName,
  GRAPHIC_LIMITS,
  GRAPHIC_MESSAGES,
  type GraphicChangedEvent,
  type GraphicRemovedEvent,
  graphicStoppedByEngineMessage,
  runEffort,
} from '@studio/shared';
import {
  GraphicNameTakenError,
  type GraphicRepository,
  type StoredGraphic,
  type StoredGraphicMessage,
  toGraphicMessage,
} from '../db/index.js';
import { errorText } from '../pipeline/claude-process.js';
import type { ReapedRun } from '../pipeline/run-records.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { ABOUT_FILE, checkGraphicWork, type GraphicCheckResult } from './graphic-check.js';
import { FIRST_RUN_LENGTH_SEC, type GraphicFolders, graphicWorkDir } from './graphic-folders.js';
import type { GraphicRunner } from './graphic-run.js';

/** What the library tells the browsers: the engine publishes it on the bus as it is. */
export type GraphicEvent = GraphicChangedEvent | GraphicRemovedEvent;

export interface GraphicWorkerOptions {
  repo: GraphicRepository;
  folders: GraphicFolders;
  runner: GraphicRunner;
  /** Checks a run's work (graphic-check.ts's `checkGraphicWork`). Replaced in tests. */
  check?: (workDir: string, graphicId: string) => Promise<GraphicCheckResult>;
  /** Every change of a graphic or of one of its messages. */
  publish: (event: GraphicEvent) => void;
  logger: WorkerLogger;
  /**
   * Stops what an engine that died left running (`reapGraphicRuns(dataDir)`). The boot waits for it
   * before it takes the first run. Left out, nothing is reaped (tests).
   */
  reapRuns?: () => Promise<readonly ReapedRun[]>;
  /** Default `GRAPHIC_LIMITS.runsAtOnce`. */
  concurrency?: number;
  /** Default `GRAPHIC_LIMITS.runTimeoutMs`. */
  timeoutMs?: number;
  clock?: () => Date;
}

/** Why a run was aborted. */
type AbortReason = 'stop' | 'shutdown' | 'timeout';

/** A run that waits for its turn, or is going on. */
interface QueuedRun {
  graphicId: string;
  /** Claude's row this run fills. */
  messageId: string;
}

interface ActiveRun extends QueuedRun {
  readonly controller: AbortController;
  /** Set once, by whoever aborted it first. */
  reason: AbortReason | null;
  /** Settles once the run is over and its row written. */
  done: Promise<void>;
}

/** The name of a graphic no run has named yet: "New graphic", "New graphic (2)", … */
const UNNAMED = /^new graphic( \(\d+\))?$/i;

/** One plain sentence for an error nobody expected. */
function unexpected(error: unknown): string {
  const text = errorText(error).trim();
  return `The graphic could not be made: ${/[.!?]$/.test(text) ? text : `${text}.`}`;
}

/** Runs the graphic runs. OWNER: GR1. */
export class GraphicWorker {
  private readonly repo: GraphicRepository;
  private readonly folders: GraphicFolders;
  private readonly runner: GraphicRunner;
  private readonly check: (workDir: string, graphicId: string) => Promise<GraphicCheckResult>;
  private readonly publish: (event: GraphicEvent) => void;
  private readonly logger: WorkerLogger;
  private readonly reapRuns: (() => Promise<readonly ReapedRun[]>) | undefined;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly clock: () => Date;

  private readonly queue: QueuedRun[] = [];
  private readonly running = new Map<string, ActiveRun>();
  private stopped = false;
  /** True while the boot stops the leftovers of an earlier engine: no run starts meanwhile. */
  private reaping = false;

  constructor(options: GraphicWorkerOptions) {
    this.repo = options.repo;
    this.folders = options.folders;
    this.runner = options.runner;
    this.check = options.check ?? checkGraphicWork;
    this.publish = options.publish;
    this.logger = options.logger;
    this.reapRuns = options.reapRuns;
    this.concurrency = options.concurrency ?? GRAPHIC_LIMITS.runsAtOnce;
    this.timeoutMs = options.timeoutMs ?? GRAPHIC_LIMITS.runTimeoutMs;
    this.clock = options.clock ?? (() => new Date());
  }

  /** The runner it drives (`claude` or `fake`). */
  get runnerKind(): GraphicRunner['kind'] {
    return this.runner.kind;
  }

  /**
   * Starts taking runs, after failing every row a stopped engine left making ("The engine stopped
   * while it was making vN. Retry to make it again."), stopping the Claude processes it left
   * running and clearing the uploads it left half way. A run asked for meanwhile waits for the
   * processes to be stopped.
   */
  start(): void {
    this.stopped = false;
    for (const row of this.repo.makingMessages()) {
      if (this.isTracked(row.graphicId, row.id)) continue;
      this.repo.updateMessage(row.id, {
        status: 'failed',
        step: null,
        error: graphicStoppedByEngineMessage(row.version ?? 1),
        endedAt: this.iso(),
      });
      this.logger.warn(
        { graphicId: row.graphicId, messageId: row.id },
        'graphic: a run the engine left making is now failed',
      );
      this.emit(row.graphicId, row.id);
    }
    void this.folders
      .cleanStaging()
      .catch((err) =>
        this.logger.warn({ err }, 'graphic: could not clear the uploads left behind'),
      );
    this.reapLeftovers();
  }

  /** Stops what an earlier engine left running; the queue is held until that is done. */
  private reapLeftovers(): void {
    const reap = this.reapRuns;
    if (reap === undefined) return;
    this.reaping = true;
    void reap()
      .then((reaped) => {
        for (const stale of reaped) {
          this.logger.warn(
            { ...stale },
            'graphic: stopped a Claude run left over from an earlier engine',
          );
        }
      })
      .catch((err) => this.logger.warn({ err }, 'graphic: could not stop the runs left behind'))
      .finally(() => {
        this.reaping = false;
        this.pump();
      });
  }

  /** Stops every run (their rows become stopped) and takes no more. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const waiting of this.queue.splice(0)) this.markStopped(waiting);
    const active = [...this.running.values()];
    for (const run of active) this.abort(run, 'shutdown');
    await Promise.allSettled(active.map((run) => run.done));
  }

  /** Queues the run of Claude's row `messageId` (status making) of the graphic. */
  enqueue(graphicId: string, messageId: string): void {
    if (this.stopped) throw new Error('The engine is shutting down.');
    if (this.isMaking(graphicId)) throw new Error(`Graphic ${graphicId} is already being made.`);
    this.queue.push({ graphicId, messageId });
    this.pump();
  }

  /**
   * Stops the run of `messageId` if it is queued or running: a queued one leaves the line, a running
   * one is aborted (its process tree stops). Answers once the row is stopped. Whether there was one.
   */
  async stopRun(graphicId: string, messageId: string): Promise<boolean> {
    const active = this.running.get(graphicId);
    if (active !== undefined && active.messageId === messageId) {
      this.abort(active, 'stop');
      await active.done;
      return true;
    }
    const at = this.queue.findIndex(
      (waiting) => waiting.graphicId === graphicId && waiting.messageId === messageId,
    );
    if (at < 0) return false;
    const [waiting] = this.queue.splice(at, 1);
    if (waiting !== undefined) this.markStopped(waiting);
    return true;
  }

  /** Whether a run of the graphic is queued or running. */
  isMaking(graphicId: string): boolean {
    return (
      this.running.has(graphicId) || this.queue.some((waiting) => waiting.graphicId === graphicId)
    );
  }

  /** The message being made (or waiting to be) for the graphic, if any. */
  makingMessageOf(graphicId: string): string | null {
    return (
      this.running.get(graphicId)?.messageId ??
      this.queue.find((waiting) => waiting.graphicId === graphicId)?.messageId ??
      null
    );
  }

  // --- the queue ---------------------------------------------------------------------------------

  private isTracked(graphicId: string, messageId: string): boolean {
    return (
      this.running.get(graphicId)?.messageId === messageId ||
      this.queue.some(
        (waiting) => waiting.graphicId === graphicId && waiting.messageId === messageId,
      )
    );
  }

  private pump(): void {
    while (!this.stopped && !this.reaping && this.running.size < this.concurrency) {
      const next = this.queue.shift();
      if (next === undefined) return;
      this.begin(next);
    }
  }

  private begin(entry: QueuedRun): void {
    const run: ActiveRun = {
      ...entry,
      controller: new AbortController(),
      reason: null,
      done: Promise.resolve(),
    };
    this.running.set(entry.graphicId, run);
    run.done = this.execute(run)
      .catch((err) => {
        // A run that was stopped is stopped, whatever it threw on its way out.
        if (run.controller.signal.aborted) this.settleAborted(run);
        else this.fail(run, unexpected(err), err);
      })
      .finally(() => {
        this.running.delete(entry.graphicId);
        this.pump();
      });
  }

  private abort(run: ActiveRun, reason: AbortReason): void {
    run.reason ??= reason;
    run.controller.abort();
  }

  // --- one run -----------------------------------------------------------------------------------

  private async execute(run: ActiveRun): Promise<void> {
    const { graphicId, messageId } = run;
    const graphic = this.repo.get(graphicId);
    const row = this.repo.message(messageId);
    if (graphic === null || row === null || row.status !== 'making') return;
    const asked = this.askedBefore(graphicId, messageId);
    if (asked === null) {
      this.fail(run, 'There is no message of yours for this version to answer.');
      return;
    }
    const version = row.version ?? (graphic.version ?? 0) + 1;
    const first = graphic.version === null;

    this.repo.updateMessage(messageId, { startedAt: this.iso(), endedAt: null, step: 0, version });
    this.emit(graphicId, messageId);
    this.logger.info(
      { graphicId, messageId, version, runner: this.runner.kind },
      'graphic: run started',
    );

    const timer = setTimeout(() => this.abort(run, 'timeout'), this.timeoutMs);
    try {
      await this.folders.prepareWork(graphic.folder, {
        id: graphic.id,
        fromVersion: graphic.version,
        lengthSec: graphic.lengthSec ?? FIRST_RUN_LENGTH_SEC,
      });
      const workDir = graphicWorkDir(this.folders.dirOf(graphic.folder));
      // What a run answered before: a run that leaves it as it is has not answered this time.
      const before = await readAbout(workDir);
      if (run.controller.signal.aborted) return this.settleAborted(run);

      const outcome = await this.runner.run({
        graphic: { id: graphic.id, name: graphic.name, dir: this.folders.dirOf(graphic.folder) },
        message: {
          id: asked.message.id,
          text: asked.message.text,
          refs: asked.message.refs,
          effort: runEffort(asked.message.effort),
        },
        version,
        first,
        conversation: asked.conversation,
        signal: run.controller.signal,
        onStep: (step) => {
          if (run.controller.signal.aborted) return;
          const current = this.repo.message(messageId);
          if (current === null || current.status !== 'making' || current.step === step) return;
          this.repo.updateMessage(messageId, { step });
          this.emit(graphicId, messageId);
        },
      });
      if (run.controller.signal.aborted) return this.settleAborted(run);
      if (!outcome.ok) return this.fail(run, outcome.error);

      const after = await readAbout(workDir);
      if (after === null || (before !== null && after.equals(before))) {
        return this.fail(run, 'The run finished without writing a new about.json.');
      }
      const checked = await this.check(workDir, graphicId);
      if (run.controller.signal.aborted) return this.settleAborted(run);
      if (!checked.ok) return this.fail(run, checked.error);

      await this.finish(run, graphic, version, first, checked);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The run's work passed the check: it becomes the version, and the row and graphic say so. */
  private async finish(
    run: ActiveRun,
    graphic: StoredGraphic,
    version: number,
    first: boolean,
    checked: Extract<GraphicCheckResult, { ok: true }>,
  ): Promise<void> {
    const { about } = checked;
    const folder = await this.nameFromAbout(graphic, first, about.name);
    await this.folders.writeWorkHost(folder, graphic.id, about.lengthSec);
    await this.folders.saveVersion(folder, version);

    const ended = this.iso();
    this.repo.updateMessage(run.messageId, {
      status: 'done',
      text: about.reply,
      step: null,
      error: null,
      endedAt: ended,
    });
    this.repo.setVersion(graphic.id, {
      version,
      kind: about.kind,
      lengthSec: about.lengthSec,
      variables: about.variables,
      when: about.when,
    });
    this.logger.info(
      { graphicId: graphic.id, messageId: run.messageId, version },
      'graphic: run finished',
    );
    this.emit(graphic.id, run.messageId);
  }

  /**
   * v1 names a graphic that is still "New graphic …" from about.json's name (made free among the
   * other graphics), and the folder follows. Naming is a courtesy: when it cannot be done the
   * graphic keeps the name it has. Answers the graphic's folder (the new one, when it moved).
   */
  private async nameFromAbout(
    graphic: StoredGraphic,
    first: boolean,
    aboutName: string | undefined,
  ): Promise<string> {
    if (!first || aboutName === undefined || !UNNAMED.test(graphic.name)) return graphic.folder;
    const clean = cleanGraphicName(aboutName);
    if (clean === '') return graphic.folder;
    try {
      const onDisk = (await this.folders.names()).filter((name) => name !== graphic.folder);
      const name = freeGraphicName(clean, [...this.repo.liveNames(graphic.id), ...onDisk]);
      if (name === graphic.name) return graphic.folder;
      this.repo.rename(graphic.id, name, name);
      try {
        await this.folders.rename(graphic.folder, name);
      } catch (err) {
        this.repo.rename(graphic.id, graphic.name, graphic.folder);
        throw err;
      }
      return name;
    } catch (err) {
      if (!(err instanceof GraphicNameTakenError)) {
        this.logger.warn({ err, graphicId: graphic.id }, 'graphic: could not name it from its run');
      }
      return graphic.folder;
    }
  }

  // --- how a run ends ----------------------------------------------------------------------------

  /** A run that was aborted: stopped by Stop, a delete or the shutdown; failed when it ran out of time. */
  private settleAborted(run: ActiveRun): void {
    if (run.reason === 'timeout') {
      this.fail(run, GRAPHIC_MESSAGES.timedOut);
      return;
    }
    this.markStopped(run);
  }

  private markStopped(entry: QueuedRun): void {
    const row = this.repo.message(entry.messageId);
    if (row === null || row.status !== 'making') return;
    this.repo.updateMessage(entry.messageId, {
      status: 'stopped',
      step: null,
      endedAt: this.iso(),
    });
    this.logger.info(
      { graphicId: entry.graphicId, messageId: entry.messageId },
      'graphic: run stopped',
    );
    this.emit(entry.graphicId, entry.messageId);
  }

  private fail(run: ActiveRun, error: string, cause?: unknown): void {
    const row = this.repo.message(run.messageId);
    if (row === null || row.status !== 'making') return;
    this.repo.updateMessage(run.messageId, {
      status: 'failed',
      step: null,
      error: error.trim() === '' ? 'The run failed.' : error,
      endedAt: this.iso(),
    });
    this.logger.warn(
      {
        graphicId: run.graphicId,
        messageId: run.messageId,
        error,
        ...(cause === undefined ? {} : { err: cause }),
      },
      'graphic: run failed',
    );
    this.emit(run.graphicId, run.messageId);
  }

  // --- the chat, for the run ---------------------------------------------------------------------

  /**
   * The owner's message that Claude's row answers (the last of their before it) and the chat before it,
   * oldest first. `null` when the row has none.
   */
  private askedBefore(
    graphicId: string,
    messageId: string,
  ): { message: StoredGraphicMessage; conversation: ReturnType<typeof toGraphicMessage>[] } | null {
    const messages = this.repo.messages(graphicId);
    const at = messages.findIndex((message) => message.id === messageId);
    for (let i = at - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate?.role === 'you') {
        return { message: candidate, conversation: messages.slice(0, i).map(toGraphicMessage) };
      }
    }
    return null;
  }

  // --- events ------------------------------------------------------------------------------------

  /** Tells the browsers: the graphic as the list shows it, and the message that moved. */
  private emit(graphicId: string, messageId: string): void {
    const graphic = this.repo.summary(graphicId);
    if (graphic === null) return;
    const message = this.repo.message(messageId);
    this.publish({
      type: 'graphic.changed',
      graphic,
      ...(message === null ? {} : { message: toGraphicMessage(message) }),
    });
  }

  private iso(): string {
    return this.clock().toISOString();
  }
}

/** work/about.json as bytes, or `null` when there is none. */
async function readAbout(workDir: string): Promise<Buffer | null> {
  try {
    return await readFile(join(workDir, ABOUT_FILE));
  } catch {
    return null;
  }
}
