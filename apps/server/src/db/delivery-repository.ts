import { isCalendarDay } from '@studio/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lt, notExists } from 'drizzle-orm';
import type { StudioDb } from './database.js';
import { type DeliveryRow, deliveries, jobs } from './schema.js';

/** A delivered job, as stored. Times are milliseconds since the epoch. */
export interface Delivery {
  jobId: string;
  clientId: string;
  client: string;
  name: string;
  /** `Client/Job`, as it was when the job was delivered. */
  relPath: string;
  /** When the owner marked the job delivered. */
  deliveredAt: number;
  /** Frozen at delivery: a later price change does not rewrite it. */
  price: number;
  /** ISO 4217 code of `price`, `ILS` by default. */
  currency: string;
  /** Seconds the owner spent reviewing the job. */
  reviewSec: number;
  /** The calendar day the money came in (`YYYY-MM-DD`); `null` while the job is not paid. */
  paidOn: string | null;
  /**
   * What the client actually paid, in `currency` (Mark paid lets the owner type it); `null` while the
   * job is not paid, and on a job paid before the amount could be typed, which was paid `price`.
   */
  paidAmount: number | null;
}

/**
 * What `record` takes: everything but the review time, which is 0 until it is known, and the paid
 * day and amount, which a new delivery never has.
 */
export type NewDelivery = Omit<Delivery, 'reviewSec' | 'paidOn' | 'paidAmount'> & {
  reviewSec?: number;
};

/** Why a job stopped `markPaid` or `unmarkPaid`: where it stands is not where the change starts. */
export interface PaymentRefusal {
  jobId: string;
  /** `not-delivered`: no delivery. `already-paid` (mark paid only). `not-paid` (unmark paid only). */
  reason: 'not-delivered' | 'already-paid' | 'not-paid';
}

/**
 * What `markPaid` and `unmarkPaid` answer: either the changed deliveries, in the order of the job
 * ids asked for, or `refused`, the jobs that were in the wrong stage, with nothing changed at all.
 */
export type PaymentResult =
  | { ok: true; deliveries: Delivery[] }
  | { ok: false; refused: PaymentRefusal[] };

/** Ids per query, well under SQLite's limit on bound variables. */
const ID_CHUNK = 500;

function rowToDelivery(row: DeliveryRow): Delivery {
  return {
    jobId: row.jobId,
    clientId: row.clientId,
    client: row.client,
    name: row.name,
    relPath: row.relPath,
    deliveredAt: row.deliveredAt,
    price: row.price,
    currency: row.currency,
    reviewSec: row.reviewSec,
    paidOn: row.paidOn,
    paidAmount: row.paidAmount,
  };
}

