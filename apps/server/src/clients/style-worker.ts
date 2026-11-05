// The style worker (Phase 2 plan §5): runs the clients' style passes one at a time, apart from the
// edit worker, so a style can be made while a video is being edited.
//
//   enqueue(client, pass) ─▶ state analysing, last_pass stored, client.upsert
//     ─▶ its turn: the files that are still there, the mode settled against style.md
//        (a Learn pass: create or merge; the job's slots copied into a fresh _Style/kit/,
//        style-kit.ts)
//     ─▶ the style run (StyleRunner) writes _Style/style.md.new
//     ─▶ install (style-install.ts) ─▶ version + 1, state ready, client.upsert
//        (a Learn pass: the old kit to history, source_job_id = its job; a Read pass that replaces
//        the style: the kit to history too, since the new style.md has no ## Kit, C17)
//   any failure ─▶ state failed, "Style stopped: <reason>", client.upsert (and the old kit back)
//
// A client is `analysing` while a pass of it is queued or running, and its `last_pass` is what it
// still has to run: the running pass and the one waiting behind it, merged. So Retry after a
// failure, and the next start after a crash or a shutdown (both leave the client `analysing`), run
// exactly that again.
//
// Passes come from uploads, Retry and Finder drops (Read), and from every job that reached ready,
// Use this look and the first start's backfill (Learn, style-learn.ts). The routes refuse an
// upload, a Retry or Use this look while the client is analysing (409). A Finder drop can't be
// refused: its files join the pass waiting for that client, or wait behind the one running. When a
// run fails while another pass of the client waits, the failed pass's files join that one, so no
// file is left out of the style. Learn passes of two jobs never join: each job's look goes into
// the style in turn. A Learn pass `create` whose turn comes once the client has a style.md merges
// into it: the style made meanwhile stays. The edit worker waits for a client's Learn passes
// before it starts that client's next edit (`isLearning`, `learned`).
//
// Undo (style-history.ts) changes the style folder too, so it takes the same turn as a run: never
// while one of them is going on. The one exception is a Learn pass of the client, queued or running
// (Use this look is one, and its toast offers Undo for 10 s while the pass takes about 30): Undo
// cancels it instead. The run is aborted (reason `UNDO_REASON`), `style.md.new` is removed, the
// set-aside kit is put back and the client is `ready` again at the version it had, so the style is
// as it was before. A Learn pass that already installed (Undo came too late to stop it) is undone
// like any finished one, from history.
//
// Series passes (Series plan §3) run on the same queue, in the same turn, so everything that writes
// a client's `_Style` or `_Series` goes one at a time. The series service queues them
// (`enqueueSeries`) once it has connected the worker to the series (`attachSeries`):
//
//   { kind: 'series', mode: 'start' | 'replace', … }   Start a series, Use as the series format,
//                                                      an approved episode with Series notes (C26)
//     ─▶ its turn: series learning; the episode's composition copied into a fresh
//        _Series/<name>/kit/ (prepareKit, layout `series`, the same three safe moves); with
//        `notes`, the notes files still in the series folder and the `## Round N` sections of the
//        episode's edit/project.md go to the run (`SeriesNotesContext`)
//     ─▶ the series run (SeriesRunner) writes series.md.new, and a `start` while the client has a
//        style.md also _Style/style.md.new (the style without what only this series does)
//     ─▶ both checked before either is put in place; series version + 1 with the old series.md
//        and kit in the series' history; a `start` also puts style.md in place (style version + 1,
//        the old one in style history) and, when the style's kit came from the format job or a job
//        of this series, sends that kit to style history (the series has it now) and puts back the
//        kit it replaced, kept in style history, unless that one came from this series too (C23).
//        Which of these it is is settled before the run, which writes ## Kit to match
//        (`StartStyleKit`)
//     ─▶ series ready, the format job in the series, `installed` (the waiting jobs join by name)
//   any failure ─▶ series failed, "Series stopped: <reason>", both kits as they were, _Style
//                  untouched; with another pass of the series waiting, that one runs instead
//
// A series is `learning` while a pass of it is queued or running, and its `last_pass` is what
// Retry and the next start run again: the oldest of its passes. Series passes never merge.
// `isLearning` is true for a client's series passes too, so an episode waits for its series the
// way a job waits for its client's style. Undo of Start a series (`undoSeriesStart`) cancels a
// pass that is still queued or running, or takes back one that installed.
//
// A start queued while a style pass of the client is queued or running (the Learn pass of the
// format episode's approval, C23) waits behind it like any pass: the series is learning meanwhile,
// and the start settles the style's kit once it has the turn, against the style that pass left.

import { lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { episodeFrom, type Job } from '@studio/shared';
import type {
  ClientStyleInput,
  ClientStyleRepository,
  JobRepository,
  SeriesPatch,
  SeriesRepository,
  StoredClientStyle,
  StoredSeries,
} from '../db/index.js';
import { EDIT_DIR_NAME } from '../inbox/classify.js';
import { clientIdFor } from '../inbox/scan.js';
import { errorText, type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import { trimMessage } from '../pipeline/failure.js';
import {
  historyFileFor,
  historyKitDirFor,
  jobDirFor,
  KIT_DIR_NAME,
  SERIES_FILE_NAME,
  SERIES_NEW_FILE_NAME,
  STYLE_FILE_NAME,
  STYLE_NEW_FILE_NAME,
  seriesDirFor,
  seriesHistoryFileFor,
  seriesHistoryKitDirFor,
  styleDirFor,
  styleFileFor,
} from './paths.js';
import { roundSections } from './series-prompt.js';
import {
  moveSeriesToHistory,
  newestHistoryVersion,
  newestKeptKit,
  readSeriesStart,
  removeSeriesFolder,
  removeSeriesStart,
  restoreHistoryKit,
  undoStyle,
  writeHistorySource,
  writeSeriesStart,
} from './style-history.js';
import {
  checkNewSeries,
  checkNewStyle,
  type InstallOutcome,
  installStyle,
  putSeriesInPlace,
  putStyleInPlace,
} from './style-install.js';
import { keepPreviousKit, keepReplacedKit, prepareKit, restoreKit } from './style-kit.js';
import {
  mergePasses,
  parseSeriesPass,
  parseStylePass,
  passLogFields,
  type SeriesFile,
  type SeriesPass,
  type StyleFile,
  type StylePass,
  withStyleState,
} from './style-pass.js';
import {
  isSeriesRunner,
  type LearnContext,
  SERIES_STOPPED,
  type SeriesNotesContext,
  type SeriesRunner,
  STYLE_STOPPED,
  type StartStyleKit,
  type StyleRunner,
  type StyleRunOutcome,
} from './style-run.js';

/** The error of a client left analysing whose `last_pass` can't be run again. */
export const NOTHING_TO_RERUN = `${STYLE_STOPPED} the engine stopped during the style run, and there was nothing to run again.`;

/** The error of a series left learning whose `last_pass` can't be run again. */
export const NOTHING_TO_RERUN_SERIES = `${SERIES_STOPPED} the engine stopped during the series run, and there was nothing to run again.`;

/** The error of a series pass on a runner that can't run one (it has no `runSeries`). */
export const NO_SERIES_RUNNER = `${SERIES_STOPPED} this engine’s style runner can’t run series passes.`;

/** The editor's plan in a job's edit folder, where each revise run adds its `## Round N` section. */
const PROJECT_FILE_NAME = 'project.md';

/** The reason of the abort Undo sends to a running Learn pass (a shutdown's is `'shutdown'`). */
export const UNDO_REASON = 'undo';

/** Thrown for a Retry or an Undo the client's style does not allow; the route answers 409. */
export class StyleRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StyleRefusedError';
  }
}

