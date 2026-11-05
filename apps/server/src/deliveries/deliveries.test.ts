import type { Job } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryRepository, JobRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import {
  createRecordDelivery,
  DEFAULT_PRICE,
  defaultPriceFor,
  type PriceFor,
} from './deliveries.js';

const OUTPUT = { fileName: 'x.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 };

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);

  /** A job as the engine would have it in `state`, finished at the clock's time. */
  function jobIn(client: string, name: string, state: 'ready' | 'failed' | 'queued' = 'ready') {
    const { job } = jobs.upsertFromScan(makeScan(client, name));
    if (state === 'queued') return jobs.applyTransition(job.id, { type: 'SETTLED' });
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    jobs.applyTransition(job.id, { type: 'START' });
    clock.tick(60_000);
    return state === 'ready'
      ? jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT })
      : jobs.applyTransition(job.id, { type: 'FAIL', step: 4, error: 'boom' });
  }

  /** A job that went through Review, where the owner spent `reviewSec`, and was approved into Ready. */
  function reviewedJob(client: string, name: string, reviewSec: number) {
    const { job } = jobs.upsertFromScan(makeScan(client, name));
    for (const event of [
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
    ] as const) {
      clock.tick(1_000);
      jobs.applyTransition(job.id, event);
    }
    if (reviewSec > 0) jobs.addReviewSec(job.id, reviewSec);
    for (const event of [
      { type: 'APPROVE' },
      { type: 'START' },
      { type: 'SUCCEED', output: OUTPUT },
    ] as const) {
      clock.tick(1_000);
      jobs.applyTransition(job.id, event);
    }
    return jobs.get(job.id) as Job;
  }

  return { db, clock, jobs, deliveries, jobIn, reviewedJob };
}

describe('the default price', () => {
  it('is 200 ILS for every client', () => {
    expect(DEFAULT_PRICE).toEqual({ price: 200, currency: 'ILS' });
    expect(defaultPriceFor('Northwind Bakery')).toEqual({ price: 200, currency: 'ILS' });
    expect(defaultPriceFor('לקוח א')).toEqual({ price: 200, currency: 'ILS' });
  });

  it('is a copy each time, so nothing can change the default', () => {
    const price = defaultPriceFor('Northwind Bakery');
    price.price = 1;

    expect(defaultPriceFor('Northwind Bakery').price).toBe(200);
  });
});

