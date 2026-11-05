// Durable storage for the LUTs library (LUTs plan, "Tables"): the only code that reads or writes
// the `luts` and `lut_uses` tables. The files themselves are in `<inbox>/_LUTs/` and belong to the
// LUT service (luts/lut-service.ts); the rules of the API (who may rename, what an import does)
// belong to it too. Built-in LUTs are a fixed catalog in shared and have no row; they only count
// here as names and slugs that Yours cannot take, and as keys in `lut_uses`.

import { randomBytes } from 'node:crypto';
import {
  BUILTIN_LUTS,
  cleanLutName,
  isNewLut,
  LUT_MESSAGES,
  type LutDetail,
  type LutKind,
  type LutSummary,
  lutKindSchema,
  lutNameKey,
  lutSizeLabel,
  lutSlug,
  lutUsedLabel,
} from '@studio/shared';
import { and, asc, countDistinct, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { lutPreviewVersion } from '../luts/lut-preview-version.js';
import type { StudioDb } from './database.js';
import { toIso, toMs } from './mapping.js';
import { type LutRow, luts, lutUses } from './schema.js';

/** A LUT as stored: everything its row says, times as ISO text. */
export interface StoredLut {
  id: string;
  /** The name in kebab-case; what notes write after `@luts/`. */
  slug: string;
  name: string;
  kind: LutKind;
  /** The grid points per side. */
  size: number;
  /** The file's name inside `<inbox>/_LUTs`. */
  file: string;
  bytes: number;
  /** Of the stored file. */
  sha256: string;
  /** The file's name as it was imported. */
  sourceName: string;
  createdAt: string;
  updatedAt: string;
  /** `null` for a live LUT. */
  deletedAt: string | null;
}

/**
 * A new LUT. Its name is cleaned (`cleanLutName`) and must be free among the live LUTs and the
 * built-in ones; its slug follows from the name. `id` is made when left out.
 */
export interface NewLut {
  id?: string;
  name: string;
  kind: LutKind;
  size: number;
  file: string;
  bytes: number;
  sha256: string;
  sourceName: string;
}

/**
 * Thrown when a name (or the slug it makes) is taken by another live LUT or by a built-in one,
 * compared without regard to case. The API answers 422.
 */
export class LutNameTakenError extends Error {
  readonly lutName: string;

  constructor(lutName: string) {
    super(LUT_MESSAGES.nameTaken);
    this.name = 'LutNameTakenError';
    this.lutName = lutName;
  }
}

/** Thrown when a name is empty once cleaned. The API answers 422. */
export class LutNameEmptyError extends Error {
  constructor() {
    super(LUT_MESSAGES.nameEmpty);
    this.name = 'LutNameEmptyError';
  }
}

export interface LutRepositoryOptions {
  /** The clock for every time it writes. Tests pass a fake. */
  clock?: () => Date;
  /** Makes a new LUT's id (12 hex characters). Tests pass their own. */
  newId?: () => string;
}

const idSchema = z.string().regex(/^[0-9a-f]{12}$/);
const keySchema = z.string().min(1);

const newLutSchema = z.object({
  id: idSchema.optional(),
  name: z.string(),
  kind: lutKindSchema,
  size: z.number().int().min(2).max(129),
  file: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  sourceName: z.string().min(1),
});

function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

function rowToStored(row: LutRow): StoredLut {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    size: row.size,
    file: row.file,
    bytes: row.bytes,
    sha256: row.sha256,
    sourceName: row.sourceName,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    deletedAt: toIsoOrNull(row.deletedAt),
  };
}

/**
 * The list's line for a LUT of Yours. `used` is how many jobs used it; `now` decides the "New" tag
 * (30 minutes after the import).
 */
export function toLutSummary(
  stored: StoredLut,
  used: number,
  now: Date | string | number = new Date(),
): LutSummary {
  return {
    slug: stored.slug,
    name: stored.name,
    kind: stored.kind,
    size: stored.size,
    owner: 'yours',
    used,
    usedLabel: lutUsedLabel(used),
    addedAt: stored.createdAt,
    isNew: isNewLut(stored.createdAt, now),
    previewKey: lutPreviewVersion(stored.sha256, stored.kind),
  };
}

/**
 * Everything the pane of a LUT of Yours shows: the summary, its file and size facts, and `usedIn`
 * (`null` while the lutsInEdits switch is off: the pane hides the row). It has no description of
 * its own yet, so the line under its name is empty.
 */