/** The repository methods the worker uses. */
export type StyleWorkerRepository = Pick<ClientStyleRepository, 'get' | 'list' | 'upsert'>;

/** What the worker needs to run series passes (`attachSeries`). */
export interface WorkerSeriesOptions {
  /** Where each series stands. */
  series: Pick<SeriesRepository, 'get' | 'list' | 'update'>;
  /** The format job joins its series on install; Start cleans the kit of a style learned from an episode. */
  jobs: Pick<JobRepository, 'get' | 'setSeries'>;
  /** Runs the series passes. Default: the style runner, when it can (`isSeriesRunner`). */
  runner?: SeriesRunner;
  /** Called with a series whenever the worker changed it; `installed` when a series.md went in. */
  onChanged?: (series: StoredSeries, installed: boolean) => void;
  /** Called with a job the worker changed (the format job joining its series). */
  onJobChanged?: (job: Job) => void;
  /** Now, for the name of a series folder Undo keeps. */
  clock?: () => Date;
}

export interface StyleWorkerOptions {
  clientStyles: StyleWorkerRepository;
  /** `Config.inboxPath`: a client's style folder is `<inboxPath>/<Client>/_Style`. */
  inboxPath: string;
  /** `Config.dataDir`: replaced styles go to `<dataDir>/clients/<clientId>/history`. */
  dataDir: string;
  /** Writes style.md.new: the Claude run or the fake one (`createStyleRunner`). */
  runner: StyleRunner;
  /** Called with a style whenever the worker changed it; the engine publishes `client.upsert`. */
  onChanged?: (style: StoredClientStyle) => void;
  logger?: RunnerLogger;
}

/** Anything the queue runs: a style pass or a series pass. */
type WorkerPass = StylePass | SeriesPass;

interface QueuedPass<P extends WorkerPass = WorkerPass> {
  clientId: string;
  /** The client folder's name, as the latest pass of it spelled it. */
  client: string;
  pass: P;
}

interface RunningPass<P extends WorkerPass = WorkerPass> extends QueuedPass<P> {
  readonly controller: AbortController;
  /** Set when Undo asked to cancel the pass (the abort carries `UNDO_REASON`). */
  cancelRequested: boolean;
  /** Set once the pass stopped because of it: nothing was installed, the style is as it was. */
  cancelled: boolean;
}

/**
 * What a Start a series that rewrites the style does with the style's kit (C23), settled before its
 * run so the run writes ## Kit to match (`styleKit`) and the install does what the run was told.
 */
interface StartKitPlan {
  /** The style's kit came from the format job or a job of this series: it goes to style history. */
  fromSeries: boolean;
  /** The kit kept in style history that comes back in its place, or null for none. */
  restore: { version: number; sourceJobId: string | null } | null;
  /** What the run is told `_Style/kit/` holds once the start is in place. */
  styleKit: StartStyleKit;
}

function isSeriesPass(pass: WorkerPass): pass is SeriesPass {
  return pass.kind === 'series';
}

function isStyleQueued(queued: QueuedPass): queued is QueuedPass<StylePass> {
  return !isSeriesPass(queued.pass);
}

function isSeriesQueued(queued: QueuedPass): queued is QueuedPass<SeriesPass> {
  return isSeriesPass(queued.pass);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The bytes of something in `_Style`: a file, or a macOS package (a folder Finder shows as one
 * file, `Deck.key`) counted whole. Null when it is not there, or is a link.
 */
export async function styleFileSize(path: string): Promise<number | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return null;
  }
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return null;
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += (await lstat(join(entry.parentPath, entry.name))).size;
    }
  } catch {
    // Part of it vanished meanwhile: what was counted will do.
  }
  return total;
}

/** Passes of one client as one pass (see `mergePasses`); a pass that can't merge replaces. */
function combine(passes: readonly StylePass[]): StylePass | null {
  let combined: StylePass | null = null;
  for (const pass of passes)
    combined = combined === null ? pass : (mergePasses(combined, pass) ?? pass);
  return combined;
}

/** The fields a log line about a series pass carries. */
function seriesLogFields(pass: SeriesPass): Record<string, unknown> {
  return {
    kind: pass.kind,
    mode: pass.mode,
    seriesId: pass.seriesId,
    jobId: pass.jobId,
    job: pass.job,
    ...(pass.notes === undefined ? {} : { notes: pass.notes.length }),
  };
}

/** A style check's reason as a series failure ("Style stopped: …" becomes "Series stopped: …"). */
function asSeriesError(error: string): string {
  return error.startsWith(STYLE_STOPPED)
    ? `${SERIES_STOPPED}${error.slice(STYLE_STOPPED.length)}`
    : error;
}

export class StyleWorker {
  private readonly repo: StyleWorkerRepository;
  private readonly inboxPath: string;
  private readonly dataDir: string;
  private readonly runner: StyleRunner;
  private readonly onChanged: ((style: StoredClientStyle) => void) | undefined;
  private readonly logger: RunnerLogger;
  /** Set by `attachSeries`: without it no series pass can be queued. */
  private series: WorkerSeriesOptions | null = null;

  private accepting = false;
  private stopped = false;
  private draining = false;
  private drainPromise: Promise<void> = Promise.resolve();
  /** Passes waiting for their turn, oldest first; at most one per client while they can merge. */
  private readonly queue: QueuedPass[] = [];
  private running: RunningPass | null = null;
  /** The turn: a run and an Undo never change a style folder at the same time. */
  private turn: Promise<unknown> = Promise.resolve();
  /** Resolves when a pass is over (or the worker stops), for `learned`. */
  private passEnded: Promise<void>;
  private endPass: () => void = () => {};

  constructor(options: StyleWorkerOptions) {
    this.repo = options.clientStyles;
    this.inboxPath = options.inboxPath;
    this.dataDir = options.dataDir;
    this.runner = options.runner;
    this.onChanged = options.onChanged;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.passEnded = this.armPassEnded();
  }

  /** The client whose pass is running now, if any. */
  get activeClientId(): string | null {
    return this.running?.clientId ?? null;
  }

  /**
   * Lets the worker run series passes (the series service calls it once, before `start()`):
   * where the series are stored, the jobs, who hears about their changes and what runs them.
   */
  attachSeries(options: WorkerSeriesOptions): void {
    this.series = options;
  }

