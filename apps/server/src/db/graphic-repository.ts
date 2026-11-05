// Durable storage for the Graphics library (Graphics plan, "Data"): the only code that reads or
// writes the `graphics`, `graphic_messages` and `graphic_uses` tables. The files of each graphic
// (versions/, work/, refs/) are in `<inbox>/_Graphics/<folder>/` and belong to graphic-folders.ts;
// the rules of the API (who may rename, when a run may start) belong to the graphic service.

import { randomBytes, randomUUID } from 'node:crypto';
import {
  cleanGraphicName,
  type Effort,
  effortSchema,
  GRAPHIC_LIMITS,
  GRAPHIC_MESSAGES,
  type GraphicDetail,
  type GraphicKind,
  type GraphicMessage,
  type GraphicMessageStatus,
  type GraphicRole,
  type GraphicStep,
  type GraphicSummary,
  type GraphicVariable,
  graphicKindSchema,
  graphicMessageStatusSchema,
  graphicNameKey,
  graphicRoleSchema,
  graphicStatusOf,
  graphicStepSchema,
  graphicVariablesSchema,
} from '@studio/shared';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { StudioDb } from './database.js';
import { toIso, toMs } from './mapping.js';
import {
  type GraphicMessageRow,
  type GraphicRow,
  graphicMessages,
  graphics,
  graphicUses,
} from './schema.js';

/** A graphic as stored: everything its row says, times as ISO text. */
export interface StoredGraphic {
  id: string;
  name: string;
  /** Its folder's name inside `<inbox>/_Graphics`. */
  folder: string;
  kind: GraphicKind | null;
  lengthSec: number | null;
  variables: GraphicVariable[];
  /** "When edits use it". */
  when: string;
  /** True once the owner edited `when`: runs no longer overwrite it. */
  whenEdited: boolean;
  /** The version edits use; `null` until v1. */
  version: number | null;
  /** "Edits can use it". */
  uses: boolean;
  createdAt: string;
  updatedAt: string;
  /** `null` for a live graphic. */
  deletedAt: string | null;
}

/** A chat message as stored: the wire message and the graphic it belongs to. */
export interface StoredGraphicMessage extends GraphicMessage {
  graphicId: string;
}

/**
 * A new graphic. Its name is cleaned (`cleanGraphicName`) and must be free among the live
 * graphics; its folder is the cleaned name unless told otherwise. `id` is made when left out.
 */
export interface NewGraphic {
  id?: string;
  name: string;
  folder?: string;
  uses?: boolean;
}

/** A new chat message. Left out: no text, no files, no effort, and nothing of a run. */
export interface NewGraphicMessage {
  id?: string;
  graphicId: string;
  role: GraphicRole;
  text?: string;
  refs?: readonly string[];
  effort?: Effort | null;
  version?: number | null;
  status?: GraphicMessageStatus | null;
  step?: GraphicStep | null;
  error?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** What to change in a chat message. A field that is left out keeps its value; `null` clears it. */
export interface GraphicMessagePatch {
  text?: string;
  version?: number | null;
  status?: GraphicMessageStatus | null;
  step?: GraphicStep | null;
  error?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

/**
 * A version made (or used again): the version edits use from now on, and what its about.json said.
 * `when` is taken only while the owner has not edited the graphic's When line.
 */
export interface GraphicVersionPatch {
  version: number;
  kind?: GraphicKind;
  lengthSec?: number;
  variables?: readonly GraphicVariable[];
  when?: string;
}

/** Thrown when a name is taken by another live graphic (compared without regard to case). The API answers 422. */
export class GraphicNameTakenError extends Error {
  readonly graphicName: string;

