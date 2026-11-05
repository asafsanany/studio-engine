// The money file loader (Phase 4 plan, §2): reads <dataDir>/money.json, keeps the last good value
// and re-reads the file when it changes. Nothing else reads money.json directly.
//
// The last good value also survives a restart: every valid read is saved next to the file as
// money.last-good.json, and a boot that finds money.json invalid starts from that copy.
//
// Only Node built-ins and @studio/shared are imported, with no relative imports: `pnpm run doctor`
// loads this file on plain Node 22 with type stripping, outside the server build, and uses
// `readMoneyFile` for its money.json line.

import { type FSWatcher, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_MONEY,
  MONEY_FILE_NAME,
  MONEY_FILE_OK,
  type MoneyFile,
  type MoneyFileState,
  moneyFileSchema,
} from '@studio/shared';

/** The copy of the last valid money.json, saved next to it. */
export const MONEY_LAST_GOOD_FILE_NAME = 'money.last-good.json';

/** How long the file has to stay quiet after a change before it is read again. */
export const MONEY_WATCH_DEBOUNCE_MS = 300;

/** Where money.json lives for a data folder (`config.dataDir`). */
export function moneyFilePath(dataDir: string): string {
  return join(dataDir, MONEY_FILE_NAME);
}

/** Where the last good copy lives for a data folder. */
export function moneyLastGoodPath(dataDir: string): string {
  return join(dataDir, MONEY_LAST_GOOD_FILE_NAME);
}

/** What one read of the file found. An invalid file has no value: the caller keeps its last one. */
export type MoneyFileRead =
  | { status: 'missing'; money: MoneyFile }
  | { status: 'ok'; money: MoneyFile }
  | { status: 'invalid'; issues: string[] };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `subscriptions[0].day`: a zod issue path the way a person would point at it in the file. */
function pathText(path: readonly PropertyKey[]): string {
  let text = '';
  for (const part of path) {
    if (typeof part === 'number') text += `[${part}]`;
    else text += text === '' ? String(part) : `.${String(part)}`;
  }
  return text;
}

/** The longest the one line about a mistake in the file goes before it is cut (the Money page shows it). */
const ISSUE_LINE_MAX = 200;

/**
 * The first problem in an invalid file as one short line: whitespace squeezed to single spaces and,
 * when it is still long (a JSON error can quote the text), cut with an ellipsis.
 */
function issueLine(issues: readonly string[]): string {
  const line = (issues[0] ?? 'is not valid').replace(/\s+/g, ' ').trim();
  return line.length > ISSUE_LINE_MAX ? `${line.slice(0, ISSUE_LINE_MAX - 1).trimEnd()}…` : line;
}

/**
 * Reads and validates the file once. A missing file is the defaults; a file that can't be read,
 * isn't JSON or doesn't fit the schema is invalid, with one line per problem, each starting with
 * where in the file it is ("subscriptions[0].day: …").
 */
export function readMoneyFile(path: string, defaultUsdRate?: number): MoneyFileRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'missing',
        money:
          defaultUsdRate === undefined
            ? DEFAULT_MONEY
            : { ...DEFAULT_MONEY, usdToIls: defaultUsdRate },
      };
    }
    return { status: 'invalid', issues: [`cannot be read (${errorText(err)})`] };
  }

  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { status: 'invalid', issues: [`cannot be read as JSON (${errorText(err)})`] };
  }

  // A file that names no rate takes `usdToHomeCurrency` from config.json.
  const withRate =
    defaultUsdRate !== undefined && typeof json === 'object' && json !== null
      ? { usdToIls: defaultUsdRate, ...json }
      : json;
  const result = moneyFileSchema.safeParse(withRate);
  if (!result.success) {
    return {
      status: 'invalid',
      issues: result.error.issues.map((issue) => {
        const where = pathText(issue.path);
        return where === '' ? issue.message : `${where}: ${issue.message}`;
      }),
    };
  }
  return { status: 'ok', money: result.data };
}

