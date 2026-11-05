import {
  normalizeSeriesName,
  SERIES_MESSAGES,
  type Series,
  type SeriesState,
  type SeriesSummary,
  seriesNameKey,
  seriesStateSchema,
} from '@studio/shared';
import { and, asc, count, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { parseSeriesPass, summarizeSeriesPass } from '../clients/style-pass.js';
import { seriesIdFor } from '../inbox/scan.js';
import type { StudioDb } from './database.js';
import { toIso, toMs } from './mapping.js';
import {
  jobs,
  type SeriesPassRecord,
  type SeriesRow,
  seriesTable,
  type WaitingSeriesNoteRecord,
} from './schema.js';

/**
 * A review-note file of the series folder that waits for its episode's approval (C26): Send writes
 * it and records it here; approving the episode takes it into a `replace` pass.
 */
export type WaitingSeriesNote = WaitingSeriesNoteRecord;

/** A series as stored: the wire `Series` plus what Retry runs again. */
export interface StoredSeries extends Omit<Series, 'pass'> {
  /** The series pass queued or running while `learning`, else the last one; `null` when none was recorded. */
  lastPass: SeriesPassRecord | null;
}

/**
 * A new series (Start a series). Its id is `seriesIdFor(clientId, name)`, its name is kept as
 * `normalizeSeriesName` leaves it, and it starts `learning` at version 0 unless told otherwise.
 */
export interface NewSeries {
  clientId: string;
  client: string;
  name: string;
  formatJobId: string;
  formatJob: string;
  state?: SeriesState;
  lastPass?: SeriesPassRecord | null;
}

/**
 * What to change in a stored series. A field that is left out keeps its value, and `null` clears
 * `error` and `lastPass`. `updatedAt` moves to now when something changed.
 */
export interface SeriesPatch {
  /** The client folder's name, spelled as the file system lists it now. */
  client?: string;
  state?: SeriesState;
  error?: string | null;
  version?: number;
  formatJobId?: string;
  formatJob?: string;
  lastPass?: SeriesPassRecord | null;
}

const newSeriesSchema = z.object({
  clientId: z.string().min(1),
  client: z.string().min(1),
  name: z.string().min(1),
  formatJobId: z.string().min(1),
  formatJob: z.string().min(1),
  state: seriesStateSchema.optional(),
  lastPass: z.record(z.string(), z.unknown()).nullable().optional(),
});

const waitingNotesSchema = z.array(
  z.object({
    jobId: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
  }),
);

const patchSchema = z.object({
  client: z.string().min(1).optional(),
  state: seriesStateSchema.optional(),
  error: z.string().min(1).nullable().optional(),
  version: z.number().int().nonnegative().optional(),
  formatJobId: z.string().min(1).optional(),
  formatJob: z.string().min(1).optional(),
  lastPass: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** Thrown by `create` when the client has a series of that name (`seriesNameKey`). The API answers 422. */
export class SeriesNameTakenError extends Error {
  readonly clientId: string;
  readonly seriesName: string;

  constructor(clientId: string, seriesName: string) {
    super(SERIES_MESSAGES.nameTaken);
    this.name = 'SeriesNameTakenError';
    this.clientId = clientId;
    this.seriesName = seriesName;
  }
}

export interface SeriesRepositoryOptions {
  /** The clock for `createdAt` and `updatedAt`. Tests pass a fake. */
  clock?: () => Date;
}

function rowToStored(row: SeriesRow): StoredSeries {
  return {
    id: row.id,
    clientId: row.clientId,
    client: row.client,
    name: row.name,
    state: row.state,
    error: row.error,
    version: row.version,
    formatJobId: row.formatJobId,
    formatJob: row.formatJob,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    lastPass: row.lastPass,
  };
}

/**
 * The wire `Series` of a stored one: everything but `lastPass`, plus what that pass does while the
 * series is learning (`last_pass` is then the pass queued or running), else `null`.
 */
export function toSeries(stored: StoredSeries): Series {
  const { lastPass, ...wire } = stored;
  const pass = stored.state === 'learning' ? parseSeriesPass(lastPass) : null;
  return { ...wire, pass: pass === null ? null : summarizeSeriesPass(pass) };
}

/** The client page's line for a series, with its episode count and the newest episode's time. */
export function toSeriesSummary(
  stored: StoredSeries,
  episodes: { episodeCount: number; lastEpisodeAt: string | null },
): SeriesSummary {
  const { id, name, state, error, formatJobId, formatJob, version, updatedAt } = stored;
  return { id, name, state, error, formatJobId, formatJob, version, updatedAt, ...episodes };
}

function samePass(a: SeriesPassRecord | null, b: SeriesPassRecord | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Durable storage for series (Series plan §2): the only code that reads or writes the `series`
 * table. Which jobs are episodes is on the jobs (`jobs.series_id`, `JobRepository.setSeries`);
 * this only counts them, for the client page.
 */
export class SeriesRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;

  constructor(db: StudioDb, { clock = () => new Date() }: SeriesRepositoryOptions = {}) {
    this.db = db;
    this.clock = clock;
  }

  get(id: string): StoredSeries | null {
    const row = this.selectById(id);
    return row === undefined ? null : rowToStored(row);
  }

  /** The client's series named `name`, compared as `seriesNameKey` (trimmed, NFC, any case). */
  getByName(clientId: string, name: string): StoredSeries | null {
    const row = this.db.orm
      .select()
      .from(seriesTable)
      .where(and(eq(seriesTable.clientId, clientId), eq(seriesTable.nameKey, seriesNameKey(name))))
      .get();
    return row === undefined ? null : rowToStored(row);
  }

  /** The client's series, by name. */
  listByClient(clientId: string): StoredSeries[] {
    return this.db.orm
      .select()
      .from(seriesTable)
      .where(eq(seriesTable.clientId, clientId))
      .orderBy(asc(seriesTable.nameKey), asc(seriesTable.id))
      .all()
      .map(rowToStored);
  }

  /** Every series, of every client, by client and name. */
  list(): StoredSeries[] {
    return this.db.orm
      .select()
      .from(seriesTable)
      .orderBy(asc(seriesTable.clientId), asc(seriesTable.nameKey), asc(seriesTable.id))
      .all()
      .map(rowToStored);
  }

  /**
   * The client's series as the client page lists them (`GET /api/clients/:clientId/series`), by
   * name: each with how many jobs are in it and when the newest of them was added.
   */
  summaries(clientId: string): SeriesSummary[] {
    const stats = new Map(
      this.db.orm
        .select({ seriesId: jobs.seriesId, episodes: count(), lastAddedAt: max(jobs.addedAt) })
        .from(jobs)
        .innerJoin(seriesTable, eq(jobs.seriesId, seriesTable.id))
        .where(eq(seriesTable.clientId, clientId))
        .groupBy(jobs.seriesId)
        .all()
        .map((row) => [row.seriesId, row]),
    );
    return this.listByClient(clientId).map((stored) => {
      const episodes = stats.get(stored.id);
      return toSeriesSummary(stored, {
        episodeCount: episodes?.episodes ?? 0,
        lastEpisodeAt:
          episodes?.lastAddedAt === undefined || episodes.lastAddedAt === null
            ? null
            : toIso(episodes.lastAddedAt),
      });
    });
  }

  /**
   * Stores a new series and returns it. `createdAt` and `updatedAt` are now. Throws
   * `SeriesNameTakenError` (writing nothing) when the client has a series of that name.
   */
  create(input: NewSeries): StoredSeries {
    const given = newSeriesSchema.parse(input);
    const name = normalizeSeriesName(given.name);
    return this.inTransaction(() => {
      if (this.getByName(given.clientId, name) !== null) {
        throw new SeriesNameTakenError(given.clientId, name);
      }
      const now = this.clock().toISOString();
      const created: StoredSeries = {
        id: seriesIdFor(given.clientId, name),
        clientId: given.clientId,
        client: given.client,
        name,
        state: given.state ?? 'learning',
        error: null,
        version: 0,
        formatJobId: given.formatJobId,
        formatJob: given.formatJob,
        createdAt: now,
        updatedAt: now,
        lastPass: given.lastPass ?? null,
      };
      this.db.orm.insert(seriesTable).values(toColumns(created)).run();
      return created;
    });
  }

  /**
   * Changes the series `id` (see {@link SeriesPatch}) and returns it, or `null` when there is no
   * such series. Nothing is written, and `updatedAt` stays, when the row already says exactly this.
   */
  update(id: string, patch: SeriesPatch): StoredSeries | null {
    const given = patchSchema.parse(patch);
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) return null;
      const before = rowToStored(row);
      const next: StoredSeries = {
        ...before,
        client: given.client ?? before.client,
        state: given.state ?? before.state,
        error: given.error === undefined ? before.error : given.error,
        version: given.version ?? before.version,
        formatJobId: given.formatJobId ?? before.formatJobId,
        formatJob: given.formatJob ?? before.formatJob,
        lastPass: given.lastPass === undefined ? before.lastPass : given.lastPass,
      };
      const changed =
        next.client !== before.client ||
        next.state !== before.state ||
        next.error !== before.error ||
        next.version !== before.version ||
        next.formatJobId !== before.formatJobId ||
        next.formatJob !== before.formatJob ||
        !samePass(next.lastPass, before.lastPass);
      if (!changed) return before;
      next.updatedAt = this.clock().toISOString();
      this.db.orm.update(seriesTable).set(toColumns(next)).where(eq(seriesTable.id, id)).run();
      return next;
    });
  }

  /**
   * The review-note files of the series that wait for their episodes' approval, oldest first: `[]`
   * for none, or when there is no such series. What is stored is checked: anything else reads as none.
   */
  waitingNotes(id: string): WaitingSeriesNote[] {
    const row = this.db.orm
      .select({ waitingNotes: seriesTable.waitingNotes })
      .from(seriesTable)
      .where(eq(seriesTable.id, id))
      .get();
    const parsed = waitingNotesSchema.safeParse(row?.waitingNotes ?? []);
    return parsed.success ? parsed.data : [];
  }

  /**
   * Adds `notes` to the series' waiting ones (a file already waiting under that name and job takes
   * the new size) and returns them all, or `null` when there is no such series. `updatedAt` stays:
   * the series itself has not changed.
   */
  addWaitingNotes(id: string, notes: readonly WaitingSeriesNote[]): WaitingSeriesNote[] | null {
    const given = waitingNotesSchema.parse(notes);
    return this.inTransaction(() => {
      if (this.selectById(id) === undefined) return null;
      const byKey = new Map<string, WaitingSeriesNote>();
      for (const note of [...this.waitingNotes(id), ...given]) {
        byKey.set(`${note.jobId}/${note.name.normalize('NFC')}`, note);
      }
      const next = [...byKey.values()];
      this.writeWaitingNotes(id, next);
      return next;
    });
  }

  /** Takes the waiting notes of the job `jobId` out of the series and returns them, oldest first. */
  takeWaitingNotes(id: string, jobId: string): WaitingSeriesNote[] {
    return this.inTransaction(() => {
      const waiting = this.waitingNotes(id);
      const taken = waiting.filter((note) => note.jobId === jobId);
      if (taken.length > 0) {
        this.writeWaitingNotes(
          id,
          waiting.filter((note) => note.jobId !== jobId),
        );
      }
      return taken;
    });
  }

  /** Deletes the series row (its jobs keep their `series_id` until the caller clears it). Whether it existed. */
  remove(id: string): boolean {
    return this.db.orm.delete(seriesTable).where(eq(seriesTable.id, id)).run().changes > 0;
  }

  // As in the other repositories: `immediate` takes the write lock up front, and a throw rolls
  // everything back and propagates.
  private inTransaction<T>(work: () => T): T {
    return this.db.sqlite.transaction(work).immediate();
  }

  private selectById(id: string): SeriesRow | undefined {
    return this.db.orm.select().from(seriesTable).where(eq(seriesTable.id, id)).get();
  }

  private writeWaitingNotes(id: string, notes: readonly WaitingSeriesNote[]): void {
    this.db.orm
      .update(seriesTable)
      .set({ waitingNotes: notes.length === 0 ? null : [...notes] })
      .where(eq(seriesTable.id, id))
      .run();
  }
}

/** The columns of a stored series. `waiting_notes` is not one: only its own methods write it. */
function toColumns(stored: StoredSeries): Omit<SeriesRow, 'waitingNotes'> {
  return {
    id: stored.id,
    clientId: stored.clientId,
    client: stored.client,
    name: stored.name,
    nameKey: seriesNameKey(stored.name),
    formatJobId: stored.formatJobId,
    formatJob: stored.formatJob,
    state: stored.state,
    error: stored.error,
    version: stored.version,
    lastPass: stored.lastPass,
    createdAt: toMs(stored.createdAt),
    updatedAt: toMs(stored.updatedAt),
  };
}
