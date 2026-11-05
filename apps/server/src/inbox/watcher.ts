import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { InputCounts, Job, JobState } from '@studio/shared';
import { type FSWatcher, watch } from 'chokidar';
import type { ClientFolders } from '../clients/client-folders.js';
import { KIT_DIR_NAME, STYLE_FILE_NAME, STYLE_NEW_FILE_NAME } from '../clients/paths.js';
import type { JobRepository } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import {
  EDIT_DIR_NAME,
  EXPORTS_DIR_NAME,
  FONTS_DIR_NAME,
  GRAPHICS_DIR_NAME,
  isDotName,
  isIgnoredName,
  isPackageName,
  isReservedJobName,
  isReservedName,
  LUTS_DIR_NAME,
  STYLE_DIR_NAME,
} from './classify.js';
import { isRegisteredClient } from './client-registry.js';
import {
  ensureStyleDir,
  isClientFolder,
  jobIdFor,
  jobRelPath,
  type ScannedJob,
  scanJob,
} from './scan.js';

// The inbox watcher (architecture §3, §4). It turns file-system events under the inbox into job
// state changes:
//
//   event ─▶ which job? ─▶ coalesce per job ─▶ rescan the folder (W1) ─▶ upsert ─▶ publish
//                                                                          │
//   one settle timer per arriving job, due `settleMs` after its lastChangeAt ─▶ SETTLED ─▶ queued
//
// One more thing happens before any of that, on the event itself: a tripwire (see
// `warnOfFolderDuringEdit`) logs a warning when a new client or job folder shows up while a job is
// being edited, because the edit may have written it.
//
// A client folder that appears gets its `_Style` folder (`sweepClient`), and `_Style` is never
// taken for a job. What happens inside it goes to `onStyleEvent` instead (Phase 2 plan §5: files
// dropped there in Finder become a Read pass), less style.md, style.md.new, kit/, dotfiles and
// partial downloads (`locateStyleEvent`). The same sweep keeps the engine's list of client
// folders (`clients`), jobs or none: a folder found is added, one found gone is removed.
//
// Every state change goes through `JobRepository` (so through the shared state machine) and is
// published on the event bus as `job.upsert` / `job.remove`.

/** How deep below the inbox root chokidar looks: Client/Job/... six levels in all. */
export const WATCH_DEPTH = 6;

/** Events for one job that arrive within this window share one rescan. */
export const DEFAULT_DEBOUNCE_MS = 500;

/** The error text of a job whose folder vanished while it was being edited. */
export const FOLDER_REMOVED_ERROR = 'Folder was removed';

/**
 * How long the chokidar source waits after chokidar says it is ready. On macOS `ready` comes
 * before the system's file event stream is really running, and a folder created in the first
 * milliseconds after it is never reported (about 1 in 15 on a busy machine; 0 in 40 with 100 ms).
 */
export const CHOKIDAR_READY_GRACE_MS = 250;

/** The longest delay a timer can have; longer ones fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The states in which a change to the folder means something (see the state machine). */
const REACTS_TO_FILES: ReadonlySet<JobState> = new Set<JobState>(['arriving', 'queued', 'held']);

// --- the file-system side: which events count, and for which job -------------------------------

export type FsEventKind = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

/** One thing that happened on disk, as chokidar reports it. `path` is absolute. */
export interface FsEvent {
  kind: FsEventKind;
  path: string;
}

/**
 * Where file events come from. The real one is chokidar; tests drive the watcher with a fake so
 * that fake timers and file-system events do not fight each other.
 */
export interface FsEventSource {
  /** Starts watching. Resolves when the source is ready; events are passed to `emit` from then on. */
  start(emit: (event: FsEvent) => void): Promise<void>;
  /** Stops watching and releases the file handles. */
  stop(): Promise<void>;
}

/** Where things sit in the inbox: its root and, when it is inside, the exports folder. */
export interface PathRules {
  /** The inbox as an absolute path. */
  readonly inbox: string;
  /** The exports folder below the inbox as NFC path segments, or null when it is somewhere else. */
  readonly exportsSegments: readonly string[] | null;
}

const nfc = (text: string): string => text.normalize('NFC');