  constructor(graphicName: string) {
    super(GRAPHIC_MESSAGES.nameTaken);
    this.name = 'GraphicNameTakenError';
    this.graphicName = graphicName;
  }
}

/** Thrown when a name is empty once cleaned. The API answers 422. */
export class GraphicNameEmptyError extends Error {
  constructor() {
    super(GRAPHIC_MESSAGES.nameEmpty);
    this.name = 'GraphicNameEmptyError';
  }
}

export interface GraphicRepositoryOptions {
  /** The clock for every time it writes. Tests pass a fake. */
  clock?: () => Date;
  /** Makes a new graphic's id (12 hex characters). Tests pass their own. */
  newId?: () => string;
}

const idSchema = z.string().regex(/^[0-9a-f]{12}$/);
const versionSchema = z.number().int().min(1);
const isoSchema = z.iso.datetime();

const newMessageSchema = z.object({
  id: z.string().min(1).optional(),
  graphicId: z.string().min(1),
  role: graphicRoleSchema,
  text: z.string().optional(),
  refs: z.array(z.string().min(1)).optional(),
  effort: effortSchema.nullable().optional(),
  version: versionSchema.nullable().optional(),
  status: graphicMessageStatusSchema.nullable().optional(),
  step: graphicStepSchema.nullable().optional(),
  error: z.string().min(1).nullable().optional(),
  startedAt: isoSchema.nullable().optional(),
  endedAt: isoSchema.nullable().optional(),
});

const messagePatchSchema = newMessageSchema
  .pick({ text: true, version: true, status: true, step: true, error: true })
  .extend({ startedAt: isoSchema.nullable().optional(), endedAt: isoSchema.nullable().optional() });

const versionPatchSchema = z.object({
  version: versionSchema,
  kind: graphicKindSchema.optional(),
  lengthSec: z.number().positive().optional(),
  variables: graphicVariablesSchema.optional(),
  when: z.string().max(GRAPHIC_LIMITS.whenMax).optional(),
});

function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

function toMsOrNull(iso: string | null): number | null {
  return iso === null ? null : toMs(iso);
}

function rowToStored(row: GraphicRow): StoredGraphic {
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    kind: row.kind,
    lengthSec: row.lengthSec,
    variables: row.variables,
    when: row.whenText,
    whenEdited: row.whenEdited,
    version: row.version,
    uses: row.uses,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    deletedAt: toIsoOrNull(row.deletedAt),
  };
}

function rowToMessage(row: GraphicMessageRow): StoredGraphicMessage {
  return {
    id: row.id,
    graphicId: row.graphicId,
    role: row.role,
    text: row.text,
    refs: row.refs,
    effort: row.effort,
    version: row.version,
    status: row.status,
    step: row.step === null ? null : (row.step as GraphicStep),
    error: row.error,
    startedAt: toIsoOrNull(row.startedAt),
    endedAt: toIsoOrNull(row.endedAt),
    createdAt: toIso(row.createdAt),
  };
}

/** The wire message of a stored one (without the graphic's id). */
export function toGraphicMessage(stored: StoredGraphicMessage): GraphicMessage {
  const { graphicId: _graphicId, ...message } = stored;
  return message;
}

/** The list's line for a graphic, its status worked out from its chat (oldest message first). */
export function toGraphicSummary(
  stored: StoredGraphic,
  messages: readonly Pick<GraphicMessage, 'role' | 'status' | 'version'>[],
): GraphicSummary {
  return {
    id: stored.id,
    name: stored.name,
    kind: stored.kind,
    lengthSec: stored.lengthSec,
    version: stored.version,
    uses: stored.uses,
    ...graphicStatusOf(stored.version, messages),
    updatedAt: stored.updatedAt,
  };
}

/**
 * Everything the graphic's page shows: the summary, its page fields and its chat (oldest first).
 * `usedIn` is how many videos used it, or `null` while edits do not use the library.
 */
export function toGraphicDetail(
  stored: StoredGraphic,
  messages: readonly StoredGraphicMessage[],
  usedIn: number | null,
): GraphicDetail {
  return {
    ...toGraphicSummary(stored, messages),
    when: stored.when,
    whenEdited: stored.whenEdited,
    variables: stored.variables,
    usedIn,
    folder: stored.folder,
    createdAt: stored.createdAt,
    messages: messages.map(toGraphicMessage),
  };
}

/** A fresh graphic id: 12 random hex characters. */
export function newGraphicId(): string {
  return randomBytes(6).toString('hex');
}

/** The rows' insertion order breaks ties between messages written in the same millisecond. */
const BY_ROWID = sql`rowid`;

/**
 * Durable storage for the Graphics library. Names are unique without regard to case among the
 * live graphics, checked here inside the write's transaction. A deleted graphic (`softDelete`) is
 * gone for every read but `usesCount`; its row and messages stay.
 */
export class GraphicRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(
    db: StudioDb,
    { clock = () => new Date(), newId = newGraphicId }: GraphicRepositoryOptions = {},
  ) {
    this.db = db;
    this.clock = clock;
    this.newId = newId;
  }

