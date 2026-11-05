// The `_Fonts` watcher (Fonts plan, "Reading the font files"): The owner drops fonts into the folder in
// Finder, and the font index has to notice. OWNER: FN3.
//
//   chokidar on <inbox>/_Fonts ─▶ which events count ─▶ one `onChange` 500 ms after the last one
//
// The inbox watcher ignores `_Fonts` (it is never a client), so this small one is the only thing
// that looks inside. It reports no detail: any font file added, changed or removed under the folder
// (at any depth), or a folder added or removed, calls `onChange` once, `debounceMs` after the last
// event of a burst, and the caller refreshes the index. Dot names (.DS_Store, a ._ copy) and
// partial downloads (.crdownload, .part, .download …) are left out wherever they are, as are files
// that are not fonts.
//
// Events come from a source that tests replace with a fake, and the timers can be replaced too, so
// the debounce is tested without waiting.

import { stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fontFormatOf } from '@studio/shared';
import { watch } from 'chokidar';
import { isIgnoredName } from '../inbox/classify.js';
import { type FsEvent, systemTimers, type Timers } from '../inbox/watcher.js';
import type { WorkerLogger } from '../pipeline/worker.js';

/** How long after the last event of a burst the index is told to refresh. */
export const FONT_WATCH_DEBOUNCE_MS = 500;

/**
 * How long the chokidar source waits after chokidar says it is ready: on macOS `ready` comes
 * before the system's event stream really runs (see the inbox watcher's note on the same).
 */
const CHOKIDAR_READY_GRACE_MS = 250;

/** Where file events come from: chokidar for real, a fake in tests. */
export interface FontEventSource {
  /** Starts watching; events go to `emit` from the moment this resolves. */
  start(emit: (event: FsEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

/** The segments of `path` below `dir`, or `null` when it is `dir` itself or not inside it. */
function segmentsBelow(dir: string, path: string): string[] | null {
  const rel = relative(dir, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep);
}

/** Whether an event is worth a refresh: not a dot name or partial download; a font file or a folder. */
export function isFontEvent(dir: string, event: FsEvent): boolean {
  const segments = segmentsBelow(dir, event.path);
  if (segments === null || segments.some((segment) => isIgnoredName(segment))) return false;
  return event.kind === 'addDir' || event.kind === 'unlinkDir' || fontFormatOf(event.path) !== null;
}

export interface ChokidarFontSourceOptions {
  dir: string;
  /** Extra wait after chokidar is ready, before `start()` resolves. */
  readyGraceMs?: number;
  /** Told about watcher errors, which are not fatal. */
  onError?: (error: unknown) => void;
}

/** The real source: chokidar on the fonts folder, any depth, ignoring dot names and partial downloads. */
export function createChokidarFontSource({
  dir,
  readyGraceMs = CHOKIDAR_READY_GRACE_MS,
  onError,
}: ChokidarFontSourceOptions): FontEventSource {
  let watcher: ReturnType<typeof watch> | undefined;
  /** Ends a wait for `ready` or for the grace when `stop()` comes first. */
  let giveUp: (() => void) | undefined;
  return {
    async start(emit) {
      // chokidar would watch nothing, and say nothing, for a folder that is not there.
      const isDirectory = await stat(dir).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
      if (!isDirectory) throw new Error(`The fonts folder does not exist: ${dir}`);
      const instance = watch(dir, {
        ignoreInitial: true,
        // The list does not follow folder links either (a link to a file counts).
        followSymlinks: false,
        ignored: (path) => {
          const segments = segmentsBelow(dir, path);
          return segments?.some((segment) => isIgnoredName(segment)) ?? false;
        },
      });
      watcher = instance;
      for (const kind of ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const) {
        instance.on(kind, (path) => emit({ kind, path }));
      }
      instance.on('error', (error) => onError?.(error));
      await new Promise<void>((done) => {
        giveUp = done;
        instance.once('ready', () => done());
      });
      await new Promise<void>((done) => {
        giveUp = done;
        setTimeout(done, readyGraceMs).unref?.();
      });
      giveUp = undefined;
    },
    async stop() {
      const instance = watcher;
      watcher = undefined;
      giveUp?.();
      await instance?.close();
    },
  };
}

export interface FontWatcherOptions {
  /** The shared fonts folder, `<inbox>/_Fonts`. */
  dir: string;
  /** Called once per burst of events: the caller refreshes the index. Its failures are its own. */
  onChange: () => void;
  /** Default {@link FONT_WATCH_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Default: chokidar on `dir`. */
  source?: FontEventSource;
  /** Default: the real timers. */
  timers?: Timers;
  logger?: WorkerLogger;
}

export interface FontWatcher {
  /** Starts watching; resolves when events flow. A folder that cannot be watched is logged, not thrown. */
  start(): Promise<void>;
  /** Stops watching and drops a refresh that was waiting for its debounce. */
  stop(): Promise<void>;
}

export function createFontWatcher(options: FontWatcherOptions): FontWatcher {
  const { dir, onChange, debounceMs = FONT_WATCH_DEBOUNCE_MS, timers = systemTimers } = options;
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };
  const source =
    options.source ??
    createChokidarFontSource({
      dir,
      onError: (err) => logger.warn({ err, dir }, 'the fonts folder watcher reported a problem'),
    });

  let timer: unknown;
  let running = false;

  const clear = (): void => {
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    timer = undefined;
  };

  const emit = (event: FsEvent): void => {
    if (!running || !isFontEvent(dir, event)) return;
    clear();
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (running) onChange();
    }, debounceMs);
  };

  return {
    async start() {
      if (running) return;
      running = true;
      try {
        await source.start(emit);
      } catch (err) {
        running = false;
        logger.error(
          { err, dir },
          'the fonts folder is not being watched; restart after fixing it',
        );
        return;
      }
      // `stop()` came while the source was starting: it let go of nothing yet, so let go now.
      if (!running) await source.stop();
    },
    async stop() {
      if (!running) return;
      running = false;
      clear();
      await source.stop();
    },
  };
}
