// The shared part of the two preview makers (LUTs plan, "Previews"): the queue that runs at most N
// stills at a time, shares a run between requests for the same still, and lets a still the page is
// waiting for jump ahead of the ones being warmed in the background. OWNER: LU2.

import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LUT_FRAMES, type LutFrame, type LutPreviewSide } from '@studio/shared';
import type { WorkerLogger } from '../pipeline/worker.js';
import { lutFrameFile, lutStillNeedsGrade } from './lut-frames.js';
import type { LutPreviews, PreviewSource } from './lut-previews.js';

/** `now`: a request is waiting for it. `background`: warming; runs when nothing else waits. */
export type StillPriority = 'now' | 'background';

interface Entry {
  key: string;
  priority: StillPriority;
  started: boolean;
  work: (priority: StillPriority) => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface StillQueue {
  /**
   * Runs `work` when a slot is free and answers its result. A second call with the same `key` while
   * the first is queued or running shares it (and, if it is `now` and the first was only
   * `background`, moves it up the queue). `work` is told the priority it starts with.
   */
  run<T>(
    key: string,
    priority: StillPriority,
    work: (priority: StillPriority) => Promise<T>,
  ): Promise<T>;
}

/** A queue that runs at most `concurrency` jobs at a time. */
export function createStillQueue(concurrency: number): StillQueue {
  const entries = new Map<string, Entry>();
  const waiting: Record<StillPriority, Entry[]> = { now: [], background: [] };
  let running = 0;

  const pump = (): void => {
    while (running < concurrency) {
      const next = waiting.now.shift() ?? waiting.background.shift();
      if (next === undefined) return;
      next.started = true;
      running += 1;
      next
        .work(next.priority)
        .then(next.resolve, next.reject)
        .finally(() => {
          running -= 1;
          entries.delete(next.key);
          pump();
        });
    }
  };

  return {
    run<T>(
      key: string,
      priority: StillPriority,
      work: (priority: StillPriority) => Promise<T>,
    ): Promise<T> {
      const existing = entries.get(key);
      if (existing !== undefined) {
        if (!existing.started && priority === 'now' && existing.priority === 'background') {
          waiting.background.splice(waiting.background.indexOf(existing), 1);
          existing.priority = 'now';
          waiting.now.push(existing);
        }
        return existing.promise as Promise<T>;
      }
      let resolve!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A background run nobody awaits must not become an unhandled rejection.
      promise.catch(() => {});
      const entry: Entry = { key, priority, started: false, work, promise, resolve, reject };
      entries.set(key, entry);
      waiting[priority].push(entry);
      pump();
      return promise as Promise<T>;
    },
  };
}

export interface QueuedPreviewsOptions {
  /** At most this many stills are made at a time. */
  concurrency: number;
  /** Where a still is cached. */
  pathFor: (source: PreviewSource, frame: LutFrame, side: LutPreviewSide) => string;
  /** Makes the "after" still of a LUT that is not a Camera one, writing `outPath`. */
  make: (
    source: PreviewSource,
    frame: LutFrame,
    outPath: string,
    priority: StillPriority,
  ) => Promise<void>;
  logger?: WorkerLogger;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The maker both engines share: a Camera LUT's stills and every "before" are the bundled frames
 * (no work), the "after" of the rest is cached in `pathFor` and made by `make`, once at a time per
 * still, `concurrency` at a time in all. A failure is logged and rejects `still`; `warm` never
 * throws.
 */
export function createQueuedPreviews(options: QueuedPreviewsOptions): LutPreviews {
  const { concurrency, pathFor, make, logger } = options;
  const queue = createStillQueue(concurrency);

  const made = (
    source: PreviewSource,
    frame: LutFrame,
    side: LutPreviewSide,
    priority: StillPriority,
  ): Promise<string> => {
    if (!lutStillNeedsGrade(side, source.kind)) {
      return Promise.resolve(lutFrameFile(frame, side, source.kind));
    }
    const outPath = pathFor(source, frame, side);
    return queue.run(outPath, priority, async (startedAs) => {
      if (await exists(outPath)) return outPath;
      await mkdir(dirname(outPath), { recursive: true });
      try {
        await make(source, frame, outPath, startedAs);
      } catch (err) {
        logger?.warn({ err, lut: source.key, frame }, 'could not make a LUT preview still');
        throw err;
      }
      return outPath;
    });
  };

  return {
    still: (source, frame, side) => made(source, frame, side, 'now'),
    warm: (source) => {
      for (const frame of LUT_FRAMES) {
        made(source, frame, 'after', 'background').catch(() => {
          // Already logged by `made`; the page asks again when it needs the still.
        });
      }
    },
  };
}