  // --- graphics ----------------------------------------------------------------------------------

  /** The live graphic `id`, or `null` (unknown or deleted). */
  get(id: string): StoredGraphic | null {
    const row = this.selectLive(id);
    return row === undefined ? null : rowToStored(row);
  }

  /** Every live graphic, newest change first. */
  list(): StoredGraphic[] {
    return this.db.orm
      .select()
      .from(graphics)
      .where(isNull(graphics.deletedAt))
      .orderBy(desc(graphics.updatedAt), asc(graphics.id))
      .all()
      .map(rowToStored);
  }

  /** The names of the live graphics, but `exceptId`'s (for `freeGraphicName`). */
  liveNames(exceptId?: string): string[] {
    return this.list()
      .filter((graphic) => graphic.id !== exceptId)
      .map((graphic) => graphic.name);
  }

  /** Whether no live graphic but `exceptId` has `name` (cleaned, compared without regard to case). */
  isNameFree(name: string, exceptId?: string): boolean {
    const key = graphicNameKey(cleanGraphicName(name));
    return this.liveNames(exceptId).every((taken) => graphicNameKey(taken) !== key);
  }

  /**
   * Stores a new graphic and returns it: no version, "Edits can use it" on unless told otherwise,
   * created and updated now. Throws `GraphicNameEmptyError` or `GraphicNameTakenError` (writing
   * nothing) for a name that cannot be used.
   */
  create(input: NewGraphic): StoredGraphic {
    const name = this.usableName(input.name);
    const folder = input.folder === undefined ? name : z.string().min(1).parse(input.folder);
    return this.inTransaction(() => {
      if (!this.isNameFree(name)) throw new GraphicNameTakenError(name);
      const id = input.id === undefined ? this.freshId() : idSchema.parse(input.id);
      const now = this.now();
      this.db.orm
        .insert(graphics)
        .values({
          id,
          name,
          folder,
          kind: null,
          lengthSec: null,
          variables: [],
          whenText: '',
          whenEdited: false,
          version: null,
          uses: input.uses ?? true,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .run();
      return this.mustGet(id);
    });
  }

  /**
   * Renames the graphic and records its folder's new name (the cleaned name unless told
   * otherwise); `null` for an unknown graphic. Throws like {@link create} for a name that cannot be
   * used. Renaming to its own name in another case is allowed.
   */
  rename(id: string, name: string, folder?: string): StoredGraphic | null {
    const clean = this.usableName(name);
    return this.inTransaction(() => {
      if (this.selectLive(id) === undefined) return null;
      if (!this.isNameFree(clean, id)) throw new GraphicNameTakenError(clean);
      return this.write(id, { name: clean, folder: folder ?? clean });
    });
  }

  /** Turns "Edits can use it" on or off; `null` for an unknown graphic. */
  setUses(id: string, uses: boolean): StoredGraphic | null {
    return this.inTransaction(() => this.write(id, { uses }));
  }

  /**
   * The owner's When line (trimmed, at most `GRAPHIC_LIMITS.whenMax` characters). From now on runs do
   * not overwrite it. `null` for an unknown graphic.
   */
  setWhen(id: string, when: string): StoredGraphic | null {
    const text = z.string().trim().max(GRAPHIC_LIMITS.whenMax).parse(when);
    return this.inTransaction(() => this.write(id, { whenText: text, whenEdited: true }));
  }

  /**
   * A version was made or used again: it becomes the one edits use, with what its about.json said
   * (`when` only while the owner has not edited the When line). `null` for an unknown graphic.
   */
  setVersion(id: string, patch: GraphicVersionPatch): StoredGraphic | null {
    const given = versionPatchSchema.parse(patch);
    return this.inTransaction(() => {
      const row = this.selectLive(id);
      if (row === undefined) return null;
      return this.write(id, {
        version: given.version,
        ...(given.kind === undefined ? {} : { kind: given.kind }),
        ...(given.lengthSec === undefined ? {} : { lengthSec: given.lengthSec }),
        ...(given.variables === undefined ? {} : { variables: [...given.variables] }),
        ...(given.when === undefined || row.whenEdited ? {} : { whenText: given.when.trim() }),
      });
    });
  }

  /** Deletes the graphic from the library (its row stays, marked deleted). Whether it was live. */
  softDelete(id: string): boolean {
    const now = this.now();
    return (
      this.db.orm
        .update(graphics)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(graphics.id, id), isNull(graphics.deletedAt)))
        .run().changes > 0
    );
  }