describe('createRecordDelivery', () => {
  it('stores the delivery of a job at the clock’s time with its client’s price', () => {
    const { deliveries, jobs, clock, jobIn } = setup();
    const job = jobIn('Northwind Bakery', 'Spring menu');
    const priceFor = vi.fn<PriceFor>(() => ({ price: 250, currency: 'USD' }));
    const record = createRecordDelivery({ deliveries, jobs, priceFor, clock });
    clock.tick(5_000);

    expect(record(job)).toBe(true);

    expect(priceFor).toHaveBeenCalledWith('Northwind Bakery');
    expect(deliveries.get(job.id)).toEqual({
      jobId: job.id,
      clientId: job.clientId,
      client: 'Northwind Bakery',
      name: 'Spring menu',
      relPath: 'Northwind Bakery/Spring menu',
      deliveredAt: clock().getTime(),
      price: 250,
      currency: 'USD',
      reviewSec: 0,
      paidOn: null,
      paidAmount: null,
    });
    expect(jobs.get(job.id)?.state).toBe('ready');
  });

  it('tells onRecorded after a row was written, and only then', () => {
    const { deliveries, jobs, clock, jobIn } = setup();
    const job = jobIn('Northwind Bakery', 'Spring menu');
    const onRecorded = vi.fn();
    const record = createRecordDelivery({
      deliveries,
      jobs,
      priceFor: defaultPriceFor,
      clock,
      onRecorded,
    });

    expect(record(job)).toBe(true);
    expect(onRecorded).toHaveBeenCalledTimes(1);
    // The row is already there when it is told.
    expect(deliveries.get(job.id)).not.toBeNull();

    // Delivered before: nothing new, nothing to tell.
    expect(record(job)).toBe(false);
    expect(onRecorded).toHaveBeenCalledTimes(1);
  });

  it('does not tell onRecorded when the price cannot be resolved', () => {
    const { deliveries, jobs, clock, jobIn } = setup();
    const job = jobIn('Northwind Bakery', 'Spring menu');
    const onRecorded = vi.fn();
    const record = createRecordDelivery({
      deliveries,
      jobs,
      clock,
      priceFor: () => {
        throw new Error('no price');
      },
      onRecorded,
    });

    expect(() => record(job)).toThrow('no price');
    expect(onRecorded).not.toHaveBeenCalled();
    expect(deliveries.get(job.id)).toBeNull();
  });

  it('copies the time the owner spent in Review into the delivery', () => {
    const { deliveries, jobs, clock, reviewedJob } = setup();
    const job = reviewedJob('Northwind Bakery', 'Spring menu', 245);
    const record = createRecordDelivery({ deliveries, jobs, priceFor: defaultPriceFor, clock });

    expect(record(job)).toBe(true);

    expect(deliveries.get(job.id)?.reviewSec).toBe(245);
  });

  it('records 0 review seconds for a job that was never reviewed', () => {
    const { deliveries, jobs, clock, reviewedJob } = setup();
    const job = reviewedJob('Northwind Bakery', 'Spring menu', 0);
    const record = createRecordDelivery({ deliveries, jobs, priceFor: defaultPriceFor, clock });

    record(job);

    expect(deliveries.get(job.id)?.reviewSec).toBe(0);
  });

  it('keeps the first review time when the same job is recorded again', () => {
    const { deliveries, jobs, clock, reviewedJob } = setup();
    const job = reviewedJob('Northwind Bakery', 'Spring menu', 90);
    const record = createRecordDelivery({ deliveries, jobs, priceFor: defaultPriceFor, clock });
    record(job);
    deliveries.setReviewSec(job.id, 95);

    expect(record(job)).toBe(false);
    expect(deliveries.get(job.id)?.reviewSec).toBe(95);
  });

  it('keeps the first time and price when the same job is recorded again', () => {
    const { deliveries, jobs, clock, jobIn } = setup();
    const job = jobIn('Northwind Bakery', 'Spring menu');
    let price = 200;
    const record = createRecordDelivery({
      deliveries,
      jobs,
      priceFor: () => ({ price, currency: 'ILS' }),
      clock,
    });
    record(job);
    const first = deliveries.get(job.id);

    clock.tick(86_400_000);
    price = 300;

    expect(record(job)).toBe(false);
    expect(deliveries.get(job.id)).toEqual(first);
  });

  it('lets a price that cannot be resolved through, and stores nothing', () => {
    const { deliveries, jobs, jobIn } = setup();
    const job = jobIn('Northwind Bakery', 'Spring menu');
    const record = createRecordDelivery({
      deliveries,
      jobs,
      priceFor: () => {
        throw new Error('money.json is broken');
      },
    });

    expect(() => record(job)).toThrow('money.json is broken');
    expect(deliveries.get(job.id)).toBeNull();
  });
});

describe('a delivery outlives its job', () => {
  it('keeps the delivery of a ready job whose folder was removed', () => {
    const { jobs, deliveries, clock, jobIn } = setup();
    const job = jobIn('Northwind Bakery', 'Spring menu');
    createRecordDelivery({ deliveries, jobs, priceFor: defaultPriceFor, clock })(job);
    const delivery = deliveries.get(job.id);

    // The folder is removed: reconcile deletes the job.
    expect(jobs.remove(job.id)).toBe(true);
    expect(jobs.get(job.id)).toBeNull();

    expect(deliveries.get(job.id)).toEqual(delivery);
    expect(deliveries.listBetween(0, Number.MAX_SAFE_INTEGER)).toEqual([delivery]);
  });
});

describe('a job that reaches Ready', () => {
  it('has no delivery until one is recorded: reaching ready writes nothing', () => {
    const { jobs, deliveries, jobIn, reviewedJob } = setup();
    const direct = jobIn('Northwind Bakery', 'Spring menu');
    const reviewed = reviewedJob('Northwind Bakery', 'Reviewed', 30);

    expect(direct.state).toBe('ready');
    expect(reviewed.state).toBe('ready');
    expect(deliveries.list()).toEqual([]);
    expect(jobs.get(direct.id)?.delivery).toBeNull();
  });
});