  /**
   * Boot. Queues the `last_pass` of every client a crash or a shutdown left `analysing` (oldest
   * first), and of every series left `learning`, then starts working. Passes queued before this
   * wait for it. Does nothing if already started, or after `stop()`.
   */
  start(): void {
    if (this.accepting || this.stopped) return;
    this.accepting = true;
    for (const style of this.repo.list().reverse()) {
      const { clientId, client } = style;
      if (
        style.state !== 'analysing' ||
        this.queue.some((queued) => queued.clientId === clientId && isStyleQueued(queued))
      ) {
        continue;
      }
      const pass = parseStylePass(style.lastPass);
      if (pass === null) {
        this.logger.warn({ clientId, client }, 'a style was left analysing with nothing to run');
        this.save({ clientId, client, state: 'failed', error: NOTHING_TO_RERUN });
        continue;
      }
      this.queue.push({ clientId, client, pass });
      this.logger.info({ clientId, client, kind: pass.kind }, 'running a stopped style pass again');
    }
    this.requeueSeries();
    this.kick();
  }

  /** The series a crash or a shutdown left learning: their `last_pass` runs again. */
  private requeueSeries(): void {
    const series = this.series;
    if (series === null) return;
    for (const stored of series.series.list()) {
      const { id, clientId, client } = stored;
      if (stored.state !== 'learning' || this.hasSeriesPass(clientId, id)) continue;
      const pass = parseSeriesPass(stored.lastPass);
      if (pass === null || pass.seriesId !== id) {
        this.logger.warn(
          { seriesId: id, client },
          'a series was left learning with nothing to run',
        );
        this.saveSeries(id, { state: 'failed', error: NOTHING_TO_RERUN_SERIES });
        continue;
      }
      this.queue.push({ clientId, client, pass });
      this.logger.info({ client, ...seriesLogFields(pass) }, 'running a stopped series pass again');
    }
  }

  /**
   * Queues a pass for `client` (the folder name) and marks the client `analysing`. A Read pass's
   * mode is settled now (create without a style.md) and again when it runs. Joins the pass already
   * waiting for the client, if there is one. Returns the style as stored.
   */
  async enqueue(client: string, pass: StylePass): Promise<StoredClientStyle> {
    const clientId = clientIdFor(client);
    const settled = withStyleState(pass, await isFile(styleFileFor(this.inboxPath, client)));
    const waiting = this.lastQueued(clientId);
    const merged =
      waiting === undefined || !isStyleQueued(waiting) ? null : mergePasses(waiting.pass, settled);
    if (waiting !== undefined && merged !== null) {
      waiting.client = client;
      waiting.pass = merged;
    } else {
      this.queue.push({ clientId, client, pass: settled });
    }
    const style = this.save({
      clientId,
      client,
      state: 'analysing',
      error: null,
      lastPass: this.pendingPass(clientId),
    });
    this.logger.info(
      { clientId, client, ...passLogFields(settled), joined: merged !== null },
      'style pass queued',
    );
    this.kick();
    return style;
  }

  /**
   * Queues a series pass for `client` (the folder name) and marks its series `learning`, with
   * `last_pass` what it now has to run. A series pass never joins another. Returns the series as
   * stored, or null when it is gone. Throws when no series are attached (`attachSeries`).
   */
  enqueueSeries(client: string, pass: SeriesPass): StoredSeries | null {
    if (this.series === null) throw new Error('The style worker runs no series passes.');
    const clientId = clientIdFor(client);
    this.queue.push({ clientId, client, pass });
    const stored = this.saveSeries(pass.seriesId, {
      client,
      state: 'learning',
      error: null,
      lastPass: this.pendingSeriesPass(pass.seriesId),
    });
    this.logger.info({ clientId, client, ...seriesLogFields(pass) }, 'series pass queued');
    this.kick();
    return stored;
  }

  /**
   * Whether a Learn pass or a series pass of the client is queued or running on a worker that runs
   * passes (started, not stopped). Before `start()` and after `stop()` nothing runs, so nothing is
   * worth waiting for.
   */
  isLearning(clientId: string): boolean {
    if (!this.accepting) return false;
    const learning = (pass: QueuedPass | null) =>
      pass !== null &&
      pass.clientId === clientId &&
      (pass.pass.kind === 'learn' || isSeriesPass(pass.pass));
    return learning(this.running) || this.queue.some(learning);
  }

  /**
   * Resolves once the client has no Learn or series pass queued or running (see `isLearning`): the
   * edit worker waits on it before it starts that client's next edit, so its Brief step copies the
   * learned style and series (Phase 2 plan §5, C10). Also resolves when the worker stops.
   */
  async learned(clientId: string): Promise<void> {
    while (this.isLearning(clientId)) await this.passEnded;
  }

  /** Whether a style pass of the client is queued or running. */
  hasStylePass(clientId: string): boolean {
    const of = (queued: QueuedPass | null) =>
      queued !== null && queued.clientId === clientId && isStyleQueued(queued);
    return of(this.running) || this.queue.some(of);
  }

  /** Whether a series pass of the client (of the series `seriesId`, when given) is queued or running. */
  hasSeriesPass(clientId: string, seriesId?: string): boolean {
    const of = (queued: QueuedPass | null) =>
      queued !== null &&
      queued.clientId === clientId &&
      isSeriesQueued(queued) &&
      (seriesId === undefined || queued.pass.seriesId === seriesId);
    return of(this.running) || this.queue.some(of);
  }

  /**
   * Undo (Phase 2 plan §5). While a Learn pass of the client is queued or running it cancels that
   * pass (see the top of this file) and answers the style as it was. Otherwise it puts the newest
   * style kept in history back, with its kit when it has one, and adds 1 to the version.
   * `StyleRefusedError` while another kind of pass is going on or when nothing was ever kept.
   * Returns the style as stored.
   */
  async undo(client: string): Promise<StoredClientStyle> {
    const clientId = clientIdFor(client);
    const cancelling = this.cancelLearn(clientId);
    if (cancelling?.run === null) {
      // Only queued passes were dropped: they touched nothing, so there is no turn to wait for
      // (another client's run may hold it for a long time).
      const stored = this.repo.get(clientId);
      if (stored !== null) return await this.settleDropped(stored, client);
    }
    return this.inTurn(async () => {
      if (cancelling?.run?.cancelled) {
        // The pass stopped in its turn, put the kit back and settled the client (`finishCancel`).
        const stored = this.repo.get(clientId);
        if (stored !== null) return stored;
      }
      // Not cancelled: no Learn pass, or one that was already installing and finished.
      return this.restoreFromHistory(clientId, client);
    });
  }

  /**
   * The client after its queued Learn passes were dropped: ready again when nothing of it is left
   * to do, else still analysing (a Read pass running or waiting), with `last_pass` as it is now.
   */
  private async settleDropped(
    stored: StoredClientStyle,
    client: string,
  ): Promise<StoredClientStyle> {
    const { clientId } = stored;
    if (stored.state !== 'analysing') return stored;
    if (this.running?.clientId !== clientId || !isStyleQueued(this.running)) {
      return this.settleIdle(clientId, client);
    }
    return this.save({
      clientId,
      client,
      state: 'analysing',
      lastPass: this.pendingPass(clientId),
    });
  }

