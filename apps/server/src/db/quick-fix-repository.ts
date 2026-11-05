// Durable storage for quick fixes (Quick fixes plan, QF0): the only code that reads or writes the
// `quick_fixes` table. A fix is one Sonnet run that changes only the live composition for one review
// note; the files it works in are in the job folder (edit/review/fixes/<id>/), and this table says
// where each fix stands. It holds what `QuickFix` (shared) holds, nothing more: the fix service
// (QF3) decides when a fix moves on, this only stores it.
//
// The order of the fixes is the order they were inserted in, which is the order they run in: the
// queue of a job is its fixes oldest first. SQLite's rowid keeps it (a row never moves), so the
// table needs no sequence column.

import type { QuickFix } from '@studio/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { StudioDb } from './database.js';
import { toIso, toMs } from './mapping.js';
import { type QuickFixRow, quickFixes, reviewNotes } from './schema.js';

/** What {@link QuickFixRepository.update} may change. A field left out keeps its value. */
export type QuickFixPatch = Partial<Omit<QuickFix, 'id' | 'jobId' | 'noteId' | 'round'>>;

export interface QuickFixRepositoryOptions {
  /** The clock for the end of a fix `markRunningFailed` stops. Tests pass a fake. */
  clock?: () => Date;
}

/** What a fix that was running when the engine stopped says about itself. */
export const FIX_STOPPED_WHY = 'The engine stopped while this fix was running.';

/**
 * What the Jobs list needs of a job's fixes (C57): the `Job.fixing` and `Job.fixedCount` of one
 * job. See {@link QuickFixRepository.summaries}.
 */
export interface FixSummary {
  /** The time of the note being fixed (a running fix's, else the next queued one's); `null` when none. */
  fixing: { atSec: number } | null;
  /** How many notes of the round are fixed and not undone. */
  fixedCount: number;
}

/** A job with no fix under way and none fixed. */
export const NO_FIX_SUMMARY: FixSummary = { fixing: null, fixedCount: 0 };

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

function msOrNull(iso: string | null): number | null {
  return iso === null ? null : toMs(iso);
}

function rowToFix(row: QuickFixRow): QuickFix {
  return {
    id: row.id,
    jobId: row.jobId,
    noteId: row.noteId,
    round: row.round,
    status: row.status,
    step: row.step,
    stepLabel: row.stepLabel,
    said: row.said,
    why: row.why,
    model: row.model,
    effort: row.effort,
    startedAt: isoOrNull(row.startedAt),
    endedAt: isoOrNull(row.endedAt),
    durationSec: row.durationSec,
    hasCompare: row.hasCompare,
  };
}

function fixToRow(fix: QuickFix): QuickFixRow {
  return {
    id: fix.id,
    jobId: fix.jobId,
    noteId: fix.noteId,
    round: fix.round,
    status: fix.status,
    step: fix.step,
    stepLabel: fix.stepLabel,
    said: fix.said,
    why: fix.why,
    model: fix.model,
    effort: fix.effort,
    startedAt: msOrNull(fix.startedAt),
    endedAt: msOrNull(fix.endedAt),
    durationSec: fix.durationSec,
    hasCompare: fix.hasCompare,
  };
}

// Oldest first: the order the fixes were queued in.
const QUEUE_ORDER = sql`rowid`;

