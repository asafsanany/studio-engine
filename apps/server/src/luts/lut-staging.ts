// The staging folder of an import (LUTs plan, "On disk"): `<data>/lut-staging/<stageId>/` holds the
// uploads that wait for the owner to mark each Look, Camera or Fix. OWNER: LU1.
//
// A stage is reaped at boot and after LUT_LIMITS.stageLifetimeMs (1 hour). Nothing here knows what
// a LUT is: checking is lut-check.ts, the import is the service's.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LUT_LIMITS } from '@studio/shared';
import type { WorkerLogger } from '../pipeline/worker.js';

/** `<data>/lut-staging`: where every stage's folder is made. */
export function lutStagingRoot(dataDir: string): string {
  return join(dataDir, 'lut-staging');
}

/** A stage: its id and its folder. */
export interface LutStage {
  stageId: string;
  dir: string;
}

export interface LutStaging {
  /** Makes an empty stage folder `<data>/lut-staging/<stageId>/` for an upload to write into. */
  create(): Promise<LutStage>;
  /** The stage's folder, or `null` for an id the engine does not know (or one that was reaped). */
  find(stageId: string): Promise<LutStage | null>;
  /** Removes the stage's folder. Whether there was one. */
  remove(stageId: string): Promise<boolean>;
  /**
   * Removes the stages older than LUT_LIMITS.stageLifetimeMs at `now` (every stage, when `all`:
   * at boot nothing is waiting any more). Answers how many it removed.
   */
  reap(options?: { now?: Date; all?: boolean }): Promise<number>;
}

export interface LutStagingOptions {
  /** The engine's data folder; the stages are in {@link lutStagingRoot} of it. */
  dataDir: string;
  clock?: () => Date;
}

/** A stage id is 12 hex characters; anything else never names a folder (no `..`, no `/`). */
const STAGE_ID = /^[0-9a-f]{12}$/;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The staging folders of this engine. */
export function createLutStaging({
  dataDir,
  clock = () => new Date(),
}: LutStagingOptions): LutStaging {
  const root = lutStagingRoot(dataDir);
  return {
    async create() {
      await mkdir(root, { recursive: true });
      for (;;) {
        const stageId = randomBytes(6).toString('hex');
        const dir = join(root, stageId);
        try {
          await mkdir(dir); // not recursive: an id that exists fails and another is drawn
          return { stageId, dir };
        } catch (err) {
          if ((err as { code?: string }).code !== 'EEXIST') throw err;
        }
      }
    },
    async find(stageId) {
      if (!STAGE_ID.test(stageId)) return null;
      const dir = join(root, stageId);
      return (await isDirectory(dir)) ? { stageId, dir } : null;
    },
    async remove(stageId) {
      if (!STAGE_ID.test(stageId)) return false;
      const dir = join(root, stageId);
      if (!(await isDirectory(dir))) return false;
      await rm(dir, { recursive: true, force: true });
      return true;
    },
    async reap({ now = clock(), all = false } = {}) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return 0; // no staging folder yet
      }
      let removed = 0;
      for (const name of names) {
        if (!STAGE_ID.test(name)) continue;
        const dir = join(root, name);
        try {
          const info = await stat(dir);
          if (!info.isDirectory()) continue;
          if (!all && now.getTime() - info.mtimeMs < LUT_LIMITS.stageLifetimeMs) continue;
          await rm(dir, { recursive: true, force: true });
          removed += 1;
        } catch {
          // gone already, or not removable now: the next pass tries again
        }
      }
      return removed;
    },
  };
}

/** How often the engine looks for stages to reap while it runs. */
export const LUT_STAGE_REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Reaps every stage now (nothing waits across a restart) and then the old ones every hour. Answers
 * the function that stops it. The engine calls it at boot while the LUTs switch is on.
 */
export function startLutStagingReaper(
  staging: LutStaging,
  logger: WorkerLogger,
  intervalMs: number = LUT_STAGE_REAP_INTERVAL_MS,
): () => void {
  const run = (all: boolean): void => {
    staging.reap({ all }).then(
      (removed) => {
        if (removed > 0) logger.info({ removed }, 'luts: removed old uploads');
      },
      (err: unknown) => logger.warn({ err }, 'luts: could not remove old uploads'),
    );
  };
  run(true);
  const timer = setInterval(() => run(false), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
