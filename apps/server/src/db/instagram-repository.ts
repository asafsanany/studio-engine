// Durable storage for Clients × Instagram (plan, "Data"): the only code that reads or writes the
// `instagram_accounts`, `instagram_scans`, `instagram_reels` and `instagram_reel_reads` tables.
// The scan itself (Apify, the photo file) belongs to src/instagram; the rules of linking a reel to
// a job (whose job, delivered or not) belong to the route. What is here is storage and the few
// rules the tables need to stay true: one account per client, one job per reel and one reel per
// job.
//
// Times are integer milliseconds since the epoch, as in the tables; "Working together since" is a
// calendar day (`YYYY-MM-DD`), as `deliveries.paid_on` is.
//
// Removing an account deletes only its row (`removeAccount`): the scans, the reels and the jobs
// they link stay, so adding the same account again brings everything back and a linked job stays
// Uploaded. A client's rename and delete move and delete these rows with the client's other rows
// (`JobRepository.renameClient` and `purgeClient`).

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  min,
  notExists,
  or,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import type { StudioDb } from './database.js';
import {
  deliveries,
  type InstagramAccountRow,
  type InstagramReelReadRow,
  type InstagramReelRow,
  type InstagramScanOutcome,
  type InstagramScanRow,
  instagramAccounts,
  instagramReelReads,
  instagramReels,
  instagramScans,
} from './schema.js';

export type { InstagramScanOutcome } from './schema.js';

/** A client's Instagram account as stored. */
export interface InstagramAccount {
  /** The client's id (`clientIdFor`). */
  clientId: string;
  /** The client folder's name, the latest spelling seen. */
  client: string;
  /** Lower case, no `@`. */
  handle: string;
  /** Instagram's id of the account; `null` until a scan reads it. */
  instagramId: string | null;
  /** "Working together since", `YYYY-MM-DD`; `null` means the client's first delivery. */
  since: string | null;
  addedAt: number;
  fullName: string | null;
  biography: string | null;
  private: boolean;
  /** When the profile picture was last saved; `null` while there is none. */
  photoSavedAt: number | null;
}

/**
 * What to store for one account. `clientId`, `client` and `handle` are required: a field that is
 * left out keeps its value (a new row starts with nothing else set, added now, not private), and
 * `null` clears `instagramId`, `since`, `fullName`, `biography` and `photoSavedAt`. The handle is
 * stored as `handleOf` spells it (trimmed, no `@`, lower case).
 */
export interface InstagramAccountInput {
  clientId: string;
  client: string;
  handle: string;
  instagramId?: string | null;
  since?: string | null;
  /** For a new row only; an account that exists keeps the time it was added. Default: now. */
  addedAt?: number;
  fullName?: string | null;
  biography?: string | null;
  private?: boolean;
  photoSavedAt?: number | null;
}

export type InstagramAccountUpsertOutcome =
  /** A new row. */
  | 'created'
  /** Something changed. */
  | 'updated'
  /** The row already said this: nothing was written. */
  | 'unchanged';

export interface InstagramAccountUpsertResult {
  account: InstagramAccount;
  outcome: InstagramAccountUpsertOutcome;
}

/** One scan of one account as stored. */
export interface InstagramScan {
  id: number;
  clientId: string;
  /** The handle that was scanned. */
  handle: string;
  startedAt: number;
  /** `null` while the scan runs. */
  finishedAt: number | null;
  /** `null` while the scan runs. */
  outcome: InstagramScanOutcome | null;
  error: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
  reelsRead: number;
  costUsd: number;
  /** The ids of the Apify runs the scan started. */
  apifyRunIds: string[];
}

/** A scan that starts now (or at `startedAt`). */
export interface NewInstagramScan {
  clientId: string;
  handle: string;
  /** Default: now. */
  startedAt?: number;
}

/** How a scan ended, as `finishScan` takes it. What is left out is 0, `null` or empty. */
export interface InstagramScanEnd {
  outcome: InstagramScanOutcome;
  error?: string | null;
  followers?: number | null;
  following?: number | null;
  posts?: number | null;
  reelsRead?: number;
  costUsd?: number;
  apifyRunIds?: string[];
  /** Default: now. */
  finishedAt?: number;
}

/** A span of time for `listOkScans`: `from` is in it, `to` is not. Either may be left out. */
export interface InstagramSpan {
  from?: number;
  to?: number;
}