function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function createPathRules(inboxPath: string, exportsDir: string): PathRules {
  const inbox = resolve(inboxPath);
  const rel = relative(inbox, resolve(exportsDir));
  const inside = rel !== '' && !isOutside(rel);
  return { inbox, exportsSegments: inside ? rel.split(sep).map(nfc) : null };
}

/** `absPath` as folder names below the inbox: `[]` for the inbox itself, null for anywhere else. */
export function relativeSegments(rules: PathRules, absPath: string): string[] | null {
  const rel = relative(rules.inbox, absPath);
  if (rel === '') return [];
  return isOutside(rel) ? null : rel.split(sep);
}

/**
 * True for paths the engine never looks at. The same rules as the scanner (W1), seen from the
 * outside: dot-names, `_Exports`, `_Fonts`, `_Graphics` and `_LUTs` at client level, dot-names and the client's `_Style`,
 * `_Series` and `_Shared` folders at job level (all of it, whatever is inside), and inside a job the `edit/`
 * workspace at its root, dot-names and partial downloads, and the configured exports folder
 * wherever it sits. (`_Style` is watched apart from this, for the Read pass: see `styleRest`.)
 */
export function isIgnoredSegments(rules: PathRules, segments: readonly string[]): boolean {
  const [client, job, inJob] = segments;
  if (
    client !== undefined &&
    (isDotName(client) ||
      isReservedName(client, EXPORTS_DIR_NAME) ||
      isReservedName(client, FONTS_DIR_NAME) ||
      isReservedName(client, GRAPHICS_DIR_NAME) ||
      isReservedName(client, LUTS_DIR_NAME) ||
      !isRegisteredClient(client))
  ) {
    return true;
  }
  if (job !== undefined && (isDotName(job) || isReservedJobName(job))) return true;
  if (inJob !== undefined && isReservedName(inJob, EDIT_DIR_NAME)) return true;
  if (segments.slice(2).some((segment) => isIgnoredName(segment))) return true;
  return isInExports(rules, segments);
}

/** True for the configured exports folder and what is in it, wherever it sits in the inbox. */
function isInExports(rules: PathRules, segments: readonly string[]): boolean {
  const exported = rules.exportsSegments;
  return (
    exported !== null &&
    segments.length >= exported.length &&
    exported.every((segment, index) => segment === nfc(segments[index] ?? ''))
  );
}

// --- the style folder --------------------------------------------------------------------------

/**
 * An event inside a client's `_Style` folder that the Read pass cares about. `path` is the file's
 * path inside `_Style` ('/' between folders); an event inside a macOS package is about the package.
 */
export interface StyleFsEvent {
  kind: FsEventKind;
  client: string;
  path: string;
}

/**
 * True for what the Read pass never looks at inside `_Style` (`rest` is the path below it):
 * style.md and style.md.new at its top, kit/, and dot-names and partial downloads anywhere.
 */
export function isIgnoredInStyle(rest: readonly string[]): boolean {
  const [first] = rest;
  if (first === undefined) return false;
  if (rest.some((segment) => isIgnoredName(segment))) return true;
  if (isReservedName(first, KIT_DIR_NAME)) return true;
  return (
    rest.length === 1 &&
    (isReservedName(first, STYLE_FILE_NAME) || isReservedName(first, STYLE_NEW_FILE_NAME))
  );
}

/** The path below `_Style` when `segments` is a client's `_Style` or inside it, else null. */
function styleRest(rules: PathRules, segments: readonly string[]): string[] | null {
  const [client, folder, ...rest] = segments;
  if (client === undefined || folder === undefined || !isReservedName(folder, STYLE_DIR_NAME)) {
    return null;
  }
  // The client itself must be one: no dot-folder, no _Exports, nothing in the exports folder.
  if (isIgnoredSegments(rules, [client]) || isInExports(rules, segments)) return null;
  return rest;
}

/** True for a client's `_Style` folder and what is in it that the Read pass looks at. */
export function isWatchedStyleSegments(rules: PathRules, segments: readonly string[]): boolean {
  const rest = styleRest(rules, segments);
  return rest !== null && !isIgnoredInStyle(rest);
}

