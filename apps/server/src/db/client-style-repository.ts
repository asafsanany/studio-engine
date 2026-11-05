import {
  type ClientStyle,
  type ClientStyleState,
  clientStyleStateSchema,
  isoTimestampSchema,
} from '@studio/shared';
import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { parseStylePass, summarizePass } from '../clients/style-pass.js';
import type { StudioDb } from './database.js';
import { toIso, toMs } from './mapping.js';
import { type ClientStylePass, type ClientStyleRow, clientStyles } from './schema.js';

/** A client's style as stored: the wire `ClientStyle` plus what Retry runs again. */
export interface StoredClientStyle extends Omit<ClientStyle, 'pass'> {
  /** A stored row always has a time, unlike a client that has no row yet. */
  updatedAt: string;
  /** The style run Retry repeats after a failure; `null` when none was recorded. */
  lastPass: ClientStylePass | null;
}

/**
 * What to store for one client. Only `clientId` and `client` are required: a field that is left
 * out keeps its value (a new row starts at state `none`, version 0, nothing else set), and `null`
 * clears `error`, `sourceJobId` and `lastPass`.
 */
export interface ClientStyleInput {
  clientId: string;
  /** The client folder's name, spelled as the file system lists it now. */
  client: string;
  state?: ClientStyleState;
  version?: number;
  /**
   * When the style changed, as an ISO timestamp. Left out, it is now for a write that changes
   * something. Reconcile passes the mtime of a hand-made `style.md`.
   */
  updatedAt?: string;
  error?: string | null;
  sourceJobId?: string | null;
  lastPass?: ClientStylePass | null;
}

const inputSchema = z.object({
  clientId: z.string().min(1),
  client: z.string().min(1),
  state: clientStyleStateSchema.optional(),
  version: z.number().int().nonnegative().optional(),
  updatedAt: isoTimestampSchema.optional(),
  error: z.string().min(1).nullable().optional(),
  sourceJobId: z.string().min(1).nullable().optional(),
  lastPass: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type ClientStyleUpsertOutcome =
  /** A new row. */
  | 'created'
  /** Something changed. */
  | 'updated'
  /** The row already said this: nothing was written. */
  | 'unchanged';

export interface ClientStyleUpsertResult {
  style: StoredClientStyle;
  outcome: ClientStyleUpsertOutcome;
}

export interface ClientStyleRepositoryOptions {
  /** The clock for `updatedAt` when the caller gives none. Tests pass a fake. */
  clock?: () => Date;
}

function rowToStored(row: ClientStyleRow): StoredClientStyle {
  return {
    clientId: row.clientId,
    client: row.client,
    state: row.state,
    version: row.version,
    updatedAt: toIso(row.updatedAt),
    error: row.error,
    sourceJobId: row.sourceJobId,
    lastPass: row.lastPass,
  };
}

/**
 * The wire `ClientStyle` of a stored one: everything but `lastPass`, plus what that pass does
 * while the client is analysing (`last_pass` is then the pass queued or running), else `null`.
 */
export function toClientStyle(style: StoredClientStyle): ClientStyle {
  const { lastPass, ...wire } = style;
  const pass = style.state === 'analysing' ? parseStylePass(lastPass) : null;
  return { ...wire, pass: pass === null ? null : summarizePass(pass) };
}

function samePass(a: ClientStylePass | null, b: ClientStylePass | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Durable storage for client styles (Phase 2 plan §4): the only code that reads or writes the
 * `client_styles` table. A client with no row has no stored style; the routes answer state `none`
 * for it (`noClientStyle`).
 */
export class ClientStyleRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;

  constructor(db: StudioDb, { clock = () => new Date() }: ClientStyleRepositoryOptions = {}) {
    this.db = db;
    this.clock = clock;
  }

  get(clientId: string): StoredClientStyle | null {
    const row = this.selectById(clientId);
    return row === undefined ? null : rowToStored(row);
  }

  /** Every stored style, most recently updated first. */
  list(): StoredClientStyle[] {
    return this.db.orm
      .select()
      .from(clientStyles)
      .orderBy(desc(clientStyles.updatedAt), asc(clientStyles.clientId))
      .all()
      .map(rowToStored);
  }

  /**
   * Creates the row for `input.clientId` or changes the one there (see {@link ClientStyleInput}
   * for what a missing field means). Nothing is written, and `updatedAt` stays, when the row
   * already says exactly this. One transaction, so a read and the write after it cannot be split.
   */
  upsert(input: ClientStyleInput): ClientStyleUpsertResult {
    const given = inputSchema.parse(input);
    return this.db.sqlite
      .transaction((): ClientStyleUpsertResult => {
        const row = this.selectById(given.clientId);
        const now = this.clock().toISOString();

        if (row === undefined) {
          const created: StoredClientStyle = {
            clientId: given.clientId,
            client: given.client,
            state: given.state ?? 'none',
            version: given.version ?? 0,
            updatedAt: given.updatedAt ?? now,
            error: given.error ?? null,
            sourceJobId: given.sourceJobId ?? null,
            lastPass: given.lastPass ?? null,
          };
          this.db.orm.insert(clientStyles).values(toColumns(created)).run();
          return { style: created, outcome: 'created' };
        }

        const before = rowToStored(row);
        const next: StoredClientStyle = {
          ...before,
          client: given.client,
          state: given.state ?? before.state,
          version: given.version ?? before.version,
          error: given.error === undefined ? before.error : given.error,
          sourceJobId: given.sourceJobId === undefined ? before.sourceJobId : given.sourceJobId,
          lastPass: given.lastPass === undefined ? before.lastPass : given.lastPass,
        };
        const changed =
          next.client !== before.client ||
          next.state !== before.state ||
          next.version !== before.version ||
          next.error !== before.error ||
          next.sourceJobId !== before.sourceJobId ||
          !samePass(next.lastPass, before.lastPass);
        const moved = given.updatedAt !== undefined && given.updatedAt !== before.updatedAt;
        if (!changed && !moved) return { style: before, outcome: 'unchanged' };

        next.updatedAt = given.updatedAt ?? now;
        this.db.orm
          .update(clientStyles)
          .set(toColumns(next))
          .where(eq(clientStyles.clientId, next.clientId))
          .run();
        return { style: next, outcome: 'updated' };
      })
      .immediate();
  }

  private selectById(clientId: string): ClientStyleRow | undefined {
    return this.db.orm.select().from(clientStyles).where(eq(clientStyles.clientId, clientId)).get();
  }
}

function toColumns(style: StoredClientStyle): ClientStyleRow {
  return {
    clientId: style.clientId,
    client: style.client,
    state: style.state,
    version: style.version,
    updatedAt: toMs(style.updatedAt),
    error: style.error,
    sourceJobId: style.sourceJobId,
    lastPass: style.lastPass,
  };
}