/**
 * A scan that cost something, as the Money page reads it. Failed and stopped scans are here too:
 * Apify bills the runs that started whatever came of the scan.
 */
export interface InstagramScanCost {
  id: number;
  clientId: string;
  /** The client's name in its account row; `null` once the account was removed (the scan stays). */
  client: string | null;
  /** The handle that was scanned. */
  handle: string;
  startedAt: number;
  /** What the scan's Apify runs cost, in dollars: more than 0. */
  costUsd: number;
}

/**
 * A scan whose cost has not been checked against Apify's runs yet, as `scansToSettle` gives it: what
 * the check needs to read the runs again and write what they really cost.
 */
export interface InstagramScanToSettle {
  id: number;
  /** When the scan ended. */
  finishedAt: number;
  /** The cost as the scan wrote it: what Apify said as the runs ended, before it tallied them. */
  costUsd: number;
  /** The Apify runs the scan started; empty for a scan that failed before it started one. */
  apifyRunIds: string[];
}

/** One reel as stored, with the numbers its latest scan read. */
export interface InstagramReel {
  shortcode: string;
  clientId: string;
  url: string;
  postedAt: number;
  caption: string | null;
  durationSec: number | null;
  plays: number;
  likes: number;
  comments: number;
  /** `null` while no scan could read them. */
  shares: number | null;
  /** The song's name, or `Original audio`. */
  sound: string | null;
  /** The handles of the other authors of a collab reel. */
  coauthors: string[];
  hashtags: string[];
  pinned: boolean;
  paidPartnership: boolean;
  /** The scan that first saw the reel, and the latest one that read it. */
  firstScanId: number;
  lastScanId: number;
  /** The job the reel is of; `null` for a reel that is the client's own. */
  jobId: string | null;
  /** When the link was made; `null` with `jobId`. */
  linkedAt: number | null;
}

/** What a scan read of one reel, as `upsertReels` takes it. */
export interface InstagramReelInput {
  shortcode: string;
  clientId: string;
  url: string;
  postedAt: number;
  caption?: string | null;
  durationSec?: number | null;
  plays: number;
  likes: number;
  comments: number;
  shares?: number | null;
  sound?: string | null;
  coauthors?: string[];
  hashtags?: string[];
  pinned?: boolean;
  paidPartnership?: boolean;
}

/** What `upsertReels` did. */
export interface InstagramReelUpsertResult {
  /** Reels this was the first scan of. */
  created: number;
  /** Reels that were stored already; their numbers are the new read's. */
  updated: number;
}

/**
 * The reel that links a job, as much of it as the job's delivery shows: where it is
 * (`Job.delivery.reelUrl`), when it was posted (`Job.delivery.uploadedAt`) and its plays
 * (`Job.delivery.reelPlays`, for the Uploaded row).
 */
export interface InstagramReelLink {
  shortcode: string;
  url: string;
  /** When the reel was posted, in ms since the epoch. */
  postedAt: number;
  /** The plays its latest scan read; `null` when they are not known (the delivery then says none). */
  plays: number | null;
}

/** What one scan read of one reel. */
export interface InstagramReelRead {
  shortcode: string;
  scanId: number;
  plays: number;
  likes: number;
  comments: number;
  shares: number | null;
}

/** What `addReelReads` takes: the scan's id is the call's. */
export type InstagramReelReadInput = Omit<InstagramReelRead, 'scanId' | 'shares'> & {
  /** Left out or `null` when the scan could not read them. */
  shares?: number | null;
};

/**
 * A delivery of a client that no reel links yet: a job that can be linked to a reel. `paid` is
 * whether the delivery has a paid day; the delivery record decides, not the job's folder (which
 * may be gone).
 */
export interface LinkableDelivery {
  jobId: string;
  name: string;
  /** When the job was marked delivered. */
  deliveredAt: number;
  paid: boolean;
}

/** Thrown by `finishScan` for an id that has no scan. */
export class InstagramScanNotFoundError extends Error {
  readonly scanId: number;

  constructor(scanId: number) {
    super(`Instagram scan ${scanId} not found`);
    this.name = 'InstagramScanNotFoundError';
    this.scanId = scanId;
  }
}

export type InstagramLinkRefusal =
  /** No reel has this shortcode. */
  | 'reel-not-found'
  /** The reel links another job already: unlink it first. */
  | 'reel-linked'
  /** Another reel links the job already: one reel, one job. */
  | 'job-linked';