/** Maps an event to the style folder file it is about, or null (also for any folder appearing). */
export function locateStyleEvent(rules: PathRules, event: FsEvent): StyleFsEvent | null {
  if (event.kind === 'addDir') return null;
  const segments = relativeSegments(rules, event.path);
  if (segments === null) return null;
  const [client] = segments;
  const rest = styleRest(rules, segments);
  if (client === undefined || rest === null || rest.length === 0 || isIgnoredInStyle(rest)) {
    return null;
  }
  // A macOS package (Brand.pages) is one file, as for the scanner: a change inside it changes it.
  const pkg = rest.findIndex((segment) => isPackageName(segment));
  if (pkg !== -1 && pkg < rest.length - 1) {
    return { kind: 'change', client, path: rest.slice(0, pkg + 1).join('/') };
  }
  return { kind: event.kind, client, path: rest.join('/') };
}

/** What an event is about: a job folder, or a whole client folder (then `name` is absent). */
export type WatchTarget = { client: string; name: string } | { client: string; name?: undefined };

/**
 * Maps an event to the job it touches. Null for everything that is not part of a job: loose
 * files in the inbox or in a client folder, ignored paths, the inbox itself, anything outside it.
 * A change anywhere inside `Client/Job/` belongs to that job; folders appearing or vanishing at
 * `Client` or `Client/Job` level are about the client or the job itself.
 */
export function locateEvent(rules: PathRules, event: FsEvent): WatchTarget | null {
  const segments = relativeSegments(rules, event.path);
  if (segments === null || segments.length === 0 || isIgnoredSegments(rules, segments)) return null;

  const [client, name] = segments;
  if (client === undefined) return null;
  const isFolderEvent = event.kind === 'addDir' || event.kind === 'unlinkDir';
  if (name === undefined) return isFolderEvent ? { client } : null;
  if (segments.length === 2) return isFolderEvent ? { client, name } : null;
  return { client, name };
}

export interface ChokidarSourceOptions {
  inboxPath: string;
  exportsDir: string;
  /** Defaults to {@link WATCH_DEPTH}. */
  depth?: number;
  /** Extra wait after chokidar is ready, before `start()` resolves. Default {@link CHOKIDAR_READY_GRACE_MS}. */
  readyGraceMs?: number;
  /** Told about watcher errors, which are not fatal (an unreadable folder, a vanished file). */
  onError?: (error: unknown) => void;
}

/**
 * The real event source: chokidar v4 on the inbox root, ignoring what the scanner ignores, except
 * the style folders' files the Read pass looks at.
 */
export function createChokidarSource({
  inboxPath,
  exportsDir,
  depth = WATCH_DEPTH,
  readyGraceMs = CHOKIDAR_READY_GRACE_MS,
  onError,
}: ChokidarSourceOptions): FsEventSource {
  const rules = createPathRules(inboxPath, exportsDir);
  let watcher: FSWatcher | undefined;

  return {
    async start(emit) {
      // chokidar would watch nothing, and say nothing, for a folder that is not there.
      if (!(await isDirectory(rules.inbox))) {
        throw new Error(`The inbox folder does not exist: ${rules.inbox}`);
      }
      const instance = watch(rules.inbox, {
        depth,
        ignoreInitial: true,
        // The scanner does not follow folder links either.
        followSymlinks: false,
        ignored: (path) => {
          const segments = relativeSegments(rules, path);
          return (
            segments !== null &&
            isIgnoredSegments(rules, segments) &&
            !isWatchedStyleSegments(rules, segments)
          );
        },
      });
      watcher = instance;
      for (const kind of ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const) {
        instance.on(kind, (path) => emit({ kind, path }));
      }
      instance.on('error', (error) => onError?.(error));
      await new Promise<void>((ready) => instance.once('ready', () => ready()));
      // Resolve when events really flow, not when chokidar thinks it is ready (see the constant).
      await new Promise<void>((done) => setTimeout(done, readyGraceMs));
    },
    async stop() {
      const instance = watcher;
      watcher = undefined;
      await instance?.close();
    },
  };
}

// --- the watcher -------------------------------------------------------------------------------

