import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job } from '@studio/shared';
import type { ClientFolders } from '../clients/client-folders.js';
import {
  type ReconcileStylesRepository,
  reconcileClientStyles,
} from '../clients/reconcile-styles.js';
import type { Config } from '../config.js';
import type { JobRepository } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { FONTS_DIR_NAME, GRAPHICS_DIR_NAME, LUTS_DIR_NAME } from './classify.js';
import type { DurationCache } from './probe.js';
import { type ReconcileSummary, reconcile } from './reconcile.js';
import { listClientNames, scanJob } from './scan.js';
import {
  createInboxWatcher,
  type FsEventSource,
  type InboxWatcher,
  type StyleFsEvent,
  type Timers,
  type WatcherLogger,
} from './watcher.js';

// The inbox side of the boot (architecture §3), in the one order that works:
//
//   make sure the inbox exists (with _Fonts, and _Graphics and _LUTs while they are on) ─▶ reconcile
//   disk and database (W3) ─▶ reconcile the client styles ─▶ list the client folders
//   ─▶ watcher.start() ─▶ armAll() ─▶ list the client folders again
//
// Reconciling comes first so that the watcher starts on a list that matches the disk, and the
// settle timers are armed last, from what reconciliation left in the database (the watcher only
// hears about changes made after it subscribed to the bus, so it has to be told about the rest).
//
// A file copied into the inbox in the moment between the scan and chokidar being ready is not
// seen until something else in that job changes: events only flow once the watcher runs. The
// window is the time chokidar takes to crawl the inbox.

export interface StartInboxOptions {
  /**
   * The settings the inbox side needs. `graphics` (the Graphics switch) makes `_Graphics` at boot
   * and `luts` (the LUTs switch) makes `_LUTs`; `generate` (the Generate switch) keeps the videos
   * under a job's `reference/` folder out of its footage (`ScanOptions.generate`). Left out, as by
   * the tests of the jobs, they are off.
   */
  config: Pick<Config, 'inboxPath' | 'exportsDir' | 'settleMs'> &
    Partial<Pick<Config, 'graphics' | 'luts' | 'generate'>>;
  repo: JobRepository;
  /**
   * The stored client styles. Given, boot also adds a `ready` record for every client that has a
   * `_Style/style.md` and none yet (see `reconcileClientStyles`). Left out by tests of the jobs.
   */
  clientStyles?: ReconcileStylesRepository;
  /**
   * The engine's list of client folders. Given, boot fills it from the inbox before the watcher
   * starts (silently) and again once it is running (announcing what changed meanwhile), and the
   * watcher keeps it current. Left out by tests of the jobs.
   */
  clientFolders?: Pick<ClientFolders, 'add' | 'remove' | 'seed' | 'sync'>;
  /** The bus the watcher listens to and publishes on. */
  bus: EventBus;
  logger?: WatcherLogger;
  /**
   * Called when a job that was being edited lost its folder (at boot or later) and was marked
   * failed. The engine uses it to stop the run: `worker.cancel(job.id)`.
   */
  onFolderRemovedWhileEditing?: (job: Job) => void;
  /** Gets what happens in the clients' `_Style` folders (see `InboxWatcherOptions.onStyleEvent`). */
  onStyleEvent?: (event: StyleFsEvent) => void;
  /** The series name rule, for the reconcile and the watcher (see `InboxWatcherOptions.assignSeries`). */
  assignSeries?: (job: Job) => Job;
  // The rest are seams for tests; the engine leaves them out.
  clock?: () => Date;
  timers?: Timers;
  /** Where footage lengths are probed. Defaults to W1's shared cache (ffprobe on PATH). */
  durations?: DurationCache;
  source?: FsEventSource;
  debounceMs?: number;
}

export interface RunningInbox {
  watcher: InboxWatcher;
  /** What reconciliation did at boot. */
  summary: ReconcileSummary;
  /** Stops the watcher and its timers. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * Starts the inbox side of the engine. Rejects when the inbox cannot be created or read, when
 * reconciliation cannot run, or when the watcher cannot start; in each case nothing is left
 * running. A caller that wants the rest of the engine up regardless catches and logs.
 */
export async function startInbox(options: StartInboxOptions): Promise<RunningInbox> {
  const {
    config,
    repo,
    clientStyles,
    clientFolders,
    bus,
    onFolderRemovedWhileEditing,
    onStyleEvent,
    assignSeries,
    durations,
  } = options;
  const { inboxPath, exportsDir, settleMs } = config;
  const logger = options.logger;

  await mkdir(inboxPath, { recursive: true });
  // CVP-201: the shared fonts folder, there from the start so fonts can be dropped into it.
  await mkdir(join(inboxPath, FONTS_DIR_NAME), { recursive: true });
  // The Graphics library, only while its switch is on: off, the inbox is as before Graphics.
  if (config.graphics === true) {
    await mkdir(join(inboxPath, GRAPHICS_DIR_NAME), { recursive: true });
  }
  // The LUTs library, likewise only while its switch is on.
  if (config.luts === true) {
    await mkdir(join(inboxPath, LUTS_DIR_NAME), { recursive: true });
  }

  // Every client folder, with jobs or without, first: the server is up already and the reconcile
  // below can take seconds, while a list of the folders is one read (the Clients page waits for
  // it, `ClientFolders.whenSeeded`). A problem here never stops the inbox.
  const readClientFolders = (): Promise<string[]> => listClientNames(inboxPath, { exportsDir });
  if (clientFolders !== undefined) {
    try {
      clientFolders.seed(await readClientFolders());
    } catch (error) {
      logger?.error({ err: error }, 'could not list the client folders');
    }
  }

  const summary = await reconcile({
    inboxPath,
    exportsDir,
    settleMs,
    repo,
    bus,
    clock: options.clock,
    durations,
    logger,
    onFolderRemovedWhileEditing,
    assignSeries,
    generate: config.generate === true,
  });

  // The scan above made every client's `_Style` folder. A style problem never stops the inbox.
  if (clientStyles !== undefined) {
    try {
      await reconcileClientStyles({ inboxPath, exportsDir, repo: clientStyles, bus, logger });
    } catch (error) {
      logger?.error({ err: error }, 'could not reconcile the client styles');
    }
  }

  const watcher = createInboxWatcher({
    inboxPath,
    exportsDir,
    settleMs,
    repo,
    bus,
    clients: clientFolders,
    clock: options.clock,
    timers: options.timers,
    source: options.source,
    debounceMs: options.debounceMs,
    logger,
    onFolderRemovedWhileEditing,
    onStyleEvent,
    assignSeries,
    // The same footage-length cache as the reconciliation's scan.
    scan: (client, name) =>
      scanJob(inboxPath, client, name, {
        exportsDir,
        durations,
        generate: config.generate === true,
        onSkip: (path, error) =>
          logger?.warn({ path, err: error }, 'skipped a folder that could not be read'),
      }),
  });

  try {
    await watcher.start();
  } catch (error) {
    await watcher.stop();
    throw error;
  }
  watcher.armAll();

  // A client folder made between the first listing and the watcher being ready was seen by
  // neither: list again, and announce what changed.
  if (clientFolders !== undefined) {
    try {
      clientFolders.sync(await readClientFolders());
    } catch (error) {
      logger?.error({ err: error }, 'could not list the client folders');
    }
  }

  let stopping: Promise<void> | undefined;
  return {
    watcher,
    summary,
    stop: () => {
      stopping ??= watcher.stop();
      return stopping;
    },
  };
}
