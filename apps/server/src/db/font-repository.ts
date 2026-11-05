// Durable storage for the Fonts page (Fonts plan, "Tables"): the only code that reads or writes the
// `font_uses` and `font_requests` tables. The fonts themselves are files in `<inbox>/_Fonts` and
// belong to the font index (fonts/font-index.ts, FN3); nothing about a font is copied into the
// database. These two tables only remember which jobs used a family ("Used in 14 jobs") and which
// fonts a note asked for that the library did not have (the banner).
//
// Families and names are compared without regard to case, with the shared rule for font names
// (`fontNameKey`: NFC, trimmed, doubled spaces collapsed, lower case). That is done here in code,
// not in SQL, so a name in any script compares the same way everywhere. Both tables are small (a
// row per face per job, a row per missing font asked for), so the reads below take the rows and
// compare them.

import { randomBytes } from 'node:crypto';
import {
  type FontUseSource,
  fontNameKey,
  fontUseSourceSchema,
  fontWeightSchema,
} from '@studio/shared';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { StudioDb } from './database.js';
import { toIso, toMs } from './mapping.js';
import { type FontRequestRow, fontRequests, fontUses } from './schema.js';

/**
 * The weight of a use that does not say which weight it is: the scan of a finished composition
 * (FN17) reads family names, and which weight a rule picks is the browser's call. "Used in" counts
 * a family's distinct jobs whatever the weight, so these rows count like any other.
 */
export const FONT_USE_ANY_WEIGHT = 0;

/** One use of a font face by a job, as {@link FontRepository.addUse} takes it. */
export interface NewFontUse {
  /** The family's name (compared without regard to case). */
  family: string;
  /** 100 to 900, in steps of 100; {@link FONT_USE_ANY_WEIGHT} (0) when the use names no weight. */
  weight: number;
  italic: boolean;
  jobId: string;
  /** 0 is the edit, n is review round n. */
  round: number;
  source: FontUseSource;
}

/** A request for a font the library does not have, as stored: times as ISO text. */
export interface StoredFontRequest {
  /** 12 hex characters. */
  id: string;
  /** As it was written in the note. */
  name: string;
  jobId: string;
  round: number;
  /** When the note was read. */
  at: string;
  /**
   * When the request stopped being open: a family with this name was imported, or it was dismissed
   * ({@link dismissedAt}); `null` while the request is open.
   */
  resolvedAt: string | null;
  /** When the owner pressed "Not a font" on it (C52); `null` if they did not. A dismissal also sets `resolvedAt`. */
  dismissedAt: string | null;
}

export interface FontRepositoryOptions {
  /** The clock for every time it writes. Tests pass a fake. */
  clock?: () => Date;
  /** Makes a row's id (12 hex characters). Tests pass their own. */
  newId?: () => string;
}

const idSchema = z.string().regex(/^[0-9a-f]{12}$/);
const textSchema = z.string().min(1);
const roundSchema = z.number().int().nonnegative();
const isoSchema = z.iso.datetime();

const useWeightSchema = z.union([z.literal(FONT_USE_ANY_WEIGHT), fontWeightSchema]);

const newUseSchema = z.object({
  family: textSchema,
  weight: useWeightSchema,
  italic: z.boolean(),
  jobId: textSchema,
  round: roundSchema,
  source: fontUseSourceSchema,
});

/** A fresh row id: 12 random hex characters. */
export function newFontRowId(): string {
  return randomBytes(6).toString('hex');
}

function rowToRequest(row: FontRequestRow): StoredFontRequest {
  return {
    id: row.id,
    name: row.name,
    jobId: row.jobId,
    round: row.round,
    at: toIso(row.at),
    resolvedAt: row.resolvedAt === null ? null : toIso(row.resolvedAt),
    dismissedAt: row.dismissedAt === null ? null : toIso(row.dismissedAt),
  };
}

/** Rows written in the same millisecond keep their insertion order. */
const BY_ROWID = sql`rowid`;

/**
 * Durable storage for font use and font requests. Every write runs in one transaction, so two
 * writers never both insert the same use or the same open request.
 */