  // --- the chat ----------------------------------------------------------------------------------

  /** Adds a message to the graphic's chat, created now, and returns it. The graphic is updated now. */
  addMessage(input: NewGraphicMessage): StoredGraphicMessage {
    const given = newMessageSchema.parse(input);
    return this.inTransaction(() => {
      const now = this.now();
      const id = given.id ?? randomUUID();
      this.db.orm
        .insert(graphicMessages)
        .values({
          id,
          graphicId: given.graphicId,
          role: given.role,
          text: given.text ?? '',
          refs: [...(given.refs ?? [])],
          effort: given.effort ?? null,
          version: given.version ?? null,
          status: given.status ?? null,
          step: given.step ?? null,
          error: given.error ?? null,
          startedAt: toMsOrNull(given.startedAt ?? null),
          endedAt: toMsOrNull(given.endedAt ?? null),
          createdAt: now,
        })
        .run();
      this.touch(given.graphicId, now);
      return this.mustGetMessage(id);
    });
  }

  /**
   * Changes a message and returns it, or `null` for an unknown message. A change of its text,
   * version or status also updates the graphic now (a step alone does not: the list does not move
   * for it).
   */
  updateMessage(id: string, patch: GraphicMessagePatch): StoredGraphicMessage | null {
    const given = messagePatchSchema.parse(patch);
    return this.inTransaction(() => {
      const before = this.message(id);
      if (before === null) return null;
      const set: Partial<GraphicMessageRow> = {};
      if (given.text !== undefined) set.text = given.text;
      if (given.version !== undefined) set.version = given.version;
      if (given.status !== undefined) set.status = given.status;
      if (given.step !== undefined) set.step = given.step;
      if (given.error !== undefined) set.error = given.error;
      if (given.startedAt !== undefined) set.startedAt = toMsOrNull(given.startedAt);
      if (given.endedAt !== undefined) set.endedAt = toMsOrNull(given.endedAt);
      if (Object.keys(set).length === 0) return before;
      this.db.orm.update(graphicMessages).set(set).where(eq(graphicMessages.id, id)).run();
      const moved =
        (given.text !== undefined && given.text !== before.text) ||
        (given.version !== undefined && given.version !== before.version) ||
        (given.status !== undefined && given.status !== before.status);
      if (moved) this.touch(before.graphicId, this.now());
      return this.mustGetMessage(id);
    });
  }

  /** One message, or `null`. */
  message(id: string): StoredGraphicMessage | null {
    const row = this.db.orm.select().from(graphicMessages).where(eq(graphicMessages.id, id)).get();
    return row === undefined ? null : rowToMessage(row);
  }

  /** The graphic's chat, oldest first. */
  messages(graphicId: string): StoredGraphicMessage[] {
    return this.db.orm
      .select()
      .from(graphicMessages)
      .where(eq(graphicMessages.graphicId, graphicId))
      .orderBy(asc(graphicMessages.createdAt), BY_ROWID)
      .all()
      .map(rowToMessage);
  }

  /**
   * Every message still `making`, of every graphic, oldest first. At boot nothing is making, so
   * these are the runs the engine left behind (they become failed).
   */
  makingMessages(): StoredGraphicMessage[] {
    return this.db.orm
      .select()
      .from(graphicMessages)
      .where(eq(graphicMessages.status, 'making'))
      .orderBy(asc(graphicMessages.createdAt), BY_ROWID)
      .all()
      .map(rowToMessage);
  }

  // --- reads for the API -------------------------------------------------------------------------

  /** The list's line for the live graphic `id`, or `null`. */
  summary(id: string): GraphicSummary | null {
    const stored = this.get(id);
    return stored === null ? null : toGraphicSummary(stored, this.messages(id));
  }

  /** The list's lines of every live graphic (empty ones too), newest change first. */
  summaries(): GraphicSummary[] {
    const stored = this.list();
    if (stored.length === 0) return [];
    const byGraphic = new Map<string, StoredGraphicMessage[]>();
    const rows = this.db.orm
      .select()
      .from(graphicMessages)
      .where(
        and(
          inArray(
            graphicMessages.graphicId,
            stored.map((graphic) => graphic.id),
          ),
          eq(graphicMessages.role, 'claude'),
        ),
      )
      .orderBy(asc(graphicMessages.createdAt), BY_ROWID)
      .all();
    for (const row of rows) {
      const list = byGraphic.get(row.graphicId) ?? [];
      list.push(rowToMessage(row));
      byGraphic.set(row.graphicId, list);
    }
    return stored.map((graphic) => toGraphicSummary(graphic, byGraphic.get(graphic.id) ?? []));
  }