export class QuickFixRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;

  constructor(db: StudioDb, { clock = () => new Date() }: QuickFixRepositoryOptions = {}) {
    this.db = db;
    this.clock = clock;
  }

  /** Stores a fix as it is given (the service queues one with status `queued`) and returns it. Throws if the id is taken. */
  insert(fix: QuickFix): QuickFix {
    this.db.orm.insert(quickFixes).values(fixToRow(fix)).run();
    return fix;
  }

  /** Changes a fix (its status, step, reply and times move as the run does); null when no fix has this id. */
  update(id: string, patch: QuickFixPatch): QuickFix | null {
    const changes: Partial<QuickFixRow> = {};
    if (patch.status !== undefined) changes.status = patch.status;
    if (patch.step !== undefined) changes.step = patch.step;
    if (patch.stepLabel !== undefined) changes.stepLabel = patch.stepLabel;
    if (patch.said !== undefined) changes.said = patch.said;
    if (patch.why !== undefined) changes.why = patch.why;
    if (patch.model !== undefined) changes.model = patch.model;
    if (patch.effort !== undefined) changes.effort = patch.effort;
    if (patch.startedAt !== undefined) changes.startedAt = msOrNull(patch.startedAt);
    if (patch.endedAt !== undefined) changes.endedAt = msOrNull(patch.endedAt);
    if (patch.durationSec !== undefined) changes.durationSec = patch.durationSec;
    if (patch.hasCompare !== undefined) changes.hasCompare = patch.hasCompare;
    if (Object.keys(changes).length > 0) {
      const changed = this.db.orm
        .update(quickFixes)
        .set(changes)
        .where(eq(quickFixes.id, id))
        .run().changes;
      if (changed === 0) return null;
    }
    return this.get(id);
  }

  get(id: string): QuickFix | null {
    const row = this.db.orm.select().from(quickFixes).where(eq(quickFixes.id, id)).get();
    return row === undefined ? null : rowToFix(row);
  }

  /** The fixes of the job's round (the round its notes will be stamped with), in the order they were queued. */
  listForRound(jobId: string, round: number): QuickFix[] {
    return this.db.orm
      .select()
      .from(quickFixes)
      .where(and(eq(quickFixes.jobId, jobId), eq(quickFixes.round, round)))
      .orderBy(asc(QUEUE_ORDER))
      .all()
      .map(rowToFix);
  }

  /**
   * The summary of each named job's fixes, one read for all of them (the Jobs list asks for every job
   * in Review at once). `round` is the round the job's notes will be stamped with (`job.round + 1`),
   * the only round whose fixes count. A job with nothing to say is left out of the map.
   *
   * - `fixing`: the note of the fix that is running, else of the oldest one still queued (it is next,
   *   and the line should not blink out between two fixes); the note's `atSec`;
   * - `fixedCount`: the notes with a `fixed` fix (an undone one is `undone`, so it does not count).
   */
  summaries(jobs: readonly { id: string; round: number }[]): Map<string, FixSummary> {
    const rounds = new Map(jobs.map((job) => [job.id, job.round]));
    const result = new Map<string, FixSummary>();
    if (rounds.size === 0) return result;
    const rows = this.db.orm
      .select({
        jobId: quickFixes.jobId,
        round: quickFixes.round,
        noteId: quickFixes.noteId,
        status: quickFixes.status,
        atSec: reviewNotes.atSec,
      })
      .from(quickFixes)
      .leftJoin(reviewNotes, eq(reviewNotes.id, quickFixes.noteId))
      .where(
        and(
          inArray(quickFixes.jobId, [...rounds.keys()]),
          inArray(quickFixes.status, ['queued', 'running', 'fixed']),
        ),
      )
      .orderBy(asc(sql`${quickFixes}.rowid`))
      .all();
    const fixedNotes = new Map<string, Set<string>>();
    const running = new Map<string, number>();
    const queued = new Map<string, number>();
    for (const row of rows) {
      if (rounds.get(row.jobId) !== row.round) continue;
      if (row.status === 'fixed') {
        const notes = fixedNotes.get(row.jobId) ?? new Set<string>();
        notes.add(row.noteId);
        fixedNotes.set(row.jobId, notes);
      } else if (row.atSec !== null) {
        // The rows come oldest first, so the first queued one of a job is the next to run.
        if (row.status === 'running') running.set(row.jobId, row.atSec);
        else if (!queued.has(row.jobId)) queued.set(row.jobId, row.atSec);
      }
    }
    for (const id of rounds.keys()) {
      const atSec = running.get(id) ?? queued.get(id);
      const fixedCount = fixedNotes.get(id)?.size ?? 0;
      if (atSec === undefined && fixedCount === 0) continue;
      result.set(id, { fixing: atSec === undefined ? null : { atSec }, fixedCount });
    }
    return result;
  }

  /**
   * Every fix still `queued`, of every job, in the order they were queued (the fix service
   * cancels the ones an earlier engine left, at start-up).
   */
  listQueued(): QuickFix[] {
    return this.db.orm
      .select()
      .from(quickFixes)
      .where(eq(quickFixes.status, 'queued'))
      .orderBy(asc(QUEUE_ORDER))
      .all()
      .map(rowToFix);
  }

  /**
   * The newest fix of the job's round that is `fixed`: the last one to have ended, which is the
   * one that changed the files last and so the one Undo takes back (a fix that was undone, failed
   * or escalated does not count), or null when it has none. Fixes that ended at the same moment,
   * or have no end, go by the order they were queued in.
   */
  newestFixed(jobId: string, round: number): QuickFix | null {
    const row = this.db.orm
      .select()
      .from(quickFixes)
      .where(
        and(
          eq(quickFixes.jobId, jobId),
          eq(quickFixes.round, round),
          eq(quickFixes.status, 'fixed'),
        ),
      )
      // Fixes run in the order of their notes, not of their rows, so the end decides first.
      .orderBy(desc(quickFixes.endedAt), desc(QUEUE_ORDER))
      .limit(1)
      .get();
    return row === undefined ? null : rowToFix(row);
  }

  /**
   * Start-up: every fix still `running` belongs to an engine that is gone. Each is marked `failed`,
   * ended now, with {@link FIX_STOPPED_WHY}; the fixes that changed are returned (oldest first) so
   * the caller can put their `before/` back and tell the page. Fixes that were only `queued` stay
   * as they are.
   */
  markRunningFailed(): QuickFix[] {
    return this.db.sqlite
      .transaction((): QuickFix[] => {
        const running = this.db.orm
          .select()
          .from(quickFixes)
          .where(eq(quickFixes.status, 'running'))
          .orderBy(asc(QUEUE_ORDER))
          .all();
        const endedAt = toMs(this.clock().toISOString());
        for (const row of running) {
          this.db.orm
            .update(quickFixes)
            .set({
              status: 'failed',
              step: null,
              stepLabel: null,
              why: FIX_STOPPED_WHY,
              endedAt,
              durationSec:
                row.startedAt === null ? null : Math.max(0, (endedAt - row.startedAt) / 1000),
            })
            .where(eq(quickFixes.id, row.id))
            .run();
        }
        return running.flatMap((row) => {
          const fix = this.get(row.id);
          return fix === null ? [] : [fix];
        });
      })
      .immediate();
  }
}
