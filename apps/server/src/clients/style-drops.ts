// Finder drops into a client's style folder (Phase 2 plan §5, Read pass). The inbox watcher hands
// over every event under `<Client>/_Style/` that its rules let through (never style.md,
// style.md.new, kit/, dotfiles or partial downloads: `locateStyleEvent`), and this turns them into
// Read passes:
//
//   add / change ─▶ remember the file ─▶ (re)arm the client's timer, `settleMs` from now
//   the timer fires ─▶ the remembered files that are still there, less what an upload put there
//                   ─▶ one Read pass: add mode, or create when there is no style.md
//
// The upload route moves its files into `_Style` too, and they must not be read twice. So it
// announces each one first (`expectUpload`) with the size and modification time it has, and a file
// that still has both when the timer fires is left out. A file changed after the upload counts.
//
// Files dropped while the engine is off are not noticed: nothing records what a style was made of.

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type StyleFsEvent,
  systemTimers,
  type Timers,
  type WatcherLogger,
} from '../inbox/watcher.js';
import { styleDirFor } from './paths.js';
import type { ReadPass, StyleFile } from './style-pass.js';
import { styleFileSize } from './style-worker.js';

export interface StyleDropsOptions {
  /** `Config.inboxPath`. */
  inboxPath: string;
  /** How long a style folder must be quiet before its files are read, `Config.settleMs`. */
  settleMs: number;
  /** Queues the pass: the style worker's `enqueue`, which settles the mode. */
  enqueue: (client: string, pass: ReadPass) => Promise<unknown>;
  /** Defaults to the watcher's own (unreferenced) timers. */
  timers?: Timers;
  logger?: Pick<WatcherLogger, 'info' | 'warn' | 'error'>;
}

/** What an uploaded file looked like when the upload put it in `_Style`. */
export interface UploadedFileStat {
  size: number;
  mtimeMs: number;
}

interface PendingDrop {
  /** The client folder's name, as the latest event spelled it. */
  client: string;
  /** Paths inside `_Style`, by their NFC spelling. */
  files: Map<string, string>;
  timer: unknown;
}

const nfc = (text: string): string => text.normalize('NFC');

export class StyleDrops {
  private readonly inboxPath: string;
  private readonly settleMs: number;
  private readonly enqueue: StyleDropsOptions['enqueue'];
  private readonly timers: Timers;
  private readonly logger: StyleDropsOptions['logger'];

  private stopped = false;
  /** Clients with dropped files waiting for quiet, by NFC client name. */
  private readonly pending = new Map<string, PendingDrop>();
  /** Files the upload route put in place, by `<client>/<path>` in NFC. */
  private readonly uploads = new Map<string, UploadedFileStat>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: StyleDropsOptions) {
    if (!Number.isFinite(options.settleMs) || options.settleMs < 0) {
      throw new RangeError(`settleMs must be a non-negative number, got ${options.settleMs}`);
    }
    this.inboxPath = options.inboxPath;
    this.settleMs = options.settleMs;
    this.enqueue = options.enqueue;
    this.timers = options.timers ?? systemTimers;
    this.logger = options.logger;
  }

  /** One event inside a style folder, from the inbox watcher. */
  notify({ kind, client, path }: StyleFsEvent): void {
    if (this.stopped) return;
    const key = nfc(client);
    let drop = this.pending.get(key);

    if (kind === 'add' || kind === 'change') {
      if (drop === undefined) {
        drop = { client, files: new Map(), timer: undefined };
        this.pending.set(key, drop);
      }
      drop.client = client;
      drop.files.set(nfc(path), path);
    } else if (drop !== undefined && (kind === 'unlink' || kind === 'unlinkDir')) {
      const gone = nfc(path);
      for (const name of [...drop.files.keys()]) {
        if (name === gone || name.startsWith(`${gone}/`)) drop.files.delete(name);
      }
    }
    // Anything that happens in the folder starts the quiet time over.
    if (drop !== undefined) this.arm(key, drop);
  }

  /**
   * The upload route is about to move `name` into the client's `_Style` folder: the events that
   * causes are not a Finder drop.
   */
  expectUpload(client: string, name: string, stat: UploadedFileStat): void {
    this.uploads.set(`${nfc(client)}/${nfc(name)}`, { size: stat.size, mtimeMs: stat.mtimeMs });
  }

  /** Drops every timer; files waiting for quiet are not read. Safe to call twice. */
  stop(): void {
    this.stopped = true;
    for (const drop of this.pending.values()) this.timers.clearTimeout(drop.timer);
    this.pending.clear();
  }

  /** Resolves when no timer that fired is still queuing its pass. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private arm(key: string, drop: PendingDrop): void {
    if (drop.timer !== undefined) this.timers.clearTimeout(drop.timer);
    drop.timer = this.timers.setTimeout(() => this.fire(key), this.settleMs);
  }

  private fire(key: string): void {
    const drop = this.pending.get(key);
    this.pending.delete(key);
    if (drop === undefined || this.stopped) return;
    const work: Promise<void> = this.queue(drop)
      .catch((err: unknown) => {
        this.logger?.error({ client: drop.client, err }, 'could not queue the dropped style files');
      })
      .finally(() => this.inflight.delete(work));
    this.inflight.add(work);
  }

  private async queue({ client, files: paths }: PendingDrop): Promise<void> {
    const styleDir = styleDirFor(this.inboxPath, client);
    const files: StyleFile[] = [];
    for (const path of paths.values()) {
      const absPath = join(styleDir, path);
      const size = await styleFileSize(absPath);
      if (size === null || (await this.wasUploaded(client, path, absPath))) continue;
      files.push({ name: path, size });
    }
    if (files.length === 0 || this.stopped) return;

    this.logger?.info(
      { client, files: files.map((file) => file.name) },
      'files were dropped into a style folder; queuing a Read pass',
    );
    await this.enqueue(client, { kind: 'read', mode: 'add', files });
  }

  /** True when the file is still exactly as the upload route put it there. */
  private async wasUploaded(client: string, path: string, absPath: string): Promise<boolean> {
    const key = `${nfc(client)}/${nfc(path)}`;
    const uploaded = this.uploads.get(key);
    if (uploaded === undefined) return false;
    this.uploads.delete(key);
    try {
      const info = await lstat(absPath);
      return info.size === uploaded.size && info.mtimeMs === uploaded.mtimeMs;
    } catch {
      return false;
    }
  }
}