/** Timer functions, injectable so tests can run a 90 s copy in no time. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real timers. They are unreferenced: a pending settle timer must not keep the process up. */
export const systemTimers: Timers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** The part of a pino logger the watcher uses. A pino `Logger` fits. */
export interface WatcherLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silentLogger: WatcherLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** The repository methods the watcher uses. */
export type WatcherRepository = Pick<
  JobRepository,
  'get' | 'getAll' | 'getEditing' | 'upsertFromScan' | 'applyTransition' | 'remove'
>;

export interface InboxWatcherOptions {
  /** The inbox root, `Config.inboxPath`. */
  inboxPath: string;
  /** The exports folder, `Config.exportsDir`. Ignored wherever it sits in the inbox. */
  exportsDir: string;
  /** How long a job's folder must be quiet before it is queued, `Config.settleMs` (60 000). */
  settleMs: number;
  repo: WatcherRepository;
  bus: EventBus;
  /** The time. Defaults to the system clock; tests pass the same fake they gave the repository. */
  clock?: () => Date;
  /** Defaults to {@link systemTimers}. */
  timers?: Timers;
  /**
   * Rescans one job folder; null means there is no such job any more. Defaults to W1's `scanJob`
   * on `inboxPath`. Tests use it to fake footage lengths.
   */
  scan?: (client: string, name: string) => Promise<ScannedJob | null>;
  /**
   * The Generate switch (`Config.generate`), for the default `scan`: it keeps the videos under a
   * job's `reference/` folder out of its footage (`ScanOptions.generate`). Left out, off.
   */
  generate?: boolean;
  /** Where file events come from. Defaults to chokidar ({@link createChokidarSource}). */
  source?: FsEventSource;
  /** Events for one job within this window share one rescan. Default 500 ms. */
  debounceMs?: number;
  logger?: WatcherLogger;
  /**
   * Called after a job that was being edited lost its folder and was marked failed
   * ("Folder was removed"). The boot wiring uses it to ask the worker (E2) to stop the run:
   * the job is already `failed`, so the worker must not try to cancel or fail it again.
   */
  onFolderRemovedWhileEditing?: (job: Job) => void;
  /**
   * Gets every event inside a client's `_Style` folder that `locateStyleEvent` lets through. The
   * boot wiring passes them to the Read pass's Finder drops (`StyleDrops`). Left out, they are
   * ignored, as everything in `_Style` used to be.
   */
  onStyleEvent?: (event: StyleFsEvent) => void;
  /**
   * The engine's list of client folders. A client folder the watcher finds is added to it, one it
   * finds gone is removed from it (which is where `client.added` / `client.removed` come from).
   * Left out, the watcher keeps no list.
   */
  clients?: Pick<ClientFolders, 'add' | 'remove'>;
  /**
   * The series name rule (Series plan §2, `assignSeries` in clients/series-assign.ts), run on a job
   * when it is first found and when it settles. It answers the job as it is afterwards, which is
   * what gets published. Left out, jobs keep their series.
   */
  assignSeries?: (job: Job) => Job;
}

export interface InboxWatcher {
  /** Starts watching; resolves when chokidar is ready. Does not arm timers: see {@link armAll}. */
  start(): Promise<void>;
  /** Stops watching, drops every timer and waits for rescans in flight. The watcher is spent. */
  stop(): Promise<void>;
  /**
   * Arms the settle timer of an `arriving` job (due `settleMs` after its `lastChangeAt`, at once
   * when that is past) or, for a job in any other state, disarms it. Safe to repeat.
   *
   * The watcher also does this for every `job.upsert` and `job.remove` on the bus, so a job that
   * comes back to `arriving` by a Release is picked up as long as whoever applied it publishes.
   */
  armSettleTimer(job: Job): void;
  /** {@link armSettleTimer} for every job in the repository. W3 calls it at boot, after reconciling. */
  armAll(): void;
  /** Feeds one file event in, as the event source does. Public for tests and replays. */
  notify(event: FsEvent): void;
  /** Resolves when no rescan is running. Timers that have not fired yet do not count. */
  whenIdle(): Promise<void>;
}

interface SettleTimer {
  handle: unknown;
  dueMs: number;
}