  /**
   * Everything the page of the live graphic `id` shows, or `null`. `usedIn: false` (edits do not
   * use the library) leaves "Used in" out as `null`.
   */
  detail(id: string, { usedIn }: { usedIn: boolean }): GraphicDetail | null {
    const stored = this.get(id);
    if (stored === null) return null;
    return toGraphicDetail(stored, this.messages(id), usedIn ? this.usesCount(id) : null);
  }

  // --- uses (build 2) ----------------------------------------------------------------------------

  /** How many jobs used the graphic (deleted or not, archived jobs too). */
  usesCount(graphicId: string): number {
    const row = this.db.orm
      .select({ n: count() })
      .from(graphicUses)
      .where(eq(graphicUses.graphicId, graphicId))
      .get();
    return row?.n ?? 0;
  }

  /** Records that the job used the graphic at `version` (a later run of the job replaces it). */
  addUse(graphicId: string, jobId: string, version: number, at: string = this.isoNow()): void {
    const row = {
      graphicId: z.string().min(1).parse(graphicId),
      jobId: z.string().min(1).parse(jobId),
      version: versionSchema.parse(version),
      at: toMs(isoSchema.parse(at)),
    };
    this.db.orm
      .insert(graphicUses)
      .values(row)
      .onConflictDoUpdate({
        target: [graphicUses.graphicId, graphicUses.jobId],
        set: { version: row.version, at: row.at },
      })
      .run();
  }

  // --- internals ---------------------------------------------------------------------------------

  private now(): number {
    return this.clock().getTime();
  }

  private isoNow(): string {
    return this.clock().toISOString();
  }

  private usableName(name: string): string {
    const clean = cleanGraphicName(name);
    if (clean === '') throw new GraphicNameEmptyError();
    return clean;
  }

  /** A new id no graphic has, deleted ones included. */
  private freshId(): string {
    for (;;) {
      const id = idSchema.parse(this.newId());
      const taken = this.db.orm
        .select({ id: graphics.id })
        .from(graphics)
        .where(eq(graphics.id, id));
      if (taken.get() === undefined) return id;
    }
  }

  /**
   * Writes `set` over the live graphic `id` and returns it, or `null` when there is none. Nothing
   * is written, and `updatedAt` stays, when the row already says exactly this.
   */
  private write(id: string, set: Partial<GraphicRow>): StoredGraphic | null {
    const row = this.selectLive(id);
    if (row === undefined) return null;
    const changed = Object.entries(set).some(
      ([key, value]) => JSON.stringify(row[key as keyof GraphicRow]) !== JSON.stringify(value),
    );
    if (!changed) return rowToStored(row);
    this.db.orm
      .update(graphics)
      .set({ ...set, updatedAt: this.now() })
      .where(eq(graphics.id, id))
      .run();
    return this.mustGet(id);
  }

  /** The graphic changed now (a message). Deleted graphics are left alone. */
  private touch(graphicId: string, at: number): void {
    this.db.orm
      .update(graphics)
      .set({ updatedAt: at })
      .where(and(eq(graphics.id, graphicId), isNull(graphics.deletedAt)))
      .run();
  }

  private selectLive(id: string): GraphicRow | undefined {
    return this.db.orm
      .select()
      .from(graphics)
      .where(and(eq(graphics.id, id), isNull(graphics.deletedAt)))
      .get();
  }

  private mustGet(id: string): StoredGraphic {
    const row = this.db.orm.select().from(graphics).where(eq(graphics.id, id)).get();
    if (row === undefined) throw new Error(`graphic ${id} vanished inside its transaction`);
    return rowToStored(row);
  }

  private mustGetMessage(id: string): StoredGraphicMessage {
    const message = this.message(id);
    if (message === null) throw new Error(`graphic message ${id} vanished inside its transaction`);
    return message;
  }

  // As in the other repositories: `immediate` takes the write lock up front, and a throw rolls
  // everything back and propagates.
  private inTransaction<T>(work: () => T): T {
    return this.db.sqlite.transaction(work).immediate();
  }
}
