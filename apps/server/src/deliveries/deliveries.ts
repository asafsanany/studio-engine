// What makes a delivery (Phase 4 §2): the record that the owner sent a job to its client, with its price.
//
//   The owner clicks Mark delivered on a ready job
//       ─▶ a delivery row: delivered_at = now, the price of its client frozen at that moment
//          (`createRecordDelivery`, which the deliver route calls), and the job's review time (M3)
//          is copied into it
//
// A job that reaches Ready is only Approved: nothing is written then, and nothing is backfilled at
// boot. A delivery is written once (a second call for a job keeps the first row). It is deleted
// only by Not delivered yet (`DeliveryRepository.remove`, refused once the job is paid), so a job
// that is removed, or fails its export later and is retried, never changes a past month.

import type { Job } from '@studio/shared';
import type { DeliveryRepository, JobRepository } from '../db/index.js';

/** A price and its currency (ISO 4217). */
export interface Price {
  price: number;
  currency: string;
}

/**
 * What a client's job costs: the engine's way of asking for the price when a job is delivered.
 * The engine answers it from the money file (`priceForClient`); {@link defaultPriceFor} is the
 * stand-in for code that has no money file.
 */
export type PriceFor = (client: string) => Price;

/** Phase 4 §1: ₪200 per job unless the money file says otherwise. */
export const DEFAULT_PRICE: Readonly<Price> = { price: 200, currency: 'ILS' };

/** The resolver used when none is injected: {@link DEFAULT_PRICE} for every client. */
export const defaultPriceFor: PriceFor = () => ({ ...DEFAULT_PRICE });

export interface RecordDeliveryOptions {
  deliveries: Pick<DeliveryRepository, 'record'>;
  /** Where the job's review time (`reviewSec`) is read, to be copied into the delivery. */
  jobs: Pick<JobRepository, 'getMeta'>;
  priceFor: PriceFor;
  /** The clock for `deliveredAt`. Tests pass a fake. */
  clock?: () => Date;
  /** Called after a row was written (not when the job had been delivered before). */
  onRecorded?: () => void;
}

/**
 * Stores the delivery of a job the owner marked delivered (the deliver route, M12), with `deliveredAt`
 * now, the price `priceFor` gives for its client and the job's review time
 * (`jobs.getMeta(...).reviewSec`). Returns whether a row was written: false when the job was
 * delivered before, which keeps its first time, price and review time. `onRecorded` is told after
 * a row was written (the engine tells the Money page); a throw from it propagates like any other.
 * Throws if the price cannot be resolved or the row cannot be written. It does not check the job's
 * state: whether a job may be marked delivered is the route's call.
 */
export function createRecordDelivery({
  deliveries,
  jobs,
  priceFor,
  clock = () => new Date(),
  onRecorded,
}: RecordDeliveryOptions): (job: Job) => boolean {
  return (job) => {
    const { price, currency } = priceFor(job.client);
    const written = deliveries.record({
      jobId: job.id,
      clientId: job.clientId,
      client: job.client,
      name: job.name,
      relPath: job.relPath,
      deliveredAt: clock().getTime(),
      price,
      currency,
      reviewSec: jobs.getMeta(job.id)?.reviewSec ?? 0,
    });
    if (written) onRecorded?.();
    return written;
  };
}
