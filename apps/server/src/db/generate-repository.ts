// Durable storage for the Generate stage of generated videos (Generated videos, GN0): the only
// code that reads or writes the `job_generate` table. One row per job that has a Generate stage.
// The files in `<job>/edit/generate/` are the truth about what was made; this row is what the Jobs
// list and the job sheet show (`Job.generate`, `GET /api/jobs/:id/generate`) without reading them.
//
// The row appears when the engine starts the stage (`start`), moves on with `update` as the run
// reports progress, and gathers the money (`addSpend`, `addVoiceChars`). Nothing here decides what
// the numbers mean: the engine (GN5) does. A job that is removed takes its row with it
// (`JobRepository.remove` and `purge`).

import {
  type GenerateCounts,
  type GeneratePhase,
  type GenerateState,
  generatePhaseSchema,
  initialGenerateState,
} from '@studio/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { StudioDb } from './database.js';
import { toIso, toMs } from './mapping.js';
import { type JobGenerateRow, jobGenerate } from './schema.js';

export interface GenerateRepositoryOptions {
  /** The clock for every time it writes. Tests pass a fake. */
  clock?: () => Date;
}

/** A row as stored: the state the page shows, plus the two numbers it does not. */
export interface StoredGenerate extends GenerateState {
  jobId: string;
  /** ElevenLabs characters the voice takes used so far. */
  elevenlabsChars: number;
  /** When the row last changed (ISO). */
  updatedAt: string;
}

/** What `update` can change; a field left out stays as it is. */
export interface GeneratePatch {
  phase?: GeneratePhase;
  voice?: GenerateCounts['voice'];
  looks?: GenerateCounts['looks'];
  keyframes?: GenerateCounts['keyframes'];
  clips?: GenerateCounts['clips'];
  belowBar?: number;
  /** The dollars spent so far on Higgsfield (the engine sets the total it read from spend.json). */
  spendUsd?: number;
  budgetUsd?: number;
}

const countSchema = z.number().int().nonnegative();
const progressSchema = z.object({ done: countSchema, total: countSchema });
const patchSchema = z.object({
  phase: generatePhaseSchema.optional(),
  voice: progressSchema.optional(),
  looks: progressSchema.optional(),
  keyframes: progressSchema.optional(),
  clips: progressSchema.optional(),
  belowBar: countSchema.optional(),
  spendUsd: z.number().nonnegative().optional(),
  budgetUsd: z.number().positive().optional(),
});
const budgetSchema = z.number().positive();
const jobIdSchema = z.string().min(1);

/** Six decimals: prices are tenths of a cent, and sums of them should not show float noise. */
const money = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

function rowToStored(row: JobGenerateRow): StoredGenerate {
  return {
    jobId: row.jobId,
    phase: row.phase,
    counts: {
      voice: { done: row.voiceDone, total: row.voiceTotal },
      looks: { done: row.looksDone, total: row.looksTotal },
      keyframes: { done: row.keyframesDone, total: row.keyframesTotal },
      clips: { done: row.clipsDone, total: row.clipsTotal },
      belowBar: row.belowBar,
    },
    spendUsd: row.spendUsd,
    budgetUsd: row.budgetUsd,
    elevenlabsChars: row.elevenlabsChars,
    updatedAt: toIso(row.updatedAt),
  };
}

/** The state the page shows: the stored row without the job id, the characters and the time. */
export function toGenerateState(stored: StoredGenerate): GenerateState {
  return {
    phase: stored.phase,
    counts: stored.counts,
    spendUsd: stored.spendUsd,
    budgetUsd: stored.budgetUsd,
  };
}

