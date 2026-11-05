// Watches a job's `edit/` folder during a run (E4) and turns what changed into `file` signals for
// the progress reducer. Separate from the inbox watcher, which ignores `edit/` at the job root.
//
// It polls (default once a second) instead of using file-system events, on purpose:
//   - it only looks where progress can show: edit/ itself, transcripts/, verify/, preview/ (the
//     files at its top: a live composition's index.html and cut.mp4), animations/ and each
//     animations/slot_*/. A HyperFrames render writes ~600 frame files into slot_*/work-*/ and
//     .render.hf-transaction-*/ (E1), and a composition holds sub-compositions, fonts and a
//     .hyperframes/ folder of snapshots; none of them are listed, so they cost nothing.
//   - edit/ usually does not exist when the run starts (the model makes it), and files are
//     deleted and made again (final.mp4 after the critic pass). A poll sees each state as it is.
//   - it works the same on a network volume, where fs.watch is unreliable.
// A second of delay is nothing next to steps that take minutes.
//
// The first look either reports everything already there, oldest first, so a resumed run replays
// its own history in order (project.md written before takes_packed.md is not the plan), or, for a
// fresh run, only records it: leftovers from an earlier edit say nothing about this one. A replay
// ends with the pass the self-check was probably at (`checkPassOf`), since the stored `pass n/3`
// is gone by then.

import type { Dirent, Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  estimateCheckPass,
  type FileChange,
  isPreviewVideo,
  type ProgressSignal,
} from './progress-reducer.js';
import { edlOverlayCount } from './progress-signals.js';

export const POLL_INTERVAL_MS = 1_000;
/** An edl.json bigger than this is not read (a real one is a few KB). */
const EDL_MAX_BYTES = 5 * 1024 * 1024;

interface Entry {
  readonly dir: boolean;
  /** For change detection (files only). */
  readonly mtimeMs: number;
  readonly size: number;
  /** For ordering: when a file last changed, when a folder was made. */
  readonly orderMs: number;
}

/** What progress can see in edit/: path (relative, `/`, folders end in `/`) -> entry. */
export type EditSnapshot = ReadonlyMap<string, Entry>;

type FileSignal = Extract<ProgressSignal, { type: 'file' }>;

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

function entryOf(info: Stats): Entry {
  const dir = info.isDirectory();
  return {
    dir,
    mtimeMs: dir ? 0 : info.mtimeMs,
    size: dir ? 0 : info.size,
    orderMs: dir ? info.birthtimeMs || info.mtimeMs : info.mtimeMs,
  };
}

/**
 * Lists `dir` into `into` under `prefix`. Dot-named entries are skipped. Returns the folder names
 * found. `filesOnly` leaves sub-folders out.
 */
async function collect(
  dir: string,
  prefix: string,
  into: Map<string, Entry>,
  filesOnly: boolean,
): Promise<string[]> {
  const folders: string[] = [];
  for (const dirent of await list(dir)) {
    if (dirent.name.startsWith('.')) continue;
    let info: Stats;
    try {
      info = await stat(join(dir, dirent.name));
    } catch (err) {
      if (isMissing(err)) continue; // gone between listing and looking
      throw err;
    }
    const entry = entryOf(info);
    if (entry.dir) {
      folders.push(dirent.name);
      if (!filesOnly) into.set(`${prefix}${dirent.name}/`, entry);
    } else if (info.isFile()) {
      into.set(`${prefix}${dirent.name}`, entry);
    }
  }
  return folders;
}

/**
 * One look at edit/. A missing edit/ (or sub-folder) is simply empty.
 *
 * The sub-folders are listed before edit/ itself, so a look never holds a file without the
 * top-level file it was made from: check frames in verify/ are grabbed from preview.mp4, so if a
 * look sees a frame, it sees the preview too (listing edit/ first could miss a preview written
 * between the two listings, and the frame would then look like a filmstrip of the sources).
 */
export async function scanEditDir(editDir: string): Promise<EditSnapshot> {
  const snapshot = new Map<string, Entry>();
  const animations = join(editDir, 'animations');
  const folders = await collect(animations, 'animations/', snapshot, false);
  for (const slot of folders.filter((name) => name.startsWith('slot_'))) {
    await collect(join(animations, slot), `animations/${slot}/`, snapshot, true);
  }
  await collect(join(editDir, 'transcripts'), 'transcripts/', snapshot, true);
  await collect(join(editDir, 'verify'), 'verify/', snapshot, true);
  await collect(join(editDir, 'preview'), 'preview/', snapshot, true);
  await collect(editDir, '', snapshot, false);
  return snapshot;
}

/**
 * The self-check pass an earlier run left in edit/, estimated from the preview's and the check
 * frames' file times (see `estimateCheckPass`). 1 when there is no preview or no check.
 */