  /**
   * Cancels the client's Learn passes: the queued ones are dropped, the running one is aborted (it
   * puts the kit back and settles the client when it stops, see `runStylePass`). Null when the
   * client has none; otherwise the running one, if there was one.
   */
  private cancelLearn(clientId: string): { run: RunningPass | null } | null {
    const isLearn = (pass: QueuedPass) => pass.clientId === clientId && pass.pass.kind === 'learn';
    const run = this.running !== null && isLearn(this.running) ? this.running : null;
    const dropped = this.dropQueued(isLearn);
    if (run === null && dropped === 0) return null;
    this.logger.info(
      { clientId, running: run !== null, queued: dropped },
      'Undo cancels the Learn pass of the client',
    );
    if (run !== null) {
      run.cancelRequested = true;
      run.controller.abort(UNDO_REASON);
    }
    return { run };
  }

  /**
   * Drops the queued passes `which` picks and returns how many; whoever waits for a client's passes
   * (`learned`) then has fewer of them to wait for.
   */
  private dropQueued(which: (queued: QueuedPass) => boolean): number {
    let dropped = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index];
      if (queued !== undefined && which(queued)) {
        this.queue.splice(index, 1);
        dropped += 1;
      }
    }
    if (dropped > 0) this.endPass();
    return dropped;
  }

  /** Undo of a style no Learn pass is working on: the newest kept style comes back. */
  private async restoreFromHistory(clientId: string, client: string): Promise<StoredClientStyle> {
    const stored = this.repo.get(clientId);
    if (stored?.state === 'analysing' || this.hasStylePass(clientId)) {
      throw new StyleRefusedError('The style is being analysed. Undo once it is done.');
    }
    const restore = await newestHistoryVersion(this.dataDir, clientId);
    if (restore === null) throw new StyleRefusedError('There is no earlier style to go back to.');

    // Every kept version is below the current one, so the current style is kept above them.
    const keepAs = Math.max(stored?.version ?? 0, restore + 1);
    const { sourceJobId } = await undoStyle({
      dataDir: this.dataDir,
      clientId,
      styleDir: styleDirFor(this.inboxPath, client),
      restore,
      keepAs,
      sourceJobId: stored?.sourceJobId ?? null,
    });
    const style = this.save({
      clientId,
      client,
      // A Finder drop may have queued a pass meanwhile: it runs next.
      state: this.hasStylePass(clientId) ? 'analysing' : 'ready',
      version: keepAs + 1,
      error: null,
      sourceJobId,
    });
    this.logger.info({ clientId, client, restored: restore, version: keepAs + 1 }, 'style undone');
    return style;
  }

  /** Runs a failed client's `last_pass` again; `StyleRefusedError` when it has not failed. */
  async retry(client: string): Promise<StoredClientStyle> {
    const stored = this.repo.get(clientIdFor(client));
    if (stored?.state !== 'failed') {
      throw new StyleRefusedError('The style has not failed, so there is nothing to retry.');
    }
    const pass = parseStylePass(stored.lastPass);
    if (pass === null) throw new StyleRefusedError('The failed style run cannot be run again.');
    return this.enqueue(client, pass);
  }

  /**
   * Undo of Start a series (Series plan §3), for the series service, which then deletes the row and
   * takes its jobs out. A pass of the series that is queued is dropped and one that is running is
   * stopped (it puts the kit back and removes what it wrote); then, in the worker's turn, a series
   * that never installed has its folder removed, and one that did has the style.md and kit the
   * start replaced put back from style history and its folder moved to its history. `_Series`
   * goes too when that leaves it empty.
   */
  async undoSeriesStart(seriesId: string): Promise<void> {
    const series = this.series;
    if (series === null) return;
    const run = this.cancelSeries(seriesId);
    const stored = series.series.get(seriesId);
    if (stored === null) return;
    const seriesDir = seriesDirFor(this.inboxPath, stored.client, stored.name);
    if (run === null && stored.version === 0 && !(await isDirectory(seriesDir))) {
      // Nothing of it ran or is on disk: there is no turn to wait for.
      return;
    }
    await this.inTurn(async () => {
      // A running pass may have installed before it heard of the Undo.
      const now = series.series.get(seriesId) ?? stored;
      if (now.version > 0) await this.undoInstalledStart(now, seriesDir);
      else await removeSeriesFolder(seriesDir);
      this.logger.info(
        { seriesId, client: now.client, installed: now.version > 0 },
        'Start a series undone',
      );
    });
  }

  /**
   * Cancels every pass of the series: the queued ones are dropped, the running one is aborted (see
   * `runSeriesPass`). Returns the running one, if there was one.
   */
  private cancelSeries(seriesId: string): RunningPass | null {
    const isOf = (queued: QueuedPass) =>
      isSeriesQueued(queued) && queued.pass.seriesId === seriesId;
    const run = this.running !== null && isOf(this.running) ? this.running : null;
    const dropped = this.dropQueued(isOf);
    if (run === null && dropped === 0) return null;
    this.logger.info(
      { seriesId, running: run !== null, queued: dropped },
      'Undo cancels the passes of the series',
    );
    if (run !== null) {
      run.cancelRequested = true;
      run.controller.abort(UNDO_REASON);
    }
    return run;
  }

  /**
   * Undo of a Start a series that installed: the style kept when it was replaced comes back (with
   * the kit the start took, `undoStyle`), and the series folder goes to its history.
   */
  private async undoInstalledStart(stored: StoredSeries, seriesDir: string): Promise<void> {
    const { id, clientId, client } = stored;
    const record = await readSeriesStart(this.dataDir, clientId, id);
    const restore = record?.styleVersion ?? null;
    if (restore !== null && (await isFile(historyFileFor(this.dataDir, clientId, restore)))) {
      const style = this.repo.get(clientId);
      const newest = (await newestHistoryVersion(this.dataDir, clientId)) ?? restore;
      // Kept above every kept version, so nothing in history is written over.
      const keepAs = Math.max(style?.version ?? 0, newest + 1);
      const { sourceJobId } = await undoStyle({
        dataDir: this.dataDir,
        clientId,
        styleDir: styleDirFor(this.inboxPath, client),
        restore,
        keepAs,
        sourceJobId: style?.sourceJobId ?? null,
      });
      this.save({
        clientId,
        client,
        ...(style === null || style.state === 'none' ? { state: 'ready' as const } : {}),
        version: keepAs + 1,
        sourceJobId,
      });
    }
    const series = this.series;
    await moveSeriesToHistory({
      dataDir: this.dataDir,
      clientId,
      seriesId: id,
      seriesDir,
      at: series?.clock?.() ?? new Date(),
    });
    await removeSeriesStart(this.dataDir, clientId, id);
  }

  /**
   * Shutdown. Stops the running pass and waits for it, and starts nothing more. The client stays
   * `analysing` with its `last_pass`, so the next start runs it again.
   */
  async stop(): Promise<void> {
    this.accepting = false;
    this.stopped = true;
    this.running?.controller.abort('shutdown');
    this.endPass();
    await this.drainPromise;
  }

  /** Resolves when nothing is running and nothing is waiting. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.draining) await this.drainPromise;
  }

  private kick(): void {
    if (!this.accepting || this.draining) return;
    this.draining = true;
    this.drainPromise = this.drain();
  }

  // A pass leaves the queue only once it has the turn, so it is always either queued or running.
  // Waiting for the turn puts a step between "nothing left" and "loop ended", so a pass queued in
  // that moment is picked up by a new loop.
  private async drain(): Promise<void> {
    try {
      while (this.accepting) {
        const ran = await this.inTurn(async () => {
          const next = this.queue.shift();
          if (next === undefined) return false;
          if (isSeriesQueued(next)) await this.runSeriesPass(next);
          else if (isStyleQueued(next)) await this.runStylePass(next);
          return true;
        });
        if (!ran) break;
        this.endPass();
      }
    } catch (err) {
      this.logger.error({ err }, 'style worker stopped on an unexpected error');
    } finally {
      this.draining = false;
      if (this.accepting && this.queue.length > 0) this.kick();
    }
  }

  /** Runs `task` once nothing else has the turn. */
  private inTurn<T>(task: () => Promise<T>): Promise<T> {
    const result = this.turn.then(task);
    this.turn = result.catch(() => undefined);
    return result;
  }

  private armPassEnded(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.endPass = () => {
        this.passEnded = this.armPassEnded();
        resolve();
      };
    });
  }

  private async runStylePass(next: QueuedPass<StylePass>): Promise<void> {
    const { clientId, client } = next;
    const styleDir = styleDirFor(this.inboxPath, client);
    const running: RunningPass<StylePass> = {
      ...next,
      controller: new AbortController(),
      cancelRequested: false,
      cancelled: false,
    };
    const { signal } = running.controller;
    this.running = running;
    // Set while a Learn pass's new kit is in kit/ and the old one is set aside: the old one is put
    // back unless the new style.md is installed.
    let kitPending = false;
    // Set once the new style.md is in place: Undo is too late to cancel the pass then.
    let installedStyle = false;
    try {
      const pass = await this.settle(next.pass, styleDir);
      if (pass === null) {
        await this.skip(running);
        return;
      }
      running.pass = pass;
      this.save({
        clientId,
        client,
        state: 'analysing',
        error: null,
        lastPass: this.pendingPass(clientId),
      });
      // A file an earlier run left must never be taken for this run's work.
      await rm(join(styleDir, STYLE_NEW_FILE_NAME), { recursive: true, force: true });

      let learn: LearnContext | undefined;
      if (pass.kind === 'learn') {
        const jobDir = jobDirFor(this.inboxPath, client, pass.job);
        if (!(await isDirectory(join(jobDir, EDIT_DIR_NAME)))) {
          this.fail(
            running,
            trimMessage(`${STYLE_STOPPED} the job “${pass.job}” has no edit folder to learn from.`),
          );
          return;
        }
        kitPending = true;
        learn = { jobDir, kit: await prepareKit(jobDir, styleDir) };
      }

      // Undo (or a shutdown) may have come while the kit was copied: the run is not even started.
      const outcome = signal.aborted
        ? null
        : await this.runner
            .run({
              clientId,
              client,
              styleDir,
              pass,
              signal,
              ...(learn === undefined ? {} : { learn }),
            })
            .catch(
              (err: unknown): StyleRunOutcome => ({
                ok: false,
                error: trimMessage(`${STYLE_STOPPED} the style could not run: ${errorText(err)}`),
              }),
            );
      if (outcome === null || signal.aborted) {
        this.logger.info(
          { clientId, client },
          running.cancelRequested
            ? 'style run cancelled by Undo; the style stays as it was'
            : 'style run stopped; it runs again at the next start',
        );
        return;
      }
      const result = outcome.ok ? await this.install(running, styleDir) : outcome;
      if (result.ok) {
        kitPending = false;
        installedStyle = true;
      } else this.fail(running, result.error);
    } catch (err) {
      this.logger.error({ clientId, client, err }, 'style pass broke');
      try {
        this.fail(running, trimMessage(`${STYLE_STOPPED} ${errorText(err)}`));
      } catch (error) {
        this.logger.error({ clientId, err: error }, 'could not record the failed style pass');
      }
    } finally {
      if (kitPending) {
        await restoreKit(styleDir).catch((err: unknown) => {
          this.logger.error({ clientId, client, err }, 'could not put the old kit back');
        });
      }
      this.running = null;
      // Undo asked for this pass to be cancelled and it was not installed: whatever it did instead
      // (stopped, failed), the style is as it was before it.
      if (running.cancelRequested && !installedStyle) await this.finishCancel(running, styleDir);
    }
  }

  /**
   * Undo cancelled the running Learn pass and its kit is back: no `style.md.new` is left, and the
   * client is what it was before the pass (`settleIdle`), at the same version.
   */
  private async finishCancel(running: RunningPass, styleDir: string): Promise<void> {
    const { clientId, client } = running;
    running.cancelled = true;
    try {
      await rm(join(styleDir, STYLE_NEW_FILE_NAME), { recursive: true, force: true });
      await this.settleIdle(clientId, client);
    } catch (err) {
      this.logger.error({ clientId, client, err }, 'could not settle a cancelled style pass');
    }
  }

  /**
   * The pass as it can run now, or null when there is nothing to run. A Read pass: its files that
   * are still there, its mode settled. A Learn pass: its mode settled (a `create` merges into a
   * style.md made meanwhile).
   */
  private async settle(pass: StylePass, styleDir: string): Promise<StylePass | null> {
    if (pass.kind === 'learn') {
      return withStyleState(pass, await isFile(join(styleDir, STYLE_FILE_NAME)));
    }
    const files: StyleFile[] = [];
    for (const file of pass.files) {
      const size = await styleFileSize(join(styleDir, file.name));
      if (size !== null) files.push({ name: file.name, size });
    }
    if (files.length === 0) return null;
    return withStyleState({ ...pass, files }, await isFile(join(styleDir, STYLE_FILE_NAME)));
  }

  /** Nothing to run (none of a Read pass's files are left), and the style is as it was. */
  private async skip({ clientId, client, pass }: RunningPass<StylePass>): Promise<void> {
    await this.settleIdle(clientId, client);
    this.logger.info(
      { clientId, client, ...passLogFields(pass) },
      'style pass skipped: none of its files are left',
    );
  }

  /**
   * The client's state once none of its passes is running and the style is as it was: analysing
   * while a pass of it is queued, else ready (none without a style.md). The version is not touched.
   */
  private async settleIdle(clientId: string, client: string): Promise<StoredClientStyle> {
    const waiting = this.queuedPass(clientId);
    const hasStyle = await isFile(styleFileFor(this.inboxPath, client));
    return this.save({
      clientId,
      client,
      state: waiting !== null ? 'analysing' : hasStyle ? 'ready' : 'none',
      error: null,
      ...(waiting === null ? {} : { lastPass: waiting }),
    });
  }

  private async install(
    running: RunningPass<StylePass>,
    styleDir: string,
  ): Promise<InstallOutcome> {
    const { clientId, client, pass } = running;
    const stored = this.repo.get(clientId);
    const version = stored?.version ?? 0;
    const hadStyle = await isFile(join(styleDir, STYLE_FILE_NAME));
    let outcome: InstallOutcome;
    try {
      outcome = await installStyle({
        styleDir,
        historyFile: historyFileFor(this.dataDir, clientId, version),
      });
    } catch (err) {
      return {
        ok: false,
        error: trimMessage(
          `${STYLE_STOPPED} style.md could not be put in place: ${errorText(err)}`,
        ),
      };
    }
    if (!outcome.ok) return outcome;
    await this.keepHistory(running, styleDir, version, hadStyle, stored?.sourceJobId ?? null);

    const waiting = this.queuedPass(clientId);
    this.save({
      clientId,
      client,
      state: waiting === null ? 'ready' : 'analysing',
      version: version + 1,
      error: null,
      // A learned style comes from its job. One written from files alone does not, and one added
      // to keeps its source.
      ...(pass.kind === 'learn'
        ? { sourceJobId: pass.jobId }
        : pass.mode === 'add'
          ? {}
          : { sourceJobId: null }),
      lastPass: waiting ?? pass,
    });
    this.logger.info(
      { clientId, client, version: version + 1, ...passLogFields(pass) },
      'style.md updated',
    );
    return outcome;
  }

  /**
   * What goes to history beside the replaced style.md (`history/<version>.md`, which
   * `installStyle` kept): the job it was learned from and the kit it had, after a Learn pass or a
   * Read pass that replaced the style (the new style.md has no kit, C17). Add leaves the kit where
   * it is. Only here, once the new style.md is in place: a pass that failed or was cut short never
   * gets this far, so the old style.md and kit stay together. Best effort: the new style is in
   * place either way.
   */
  private async keepHistory(
    { clientId, client, pass }: RunningPass<StylePass>,
    styleDir: string,
    version: number,
    hadStyle: boolean,
    sourceJobId: string | null,
  ): Promise<void> {
    try {
      if (hadStyle) await writeHistorySource(this.dataDir, clientId, version, sourceJobId);
      const keptKit = historyKitDirFor(this.dataDir, clientId, version);
      if (pass.kind === 'learn') await keepPreviousKit(styleDir, keptKit, hadStyle);
      else if (pass.mode === 'replace') await keepReplacedKit(styleDir, keptKit);
    } catch (err) {
      this.logger.warn({ clientId, client, err }, 'could not keep the old kit in history');
    }
  }

  private fail(running: RunningPass<StylePass>, error: string): void {
    const { clientId, client, pass } = running;
    const waiting = this.queue.find(
      (queued): queued is QueuedPass<StylePass> =>
        queued.clientId === clientId && isStyleQueued(queued),
    );
    if (waiting !== undefined) {
      waiting.pass = mergePasses(pass, waiting.pass) ?? waiting.pass;
      this.save({
        clientId,
        client,
        state: 'analysing',
        error: null,
        lastPass: this.queuedPass(clientId),
      });
      this.logger.warn(
        { clientId, client, error },
        'style run failed; its files go with the next pass of the client',
      );
      return;
    }
    this.save({ clientId, client, state: 'failed', error, lastPass: pass });
    this.logger.warn({ clientId, client, error }, 'style run failed');
  }

  // --- series passes ----------------------------------------------------------------------------

  private async runSeriesPass(next: QueuedPass<SeriesPass>): Promise<void> {
    const { clientId, client } = next;
    const seriesId = next.pass.seriesId;
    const seriesDir = seriesDirFor(this.inboxPath, client, next.pass.series);
    const styleDir = styleDirFor(this.inboxPath, client);
    const running: RunningPass<SeriesPass> = {
      ...next,
      controller: new AbortController(),
      cancelRequested: false,
      cancelled: false,
    };
    const { signal } = running.controller;
    this.running = running;
    // Set while the episode's composition is in the series' kit/ and the old kit is set aside.
    let kitPending = false;
    // Set once series.md (and style.md) are in place: nothing to put back, Undo is too late.
    let installed = false;
    // Set when the run may write style.md.new: a start while the client has a style.md.
    let writesStyle = false;
    // With `writesStyle`: what the start does with the style's kit.
    let startKit: StartKitPlan | null = null;
    try {
      const series = this.series;
      const stored = series?.series.get(seriesId) ?? null;
      if (series === null || stored === null) {
        this.logger.info({ client, seriesId }, 'series pass skipped: the series is gone');
        return;
      }
      const jobDir = jobDirFor(this.inboxPath, client, running.pass.job);
      const notes = await this.settleNotes(running, seriesDir, jobDir);
      const { pass } = running;
      this.saveSeries(seriesId, {
        client,
        state: 'learning',
        error: null,
        lastPass: this.pendingSeriesPass(seriesId),
      });
      // A file an earlier run left must never be taken for this run's work.
      await rm(join(seriesDir, SERIES_NEW_FILE_NAME), { recursive: true, force: true });

      if (!(await isDirectory(join(jobDir, EDIT_DIR_NAME)))) {
        this.failSeries(
          running,
          trimMessage(`${SERIES_STOPPED} the episode “${pass.job}” has no edit folder.`),
        );
        return;
      }
      writesStyle = pass.mode === 'start' && (await isFile(join(styleDir, STYLE_FILE_NAME)));
      if (writesStyle) {
        await rm(join(styleDir, STYLE_NEW_FILE_NAME), { recursive: true, force: true });
        startKit = await this.planStartKit(clientId, pass, styleDir);
      }
      kitPending = true;
      const kit = await prepareKit(jobDir, seriesDir, 'series');
      if (kit.length === 0) {
        this.failSeries(
          running,
          trimMessage(
            `${SERIES_STOPPED} the episode “${pass.job}” has no composition to copy (edit/preview/ or edit/composition/).`,
          ),
        );
        return;
      }

      const runner = series.runner ?? (isSeriesRunner(this.runner) ? this.runner : null);
      if (runner === null) {
        this.failSeries(running, NO_SERIES_RUNNER);
        return;
      }
      // Undo (or a shutdown) may have come while the kit was copied: the run is not even started.
      const outcome = signal.aborted
        ? null
        : await runner
            .runSeries({
              clientId,
              client,
              seriesDir,
              styleDir,
              pass,
              writesStyle,
              signal,
              jobDir,
              ...(startKit === null ? {} : { styleKit: startKit.styleKit }),
              ...(notes === undefined ? {} : { notes }),
            })
            .catch(
              (err: unknown): StyleRunOutcome => ({
                ok: false,
                error: trimMessage(`${SERIES_STOPPED} the series could not run: ${errorText(err)}`),
              }),
            );
      if (outcome === null || signal.aborted) {
        this.logger.info(
          { client, seriesId },
          running.cancelRequested
            ? 'series run cancelled by Undo'
            : 'series run stopped; it runs again at the next start',
        );
        return;
      }
      const result = outcome.ok
        ? await this.installSeriesPass(running, { seriesDir, styleDir, startKit })
        : { ok: false as const, error: asSeriesError(outcome.error) };
      if (result.ok) {
        kitPending = false;
        installed = true;
      } else this.failSeries(running, result.error);
    } catch (err) {
      this.logger.error({ client, seriesId, err }, 'series pass broke');
      try {
        if (this.series?.series.get(seriesId)) {
          this.failSeries(running, trimMessage(`${SERIES_STOPPED} ${errorText(err)}`));
        }
      } catch (error) {
        this.logger.error({ seriesId, err: error }, 'could not record the failed series pass');
      }
    } finally {
      if (kitPending) {
        await restoreKit(seriesDir).catch((err: unknown) => {
          this.logger.error({ client, seriesId, err }, 'could not put the old series kit back');
        });
      }
      if (!installed) {
        // Whatever the run left is not the series' (nor the style's): the next run starts clean.
        await rm(join(seriesDir, SERIES_NEW_FILE_NAME), { recursive: true, force: true }).catch(
          () => {},
        );
        if (writesStyle) {
          await rm(join(styleDir, STYLE_NEW_FILE_NAME), { recursive: true, force: true }).catch(
            () => {},
          );
        }
      }
      this.running = null;
      if (running.cancelRequested && !installed) running.cancelled = true;
    }
  }

  /**
   * What the run of a pass with `notes` (C26) gets of them, or undefined for a pass without: the
   * notes files that are still in the series folder, at their size now, and the `## Round N`
   * sections of the episode's edit/project.md. The pass keeps only the files that are there, so
   * `last_pass` and Retry do too; one whose files are all gone runs as a plain `replace`.
   */
  private async settleNotes(
    running: RunningPass<SeriesPass>,
    seriesDir: string,
    jobDir: string,
  ): Promise<SeriesNotesContext | undefined> {
    const { notes, ...plain } = running.pass;
    if (notes === undefined) return undefined;
    const files: SeriesFile[] = [];
    for (const file of notes) {
      const size = await styleFileSize(join(seriesDir, file.name));
      if (size !== null) files.push({ name: file.name, size });
    }
    if (files.length === 0) {
      running.pass = plain;
      this.logger.warn(
        { client: running.client, ...seriesLogFields(running.pass) },
        'the review notes of the episode are gone from the series folder: the format is made without them',
      );
      return undefined;
    }
    running.pass = { ...plain, notes: files };
    const project = await readFile(join(jobDir, EDIT_DIR_NAME, PROJECT_FILE_NAME), 'utf8').catch(
      () => null,
    );
    return { files, rounds: project === null ? null : roundSections(project) };
  }

  /**
   * Puts a series run's work in place. Both new files are checked before either is put in place,
   * so a run that got one of them wrong changes neither. Then series.md (the old one and the kit
   * set aside to the series' history), style.md for a start that rewrote it (`startKit`, given
   * then), the series ready at its next version, and the format job in the series.
   */
  private async installSeriesPass(
    running: RunningPass<SeriesPass>,
    {
      seriesDir,
      styleDir,
      startKit,
    }: { seriesDir: string; styleDir: string; startKit: StartKitPlan | null },
  ): Promise<InstallOutcome> {
    const { clientId, client, pass } = running;
    const writesStyle = startKit !== null;
    const series = this.series;
    const stored = series?.series.get(pass.seriesId) ?? null;
    if (series === null || stored === null) {
      return { ok: false, error: `${SERIES_STOPPED} the series is gone.` };
    }
    const version = stored.version;
    const problem =
      (await checkNewSeries(seriesDir)) ??
      (writesStyle
        ? await checkNewStyle(styleDir).then((p) => (p === null ? null : asSeriesError(p)))
        : null);
    if (problem !== null) return { ok: false, error: problem };

    const hadSeries = await isFile(join(seriesDir, SERIES_FILE_NAME));
    try {
      await putSeriesInPlace({
        seriesDir,
        historyFile: seriesHistoryFileFor(this.dataDir, clientId, pass.seriesId, version),
      });
    } catch (err) {
      return {
        ok: false,
        error: trimMessage(
          `${SERIES_STOPPED} series.md could not be put in place: ${errorText(err)}`,
        ),
      };
    }
    if (pass.kind === 'series') {
      await keepPreviousKit(
        seriesDir,
        seriesHistoryKitDirFor(this.dataDir, clientId, pass.seriesId, version),
        hadSeries,
      ).catch((err: unknown) => {
        this.logger.warn(
          { client, seriesId: pass.seriesId, err },
          'could not keep the old series kit',
        );
      });
    }
    if (pass.kind === 'series' && pass.mode === 'start') {
      const styleVersion =
        startKit === null ? null : await this.installStartStyle(running, startKit, styleDir);
      await writeSeriesStart(this.dataDir, clientId, pass.seriesId, { styleVersion }).catch(
        (err: unknown) => {
          this.logger.warn({ client, seriesId: pass.seriesId, err }, 'could not record the start');
        },
      );
    }

    if (pass.kind === 'series') this.joinFormatJob(pass.seriesId, pass.jobId);
    const waiting = this.queuedSeriesPass(pass.seriesId);
    this.saveSeries(
      pass.seriesId,
      {
        client,
        state: waiting === null ? 'ready' : 'learning',
        version: version + 1,
        error: null,
        ...(pass.kind === 'series' ? { formatJobId: pass.jobId, formatJob: pass.job } : {}),
        lastPass: waiting ?? pass,
      },
      true,
    );
    this.logger.info(
      {
        clientId,
        client,
        version: version + 1,
        styleRewritten: writesStyle,
        ...seriesLogFields(pass),
      },
      'series.md updated',
    );
    return { ok: true };
  }

  /**
   * What Start a series will do with the style's kit (see `StartKitPlan`), settled before its run.
   * The kit stays unless the style came from the format job or a job of this series. Then it goes
   * to style history, and when there is one, the kit it replaced comes back: the newest kit kept
   * below the current version, unless it came from this series too or was no kit at all.
   */
  private async planStartKit(
    clientId: string,
    pass: SeriesPass,
    styleDir: string,
  ): Promise<StartKitPlan> {
    const style = this.repo.get(clientId);
    if (!this.isOfSeries(style?.sourceJobId ?? null, pass)) {
      return { fromSeries: false, restore: null, styleKit: { kind: 'keep' } };
    }
    const none: StartKitPlan = { fromSeries: true, restore: null, styleKit: { kind: 'none' } };
    // Only a kit that is set aside is replaced.
    if (!(await isDirectory(join(styleDir, KIT_DIR_NAME)))) return none;
    const kept = await newestKeptKit(this.dataDir, clientId, style?.version ?? 0).catch(
      (err: unknown) => {
        this.logger.warn({ clientId, err }, 'could not read the kits kept in style history');
        return null;
      },
    );
    if (kept === null || kept.names.length === 0 || this.isOfSeries(kept.sourceJobId, pass)) {
      return none;
    }
    const job =
      kept.sourceJobId === null ? null : (this.series?.jobs.get(kept.sourceJobId)?.name ?? null);
    return {
      fromSeries: true,
      restore: { version: kept.version, sourceJobId: kept.sourceJobId },
      styleKit: { kind: 'restore', names: kept.names, job, section: kept.section },
    };
  }

  /** Whether `jobId` is the format job of the `series` pass or a job of its series. */
  private isOfSeries(jobId: string | null, pass: SeriesPass): boolean {
    return (
      jobId !== null &&
      (jobId === pass.jobId || this.series?.jobs.get(jobId)?.seriesId === pass.seriesId)
    );
  }

  /**
   * Start a series rewrote the client's style: style.md goes in like a Learn pass's (version + 1,
   * the old one in style history with the job it came from). When the style's kit came from the
   * format job or another episode of this series (`plan`), that kit goes to style history beside it
   * and the style is no longer that job's look: the series has its kit now. The kit it replaced
   * comes back in its place when the plan says so (C23), and the style is that kit's job's again.
   * Returns the style version that was replaced (null when style.md could not be put in place, which
   * leaves the style as it was).
   */
  private async installStartStyle(
    { clientId, client, pass }: RunningPass<SeriesPass>,
    plan: StartKitPlan,
    styleDir: string,
  ): Promise<number | null> {
    const style = this.repo.get(clientId);
    const version = style?.version ?? 0;
    const sourceJobId = style?.sourceJobId ?? null;
    try {
      await putStyleInPlace({
        styleDir,
        historyFile: historyFileFor(this.dataDir, clientId, version),
      });
    } catch (err) {
      this.logger.error(
        { client, seriesId: pass.seriesId, err },
        'could not put the new style.md in place',
      );
      await rm(join(styleDir, STYLE_NEW_FILE_NAME), { recursive: true, force: true }).catch(
        () => {},
      );
      return null;
    }
    const { fromSeries, restore } = plan;
    const keptKit = historyKitDirFor(this.dataDir, clientId, version);
    // Set once the style's kit is in history: only then may another take its place.
    let setAside = false;
    let kept = false;
    try {
      await writeHistorySource(this.dataDir, clientId, version, sourceJobId);
      if (fromSeries) {
        kept = await keepReplacedKit(styleDir, keptKit);
        setAside = true;
      }
    } catch (err) {
      this.logger.warn({ clientId, client, err }, 'could not keep the old kit in history');
    }
    let restored = false;
    if (setAside && restore !== null) {
      try {
        // Undo of the start takes the kit that comes back out again: an empty kept kit says the
        // style had none (its kit/ went missing during the run).
        if (!kept) await mkdir(keptKit, { recursive: true });
        await restoreHistoryKit(this.dataDir, clientId, restore.version, styleDir);
        restored = true;
      } catch (err) {
        this.logger.warn({ clientId, client, err }, 'could not put the earlier kit back');
      }
    }
    this.save({
      clientId,
      client,
      ...(style === null || style.state === 'none' ? { state: 'ready' as const } : {}),
      version: version + 1,
      ...(fromSeries ? { sourceJobId: restored ? (restore?.sourceJobId ?? null) : null } : {}),
    });
    this.logger.info(
      {
        clientId,
        client,
        version: version + 1,
        kitToSeries: fromSeries,
        kitBack: restored ? restore?.version : null,
      },
      'style.md updated by Start a series',
    );
    return version;
  }

  /** The format job of an installed `series` pass is in its series (it joined when the series started). */
  private joinFormatJob(seriesId: string, jobId: string): void {
    const series = this.series;
    const job = series?.jobs.get(jobId) ?? null;
    if (series === null || job === null || job.seriesId === seriesId) return;
    try {
      const joined = series.jobs.setSeries(jobId, {
        seriesId,
        episode: episodeFrom(job.name),
        pinned: true,
      });
      series.onJobChanged?.(joined);
    } catch (err) {
      this.logger.warn({ seriesId, jobId, err }, 'could not put the format job in its series');
    }
  }

  /**
   * A series pass failed. With another pass of the series waiting, that one runs next and the
   * series stays learning with it as `last_pass`; otherwise the series is failed with this pass as
   * `last_pass`, so Retry runs it again.
   */
  private failSeries(running: RunningPass<SeriesPass>, error: string): void {
    const { client, pass } = running;
    const seriesId = pass.seriesId;
    const waiting = this.queuedSeriesPass(seriesId);
    if (waiting !== null) {
      this.saveSeries(seriesId, { client, state: 'learning', error: null, lastPass: waiting });
      this.logger.warn(
        { client, seriesId, error },
        'series run failed; the next pass of the series runs',
      );
      return;
    }
    this.saveSeries(seriesId, { client, state: 'failed', error, lastPass: pass });
    this.logger.warn({ client, seriesId, error }, 'series run failed');
  }

  /** The oldest queued pass of the series: what it runs next, or null for none. */
  private queuedSeriesPass(seriesId: string): SeriesPass | null {
    for (const queued of this.queue) {
      if (isSeriesQueued(queued) && queued.pass.seriesId === seriesId) return queued.pass;
    }
    return null;
  }

  /** The series' running pass, else its oldest queued one: what `last_pass` stores. */
  private pendingSeriesPass(seriesId: string): SeriesPass | null {
    const run = this.running;
    if (run !== null && isSeriesQueued(run) && run.pass.seriesId === seriesId) return run.pass;
    return this.queuedSeriesPass(seriesId);
  }

  /** Changes the series and tells about it when something changed (always when it `installed`). */
  private saveSeries(seriesId: string, patch: SeriesPatch, installed = false): StoredSeries | null {
    const series = this.series;
    if (series === null) return null;
    const before = series.series.get(seriesId);
    const after = series.series.update(seriesId, patch);
    if (after !== null && (installed || JSON.stringify(after) !== JSON.stringify(before))) {
      try {
        series.onChanged?.(after, installed);
      } catch (err) {
        this.logger.warn({ seriesId, err }, 'a series change listener failed');
      }
    }
    return after;
  }

  // --- the client's style passes ----------------------------------------------------------------

  /** The client's last queued pass, of either kind. */
  private lastQueued(clientId: string): QueuedPass | undefined {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index];
      if (queued?.clientId === clientId) return queued;
    }
    return undefined;
  }

  /** What the client's queued style passes would run, merged. */
  private queuedPass(clientId: string): StylePass | null {
    return combine(
      this.queue
        .filter(isStyleQueued)
        .filter((queued) => queued.clientId === clientId)
        .map((queued) => queued.pass),
    );
  }

  /** The client's running style pass and its queued ones, merged: what `last_pass` stores. */
  private pendingPass(clientId: string): StylePass | null {
    const run = this.running;
    const running =
      run !== null && run.clientId === clientId && isStyleQueued(run) ? [run.pass] : [];
    const queued = this.queuedPass(clientId);
    return combine(queued === null ? running : [...running, queued]);
  }

  private save(input: ClientStyleInput): StoredClientStyle {
    const { style, outcome } = this.repo.upsert(input);
    if (outcome !== 'unchanged') {
      try {
        this.onChanged?.(style);
      } catch (err) {
        this.logger.warn({ clientId: style.clientId, err }, 'a style change listener failed');
      }
    }
    return style;
  }
}