/** The part of a pino logger the loader uses. */
export interface MoneyFileLogger {
  warn(obj: object, msg: string): void;
}

const SILENT_LOGGER: MoneyFileLogger = { warn() {} };

/** The part of an `fs.FSWatcher` the loader uses. */
export interface DirWatcher {
  close(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** `fs.watch` on a folder, reduced to what the loader needs. Tests pass a fake. */
export type WatchDir = (
  dir: string,
  listener: (event: string, filename: string | null) => void,
) => DirWatcher;

const watchDirWithFs: WatchDir = (dir, listener): FSWatcher =>
  watch(dir, (event, filename) => listener(event, filename));

export interface MoneyFileLoaderOptions {
  /** Absolute path of money.json, normally `moneyFilePath(config.dataDir)`. */
  path: string;
  /** What a dollar is worth for a file that names no rate. Default: the schema's. */
  defaultUsdRate?: number;
  /** Where the last good copy is saved. Default: money.last-good.json next to `path`. */
  lastGoodPath?: string;
  logger?: MoneyFileLogger;
  /** Defaults to 300 ms. */
  debounceMs?: number;
  /** Defaults to `fs.watch`. */
  watchDir?: WatchDir;
}

/**
 * Holds the current money.json. The file is read once when the loader is made, and again whenever
 * the watcher sees it change (`watch`) or `reload` is called.
 *
 * - A missing file is the defaults, also after a file that was there is removed.
 * - Every valid file is also saved as the last good copy (written to a temp file, then renamed).
 * - An invalid file is logged with the path of each problem in it, and the last good value stays.
 *   When the very first read is invalid (a restart), the last good copy is the value; with no
 *   valid copy either, that is the defaults and `hasGoodValues()` is false.
 * - `fileState()` says which of these it is, for the Money page's warning line.
 */
export class MoneyFileLoader {
  readonly path: string;
  private readonly defaultUsdRate: number | undefined;
  readonly lastGoodPath: string;

  private readonly logger: MoneyFileLogger;
  private readonly debounceMs: number;
  private readonly watchDir: WatchDir;
  private readonly listeners = new Set<(money: MoneyFile) => void>();
  private current: MoneyFile = DEFAULT_MONEY;
  private currentKey = JSON.stringify(DEFAULT_MONEY);
  /** False until a read gave a good version, and while the file is invalid with none to fall back on. */
  private good = false;
  /** How the file is doing, for the Money page: replaced (not edited) when it changes. */
  private state: MoneyFileState = MONEY_FILE_OK;
  /** The value last saved as the copy, so an unchanged file is not written again. */
  private savedKey: string | undefined;
  private watcher: DirWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: MoneyFileLoaderOptions) {
    this.defaultUsdRate = options.defaultUsdRate;
    this.path = options.path;
    this.lastGoodPath =
      options.lastGoodPath ?? join(dirname(options.path), MONEY_LAST_GOOD_FILE_NAME);
    this.logger = options.logger ?? SILENT_LOGGER;
    this.debounceMs = options.debounceMs ?? MONEY_WATCH_DEBOUNCE_MS;
    this.watchDir = options.watchDir ?? watchDirWithFs;
    this.reload();
  }

  /** The current value: the last good file, or the defaults. */
  get(): MoneyFile {
    return this.current;
  }

  /**
   * False when money.json is invalid and there is no good version to fall back on (not in memory
   * and not saved): `get()` is then only the defaults, which must not decide a price.
   */
  hasGoodValues(): boolean {
    return this.good;
  }

  /**
   * How the file is doing: `ok` (valid, or missing so the defaults are right), `last-good` (it has
   * a mistake and the last good values are used) or `defaults` (a mistake and no good version, so
   * only the defaults), with the first problem as one short line while it is not `ok`.
   */
  fileState(): MoneyFileState {
    return this.state;
  }

  /** Reads the file now. True when what the Money page shows changed: the value or the file's state. */
  reload(): boolean {
    const read = readMoneyFile(this.path, this.defaultUsdRate);
    let valueChanged: boolean;
    let next: MoneyFileState;
    if (read.status === 'invalid') {
      valueChanged = this.useFallback(read.issues);
      next = { status: this.good ? 'last-good' : 'defaults', issue: issueLine(read.issues) };
    } else {
      this.good = true;
      if (read.status === 'ok') this.saveCopy(read.money);
      valueChanged = this.use(read.money);
      next = MONEY_FILE_OK;
    }
    const stateChanged = next.status !== this.state.status || next.issue !== this.state.issue;
    if (stateChanged) this.state = next;
    return valueChanged || stateChanged;
  }

  /** Sets the current value. True when it differs from the one before. */
  private use(money: MoneyFile): boolean {
    const key = JSON.stringify(money);
    if (key === this.currentKey) return false;
    this.current = money;
    this.currentKey = key;
    return true;
  }

  /**
   * The file is invalid. A value already in memory stays; without one (a restart) the saved copy
   * is tried. The log line says which of the two, or that it is only the defaults.
   */
  private useFallback(issues: string[]): boolean {
    const fields: { path: string; issues: string[]; copyIssues?: string[] } = {
      path: this.path,
      issues,
    };
    let changed = false;
    let message = 'money.json is invalid; keeping the last good values';
    if (!this.good) {
      const copy = readMoneyFile(this.lastGoodPath, this.defaultUsdRate);
      if (copy.status === 'ok') {
        this.good = true;
        changed = this.use(copy.money);
        message = `${message} (from ${basename(this.lastGoodPath)})`;
      } else {
        if (copy.status === 'invalid') fields.copyIssues = copy.issues;
        message = 'money.json is invalid; using defaults (no good version saved)';
      }
    }
    this.logger.warn(fields, message);
    return changed;
  }

  /** Saves a valid value as the last good copy: a temp file in the same folder, then a rename. */
  private saveCopy(money: MoneyFile): void {
    const key = JSON.stringify(money);
    if (key === this.savedKey) return;
    const temp = `${this.lastGoodPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(money, null, 2)}\n`);
      renameSync(temp, this.lastGoodPath);
      this.savedKey = key;
    } catch (err) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Nothing more to do about a temp file that cannot be removed.
      }
      this.logger.warn(
        { path: this.lastGoodPath, error: errorText(err) },
        'cannot save the last good copy of money.json',
      );
    }
  }

  /**
   * Calls `onChange` with the current value each time the file changes the value or its state (a
   * mistake appears, changes or is fixed, even when the numbers stay the same). Changes are noticed
   * through the data folder, so a file created later, or replaced by an editor's safe save, is
   * seen too. A burst of events is read once, `debounceMs` after the last one. Returns the
   * function that stops this subscription.
   */
  watch(onChange: (money: MoneyFile) => void): () => void {
    this.listeners.add(onChange);
    this.startWatching();
    return () => {
      this.listeners.delete(onChange);
      if (this.listeners.size === 0) this.stopWatching();
    };
  }

  /** Stops watching and drops every subscription. */
  close(): void {
    this.listeners.clear();
    this.stopWatching();
  }

  private startWatching(): void {
    if (this.watcher) return;
    const name = basename(this.path);
    try {
      const watcher = this.watchDir(dirname(this.path), (_event, filename) => {
        // A null name means the platform didn't say which file, so any of them might be ours.
        if (filename === null || filename === name) this.schedule();
      });
      watcher.on('error', (err) => {
        this.logger.warn({ path: this.path, error: errorText(err) }, 'money.json watcher stopped');
        this.stopWatching();
      });
      this.watcher = watcher;
    } catch (err) {
      this.logger.warn(
        { path: this.path, error: errorText(err) },
        'cannot watch money.json for changes',
      );
    }
  }

  private stopWatching(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    try {
      watcher?.close();
    } catch {
      // Already closed.
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.reload()) this.notify();
    }, this.debounceMs);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current);
      } catch (err) {
        this.logger.warn(
          { path: this.path, error: errorText(err) },
          'a money.json change listener threw',
        );
      }
    }
  }
}