export function toLutDetail(
  stored: StoredLut,
  used: number,
  usedIn: number | null,
  now: Date | string | number = new Date(),
): LutDetail {
  return {
    ...toLutSummary(stored, used, now),
    description: '',
    note: null,
    file: stored.file,
    sizeLabel: lutSizeLabel(stored.size),
    bytes: stored.bytes,
    usedIn,
  };
}

/** A fresh LUT id: 12 random hex characters. */
export function newLutId(): string {
  return randomBytes(6).toString('hex');
}

/** Rows written in the same millisecond keep their insertion order. */
const BY_ROWID = sql`rowid`;

/**
 * Durable storage for the LUTs library. Names and slugs are unique without regard to case among
 * the live LUTs and the built-in catalog, checked here inside the write's transaction. A deleted
 * LUT (`softDelete`) is gone for every read but the use counts; its row stays.
 */
export class LutRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(
    db: StudioDb,
    { clock = () => new Date(), newId = newLutId }: LutRepositoryOptions = {},
  ) {
    this.db = db;
    this.clock = clock;
    this.newId = newId;
  }

  // --- luts --------------------------------------------------------------------------------------

  /** The live LUT with this id, or `null` (unknown or deleted). */
  getById(id: string): StoredLut | null {
    const row = this.selectLive(eq(luts.id, id));
    return row === undefined ? null : rowToStored(row);
  }

  /** The live LUT with this slug, or `null`. */
  getBySlug(slug: string): StoredLut | null {
    const row = this.selectLive(eq(luts.slug, slug));
    return row === undefined ? null : rowToStored(row);
  }

  /** Every live LUT, newest first. */
  list(): StoredLut[] {
    return this.db.orm
      .select()
      .from(luts)
      .where(isNull(luts.deletedAt))
      .orderBy(desc(luts.createdAt), desc(BY_ROWID))
      .all()
      .map(rowToStored);
  }

  /** The slugs Yours cannot take: the live LUTs' and the built-in ones, but `exceptId`'s own. */
  takenSlugs(exceptId?: string): string[] {
    return [
      ...this.list()
        .filter((lut) => lut.id !== exceptId)
        .map((lut) => lut.slug),
      ...BUILTIN_LUTS.map((lut) => lut.slug),
    ];
  }

  /** The names Yours cannot take (for `freeLutName`): the live LUTs' and the built-in ones. */
  takenNames(exceptId?: string): string[] {
    return [
      ...this.list()
        .filter((lut) => lut.id !== exceptId)
        .map((lut) => lut.name),
      ...BUILTIN_LUTS.map((lut) => lut.name),
    ];
  }

  /**
   * Whether `name` (cleaned, compared without regard to case) and the slug it makes are both free,
   * `exceptId`'s own LUT aside.
   */
  isNameFree(name: string, exceptId?: string): boolean {
    return this.isFree(cleanLutName(name), exceptId ?? '000000000000', exceptId);
  }

  /**
   * Stores a new LUT and returns it, created and updated now. Throws `LutNameEmptyError` or
   * `LutNameTakenError` (writing nothing) for a name that cannot be used.
   */
  create(input: NewLut): StoredLut {
    const given = newLutSchema.parse(input);
    const name = this.usableName(given.name);
    return this.inTransaction(() => {
      const id = given.id ?? this.freshId();
      if (given.id !== undefined && this.anyRow(id)) throw new Error(`LUT id ${id} is taken`);
      if (!this.isFree(name, id)) throw new LutNameTakenError(name);
      const now = this.now();
      this.db.orm
        .insert(luts)
        .values({
          id,
          slug: lutSlug(name, id),
          name,
          kind: given.kind,
          size: given.size,
          file: given.file,
          bytes: given.bytes,
          sha256: given.sha256,
          sourceName: given.sourceName,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .run();
      return this.mustGet(id);
    });
  }

  /**
   * Renames the LUT: its name, its file's name and its slug follow. `null` for an unknown LUT.
   * Throws like {@link create} for a name that cannot be used. Renaming to its own name in
   * another case is allowed.
   */
  rename(id: string, name: string, file: string): StoredLut | null {
    const clean = this.usableName(name);
    const fileName = z.string().min(1).parse(file);
    return this.inTransaction(() => {
      if (this.selectLive(eq(luts.id, id)) === undefined) return null;
      if (!this.isFree(clean, id, id)) throw new LutNameTakenError(clean);
      return this.write(id, { name: clean, file: fileName, slug: lutSlug(clean, id) });
    });
  }

  /** Marks the LUT a Look, Camera or Fix; `null` for an unknown LUT. */
  setKind(id: string, kind: LutKind): StoredLut | null {
    const given = lutKindSchema.parse(kind);
    return this.inTransaction(() => this.write(id, { kind: given }));
  }

  /** Deletes the LUT from Yours (its row stays, marked deleted). Whether it was live. */
  softDelete(id: string): boolean {
    const now = this.now();
    return (
      this.db.orm
        .update(luts)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(luts.id, id), isNull(luts.deletedAt)))
        .run().changes > 0
    );
  }

  // --- uses (build 2) ----------------------------------------------------------------------------

  /**
   * Records that the job used the LUT in `round` (0 is the edit, n is review round n). `key` is a
   * LUT's id, or a built-in slug. Recording it again only moves its time.
   */
  addUse(key: string, jobId: string, round: number, at: string = this.clock().toISOString()): void {
    const row = {
      lutKey: keySchema.parse(key),
      jobId: keySchema.parse(jobId),
      round: z.number().int().nonnegative().parse(round),
      at: toMs(z.iso.datetime().parse(at)),
    };
    this.db.orm
      .insert(lutUses)
      .values(row)
      .onConflictDoUpdate({
        target: [lutUses.lutKey, lutUses.jobId, lutUses.round],
        set: { at: row.at },
      })
      .run();
  }

  /** How many distinct jobs used the LUT (deleted or not, in any round). */
  usedCount(key: string): number {
    const row = this.db.orm
      .select({ n: countDistinct(lutUses.jobId) })
      .from(lutUses)
      .where(eq(lutUses.lutKey, key))
      .get();
    return row?.n ?? 0;
  }

  /** How many distinct jobs used each LUT that any job used: key (id or built-in slug) → count. */
  usedCounts(): Map<string, number> {
    const rows = this.db.orm
      .select({ key: lutUses.lutKey, n: countDistinct(lutUses.jobId) })
      .from(lutUses)
      .groupBy(lutUses.lutKey)
      .orderBy(asc(lutUses.lutKey))
      .all();
    return new Map(rows.map((row) => [row.key, row.n]));
  }

  // --- internals ---------------------------------------------------------------------------------

  private now(): number {
    return this.clock().getTime();
  }

  /** Whether the clean `name`, and the slug it makes for LUT `id`, are free but for `exceptId`'s. */
  private isFree(name: string, id: string, exceptId?: string): boolean {
    const key = lutNameKey(name);
    if (this.takenNames(exceptId).some((taken) => lutNameKey(taken) === key)) return false;
    return !this.takenSlugs(exceptId).includes(lutSlug(name, id));
  }

  private usableName(name: string): string {
    const clean = cleanLutName(name);
    if (clean === '') throw new LutNameEmptyError();
    return clean;
  }

  /** A new id no LUT has, deleted ones included. */
  private freshId(): string {
    for (;;) {
      const id = idSchema.parse(this.newId());
      if (!this.anyRow(id)) return id;
    }
  }

  private anyRow(id: string): boolean {
    return (
      this.db.orm.select({ id: luts.id }).from(luts).where(eq(luts.id, id)).get() !== undefined
    );
  }

  /**
   * Writes `set` over the live LUT `id` and returns it, or `null` when there is none. Nothing is
   * written, and `updatedAt` stays, when the row already says exactly this.
   */
  private write(id: string, set: Partial<LutRow>): StoredLut | null {
    const row = this.selectLive(eq(luts.id, id));
    if (row === undefined) return null;
    const changed = Object.entries(set).some(([key, value]) => row[key as keyof LutRow] !== value);
    if (!changed) return rowToStored(row);
    this.db.orm
      .update(luts)
      .set({ ...set, updatedAt: this.now() })
      .where(eq(luts.id, id))
      .run();
    return this.mustGet(id);
  }

  private selectLive(where: ReturnType<typeof eq>): LutRow | undefined {
    return this.db.orm
      .select()
      .from(luts)
      .where(and(where, isNull(luts.deletedAt)))
      .get();
  }

  private mustGet(id: string): StoredLut {
    const row = this.db.orm.select().from(luts).where(eq(luts.id, id)).get();
    if (row === undefined) throw new Error(`LUT ${id} vanished inside its transaction`);
    return rowToStored(row);
  }

  // As in the other repositories: `immediate` takes the write lock up front, and a throw rolls
  // everything back and propagates.
  private inTransaction<T>(work: () => T): T {
    return this.db.sqlite.transaction(work).immediate();
  }
}
