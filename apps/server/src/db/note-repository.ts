import type { NoteRoute, ReviewNote } from '@studio/shared';
import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { StudioDb } from './database.js';
import { toIso, toMs } from './mapping.js';
import { type ReviewNoteRow, reviewNotes } from './schema.js';

/**
 * A note to store. The id comes from the caller (a voice note's file is named after it). `format`
 * (Generated videos) is the id of the extra format the note was written on; left out or `null` it is
 * the main format.
 */
export type NewReviewNote =
  | { id: string; jobId: string; kind: 'text'; atSec: number; text: string; format?: string | null }
  | {
      id: string;
      jobId: string;
      kind: 'voice';
      atSec: number;
      audioFile: string;
      audioSec: number;
      format?: string | null;
    };

/** What PATCH may change. A field left out keeps its value. */
export interface ReviewNotePatch {
  text?: string;
  addToStyle?: boolean;
  addToSeries?: boolean;
}

/**
 * Where Auto's sorting of a note stands (quick fixes): the router is reading it, or it answered
 * with this route. `setRoute(noteId, null)` takes the sorting off again.
 */
export type NoteRouteState = { status: 'pending' } | { status: 'routed'; route: NoteRoute };

/** How a voice note's transcription ended. */
export type TranscriptOutcome = { status: 'done'; text: string } | { status: 'failed' };

export interface NoteRepositoryOptions {
  /** The clock for `createdAt`. Tests pass a fake. */
  clock?: () => Date;
}

function rowToNote(row: ReviewNoteRow): ReviewNote {
  return {
    id: row.id,
    jobId: row.jobId,
    round: row.round,
    atSec: row.atSec,
    kind: row.kind,
    text: row.text,
    audioFile: row.audioFile,
    audioSec: row.audioSec,
    transcriptStatus: row.transcriptStatus,
    addToStyle: row.addToStyle,
    addToSeries: row.addToSeries,
    createdAt: toIso(row.createdAt),
    sentAt: row.sentAt === null ? null : toIso(row.sentAt),
    routeStatus: row.routeStatus,
    route:
      row.routeTier === null
        ? null
        : { tier: row.routeTier, kind: row.routeKind ?? '', why: row.routeWhy ?? '' },
    format: row.format,
    fixId: row.fixId,
    fixedAt: row.fixedAt === null ? null : toIso(row.fixedAt),
  };
}

// The order the web shows and the round file reads: where the note is pinned, then when it was
// written; the id only breaks exact ties so every read is in the same order.
const NOTE_ORDER = [
  asc(reviewNotes.atSec),
  asc(reviewNotes.createdAt),
  asc(reviewNotes.id),
] as const;

/**
 * Durable storage for review notes (Phase 3 §6): the only code that reads or writes the
 * `review_notes` table. A note is unsent while its `round` is null; Send stamps the round (and
 * `sentAt`) with {@link markSent}. Sent notes are never changed again.
 */