/** The local `YYYY-MM` of a time, the way a calendar month is read in the engine's time zone. */
function localMonth(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Durable storage for delivered jobs (Phase 4 §2): the only code that reads or writes the
 * `deliveries` table. A delivery is written when the owner marks a job delivered (`record`) and kept
 * for good, with one exception: `remove` (Not delivered yet) deletes it while the job is unpaid.
 * Removing a job (`JobRepository.remove`) never touches it, so the Money page's past months keep
 * their numbers after a job's folder is gone.
 *
 * A job is in exactly one stage here: not delivered (no row), delivered (a row, `paidOn` null) or
 * paid (a row with a `paidOn`). `markPaid`, `unmarkPaid` and `remove` move it between them and
 * refuse a move from the wrong stage.
 */
export class DeliveryRepository {
  private readonly db: StudioDb;

  constructor(db: StudioDb) {
    this.db = db;
  }

  /**
   * Stores the delivery of a job. Insert-or-ignore on the job id: a second call for the same job
   * (a retry, a re-export, a job delivered again after its export went missing) keeps the first
   * `deliveredAt` and price. Returns whether a row was written.
   */
  record(delivery: NewDelivery): boolean {
    const result = this.db.orm
      .insert(deliveries)
      .values({ ...delivery, reviewSec: delivery.reviewSec ?? 0 })
      .onConflictDoNothing({ target: deliveries.jobId })
      .run();
    return result.changes > 0;
  }

  get(jobId: string): Delivery | null {
    const row = this.db.orm.select().from(deliveries).where(eq(deliveries.jobId, jobId)).get();
    return row === undefined ? null : rowToDelivery(row);
  }

  /** The deliveries of these jobs, by job id; a job that was not delivered is not in the map. */
  getMany(jobIds: readonly string[]): Map<string, Delivery> {
    const found = new Map<string, Delivery>();
    for (let from = 0; from < jobIds.length; from += ID_CHUNK) {
      const rows = this.db.orm
        .select()
        .from(deliveries)
        .where(inArray(deliveries.jobId, jobIds.slice(from, from + ID_CHUNK)))
        .all();
      for (const row of rows) found.set(row.jobId, rowToDelivery(row));
    }
    return found;
  }

  /** Every delivery, oldest first (then by job id): what the Money page works its months out from. */
  list(): Delivery[] {
    return this.db.orm
      .select()
      .from(deliveries)
      .orderBy(asc(deliveries.deliveredAt), asc(deliveries.jobId))
      .all()
      .map(rowToDelivery);
  }

  /** The deliveries with `fromMs <= deliveredAt < toMs`, oldest first (then by job id). */
  listBetween(fromMs: number, toMs: number): Delivery[] {
    return this.db.orm
      .select()
      .from(deliveries)
      .where(and(gte(deliveries.deliveredAt, fromMs), lt(deliveries.deliveredAt, toMs)))
      .orderBy(asc(deliveries.deliveredAt), asc(deliveries.jobId))
      .all()
      .map(rowToDelivery);
  }

  /**
   * The deliveries that are not paid and whose job is gone (its folder was deleted), newest first
   * (then by job id). They are still payable and can still be taken back (CVP-204): the Jobs page
   * lists them. A paid one is not here; it is only in the Money page's Ledger.
   */
  listUnpaidWithoutJob(): Delivery[] {
    const hasJob = this.db.orm
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.id, deliveries.jobId));
    return this.db.orm
      .select()
      .from(deliveries)
      .where(and(isNull(deliveries.paidOn), notExists(hasJob)))
      .orderBy(desc(deliveries.deliveredAt), asc(deliveries.jobId))
      .all()
      .map(rowToDelivery);
  }

  /** The distinct local `YYYY-MM` months that have a delivery, newest first. */
  months(): string[] {
    const times = this.db.orm
      .select({ deliveredAt: deliveries.deliveredAt })
      .from(deliveries)
      .orderBy(desc(deliveries.deliveredAt))
      .all();
    // Newest first in, so the first sighting of a month keeps the order.
    return [...new Set(times.map((row) => localMonth(row.deliveredAt)))];
  }

  /** Sets the review time of a delivery (whole seconds). Returns whether the job has a delivery. */
  setReviewSec(jobId: string, sec: number): boolean {
    if (!Number.isFinite(sec) || sec < 0) {
      throw new RangeError(`Review time must be zero or more seconds, got ${sec}.`);
    }
    return (
      this.db.orm
        .update(deliveries)
        .set({ reviewSec: Math.round(sec) })
        .where(eq(deliveries.jobId, jobId))
        .run().changes > 0
    );
  }

  /**
   * Deletes the delivery of a job: Not delivered yet. Refused, returning false and changing
   * nothing, when the job is paid (Not paid yet comes first) and when it has no delivery. Returns
   * whether a row was deleted.
   */
  remove(jobId: string): boolean {
    return (
      this.db.orm
        .delete(deliveries)
        .where(and(eq(deliveries.jobId, jobId), isNull(deliveries.paidOn)))
        .run().changes > 0
    );
  }

  /**
   * Marks these deliveries paid on `paidOn` (`YYYY-MM-DD`): Mark paid. `amounts` is what the client
   * paid for each video, by job id, in its delivery's currency; a video it leaves out was paid its
   * price. All or nothing, in one transaction: when any job has no delivery or is paid already, no
   * job is changed and the answer lists every job that was in the wrong stage. A job id given twice
   * counts once.
   *
   * Throws `RangeError` for no job at all, for a `paidOn` that is not a real calendar day and for an
   * amount that is negative or not a number.
   */
  markPaid(
    jobIds: readonly string[],
    paidOn: string,
    amounts: Readonly<Record<string, number>> = {},
  ): PaymentResult {
    if (!isCalendarDay(paidOn)) {
      throw new RangeError(
        `Paid on must be a day written YYYY-MM-DD, got ${JSON.stringify(paidOn)}.`,
      );
    }
    for (const [jobId, amount] of Object.entries(amounts)) {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new RangeError(`The amount paid for ${jobId} must be zero or more, got ${amount}.`);
      }
    }
    return this.changePayment(
      jobIds,
      (delivery) =>
        delivery === undefined ? 'not-delivered' : delivery.paidOn === null ? null : 'already-paid',
      (ids, before) => {
        // One update per video: each has its own amount.
        for (const jobId of ids) {
          const paidAmount = amounts[jobId] ?? before.get(jobId)?.price ?? null;
          this.db.orm
            .update(deliveries)
            .set({ paidOn, paidAmount })
            .where(eq(deliveries.jobId, jobId))
            .run();
        }
      },
    );
  }

  /**
   * Clears the paid day of these deliveries: Not paid yet. All or nothing, like {@link markPaid}:
   * when any job has no delivery or is not paid, no job is changed and the answer lists them.
   *
   * Throws `RangeError` for no job at all.
   */
  unmarkPaid(jobIds: readonly string[]): PaymentResult {
    return this.changePayment(
      jobIds,
      (delivery) =>
        delivery === undefined ? 'not-delivered' : delivery.paidOn === null ? 'not-paid' : null,
      (ids) => {
        this.db.orm
          .update(deliveries)
          .set({ paidOn: null, paidAmount: null })
          .where(inArray(deliveries.jobId, ids))
          .run();
      },
    );
  }

  /**
   * The shared shape of `markPaid` and `unmarkPaid`: inside one immediate transaction, reads the
   * deliveries, asks `refusalOf` about each job, and runs `write` only when none is refused. `write`
   * gets the deliveries as they were read.
   */
  private changePayment(
    jobIds: readonly string[],
    refusalOf: (delivery: Delivery | undefined) => PaymentRefusal['reason'] | null,
    write: (ids: string[], before: ReadonlyMap<string, Delivery>) => void,
  ): PaymentResult {
    const ids = [...new Set(jobIds)];
    if (ids.length === 0) throw new RangeError('At least one job is needed.');
    return this.db.sqlite
      .transaction((): PaymentResult => {
        const before = this.getMany(ids);
        const refused: PaymentRefusal[] = [];
        for (const jobId of ids) {
          const reason = refusalOf(before.get(jobId));
          if (reason !== null) refused.push({ jobId, reason });
        }
        if (refused.length > 0) return { ok: false, refused };
        for (let from = 0; from < ids.length; from += ID_CHUNK) {
          write(ids.slice(from, from + ID_CHUNK), before);
        }
        const after = this.getMany(ids);
        return {
          ok: true,
          deliveries: ids.flatMap((jobId) => after.get(jobId) ?? []),
        };
      })
      .immediate();
  }
}