/** Thrown by `linkReel` when the link would break one reel, one job. The route answers 409. */
export class InstagramLinkError extends Error {
  readonly reason: InstagramLinkRefusal;

  constructor(reason: InstagramLinkRefusal, shortcode: string, jobId: string) {
    super(
      reason === 'reel-not-found'
        ? `Reel ${shortcode} not found`
        : reason === 'reel-linked'
          ? `Reel ${shortcode} is linked to a job already`
          : `Job ${jobId} is linked to a reel already`,
    );
    this.name = 'InstagramLinkError';
    this.reason = reason;
  }
}

/** Ids per query, well under SQLite's limit on bound variables. */
const ID_CHUNK = 500;

export interface InstagramRepositoryOptions {
  /** The clock for every time it writes when the caller gives none. Tests pass a fake. */
  clock?: () => Date;
}

/** How an account's handle is stored: trimmed, no `@`, lower case. */
export function handleOf(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

const textSchema = z.string().min(1);
const countSchema = z.number().int().nonnegative();
const timeSchema = z.number().int().nonnegative();
const handleSchema = z
  .string()
  .transform(handleOf)
  .pipe(z.string().regex(/^[^\s@/]+$/));
const strings = z.array(z.string());

const accountSchema = z.object({
  clientId: textSchema,
  client: textSchema,
  handle: handleSchema,
  instagramId: textSchema.nullable().optional(),
  since: z.iso.date().nullable().optional(),
  addedAt: timeSchema.optional(),
  fullName: z.string().nullable().optional(),
  biography: z.string().nullable().optional(),
  private: z.boolean().optional(),
  photoSavedAt: timeSchema.nullable().optional(),
});

const newScanSchema = z.object({
  clientId: textSchema,
  handle: handleSchema,
  startedAt: timeSchema.optional(),
});

const scanEndSchema = z.object({
  outcome: z.enum(['ok', 'private', 'not-found', 'no-token', 'no-credit', 'failed']),
  error: z.string().nullable().optional(),
  followers: countSchema.nullable().optional(),
  following: countSchema.nullable().optional(),
  posts: countSchema.nullable().optional(),
  reelsRead: countSchema.optional(),
  costUsd: z.number().nonnegative().optional(),
  apifyRunIds: strings.optional(),
  finishedAt: timeSchema.optional(),
});

const reelSchema = z.object({
  shortcode: z.string().regex(/^[A-Za-z0-9_-]+$/),
  clientId: textSchema,
  url: textSchema,
  postedAt: timeSchema,
  caption: z.string().nullable().optional(),
  durationSec: z.number().nonnegative().nullable().optional(),
  plays: countSchema,
  likes: countSchema,
  comments: countSchema,
  shares: countSchema.nullable().optional(),
  sound: z.string().nullable().optional(),
  coauthors: strings.optional(),
  hashtags: strings.optional(),
  pinned: z.boolean().optional(),
  paidPartnership: z.boolean().optional(),
});

const readSchema = z.object({
  shortcode: z.string().regex(/^[A-Za-z0-9_-]+$/),
  plays: countSchema,
  likes: countSchema,
  comments: countSchema,
  shares: countSchema.nullable().optional(),
});

const scanIdSchema = z.number().int().positive();
const spanSchema = z.object({ from: timeSchema.optional(), to: timeSchema.optional() });

function toAccount(row: InstagramAccountRow): InstagramAccount {
  return { ...row };
}

function toScan(row: InstagramScanRow): InstagramScan {
  // `costSettledAt` is the cost check's own (see `scansToSettle`), not part of a scan as the page reads it.
  const { costSettledAt: _settled, ...scan } = row;
  return { ...scan, apifyRunIds: [...row.apifyRunIds] };
}

function toReel(row: InstagramReelRow): InstagramReel {
  return { ...row, coauthors: [...row.coauthors], hashtags: [...row.hashtags] };
}

function toRead(row: InstagramReelReadRow): InstagramReelRead {
  return { ...row };
}

function sameAccount(a: InstagramAccount, b: InstagramAccount): boolean {
  return (
    a.client === b.client &&
    a.handle === b.handle &&
    a.instagramId === b.instagramId &&
    a.since === b.since &&
    a.fullName === b.fullName &&
    a.biography === b.biography &&
    a.private === b.private &&
    a.photoSavedAt === b.photoSavedAt
  );
}

/**
 * Durable storage for the Instagram tables. Every write that reads before it writes runs in one
 * transaction, so two writers cannot both link one job or both add one account.
 */
export class InstagramRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;

  constructor(db: StudioDb, { clock = () => new Date() }: InstagramRepositoryOptions = {}) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * Runs `work` in one transaction: what it writes is all kept or none of it, and nothing else
   * writes in between. The scanner's write (the account, the reels, their reads and the end of
   * the scan) is one call of this, so a scan that breaks half way changes nothing. `work` must be
   * synchronous, and calls of this repository's own methods inside it join the transaction.
   */
  atomically<T>(work: () => T): T {
    return this.inTransaction(work);
  }

  // --- accounts ----------------------------------------------------------------------------------

  getAccount(clientId: string): InstagramAccount | null {
    const row = this.selectAccount(clientId);
    return row === undefined ? null : toAccount(row);
  }

  /** Every account, the one added first first. */
  listAccounts(): InstagramAccount[] {
    return this.db.orm
      .select()
      .from(instagramAccounts)
      .orderBy(asc(instagramAccounts.addedAt), asc(instagramAccounts.clientId))
      .all()
      .map(toAccount);
  }

  /**
   * Creates the account of `input.clientId` or changes the one there (see
   * {@link InstagramAccountInput} for what a missing field means). Nothing is written when the
   * row already says exactly this.
   */
  upsertAccount(input: InstagramAccountInput): InstagramAccountUpsertResult {
    const given = accountSchema.parse(input);
    return this.inTransaction((): InstagramAccountUpsertResult => {
      const row = this.selectAccount(given.clientId);
      if (row === undefined) {
        const created: InstagramAccount = {
          clientId: given.clientId,
          client: given.client,
          handle: given.handle,
          instagramId: given.instagramId ?? null,
          since: given.since ?? null,
          addedAt: given.addedAt ?? this.clock().getTime(),
          fullName: given.fullName ?? null,
          biography: given.biography ?? null,
          private: given.private ?? false,
          photoSavedAt: given.photoSavedAt ?? null,
        };
        this.db.orm.insert(instagramAccounts).values(created).run();
        return { account: created, outcome: 'created' };
      }

      const before = toAccount(row);
      const next: InstagramAccount = {
        ...before,
        client: given.client,
        handle: given.handle,
        instagramId: given.instagramId === undefined ? before.instagramId : given.instagramId,
        since: given.since === undefined ? before.since : given.since,
        fullName: given.fullName === undefined ? before.fullName : given.fullName,
        biography: given.biography === undefined ? before.biography : given.biography,
        private: given.private ?? before.private,
        photoSavedAt: given.photoSavedAt === undefined ? before.photoSavedAt : given.photoSavedAt,
      };
      if (sameAccount(before, next)) return { account: before, outcome: 'unchanged' };
      this.db.orm
        .update(instagramAccounts)
        .set(next)
        .where(eq(instagramAccounts.clientId, next.clientId))
        .run();
      return { account: next, outcome: 'updated' };
    });
  }

  /**
   * Removes the client's account: its row, and nothing else. The scans, the reels and their links
   * to jobs stay, so adding the same account again brings everything back and a linked job stays
   * Uploaded. Returns whether there was an account.
   */
  removeAccount(clientId: string): boolean {
    return (
      this.db.orm.delete(instagramAccounts).where(eq(instagramAccounts.clientId, clientId)).run()
        .changes > 0
    );
  }

  // --- scans -------------------------------------------------------------------------------------

  /** Writes the row of a scan that starts now: no outcome yet. */
  startScan(input: NewInstagramScan): InstagramScan {
    const given = newScanSchema.parse(input);
    const row = this.db.orm
      .insert(instagramScans)
      .values({
        clientId: given.clientId,
        handle: given.handle,
        startedAt: given.startedAt ?? this.clock().getTime(),
      })
      .returning()
      .get();
    return toScan(row);
  }

  /**
   * Ends a scan: when it ended, how, and what it read and cost. Throws
   * {@link InstagramScanNotFoundError} for an id that has no scan.
   */
  finishScan(id: number, end: InstagramScanEnd): InstagramScan {
    const given = scanEndSchema.parse(end);
    const scanId = scanIdSchema.parse(id);
    const row = this.db.orm
      .update(instagramScans)
      .set({
        finishedAt: given.finishedAt ?? this.clock().getTime(),
        outcome: given.outcome,
        error: given.error ?? null,
        followers: given.followers ?? null,
        following: given.following ?? null,
        posts: given.posts ?? null,
        reelsRead: given.reelsRead ?? 0,
        costUsd: given.costUsd ?? 0,
        apifyRunIds: given.apifyRunIds ?? [],
      })
      .where(eq(instagramScans.id, scanId))
      .returning()
      .get();
    if (row === undefined) throw new InstagramScanNotFoundError(scanId);
    return toScan(row);
  }

  getScan(id: number): InstagramScan | null {
    const row = this.db.orm.select().from(instagramScans).where(eq(instagramScans.id, id)).get();
    return row === undefined ? null : toScan(row);
  }

  /** The client's latest scan that started, finished or not. */
  latestScan(clientId: string): InstagramScan | null {
    return this.latest(eq(instagramScans.clientId, clientId));
  }

  /** The client's latest scan that has ended, with any outcome: what "last scanned" says. */
  latestEndedScan(clientId: string): InstagramScan | null {
    return this.latest(
      and(eq(instagramScans.clientId, clientId), isNotNull(instagramScans.finishedAt)),
    );
  }

  /** The client's latest scan that ended `ok`: the followers and the reels as last read. */
  latestOkScan(clientId: string): InstagramScan | null {
    return this.latest(
      and(eq(instagramScans.clientId, clientId), eq(instagramScans.outcome, 'ok')),
    );
  }

  /**
   * The client's latest `limit` scans (default 20) that started, the newest first, finished or
   * not. The weekly check looks through them for the last scan that counts as this week's.
   */
  recentScans(clientId: string, limit = 20): InstagramScan[] {
    return this.db.orm
      .select()
      .from(instagramScans)
      .where(eq(instagramScans.clientId, clientId))
      .orderBy(desc(instagramScans.startedAt), desc(instagramScans.id))
      .limit(Math.max(1, Math.floor(limit)))
      .all()
      .map(toScan);
  }

  /**
   * The client's scans that ended `ok` and started in the span (`from` in it, `to` not), the
   * oldest first: the points of the followers line.
   */
  listOkScans(clientId: string, span: InstagramSpan = {}): InstagramScan[] {
    const { from, to } = spanSchema.parse(span);
    return this.db.orm
      .select()
      .from(instagramScans)
      .where(
        and(
          eq(instagramScans.clientId, clientId),
          eq(instagramScans.outcome, 'ok'),
          from === undefined ? undefined : gte(instagramScans.startedAt, from),
          to === undefined ? undefined : lt(instagramScans.startedAt, to),
        ),
      )
      .orderBy(asc(instagramScans.startedAt), asc(instagramScans.id))
      .all()
      .map(toScan);
  }

  /**
   * The scans that ended before `finishedBefore` and whose cost was not checked against Apify's
   * runs yet, the oldest first (C90). The scan writes the cost it read as its runs ended, which is
   * early; the check reads the runs again once Apify has tallied them and calls `settleScanCost`.
   * Every scan stored before the check existed is in here until it is checked.
   */
  scansToSettle(finishedBefore: number): InstagramScanToSettle[] {
    return this.db.orm
      .select({
        id: instagramScans.id,
        finishedAt: instagramScans.finishedAt,
        costUsd: instagramScans.costUsd,
        apifyRunIds: instagramScans.apifyRunIds,
      })
      .from(instagramScans)
      .where(
        and(
          isNotNull(instagramScans.finishedAt),
          lt(instagramScans.finishedAt, finishedBefore),
          isNull(instagramScans.costSettledAt),
        ),
      )
      .orderBy(asc(instagramScans.id))
      .all()
      .flatMap((row) =>
        row.finishedAt === null
          ? []
          : [
              {
                id: row.id,
                finishedAt: row.finishedAt,
                costUsd: row.costUsd,
                apifyRunIds: [...row.apifyRunIds],
              },
            ],
      );
  }

  /**
   * Writes what a scan's runs really cost and notes it was checked (`at`, default now), so it is
   * not looked at again. Returns whether the cost changed. A scan that is not there is left alone
   * (`false`).
   */
  settleScanCost(id: number, costUsd: number, at: number = this.clock().getTime()): boolean {
    const scanId = scanIdSchema.parse(id);
    const cost = z.number().nonnegative().parse(costUsd);
    const settledAt = timeSchema.parse(at);
    return this.inTransaction(() => {
      const row = this.db.orm
        .select({ costUsd: instagramScans.costUsd })
        .from(instagramScans)
        .where(eq(instagramScans.id, scanId))
        .get();
      if (row === undefined) return false;
      this.db.orm
        .update(instagramScans)
        .set({ costUsd: cost, costSettledAt: settledAt })
        .where(eq(instagramScans.id, scanId))
        .run();
      return row.costUsd !== cost;
    });
  }

  // --- reels -------------------------------------------------------------------------------------

  /**
   * Stores what scan `scanId` read of the reels, in one transaction. A new reel starts with this
   * scan as its first and its last, a theirs reel (no job). A reel that is stored already takes the
   * new numbers and this scan as its last; its owner, its first scan and its link to a job stay.
   * A read that has no shares (`null`) keeps the shares the reel had. A shortcode listed twice
   * takes the later entry.
   */
  upsertReels(scanId: number, reels: readonly InstagramReelInput[]): InstagramReelUpsertResult {
    const id = scanIdSchema.parse(scanId);
    const given = reels.map((reel) => reelSchema.parse(reel));
    return this.inTransaction(() => {
      const result: InstagramReelUpsertResult = { created: 0, updated: 0 };
      for (const reel of given) {
        const row = this.selectReel(reel.shortcode);
        const numbers = {
          url: reel.url,
          postedAt: reel.postedAt,
          caption: reel.caption ?? null,
          durationSec: reel.durationSec ?? null,
          plays: reel.plays,
          likes: reel.likes,
          comments: reel.comments,
          sound: reel.sound ?? null,
          coauthors: reel.coauthors ?? [],
          hashtags: reel.hashtags ?? [],
          pinned: reel.pinned ?? false,
          paidPartnership: reel.paidPartnership ?? false,
          lastScanId: id,
        };
        if (row === undefined) {
          this.db.orm
            .insert(instagramReels)
            .values({
              ...numbers,
              shortcode: reel.shortcode,
              clientId: reel.clientId,
              shares: reel.shares ?? null,
              firstScanId: id,
            })
            .run();
          result.created += 1;
        } else {
          this.db.orm
            .update(instagramReels)
            .set({ ...numbers, shares: reel.shares ?? row.shares })
            .where(eq(instagramReels.shortcode, reel.shortcode))
            .run();
          result.updated += 1;
        }
      }
      return result;
    });
  }

  getReel(shortcode: string): InstagramReel | null {
    const row = this.selectReel(shortcode);
    return row === undefined ? null : toReel(row);
  }

  /**
   * The client's reels posted at or after `sinceMs` (all of them without it), the newest first.
   * The caller turns a calendar day into the time its day starts. A client's reels are those on its
   * page: the ones it owns and the ones one of its scans read, which is how a collab reel stored
   * under the other account (its owner, the client that read it first) is on both pages.
   */
  listReels(clientId: string, sinceMs?: number): InstagramReel[] {
    return this.db.orm
      .select()
      .from(instagramReels)
      .where(
        and(
          this.onPageOf(clientId),
          sinceMs === undefined ? undefined : gte(instagramReels.postedAt, sinceMs),
        ),
      )
      .orderBy(desc(instagramReels.postedAt), asc(instagramReels.shortcode))
      .all()
      .map(toReel);
  }

  /** Whether the reel is on the client's page (see `listReels`): its own, or read by its scans. */
  reelIsOnPageOf(shortcode: string, clientId: string): boolean {
    const row = this.db.orm
      .select({ shortcode: instagramReels.shortcode })
      .from(instagramReels)
      .where(and(eq(instagramReels.shortcode, shortcode), this.onPageOf(clientId)))
      .get();
    return row !== undefined;
  }

  /** The reel that links the job; `null` when none does. */
  reelOfJob(jobId: string): InstagramReel | null {
    const row = this.db.orm
      .select()
      .from(instagramReels)
      .where(eq(instagramReels.jobId, jobId))
      .get();
    return row === undefined ? null : toReel(row);
  }

  /**
   * The reel that links each of the jobs, keyed by job id; a job no reel links is not in the map.
   * One query for every ID_CHUNK ids, so a whole job list costs one read (the job read fills a
   * delivery's `uploadedAt`, `reelUrl` and `reelPlays` from it).
   */
  reelLinksOfJobs(jobIds: readonly string[]): Map<string, InstagramReelLink> {
    const found = new Map<string, InstagramReelLink>();
    for (let from = 0; from < jobIds.length; from += ID_CHUNK) {
      const rows = this.db.orm
        .select({
          shortcode: instagramReels.shortcode,
          url: instagramReels.url,
          postedAt: instagramReels.postedAt,
          plays: instagramReels.plays,
          jobId: instagramReels.jobId,
        })
        .from(instagramReels)
        .where(inArray(instagramReels.jobId, jobIds.slice(from, from + ID_CHUNK)))
        .all();
      for (const { jobId, ...link } of rows) {
        if (jobId !== null) found.set(jobId, link);
      }
    }
    return found;
  }

  /**
   * Links the reel to the job: the reel is ours from then on. Linking the pair that is linked
   * already changes nothing. Throws {@link InstagramLinkError}: the reel is unknown, or it links
   * another job (unlink it first), or another reel links this job (one reel, one job). Whether the
   * job may be linked (this client's, delivered) is the route's to decide.
   */
  linkReel(shortcode: string, jobId: string, at: number = this.clock().getTime()): InstagramReel {
    const job = textSchema.parse(jobId);
    const linkedAt = timeSchema.parse(at);
    return this.inTransaction(() => {
      const row = this.selectReel(shortcode);
      if (row === undefined) throw new InstagramLinkError('reel-not-found', shortcode, job);
      if (row.jobId === job) return toReel(row);
      if (row.jobId !== null) throw new InstagramLinkError('reel-linked', shortcode, job);
      const other = this.db.orm
        .select({ shortcode: instagramReels.shortcode })
        .from(instagramReels)
        .where(eq(instagramReels.jobId, job))
        .get();
      if (other !== undefined) throw new InstagramLinkError('job-linked', shortcode, job);
      this.db.orm
        .update(instagramReels)
        .set({ jobId: job, linkedAt })
        .where(eq(instagramReels.shortcode, shortcode))
        .run();
      return toReel({ ...row, jobId: job, linkedAt });
    });
  }

  /**
   * Takes the reel's link to its job away: the reel is theirs again. Returns the reel, or `null`
   * when no reel has this shortcode. A reel that links no job is returned as it is.
   */
  unlinkReel(shortcode: string): InstagramReel | null {
    return this.inTransaction(() => {
      const row = this.selectReel(shortcode);
      if (row === undefined) return null;
      if (row.jobId === null) return toReel(row);
      this.db.orm
        .update(instagramReels)
        .set({ jobId: null, linkedAt: null })
        .where(eq(instagramReels.shortcode, shortcode))
        .run();
      return toReel({ ...row, jobId: null, linkedAt: null });
    });
  }

  // --- deliveries (read only) --------------------------------------------------------------------
  // What the numbers and the Link to job menu need of the `deliveries` table: a job is delivered
  // when it has a row there, whether or not its folder is still in the inbox.

  /** When the client's first delivery was marked; `null` for a client with none. */
  firstDeliveryAt(clientId: string): number | null {
    const row = this.db.orm
      .select({ at: min(deliveries.deliveredAt) })
      .from(deliveries)
      .where(eq(deliveries.clientId, clientId))
      .get();
    return row?.at ?? null;
  }

  /** The names of these jobs' deliveries, by job id; a job with no delivery is not in the map. */
  deliveryNames(jobIds: readonly string[]): Map<string, string> {
    const names = new Map<string, string>();
    for (let from = 0; from < jobIds.length; from += ID_CHUNK) {
      const rows = this.db.orm
        .select({ jobId: deliveries.jobId, name: deliveries.name })
        .from(deliveries)
        .where(inArray(deliveries.jobId, jobIds.slice(from, from + ID_CHUNK)))
        .all();
      for (const row of rows) names.set(row.jobId, row.name);
    }
    return names;
  }

  /**
   * The client's deliveries that no reel links, newest delivery first (then by job id): the jobs
   * the Link to job menu offers. Delivered and paid both count; Not delivered yet takes a job out
   * of the list because it deletes the delivery.
   */
  linkableDeliveries(clientId: string): LinkableDelivery[] {
    const linked = this.db.orm
      .select({ jobId: instagramReels.jobId })
      .from(instagramReels)
      .where(eq(instagramReels.jobId, deliveries.jobId));
    return this.db.orm
      .select({
        jobId: deliveries.jobId,
        name: deliveries.name,
        deliveredAt: deliveries.deliveredAt,
        paidOn: deliveries.paidOn,
      })
      .from(deliveries)
      .where(and(eq(deliveries.clientId, clientId), notExists(linked)))
      .orderBy(desc(deliveries.deliveredAt), asc(deliveries.jobId))
      .all()
      .map((row) => ({
        jobId: row.jobId,
        name: row.name,
        deliveredAt: row.deliveredAt,
        paid: row.paidOn !== null,
      }));
  }

  // --- reel reads --------------------------------------------------------------------------------

  /**
   * Stores what scan `scanId` read of each reel: one read per reel and scan, so a second write for
   * the same pair replaces the first. One transaction.
   */
  addReelReads(scanId: number, reads: readonly InstagramReelReadInput[]): void {
    const id = scanIdSchema.parse(scanId);
    const given = reads.map((read) => readSchema.parse(read));
    this.inTransaction(() => {
      for (const read of given) {
        const values = {
          shortcode: read.shortcode,
          scanId: id,
          plays: read.plays,
          likes: read.likes,
          comments: read.comments,
          shares: read.shares ?? null,
        };
        this.db.orm
          .insert(instagramReelReads)
          .values(values)
          .onConflictDoUpdate({
            target: [instagramReelReads.shortcode, instagramReelReads.scanId],
            set: values,
          })
          .run();
      }
    });
  }

  /**
   * What the scans read of every reel they read, by reel and then by scan: "this week" is the
   * difference between a reel's two reads, and the "Shares a week" line has one such difference
   * per pair of consecutive scans.
   */
  readsOfScans(...scanIds: number[]): InstagramReelRead[] {
    const ids = scanIds.map((scanId) => scanIdSchema.parse(scanId));
    return this.db.orm
      .select()
      .from(instagramReelReads)
      .where(inArray(instagramReelReads.scanId, ids))
      .orderBy(asc(instagramReelReads.shortcode), asc(instagramReelReads.scanId))
      .all()
      .map(toRead);
  }

  // --- cost --------------------------------------------------------------------------------------

  /**
   * Every scan that cost something, whatever its outcome, the oldest first: the Money page's
   * Apify payments. The client's name comes from its account row, `null` when the account is gone.
   */
  listScanCosts(): InstagramScanCost[] {
    return this.db.orm
      .select({
        id: instagramScans.id,
        clientId: instagramScans.clientId,
        client: instagramAccounts.client,
        handle: instagramScans.handle,
        startedAt: instagramScans.startedAt,
        costUsd: instagramScans.costUsd,
      })
      .from(instagramScans)
      .leftJoin(instagramAccounts, eq(instagramAccounts.clientId, instagramScans.clientId))
      .orderBy(asc(instagramScans.startedAt), asc(instagramScans.id))
      .all()
      .filter((scan) => scan.costUsd > 0);
  }

  // ----------------------------------------------------------------------------------------------

  private latest(where: SQL | undefined): InstagramScan | null {
    const row = this.db.orm
      .select()
      .from(instagramScans)
      .where(where)
      .orderBy(desc(instagramScans.startedAt), desc(instagramScans.id))
      .limit(1)
      .get();
    return row === undefined ? null : toScan(row);
  }

  private selectAccount(clientId: string): InstagramAccountRow | undefined {
    return this.db.orm
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.clientId, clientId))
      .get();
  }

  /** The reels on the client's page: the ones it owns, and the ones a scan of it read. */
  private onPageOf(clientId: string): SQL | undefined {
    const readByClient = this.db.orm
      .select({ shortcode: instagramReelReads.shortcode })
      .from(instagramReelReads)
      .innerJoin(instagramScans, eq(instagramScans.id, instagramReelReads.scanId))
      .where(eq(instagramScans.clientId, clientId));
    return or(
      eq(instagramReels.clientId, clientId),
      inArray(instagramReels.shortcode, readByClient),
    );
  }

  private selectReel(shortcode: string): InstagramReelRow | undefined {
    return this.db.orm
      .select()
      .from(instagramReels)
      .where(eq(instagramReels.shortcode, shortcode))
      .get();
  }

  private inTransaction<T>(work: () => T): T {
    return this.db.sqlite.transaction(work).immediate();
  }
}