export class GenerateRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;

  constructor(db: StudioDb, { clock = () => new Date() }: GenerateRepositoryOptions = {}) {
    this.db = db;
    this.clock = clock;
  }

  /** The job's row, or `null` for a job that has no Generate stage. */
  get(jobId: string): StoredGenerate | null {
    const row = this.db.orm.select().from(jobGenerate).where(eq(jobGenerate.jobId, jobId)).get();
    return row === undefined ? null : rowToStored(row);
  }

  /** Every row, for the money page's service charges (Higgsfield's dollars, ElevenLabs' credits). */
  listAll(): StoredGenerate[] {
    return this.db.orm.select().from(jobGenerate).all().map(rowToStored);
  }

  /** The state of each of these jobs that has one, by job id. */
  states(jobIds: readonly string[]): Map<string, GenerateState> {
    const out = new Map<string, GenerateState>();
    if (jobIds.length === 0) return out;
    const rows = this.db.orm
      .select()
      .from(jobGenerate)
      .where(inArray(jobGenerate.jobId, [...jobIds]))
      .all();
    for (const row of rows) out.set(row.jobId, toGenerateState(rowToStored(row)));
    return out;
  }

  /**
   * Starts the stage for a job: a row at the planning phase with nothing made and nothing spent,
   * under `budgetUsd`. A job that already has a row keeps it (a retry or a resume reuses what was
   * made); only its budget is set again, since a note may have raised it. Returns the row.
   */
  start(jobId: string, budgetUsd: number): StoredGenerate {
    const id = jobIdSchema.parse(jobId);
    const budget = budgetSchema.parse(budgetUsd);
    const at = toMs(this.clock().toISOString());
    return this.inTransaction(() => {
      const existing = this.get(id);
      if (existing === null) {
        const fresh = initialGenerateState(budget);
        this.db.orm
          .insert(jobGenerate)
          .values({
            jobId: id,
            phase: fresh.phase,
            budgetUsd: fresh.budgetUsd,
            updatedAt: at,
          })
          .run();
      } else if (existing.budgetUsd !== budget) {
        this.db.orm
          .update(jobGenerate)
          .set({ budgetUsd: budget, updatedAt: at })
          .where(eq(jobGenerate.jobId, id))
          .run();
      }
      return this.mustGet(id);
    });
  }

  /** Changes the fields of `patch`. Returns the row, or `null` when the job has none. */
  update(jobId: string, patch: GeneratePatch): StoredGenerate | null {
    const given = patchSchema.parse(patch);
    const at = toMs(this.clock().toISOString());
    return this.inTransaction(() => {
      if (this.get(jobId) === null) return null;
      this.db.orm
        .update(jobGenerate)
        .set({
          ...(given.phase === undefined ? {} : { phase: given.phase }),
          ...(given.voice === undefined
            ? {}
            : { voiceDone: given.voice.done, voiceTotal: given.voice.total }),
          ...(given.looks === undefined
            ? {}
            : { looksDone: given.looks.done, looksTotal: given.looks.total }),
          ...(given.keyframes === undefined
            ? {}
            : { keyframesDone: given.keyframes.done, keyframesTotal: given.keyframes.total }),
          ...(given.clips === undefined
            ? {}
            : { clipsDone: given.clips.done, clipsTotal: given.clips.total }),
          ...(given.belowBar === undefined ? {} : { belowBar: given.belowBar }),
          ...(given.spendUsd === undefined ? {} : { spendUsd: money(given.spendUsd) }),
          ...(given.budgetUsd === undefined ? {} : { budgetUsd: given.budgetUsd }),
          updatedAt: at,
        })
        .where(eq(jobGenerate.jobId, jobId))
        .run();
      return this.get(jobId);
    });
  }

  /** Adds `usd` to what has been spent. Returns the row, or `null` when the job has none. */
  addSpend(jobId: string, usd: number): StoredGenerate | null {
    const amount = z.number().nonnegative().parse(usd);
    const at = toMs(this.clock().toISOString());
    // One statement, so two adds never lose one; rounded to six decimals like `update`.
    this.db.orm
      .update(jobGenerate)
      .set({ spendUsd: sql`round(${jobGenerate.spendUsd} + ${amount}, 6)`, updatedAt: at })
      .where(eq(jobGenerate.jobId, jobId))
      .run();
    return this.get(jobId);
  }

  /** Adds ElevenLabs characters to the count. Returns the row, or `null` when the job has none. */
  addVoiceChars(jobId: string, chars: number): StoredGenerate | null {
    const amount = countSchema.parse(chars);
    const at = toMs(this.clock().toISOString());
    this.db.orm
      .update(jobGenerate)
      .set({ elevenlabsChars: sql`${jobGenerate.elevenlabsChars} + ${amount}`, updatedAt: at })
      .where(eq(jobGenerate.jobId, jobId))
      .run();
    return this.get(jobId);
  }

  /** Deletes the job's row. Returns whether there was one. */
  remove(jobId: string): boolean {
    return this.db.orm.delete(jobGenerate).where(eq(jobGenerate.jobId, jobId)).run().changes > 0;
  }

  private mustGet(jobId: string): StoredGenerate {
    const row = this.get(jobId);
    if (row === null) throw new Error(`The job ${jobId} has no Generate row.`);
    return row;
  }

  private inTransaction<T>(work: () => T): T {
    return this.db.sqlite.transaction(work).immediate();
  }
}