export function checkPassOf(snapshot: EditSnapshot): number {
  let previewMs: number | null = null;
  const checkMs: number[] = [];
  for (const [path, entry] of snapshot) {
    if (entry.dir) continue;
    if (path.startsWith('verify/')) checkMs.push(entry.orderMs);
    else if (!path.includes('/') && isPreviewVideo(path)) {
      previewMs = Math.max(previewMs ?? Number.NEGATIVE_INFINITY, entry.orderMs);
    }
  }
  return estimateCheckPass(previewMs, checkMs);
}

/** What changed between two looks: removals first, then additions and changes, oldest first. */
export function diffSnapshots(before: EditSnapshot, after: EditSnapshot): FileSignal[] {
  const removed: FileSignal[] = [];
  for (const path of before.keys()) {
    if (!after.has(path)) removed.push({ type: 'file', path, change: 'unlink' });
  }
  removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const touched: { signal: FileSignal; orderMs: number }[] = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    let change: FileChange | null = null;
    if (old === undefined || old.dir !== entry.dir) change = 'add';
    else if (!entry.dir && (old.mtimeMs !== entry.mtimeMs || old.size !== entry.size)) {
      change = 'change';
    }
    if (change !== null)
      touched.push({ signal: { type: 'file', path, change }, orderMs: entry.orderMs });
  }
  touched.sort(
    (a, b) =>
      a.orderMs - b.orderMs ||
      (a.signal.path < b.signal.path ? -1 : a.signal.path > b.signal.path ? 1 : 0),
  );
  return [...removed, ...touched.map((item) => item.signal)];
}

export interface EditWatcherOptions {
  /** `<job>/edit`. It may not exist yet. */
  editDir: string;
  /**
   * `true`: the first look only records what is there (a fresh run). `false`: it reports what is
   * already there, oldest first (a resumed or retried run carries on from it).
   */
  baseline: boolean;
  /** Called with the signals of each look that found something (in order, never concurrently). */
  onSignals: (signals: ProgressSignal[]) => void;
  /** A look failed (other than "not there"); the next one tries again. */
  onError?: (err: unknown) => void;
  intervalMs?: number;
}

export class EditWatcher {
  private readonly editDir: string;
  private readonly baseline: boolean;
  private readonly onSignals: EditWatcherOptions['onSignals'];
  private readonly onError: NonNullable<EditWatcherOptions['onError']>;
  private readonly intervalMs: number;
  private snapshot: EditSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  constructor(options: EditWatcherOptions) {
    this.editDir = options.editDir;
    this.baseline = options.baseline;
    this.onSignals = options.onSignals;
    this.onError = options.onError ?? (() => {});
    this.intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  }

  /** Looks right away, then every `intervalMs` until `stop()`. Resolves after the first look. */
  start(): Promise<void> {
    if (this.started || this.stopped) return this.queue;
    this.started = true;
    const first = this.enqueue();
    void first.then(() => this.schedule());
    return first;
  }

  /** One look now, after any look still under way. Does nothing once stopped. Never rejects. */
  poll(): Promise<void> {
    return this.stopped ? this.queue : this.enqueue();
  }

  /**
   * Stops looking and waits for a look under way. `finalLook` takes one more first, so nothing
   * written in the last moments of a run is missed.
   */
  async stop({ finalLook = false }: { finalLook?: boolean } = {}): Promise<void> {
    if (this.stopped) {
      await this.queue;
      return;
    }
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (finalLook && this.started) await this.enqueue();
    else await this.queue;
  }

  private enqueue(): Promise<void> {
    this.queue = this.queue.then(() => this.look());
    return this.queue;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().then(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }

  private async look(): Promise<void> {
    let next: EditSnapshot;
    try {
      next = await scanEditDir(this.editDir);
    } catch (err) {
      this.onError(err);
      return;
    }

    const previous = this.snapshot;
    if (previous === null && this.baseline) {
      this.snapshot = next;
      return;
    }

    const signals: ProgressSignal[] = [];
    const kept = new Map(next);
    for (const signal of diffSnapshots(previous ?? new Map(), next)) {
      signals.push(signal);
      if (signal.path === 'edl.json' && signal.change !== 'unlink') {
        const overlays = await this.readEdl(next.get('edl.json')?.size ?? 0);
        if (overlays === null) {
          // Not complete yet: look at it again next time.
          const old = previous?.get('edl.json');
          if (old === undefined) kept.delete('edl.json');
          else kept.set('edl.json', old);
        } else {
          signals.push({ type: 'edl', overlays });
        }
      }
    }
    if (previous === null) {
      // A replay: the stored pass is gone, so say how far the self-check probably got.
      const pass = checkPassOf(next);
      if (pass > 1) signals.push({ type: 'pass', n: pass });
    }
    this.snapshot = kept;
    if (signals.length === 0) return;
    try {
      this.onSignals(signals);
    } catch (err) {
      this.onError(err);
    }
  }

  private async readEdl(size: number): Promise<number | null> {
    if (size > EDL_MAX_BYTES) return 0;
    try {
      return edlOverlayCount(await readFile(join(this.editDir, 'edl.json'), 'utf8'));
    } catch {
      return null;
    }
  }
}