export class NoteRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;

  constructor(db: StudioDb, { clock = () => new Date() }: NoteRepositoryOptions = {}) {
    this.db = db;
    this.clock = clock;
  }

  /** Any note, sent or not, of any job. */
  get(noteId: string): ReviewNote | null {
    const row = this.selectById(noteId);
    return row === undefined ? null : rowToNote(row);
  }

  /** The job's unsent notes (round null), by atSec, then createdAt, then id. */
  listUnsent(jobId: string): ReviewNote[] {
    return this.db.orm
      .select()
      .from(reviewNotes)
      .where(and(eq(reviewNotes.jobId, jobId), isNull(reviewNotes.round)))
      .orderBy(...NOTE_ORDER)
      .all()
      .map(rowToNote);
  }

  /**
   * The job's sent notes (round not null), by round, then atSec, then createdAt, then id. Sent
   * notes never change, so this is the same list in every state of the job.
   */
  listSent(jobId: string): ReviewNote[] {
    return this.db.orm
      .select()
      .from(reviewNotes)
      .where(and(eq(reviewNotes.jobId, jobId), isNotNull(reviewNotes.round)))
      .orderBy(asc(reviewNotes.round), ...NOTE_ORDER)
      .all()
      .map(rowToNote);
  }

  /**
   * Every sent note of every job, oldest sent first, then by job, round and the order the Review
   * dialog shows them. The Analytics page reads it once for all its numbers (its Reviews section).
   */
  listAllSent(): ReviewNote[] {
    return this.db.orm
      .select()
      .from(reviewNotes)
      .where(isNotNull(reviewNotes.round))
      .orderBy(
        asc(reviewNotes.sentAt),
        asc(reviewNotes.jobId),
        asc(reviewNotes.round),
        ...NOTE_ORDER,
      )
      .all()
      .map(rowToNote);
  }

  countUnsent(jobId: string): number {
    const row = this.db.orm
      .select({ n: count() })
      .from(reviewNotes)
      .where(and(eq(reviewNotes.jobId, jobId), isNull(reviewNotes.round)))
      .get();
    return row?.n ?? 0;
  }

  /** Unsent voice notes whose transcript is pending, of every job, oldest first (boot re-enqueues them). */
  listPendingVoice(): ReviewNote[] {
    return this.db.orm
      .select()
      .from(reviewNotes)
      .where(
        and(
          isNull(reviewNotes.round),
          eq(reviewNotes.kind, 'voice'),
          eq(reviewNotes.transcriptStatus, 'pending'),
        ),
      )
      .orderBy(asc(reviewNotes.createdAt), asc(reviewNotes.id))
      .all()
      .map(rowToNote);
  }

  /** Unsent notes whose sorting was left `pending` (the engine stopped while the router read them), of every job, oldest first (boot sorts them again). */
  listRoutePending(): ReviewNote[] {
    return this.db.orm
      .select()
      .from(reviewNotes)
      .where(and(isNull(reviewNotes.round), eq(reviewNotes.routeStatus, 'pending')))
      .orderBy(asc(reviewNotes.createdAt), asc(reviewNotes.id))
      .all()
      .map(rowToNote);
  }

  /** Stores an unsent note, createdAt = now, addToStyle and addToSeries false. Text: audio fields and status null. Voice: text null, status 'pending'. */
  create(note: NewReviewNote): ReviewNote {
    const base = {
      id: note.id,
      jobId: note.jobId,
      round: null,
      atSec: note.atSec,
      addToStyle: false,
      addToSeries: false,
      createdAt: toMs(this.clock().toISOString()),
      sentAt: null,
      routeStatus: null,
      routeTier: null,
      routeKind: null,
      routeWhy: null,
      format: note.format ?? null,
      fixId: null,
      fixedAt: null,
    };
    const row: ReviewNoteRow =
      note.kind === 'text'
        ? {
            ...base,
            kind: 'text',
            text: note.text,
            audioFile: null,
            audioSec: null,
            transcriptStatus: null,
          }
        : {
            ...base,
            kind: 'voice',
            text: null,
            audioFile: note.audioFile,
            audioSec: note.audioSec,
            transcriptStatus: 'pending',
          };
    this.db.orm.insert(reviewNotes).values(row).run();
    return rowToNote(row);
  }

  /** Changes an unsent note; null when no unsent note has this id. */
  update(noteId: string, patch: ReviewNotePatch): ReviewNote | null {
    return this.db.sqlite
      .transaction((): ReviewNote | null => {
        const row = this.selectById(noteId);
        if (row === undefined || row.round !== null) return null;
        const changes: Partial<Pick<ReviewNoteRow, 'text' | 'addToStyle' | 'addToSeries'>> = {};
        if (patch.text !== undefined) changes.text = patch.text;
        if (patch.addToStyle !== undefined) changes.addToStyle = patch.addToStyle;
        if (patch.addToSeries !== undefined) changes.addToSeries = patch.addToSeries;
        if (Object.keys(changes).length > 0) {
          this.db.orm
            .update(reviewNotes)
            .set(changes)
            .where(and(eq(reviewNotes.id, noteId), isNull(reviewNotes.round)))
            .run();
        }
        return this.mustGet(noteId);
      })
      .immediate();
  }

  /**
   * Saves where Auto's sorting of an unsent note stands (quick fixes): `pending` while the router
   * reads it, `routed` with its route once it has answered, or `null` to take the sorting off (a
   * note whose text changed is read again). Returns the note; null when no unsent note has this id.
   */
  setRoute(noteId: string, state: NoteRouteState | null): ReviewNote | null {
    const changed = this.db.orm
      .update(reviewNotes)
      .set(
        state === null
          ? { routeStatus: null, routeTier: null, routeKind: null, routeWhy: null }
          : state.status === 'pending'
            ? { routeStatus: 'pending', routeTier: null, routeKind: null, routeWhy: null }
            : {
                routeStatus: 'routed',
                routeTier: state.route.tier,
                routeKind: state.route.kind,
                routeWhy: state.route.why,
              },
      )
      .where(and(eq(reviewNotes.id, noteId), isNull(reviewNotes.round)))
      .run().changes;
    return changed > 0 ? this.get(noteId) : null;
  }

  /**
   * Saves the quick fix made for an unsent note (quick fixes): its id (`null` for none) and when it
   * landed (`null` until then, and again after Undo). Returns the note; null when no unsent note
   * has this id.
   */
  setFix(noteId: string, fix: { fixId: string | null; fixedAt: string | null }): ReviewNote | null {
    const changed = this.db.orm
      .update(reviewNotes)
      .set({
        fixId: fix.fixId,
        fixedAt: fix.fixedAt === null ? null : toMs(fix.fixedAt),
      })
      .where(and(eq(reviewNotes.id, noteId), isNull(reviewNotes.round)))
      .run().changes;
    return changed > 0 ? this.get(noteId) : null;
  }

  /** Saves a transcription's outcome (done: the text too), only while the note is still pending; else null. */
  setTranscript(noteId: string, outcome: TranscriptOutcome): ReviewNote | null {
    const changed = this.db.orm
      .update(reviewNotes)
      .set(
        outcome.status === 'done'
          ? { transcriptStatus: 'done', text: outcome.text }
          : { transcriptStatus: 'failed' },
      )
      .where(and(eq(reviewNotes.id, noteId), eq(reviewNotes.transcriptStatus, 'pending')))
      .run().changes;
    return changed > 0 ? this.get(noteId) : null;
  }

  /** Deletes the note; whether it existed. */
  remove(noteId: string): boolean {
    return this.db.orm.delete(reviewNotes).where(eq(reviewNotes.id, noteId)).run().changes > 0;
  }

  /**
   * Stamps these unsent notes of the job with `round` and `sentAt` and returns them, by atSec. Throws
   * (writing nothing) unless every id is an unsent note of this job. Called inside the Send transaction.
   */
  markSent(jobId: string, noteIds: readonly string[], round: number, sentAt: string): ReviewNote[] {
    const ids = [...new Set(noteIds)];
    return this.db.sqlite
      .transaction((): ReviewNote[] => {
        if (ids.length === 0) return [];
        const rows = this.db.orm
          .select()
          .from(reviewNotes)
          .where(inArray(reviewNotes.id, ids))
          .all();
        for (const id of ids) {
          const row = rows.find((candidate) => candidate.id === id);
          if (row === undefined) throw new Error(`Note ${id} not found`);
          if (row.jobId !== jobId) throw new Error(`Note ${id} belongs to another job`);
          if (row.round !== null) throw new Error(`Note ${id} was sent already`);
        }
        this.db.orm
          .update(reviewNotes)
          .set({ round, sentAt: toMs(sentAt) })
          .where(
            and(
              eq(reviewNotes.jobId, jobId),
              inArray(reviewNotes.id, ids),
              isNull(reviewNotes.round),
            ),
          )
          .run();
        return this.db.orm
          .select()
          .from(reviewNotes)
          .where(inArray(reviewNotes.id, ids))
          .orderBy(...NOTE_ORDER)
          .all()
          .map(rowToNote);
      })
      .immediate();
  }

  private selectById(noteId: string): ReviewNoteRow | undefined {
    return this.db.orm.select().from(reviewNotes).where(eq(reviewNotes.id, noteId)).get();
  }

  private mustGet(noteId: string): ReviewNote {
    const note = this.get(noteId);
    if (note === null) throw new Error(`Note ${noteId} not found`);
    return note;
  }
}