export class FontRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(
    db: StudioDb,
    { clock = () => new Date(), newId = newFontRowId }: FontRepositoryOptions = {},
  ) {
    this.db = db;
    this.clock = clock;
    this.newId = newId;
  }

  // --- uses --------------------------------------------------------------------------------------

  /**
   * Records that the job used this face in `round` (0 is the edit, n is review round n), from a
   * note (`token`) or from its finished compositions (`composition`). An exact duplicate (the same
   * family without regard to case, weight, italic, job, round and source) is ignored. `at` is the
   * time to record (an ISO text); default now. Returns whether a row was added.
   */
  addUse(use: NewFontUse, at: string = this.clock().toISOString()): boolean {
    const given = newUseSchema.parse(use);
    const time = toMs(isoSchema.parse(at));
    const key = fontNameKey(given.family);
    return this.inTransaction(() => {
      const same = this.db.orm
        .select({ family: fontUses.family })
        .from(fontUses)
        .where(
          and(
            eq(fontUses.jobId, given.jobId),
            eq(fontUses.round, given.round),
            eq(fontUses.weight, given.weight),
            eq(fontUses.italic, given.italic ? 1 : 0),
            eq(fontUses.source, given.source),
          ),
        )
        .all();
      if (same.some((row) => fontNameKey(row.family) === key)) return false;
      this.db.orm
        .insert(fontUses)
        .values({
          id: this.freshId(),
          family: given.family,
          weight: given.weight,
          italic: given.italic ? 1 : 0,
          jobId: given.jobId,
          round: given.round,
          source: given.source,
          at: time,
        })
        .run();
      return true;
    });
  }

  /**
   * How many distinct jobs used each family that any job used, in any weight, round or source:
   * `fontNameKey(family)` → count. Look a family up with `fontNameKey(name)`.
   */
  usedCounts(): Map<string, number> {
    const rows = this.db.orm
      .selectDistinct({ family: fontUses.family, jobId: fontUses.jobId })
      .from(fontUses)
      .orderBy(asc(fontUses.family), asc(fontUses.jobId))
      .all();
    const jobs = new Map<string, Set<string>>();
    for (const { family, jobId } of rows) {
      const key = fontNameKey(family);
      const set = jobs.get(key) ?? new Set<string>();
      set.add(jobId);
      jobs.set(key, set);
    }
    return new Map([...jobs].map(([key, set]) => [key, set.size]));
  }

  /** How many distinct jobs used this family (without regard to case), in any weight or round. */
  usedCount(family: string): number {
    return this.usedCounts().get(fontNameKey(family)) ?? 0;
  }

  // --- requests ----------------------------------------------------------------------------------

  /**
   * Records that a note read at `at` (an ISO text; default now) asked for a font the library does
   * not have. `name` is as it was written. The same open request again (the same name without
   * regard to case, job and round) is not added twice: the one that is open is returned. A name
   * The owner dismissed for the job ("Not a font", {@link dismissRequest}) is not added again in any
   * later round either: the dismissed request is returned.
   */
  addRequest(
    name: string,
    jobId: string,
    round: number,
    at: string = this.clock().toISOString(),
  ): StoredFontRequest {
    return this.recordRequest(name, jobId, round, at).request;
  }

  /**
   * {@link addRequest}, and whether the row is new: `added` is false when the same request was
   * already open (a retry or a resume of the same round reads the same note again). The run that
   * tells the browsers a font was asked for does it only for a request that was added.
   */
  recordRequest(
    name: string,
    jobId: string,
    round: number,
    at: string = this.clock().toISOString(),
  ): { request: StoredFontRequest; added: boolean } {
    const given = {
      name: textSchema.parse(name),
      jobId: textSchema.parse(jobId),
      round: roundSchema.parse(round),
      at: toMs(isoSchema.parse(at)),
    };
    const key = fontNameKey(given.name);
    return this.inTransaction(() => {
      const sameName = this.db.orm
        .select()
        .from(fontRequests)
        .where(eq(fontRequests.jobId, given.jobId))
        .orderBy(asc(BY_ROWID))
        .all()
        .filter((row) => fontNameKey(row.name) === key);
      // "Not a font" holds for the job and the name, in this round and every later one.
      const dismissed = sameName.find((row) => row.dismissedAt !== null);
      if (dismissed !== undefined) return { request: rowToRequest(dismissed), added: false };
      const open = sameName.find((row) => row.round === given.round && row.resolvedAt === null);
      if (open !== undefined) return { request: rowToRequest(open), added: false };
      const id = this.freshId();
      this.db.orm
        .insert(fontRequests)
        .values({ id, ...given, resolvedAt: null, dismissedAt: null })
        .run();
      return { request: this.mustGetRequest(id), added: true };
    });
  }

  /**
   * The requests nobody has answered yet that were made after `sinceMs` (milliseconds since the
   * epoch: the banner passes now minus its 7 days), newest first.
   */
  openRequests(sinceMs: number): StoredFontRequest[] {
    return this.db.orm
      .select()
      .from(fontRequests)
      .where(and(isNull(fontRequests.resolvedAt), gt(fontRequests.at, z.number().parse(sinceMs))))
      .orderBy(desc(fontRequests.at), desc(BY_ROWID))
      .all()
      .map(rowToRequest);
  }

  /**
   * A family called `name` (without regard to case) was imported at `at` (an ISO text; default
   * now): every open request with that name is resolved. Returns how many were.
   */
  resolveRequests(name: string, at: string = this.clock().toISOString()): number {
    const key = fontNameKey(textSchema.parse(name));
    const time = toMs(isoSchema.parse(at));
    return this.inTransaction(() => {
      const ids = this.db.orm
        .select({ id: fontRequests.id, name: fontRequests.name })
        .from(fontRequests)
        .where(isNull(fontRequests.resolvedAt))
        .all()
        .filter((row) => fontNameKey(row.name) === key)
        .map((row) => row.id);
      for (const id of ids) {
        this.db.orm
          .update(fontRequests)
          .set({ resolvedAt: time })
          .where(eq(fontRequests.id, id))
          .run();
      }
      return ids.length;
    });
  }

  /**
   * "Not a font" (C52): The owner pressed it on the request `id`, because the word after the `@` was
   * never a font. That request is dismissed at `at` (an ISO text; default now), and so is every
   * other open request of the same job for the same name (a later round that kept the word), so
   * the bar does not ask them twice; {@link recordRequest} never adds that name for that job again.
   * Returns how many requests were open and are dismissed now, `0` when this one was settled
   * already (an import answered it, or it was dismissed before), and `null` when no request has
   * this id.
   */
  dismissRequest(id: string, at: string = this.clock().toISOString()): number | null {
    const given = textSchema.parse(id);
    const time = toMs(isoSchema.parse(at));
    return this.inTransaction(() => {
      const row = this.db.orm.select().from(fontRequests).where(eq(fontRequests.id, given)).get();
      if (row === undefined) return null;
      if (row.resolvedAt !== null) return 0;
      const key = fontNameKey(row.name);
      const ids = this.db.orm
        .select({ id: fontRequests.id, name: fontRequests.name })
        .from(fontRequests)
        .where(and(eq(fontRequests.jobId, row.jobId), isNull(fontRequests.resolvedAt)))
        .all()
        .filter((open) => fontNameKey(open.name) === key)
        .map((open) => open.id);
      for (const openId of ids) {
        this.db.orm
          .update(fontRequests)
          .set({ resolvedAt: time, dismissedAt: time })
          .where(eq(fontRequests.id, openId))
          .run();
      }
      return ids.length;
    });
  }

  // --- internals ---------------------------------------------------------------------------------

  /** A new id no use and no request has. */
  private freshId(): string {
    for (;;) {
      const id = idSchema.parse(this.newId());
      if (!this.idTaken(id)) return id;
    }
  }

  private idTaken(id: string): boolean {
    const use = this.db.orm.select({ id: fontUses.id }).from(fontUses).where(eq(fontUses.id, id));
    const request = this.db.orm
      .select({ id: fontRequests.id })
      .from(fontRequests)
      .where(eq(fontRequests.id, id));
    return use.get() !== undefined || request.get() !== undefined;
  }

  private mustGetRequest(id: string): StoredFontRequest {
    const row = this.db.orm.select().from(fontRequests).where(eq(fontRequests.id, id)).get();
    if (row === undefined) throw new Error(`Font request ${id} vanished inside its transaction`);
    return rowToRequest(row);
  }

  // As in the other repositories: `immediate` takes the write lock up front, and a throw rolls
  // everything back and propagates.
  private inTransaction<T>(work: () => T): T {
    return this.db.sqlite.transaction(work).immediate();
  }
}