function sameInputs(a: InputCounts, b: InputCounts): boolean {
  return a.video === b.video && a.audio === b.audio && a.image === b.image && a.doc === b.doc;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

class Watcher implements InboxWatcher {
  private readonly rules: PathRules;
  private readonly exportsDir: string;
  private readonly settleMs: number;
  private readonly debounceMs: number;
  private readonly repo: WatcherRepository;
  private readonly bus: EventBus;
  private readonly clock: () => Date;
  private readonly timers: Timers;
  private readonly scan: (client: string, name: string) => Promise<ScannedJob | null>;
  private readonly source: FsEventSource;
  private readonly logger: WatcherLogger;
  private readonly onFolderRemovedWhileEditing: ((job: Job) => void) | undefined;
  private readonly onStyleEvent: ((event: StyleFsEvent) => void) | undefined;
  private readonly clients: Pick<ClientFolders, 'add' | 'remove'> | undefined;
  private readonly assignSeries: (job: Job) => Job;

  private started = false;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;

  /** Coalescing windows that are open, by job id (`client:<name>` for a whole client folder). */
  private readonly pending = new Map<string, unknown>();
  /** Rescans that are running, by job id. `again` is set when an event came in meanwhile. */
  private readonly active = new Map<string, { again: boolean }>();
  /** Everything in flight, for {@link whenIdle} and {@link stop}. */
  private readonly inflight = new Set<Promise<void>>();
  /** Settle timers by job id. */
  private readonly settle = new Map<string, SettleTimer>();

  constructor(options: InboxWatcherOptions) {
    const { settleMs, debounceMs = DEFAULT_DEBOUNCE_MS } = options;
    if (!Number.isFinite(settleMs) || settleMs < 0) {
      throw new RangeError(`settleMs must be a non-negative number, got ${settleMs}`);
    }
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new RangeError(`debounceMs must be a non-negative number, got ${debounceMs}`);
    }
    this.settleMs = settleMs;
    this.debounceMs = debounceMs;
    this.rules = createPathRules(options.inboxPath, options.exportsDir);
    this.exportsDir = options.exportsDir;
    this.repo = options.repo;
    this.bus = options.bus;
    this.clock = options.clock ?? (() => new Date());
    this.timers = options.timers ?? systemTimers;
    this.logger = options.logger ?? silentLogger;
    this.onFolderRemovedWhileEditing = options.onFolderRemovedWhileEditing;
    this.onStyleEvent = options.onStyleEvent;
    this.clients = options.clients;
    this.assignSeries = options.assignSeries ?? ((job) => job);
    this.scan =
      options.scan ??
      ((client, name) =>
        scanJob(this.rules.inbox, client, name, {
          exportsDir: options.exportsDir,
          generate: options.generate,
          onSkip: (path, error) =>
            this.logger.warn({ path, err: error }, 'skipped a folder that could not be read'),
        }));
    this.source =
      options.source ??
      createChokidarSource({
        inboxPath: options.inboxPath,
        exportsDir: options.exportsDir,
        onError: (error) => this.logger.error({ err: error }, 'file watcher error'),
      });
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('This watcher was stopped; create a new one');
    if (this.started) return;
    this.started = true;

    this.unsubscribe = this.bus.subscribe((event) => {
      if (event.type === 'job.upsert') this.armSettleTimer(event.job);
      else if (event.type === 'job.remove') this.disarm(event.id);
    });

    try {
      await this.source.start((event) => this.notify(event));
    } catch (error) {
      this.started = false;
      this.unsubscribe();
      this.unsubscribe = undefined;
      throw error;
    }
    this.logger.info({ inbox: this.rules.inbox }, 'watching the inbox');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    for (const handle of this.pending.values()) this.timers.clearTimeout(handle);
    this.pending.clear();
    for (const { handle } of this.settle.values()) this.timers.clearTimeout(handle);
    this.settle.clear();

    if (this.started) await this.source.stop();
    await this.whenIdle();
  }

  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  // --- events in ---------------------------------------------------------------------------

  notify(event: FsEvent): void {
    if (this.stopped) return;
    const style = locateStyleEvent(this.rules, event);
    if (style !== null) {
      this.passStyleEvent(style);
      return;
    }
    const target = locateEvent(this.rules, event);
    if (target === null) return;

    // Only a log line: the folder is handled like any other below.
    if (event.kind === 'addDir') this.warnOfFolderDuringEdit(event);

    const { client, name } = target;
    if (name === undefined) {
      this.coalesce(`client:${nfc(client)}`, () => this.sweepClient(client));
    } else {
      this.coalesce(jobIdFor(jobRelPath(client, name)), () => this.refresh(client, name));
    }
  }

  /** Hands a style folder event over. Never touches a job. */
  private passStyleEvent(event: StyleFsEvent): void {
    if (this.onStyleEvent === undefined) return;
    try {
      this.onStyleEvent(event);
    } catch (error) {
      this.logger.error({ err: error, client: event.client }, 'a style folder event failed');
    }
  }

  /**
   * The tripwire for an edit that writes outside its own job folder (CVP-94; in V4 a word-split
   * `cd` made `<inbox>/Client/package` while a job was being edited, and it showed up as an
   * arriving job). When a new folder appears at client level, or at job level in the client of a
   * job that is `editing`, this logs one warning that names the folder and the editing job.
   *
   * It only logs: nothing changes in the job or the folder, which is still scanned like any other.
   * Whether something is editing is read from the repository as the event arrives. The ignore
   * rules are the watcher's own, so dot-names and the exports folder never warn; neither do files
   * or anything deeper than `Client/Job`, and neither does the editing job's own folder, or the
   * folder of the client it is in.
   *
   * A folder the user drops in on purpose while an edit runs warns too: the engine cannot tell it
   * from one the edit wrote, so the message says "may".
   */
  private warnOfFolderDuringEdit(event: FsEvent): void {
    try {
      const segments = relativeSegments(this.rules, event.path);
      if (segments === null || segments.length < 1 || segments.length > 2) return;
      if (isIgnoredSegments(this.rules, segments)) return;

      const editing = this.repo.getEditing();
      if (editing.length === 0) return;

      const [client = '', name] = segments;
      const clientKey = nfc(client);
      const inClient = editing.filter((job) => nfc(job.client) === clientKey);

      let culprit: Job | undefined;
      if (name === undefined) {
        // A client folder is new unless an editing job lives in it already.
        if (inClient.length === 0) culprit = editing[0];
      } else if (!inClient.some((job) => nfc(job.name) === nfc(name))) {
        // A job folder counts when it sits beside the editing job, not when it is that job.
        culprit = inClient[0];
      }
      if (culprit === undefined) return;

      this.logger.warn(
        { folder: segments.join('/'), editingJobId: culprit.id, editingRelPath: culprit.relPath },
        'a new folder appeared in the inbox while an edit is running; the edit may have written it',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'could not check a new folder against the running edit');
    }
  }

  /**
   * Opens a window of `debounceMs` for `key` and runs `work` when it closes. Events that arrive
   * while it is open join it, so a burst of events costs one rescan. The window does not slide:
   * a copy that never pauses is rescanned every `debounceMs` rather than only at its end, so the
   * job shows up and grows in the list while the files are still arriving.
   */
  private coalesce(key: string, work: () => Promise<void>): void {
    if (this.pending.has(key)) return;
    const handle = this.timers.setTimeout(() => {
      this.pending.delete(key);
      this.track(work());
    }, this.debounceMs);
    this.pending.set(key, handle);
  }

  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error: unknown) => this.logger.error({ err: error }, 'inbox watcher task failed'))
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /**
   * A client folder appeared or vanished: make its `_Style` folder if it is there, keep the list
   * of client folders right, and look at every job it holds or held.
   */
  private async sweepClient(client: string): Promise<void> {
    await this.makeStyleDir(client);
    await this.trackClient(client);

    const names = new Map<string, string>();
    try {
      const entries = await readdir(join(this.rules.inbox, client), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !isDotName(entry.name) && !isReservedJobName(entry.name)) {
          names.set(nfc(entry.name), entry.name);
        }
      }
    } catch {
      // The client folder is gone: only the jobs we already know about are left to check.
    }
    const clientKey = nfc(client);
    for (const job of this.repo.getAll()) {
      if (nfc(job.client) === clientKey && !names.has(nfc(job.name))) {
        names.set(nfc(job.name), job.name);
      }
    }
    await Promise.all(
      [...names.values()]
        // A job with its own window open is rescanned by that window.
        .filter((name) => !this.pending.has(jobIdFor(jobRelPath(client, name))))
        .map((name) => this.refresh(client, name)),
    );
  }

  /**
   * Tells the list of client folders whether this one is there now. A folder the inbox rules skip
   * is not a client, and nothing is removed while the inbox itself is missing (an unplugged drive
   * looks like every folder vanishing at once). It never fails the sweep.
   */
  private async trackClient(client: string): Promise<void> {
    if (this.clients === undefined) return;
    try {
      const present = await isClientFolder(this.rules.inbox, client, {
        exportsDir: this.exportsDir,
        onSkip: (path, error) =>
          this.logger.warn({ path, err: error }, 'could not read the client folder'),
      });
      if (this.stopped) return;
      if (present) this.clients.add(client);
      else if (await isDirectory(this.rules.inbox)) this.clients.remove(client);
    } catch (error) {
      this.logger.error({ client, err: error }, 'could not update the list of client folders');
    }
  }

  /** `ensureStyleDir` for a client folder the watcher found. It never fails the sweep. */
  private async makeStyleDir(client: string): Promise<void> {
    try {
      await ensureStyleDir(this.rules.inbox, client, {
        exportsDir: this.exportsDir,
        onSkip: (path, error) =>
          this.logger.warn({ path, err: error }, 'could not make the client style folder'),
      });
    } catch (error) {
      this.logger.error({ client, err: error }, 'could not make the client style folder');
    }
  }

  // --- rescanning a job --------------------------------------------------------------------

  /** Rescans one job and applies the result. One at a time per job; events meanwhile run it again. */
  private async refresh(client: string, name: string): Promise<void> {
    const relPath = jobRelPath(client, name);
    const id = jobIdFor(relPath);
    const running = this.active.get(id);
    if (running) {
      running.again = true;
      return;
    }

    const entry = { again: false };
    this.active.set(id, entry);
    try {
      do {
        entry.again = false;
        await this.rescan(client, name, id);
      } while (entry.again && !this.stopped);
    } finally {
      this.active.delete(id);
      // Whatever happened, the timer must match the job as it is now (a settle timer that came
      // due during the rescan was skipped and relies on this).
      if (!this.stopped) {
        const job = this.repo.get(id);
        if (job === null) this.disarm(id);
        else this.armSettleTimer(job);
      }
    }
  }

  private async rescan(client: string, name: string, id: string): Promise<void> {
    let scanned: ScannedJob | null;
    try {
      scanned = await this.scan(client, name);
    } catch (error) {
      // Not knowing is not the same as the folder being gone: leave the job alone.
      this.logger.warn({ client, name, err: error }, 'could not scan the job folder');
      return;
    }
    if (this.stopped) return;

    if (scanned === null) await this.handleGone(id, jobRelPath(client, name));
    else this.applyScan(scanned);
  }

  private applyScan(scanned: ScannedJob): void {
    const before = this.repo.get(scanned.id);
    const { job: upserted, outcome } = this.repo.upsertFromScan(scanned);
    let job = upserted;
    let changed = outcome !== 'unchanged';

    if (outcome === 'created') {
      this.logger.info({ jobId: job.id, relPath: job.relPath }, 'new job folder');
      job = this.assignSeries(job);
    } else if (!REACTS_TO_FILES.has(job.state)) {
      // A job that has started editing, is in review or has finished keeps its inputs; changes are logged.
      this.logger.info(
        { jobId: job.id, relPath: job.relPath, state: job.state },
        'files changed in a job that no longer reacts to them; ignored',
      );
    } else if (
      before !== null &&
      before.sizeBytes === scanned.sizeBytes &&
      sameInputs(before.inputs, scanned.inputs)
    ) {
      // The upsert runs FILES_CHANGED itself when the counts or the size differ. Files were
      // touched without changing either (rewritten in place, moved around): the folder is still
      // active, so the settle timer must start over all the same.
      job = this.repo.applyTransition(job.id, { type: 'FILES_CHANGED' });
      changed = true;
    }

    if (changed) this.publishUpsert(job);
  }

  /** The folder is gone. */
  private async handleGone(id: string, relPath: string): Promise<void> {
    if (this.repo.get(id) === null) return;

    // A missing inbox (an unplugged drive, a renamed parent) looks like every folder vanishing at
    // once. The jobs stay; they are reconciled the next time the engine starts with an inbox.
    if (!(await isDirectory(this.rules.inbox))) {
      this.logger.warn({ inbox: this.rules.inbox }, 'the inbox is missing; keeping its jobs');
      return;
    }
    if (this.stopped) return;

    const job = this.repo.get(id);
    if (job === null) return;

    if (job.state === 'editing') {
      this.logger.warn({ jobId: job.id, relPath }, 'folder removed while editing; marking failed');
      const failed = this.repo.applyTransition(job.id, {
        type: 'FAIL',
        step: job.step ?? 1,
        error: FOLDER_REMOVED_ERROR,
      });
      this.publishUpsert(failed);
      try {
        this.onFolderRemovedWhileEditing?.(failed);
      } catch (error) {
        this.logger.error({ jobId: job.id, err: error }, 'onFolderRemovedWhileEditing threw');
      }
      return;
    }

    // Already failed because of this very removal (more events for the same deletion): keep the
    // failure on screen instead of dropping it a moment later.
    if (job.state === 'failed' && job.error === FOLDER_REMOVED_ERROR) return;

    this.logger.info({ jobId: job.id, relPath, state: job.state }, 'job folder removed');
    this.disarm(job.id);
    if (this.repo.remove(job.id)) this.bus.publish({ type: 'job.remove', id: job.id });
  }

  private publishUpsert(job: Job): void {
    this.bus.publish({ type: 'job.upsert', job });
  }

  // --- settle timers -----------------------------------------------------------------------

  armSettleTimer(job: Job): void {
    if (this.stopped) return;
    if (job.state !== 'arriving') {
      // Held jobs keep their lastChangeAt (Release decides from it) but have no timer: they
      // stay held until the user releases them.
      this.disarm(job.id);
      return;
    }

    const changedAt = Date.parse(job.lastChangeAt);
    const dueMs = (Number.isNaN(changedAt) ? this.clock().getTime() : changedAt) + this.settleMs;
    const existing = this.settle.get(job.id);
    if (existing?.dueMs === dueMs) return;
    if (existing) this.timers.clearTimeout(existing.handle);

    const delay = Math.min(Math.max(dueMs - this.clock().getTime(), 0), MAX_TIMER_MS);
    const handle = this.timers.setTimeout(() => this.fireSettle(job.id), delay);
    this.settle.set(job.id, { handle, dueMs });
  }

  armAll(): void {
    const jobs = this.repo.getAll();
    for (const job of jobs) this.armSettleTimer(job);
    this.logger.info({ jobs: jobs.length }, 'settle timers armed');
  }

  private disarm(id: string): void {
    const existing = this.settle.get(id);
    if (!existing) return;
    this.timers.clearTimeout(existing.handle);
    this.settle.delete(id);
  }

  private fireSettle(id: string): void {
    this.settle.delete(id);
    if (this.stopped) return;

    // A rescan is about to say whether the folder changed again. It re-arms the timer either way.
    if (this.pending.has(id) || this.active.has(id)) return;

    try {
      const job = this.repo.get(id);
      // Held, queued, gone: nothing to settle. (A held job stays held.)
      if (job === null || job.state !== 'arriving') return;

      // The timer may be early if the job's lastChangeAt moved without a re-arm.
      if (this.clock().getTime() < Date.parse(job.lastChangeAt) + this.settleMs) {
        this.armSettleTimer(job);
        return;
      }

      const queued = this.assignSeries(this.repo.applyTransition(id, { type: 'SETTLED' }));
      this.logger.info({ jobId: id, relPath: queued.relPath }, 'job settled; queued');
      this.publishUpsert(queued);
    } catch (error) {
      this.logger.error({ jobId: id, err: error }, 'could not settle the job');
    }
  }
}

/** Creates the inbox watcher. Nothing happens until `start()`. */
export function createInboxWatcher(options: InboxWatcherOptions): InboxWatcher {
  return new Watcher(options);
}
