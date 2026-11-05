import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { DeliveryRepository, type NewDelivery } from './delivery-repository.js';
import { JobRepository } from './job-repository.js';
import { idFor, makeScan, memoryDb, rawRow } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const db = memoryDb();
  opened.push(db);
  return { db, deliveries: new DeliveryRepository(db) };
}

/** A delivery of `Northwind Bakery/<name>`; override what a test cares about. */
function delivery(name: string, overrides: Partial<NewDelivery> = {}): NewDelivery {
  return {
    jobId: idFor(`Northwind Bakery/${name}`),
    clientId: 'client000001',
    client: 'Northwind Bakery',
    name,
    relPath: `Northwind Bakery/${name}`,
    deliveredAt: Date.parse('2026-10-20T10:00:00.000Z'),
    price: 200,
    currency: 'ILS',
    ...overrides,
  };
}

/** A moment in the engine's local time zone, which is what a month means to the Money page. */
function local(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('DeliveryRepository.record', () => {
  it('stores the delivery, with a review time of 0 until it is known and not paid', () => {
    const { deliveries } = setup();
    const input = delivery('Spring menu');

    expect(deliveries.record(input)).toBe(true);

    expect(deliveries.get(input.jobId)).toEqual({
      ...input,
      reviewSec: 0,
      paidOn: null,
      paidAmount: null,
    });
  });

  it('stores the review time it is given', () => {
    const { deliveries } = setup();
    const input = delivery('Spring menu', { reviewSec: 95 });

    deliveries.record(input);

    expect(deliveries.get(input.jobId)?.reviewSec).toBe(95);
  });

  it('is idempotent: a second call keeps the first delivered_at and price', () => {
    const { deliveries, db } = setup();
    const first = delivery('Spring menu', { deliveredAt: local(2026, 10, 20), price: 200 });
    deliveries.record(first);
    deliveries.setReviewSec(first.jobId, 120);

    const again = deliveries.record({
      ...first,
      deliveredAt: local(2026, 11, 3),
      price: 350,
      currency: 'USD',
      client: 'Northwind Bakery Ltd',
    });

    expect(again).toBe(false);
    expect(deliveries.get(first.jobId)).toEqual({
      ...first,
      reviewSec: 120,
      paidOn: null,
      paidAmount: null,
    });
    expect(rawRow(db, 'deliveries')).toHaveLength(1);
  });

  it('keeps one row per job: different jobs of one client each get theirs', () => {
    const { deliveries, db } = setup();

    expect(deliveries.record(delivery('One'))).toBe(true);
    expect(deliveries.record(delivery('Two'))).toBe(true);

    expect(rawRow(db, 'deliveries')).toHaveLength(2);
  });

  it('keeps Hebrew names as they are', () => {
    const { deliveries } = setup();
    const input = delivery('סרטון אביב', {
      client: 'לקוח א',
      relPath: 'לקוח א/סרטון אביב',
    });

    deliveries.record(input);

    expect(deliveries.get(input.jobId)).toMatchObject({
      client: 'לקוח א',
      name: 'סרטון אביב',
      relPath: 'לקוח א/סרטון אביב',
    });
  });
});

describe('DeliveryRepository.get', () => {
  it('is null for a job that was not delivered', () => {
    const { deliveries } = setup();

    expect(deliveries.get('nothing0000')).toBeNull();
  });
});

describe('DeliveryRepository.list', () => {
  it('is empty without deliveries', () => {
    expect(setup().deliveries.list()).toEqual([]);
  });

  it('lists every delivery, the oldest first and those at the same time by job id', () => {
    const { deliveries } = setup();
    deliveries.record(delivery('Late', { jobId: 'aaa', deliveredAt: 3_000 }));
    deliveries.record(delivery('TwinB', { jobId: 'ccc', deliveredAt: 2_000 }));
    deliveries.record(delivery('Ancient', { jobId: 'yyy', deliveredAt: 0 }));
    deliveries.record(delivery('Early', { jobId: 'zzz', deliveredAt: 1_000, reviewSec: 90 }));
    deliveries.record(delivery('TwinA', { jobId: 'bbb', deliveredAt: 2_000 }));

    const all = deliveries.list();

    expect(all.map((row) => row.name)).toEqual(['Ancient', 'Early', 'TwinA', 'TwinB', 'Late']);
    expect(all[1]).toEqual({
      ...delivery('Early', { jobId: 'zzz', deliveredAt: 1_000 }),
      reviewSec: 90,
      paidOn: null,
      paidAmount: null,
    });
  });
});

describe('DeliveryRepository.listBetween', () => {
  it('lists the deliveries from the first time up to, not including, the second', () => {
    const { deliveries } = setup();
    deliveries.record(delivery('Before', { deliveredAt: 999 }));
    deliveries.record(delivery('AtStart', { deliveredAt: 1_000 }));
    deliveries.record(delivery('Inside', { deliveredAt: 1_500 }));
    deliveries.record(delivery('JustBeforeEnd', { deliveredAt: 1_999 }));
    deliveries.record(delivery('AtEnd', { deliveredAt: 2_000 }));

    expect(deliveries.listBetween(1_000, 2_000).map((row) => row.name)).toEqual([
      'AtStart',
      'Inside',
      'JustBeforeEnd',
    ]);
  });

  it('lists the oldest first, and those at the same time by job id', () => {
    const { deliveries } = setup();
    deliveries.record(delivery('Late', { jobId: 'aaa', deliveredAt: 3_000 }));
    deliveries.record(delivery('TwinB', { jobId: 'ccc', deliveredAt: 2_000 }));
    deliveries.record(delivery('Early', { jobId: 'zzz', deliveredAt: 1_000 }));
    deliveries.record(delivery('TwinA', { jobId: 'bbb', deliveredAt: 2_000 }));

    expect(deliveries.listBetween(0, 10_000).map((row) => row.name)).toEqual([
      'Early',
      'TwinA',
      'TwinB',
      'Late',
    ]);
  });

  it('is empty when nothing falls in the range, and for an empty range', () => {
    const { deliveries } = setup();
    deliveries.record(delivery('One', { deliveredAt: 1_000 }));

    expect(deliveries.listBetween(2_000, 3_000)).toEqual([]);
    expect(deliveries.listBetween(1_000, 1_000)).toEqual([]);
  });

  it('reads a local month as the first of it up to the first of the next', () => {
    const { deliveries } = setup();
    deliveries.record(delivery('LastOfSeptember', { deliveredAt: local(2026, 9, 30, 23, 59) }));
    deliveries.record(delivery('FirstOfOctober', { deliveredAt: local(2026, 10, 1, 0, 0) }));
    deliveries.record(delivery('LastOfOctober', { deliveredAt: local(2026, 10, 31, 23, 59) }));
    deliveries.record(delivery('FirstOfNovember', { deliveredAt: local(2026, 11, 1, 0, 0) }));

    const october = deliveries.listBetween(local(2026, 10, 1, 0, 0), local(2026, 11, 1, 0, 0));

    expect(october.map((row) => row.name)).toEqual(['FirstOfOctober', 'LastOfOctober']);
  });
});

describe('DeliveryRepository.months', () => {
  it('is empty without deliveries', () => {
    const { deliveries } = setup();

    expect(deliveries.months()).toEqual([]);
  });

  it('lists each local month once, newest first', () => {
    const { deliveries } = setup();
    deliveries.record(delivery('A', { deliveredAt: local(2026, 8, 14) }));
    deliveries.record(delivery('B', { deliveredAt: local(2026, 10, 2) }));
    deliveries.record(delivery('C', { deliveredAt: local(2026, 10, 28) }));
    deliveries.record(delivery('D', { deliveredAt: local(2026, 9, 9) }));
    deliveries.record(delivery('E', { deliveredAt: local(2025, 12, 31, 23, 59) }));
    deliveries.record(delivery('F', { deliveredAt: local(2026, 1, 1, 0, 0) }));

    expect(deliveries.months()).toEqual(['2026-10', '2026-09', '2026-08', '2026-01', '2025-12']);
  });

  it('puts the late evening of the last day and the early morning of the first in their own months', () => {
    const { deliveries } = setup();
    deliveries.record(delivery('Late', { deliveredAt: local(2026, 3, 31, 23, 59) }));
    deliveries.record(delivery('Early', { deliveredAt: local(2026, 4, 1, 0, 0) }));

    expect(deliveries.months()).toEqual(['2026-04', '2026-03']);
  });
});

describe('DeliveryRepository.setReviewSec', () => {
  it('sets the review time of a delivery in whole seconds, and says so', () => {
    const { deliveries } = setup();
    const input = delivery('Spring menu');
    deliveries.record(input);

    expect(deliveries.setReviewSec(input.jobId, 210)).toBe(true);
    expect(deliveries.get(input.jobId)?.reviewSec).toBe(210);

    expect(deliveries.setReviewSec(input.jobId, 95.6)).toBe(true);
    expect(deliveries.get(input.jobId)?.reviewSec).toBe(96);
  });

  it('changes nothing else, and says false for a job that was not delivered', () => {
    const { deliveries } = setup();
    const input = delivery('Spring menu');
    deliveries.record(input);

    expect(deliveries.setReviewSec('nothing0000', 30)).toBe(false);
    deliveries.setReviewSec(input.jobId, 30);

    expect(deliveries.get(input.jobId)).toEqual({
      ...input,
      reviewSec: 30,
      paidOn: null,
      paidAmount: null,
    });
  });

  it('refuses a negative or non-finite time', () => {
    const { deliveries } = setup();
    const input = delivery('Spring menu', { reviewSec: 40 });
    deliveries.record(input);

    expect(() => deliveries.setReviewSec(input.jobId, -1)).toThrow(RangeError);
    expect(() => deliveries.setReviewSec(input.jobId, Number.NaN)).toThrow(RangeError);
    expect(() => deliveries.setReviewSec(input.jobId, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    expect(deliveries.get(input.jobId)?.reviewSec).toBe(40);
  });
});

/** Records a delivery of `Northwind Bakery/<name>` and returns its job id. */
function delivered(
  deliveries: DeliveryRepository,
  name: string,
  overrides: Partial<NewDelivery> = {},
): string {
  const input = delivery(name, overrides);
  deliveries.record(input);
  return input.jobId;
}

describe('DeliveryRepository.getMany', () => {
  it('maps the job ids that were delivered to their deliveries and leaves the others out', () => {
    const { deliveries } = setup();
    const one = delivered(deliveries, 'One');
    delivered(deliveries, 'Two');

    const found = deliveries.getMany([one, 'nothing0000']);

    expect([...found.keys()]).toEqual([one]);
    expect(found.get(one)).toMatchObject({ name: 'One', paidOn: null });
    expect(deliveries.getMany([])).toEqual(new Map());
  });
});

describe('DeliveryRepository.remove (Not delivered yet)', () => {
  it('deletes the delivery of an unpaid job and says so', () => {
    const { deliveries, db } = setup();
    const one = delivered(deliveries, 'One');
    const two = delivered(deliveries, 'Two');

    expect(deliveries.remove(one)).toBe(true);

    expect(deliveries.get(one)).toBeNull();
    expect(deliveries.get(two)).not.toBeNull();
    expect(rawRow(db, 'deliveries')).toHaveLength(1);
  });

  it('is refused, and changes nothing, when the job is paid', () => {
    const { deliveries, db } = setup();
    const one = delivered(deliveries, 'One');
    deliveries.markPaid([one], '2026-10-23');
    const rows = rawRow(db, 'deliveries');

    expect(deliveries.remove(one)).toBe(false);

    expect(rawRow(db, 'deliveries')).toEqual(rows);
    expect(deliveries.get(one)?.paidOn).toBe('2026-10-23');
  });

  it('can delete it once the job is not paid yet', () => {
    const { deliveries } = setup();
    const one = delivered(deliveries, 'One');
    deliveries.markPaid([one], '2026-10-23');
    deliveries.unmarkPaid([one]);

    expect(deliveries.remove(one)).toBe(true);
    expect(deliveries.get(one)).toBeNull();
  });

  it('says false for a job that was not delivered', () => {
    expect(setup().deliveries.remove('nothing0000')).toBe(false);
  });

  it('lets the job be delivered again at the new price afterwards', () => {
    const { deliveries } = setup();
    const input = delivery('One', { price: 200 });
    deliveries.record(input);
    deliveries.remove(input.jobId);

    expect(deliveries.record({ ...input, price: 40, deliveredAt: input.deliveredAt + 1 })).toBe(
      true,
    );

    expect(deliveries.get(input.jobId)).toMatchObject({ price: 40 });
  });
});

describe('DeliveryRepository.markPaid (Mark paid)', () => {
  it('sets the paid day of every job, and returns their deliveries in the order asked', () => {
    const { deliveries } = setup();
    const one = delivered(deliveries, 'One');
    const two = delivered(deliveries, 'Two');
    const three = delivered(deliveries, 'Three');

    const result = deliveries.markPaid([three, one], '2026-10-23');

    expect(result).toEqual({
      ok: true,
      deliveries: [
        expect.objectContaining({ jobId: three, paidOn: '2026-10-23' }),
        expect.objectContaining({ jobId: one, paidOn: '2026-10-23' }),
      ],
    });
    expect(deliveries.get(one)?.paidOn).toBe('2026-10-23');
    expect(deliveries.get(two)?.paidOn).toBeNull();
    expect(deliveries.get(three)?.paidOn).toBe('2026-10-23');
  });

  it('changes nothing else of the delivery: its time, its frozen price, its review time', () => {
    const { deliveries } = setup();
    const input = delivery('One', { price: 40, reviewSec: 95 });
    deliveries.record(input);

    deliveries.markPaid([input.jobId], '2026-10-23');

    expect(deliveries.get(input.jobId)).toEqual({
      ...input,
      reviewSec: 95,
      paidOn: '2026-10-23',
      paidAmount: 40,
    });
  });

  it('records what was paid for each video: what was typed, else its price, 0 included', () => {
    const { deliveries } = setup();
    const one = delivered(deliveries, 'One', { price: 40 });
    const two = delivered(deliveries, 'Two', { price: 40 });
    const three = delivered(deliveries, 'Three', { price: 40 });

    const result = deliveries.markPaid([one, two, three], '2026-10-23', {
      one: 1,
      [one]: 0,
      [two]: 25.5,
    });

    expect(result.ok).toBe(true);
    expect(deliveries.get(one)).toMatchObject({ price: 40, paidAmount: 0 });
    expect(deliveries.get(two)).toMatchObject({ price: 40, paidAmount: 25.5 });
    expect(deliveries.get(three)).toMatchObject({ price: 40, paidAmount: 40 });
  });

  it('refuses an amount that is negative or not a number, and changes nothing', () => {
    const { deliveries, db } = setup();
    const one = delivered(deliveries, 'One');
    const rows = rawRow(db, 'deliveries');

    expect(() => deliveries.markPaid([one], '2026-10-23', { [one]: -1 })).toThrow(RangeError);
    expect(() => deliveries.markPaid([one], '2026-10-23', { [one]: Number.NaN })).toThrow(
      RangeError,
    );
    expect(rawRow(db, 'deliveries')).toEqual(rows);
  });

  it('records no amount for a job it refuses', () => {
    const { deliveries } = setup();
    const one = delivered(deliveries, 'One');
    const two = delivered(deliveries, 'Two');
    deliveries.markPaid([two], '2026-10-20', { [two]: 10 });

    const result = deliveries.markPaid([one, two], '2026-10-23', { [one]: 0, [two]: 0 });

    expect(result.ok).toBe(false);
    expect(deliveries.get(one)).toMatchObject({ paidOn: null, paidAmount: null });
    expect(deliveries.get(two)).toMatchObject({ paidOn: '2026-10-20', paidAmount: 10 });
  });

  it('refuses all of them, and changes nothing, when one was not delivered', () => {
    const { deliveries, db } = setup();
    const one = delivered(deliveries, 'One');
    const two = delivered(deliveries, 'Two');
    const rows = rawRow(db, 'deliveries');

    const result = deliveries.markPaid([one, 'nothing0000', two], '2026-10-23');

    expect(result).toEqual({
      ok: false,
      refused: [{ jobId: 'nothing0000', reason: 'not-delivered' }],
    });
    expect(rawRow(db, 'deliveries')).toEqual(rows);
  });

  it('refuses all of them, and changes nothing, when one is paid already; it keeps its first day', () => {
    const { deliveries, db } = setup();
    const one = delivered(deliveries, 'One');
    const two = delivered(deliveries, 'Two');
    deliveries.markPaid([one], '2026-10-20');
    const rows = rawRow(db, 'deliveries');

    const result = deliveries.markPaid([one, two], '2026-10-23');

    expect(result).toEqual({ ok: false, refused: [{ jobId: one, reason: 'already-paid' }] });
    expect(rawRow(db, 'deliveries')).toEqual(rows);
    expect(deliveries.get(one)?.paidOn).toBe('2026-10-20');
    expect(deliveries.get(two)?.paidOn).toBeNull();
  });

  it('lists every job in the wrong stage, in the order asked', () => {
    const { deliveries } = setup();
    const paid = delivered(deliveries, 'Paid');
    deliveries.markPaid([paid], '2026-10-20');

    const result = deliveries.markPaid(['nothing0000', paid], '2026-10-23');

    expect(result).toEqual({
      ok: false,
      refused: [
        { jobId: 'nothing0000', reason: 'not-delivered' },
        { jobId: paid, reason: 'already-paid' },
      ],
    });
  });

  it('counts a job asked for twice once', () => {
    const { deliveries } = setup();
    const one = delivered(deliveries, 'One');

    const result = deliveries.markPaid([one, one], '2026-10-23');

    expect(result).toMatchObject({
      ok: true,
      deliveries: [expect.objectContaining({ jobId: one })],
    });
  });

  it('is all or nothing even when the write itself fails half way', () => {
    const { deliveries, db } = setup();
    const one = delivered(deliveries, 'One');
    const two = delivered(deliveries, 'Two');
    // A trigger that refuses the second job's update, after the first one was written.
    db.sqlite.exec(`
      create trigger refuse_two before update on deliveries
      when new.job_id = '${two}'
      begin select raise(abort, 'disk says no'); end;
    `);
    const rows = rawRow(db, 'deliveries');

    expect(() => deliveries.markPaid([one, two], '2026-10-23')).toThrow(/disk says no/);

    expect(rawRow(db, 'deliveries')).toEqual(rows);
    expect(deliveries.get(one)?.paidOn).toBeNull();
  });

  it('works through more jobs than one query holds', () => {
    const { deliveries } = setup();
    const ids = Array.from({ length: 1_200 }, (_, index) => delivered(deliveries, `Job ${index}`));

    const result = deliveries.markPaid(ids, '2026-10-23');

    expect(result).toMatchObject({ ok: true });
    expect(deliveries.list().every((row) => row.paidOn === '2026-10-23')).toBe(true);
  });

  it.each(['2026-02-30', '2026-13-01', '23/10/2026', '2026-10-23T10:00:00Z', '', 'today'])(
    'refuses the paid day %j without writing',
    (day) => {
      const { deliveries } = setup();
      const one = delivered(deliveries, 'One');

      expect(() => deliveries.markPaid([one], day)).toThrow(RangeError);

      expect(deliveries.get(one)?.paidOn).toBeNull();
    },
  );

  it('refuses no jobs at all', () => {
    expect(() => setup().deliveries.markPaid([], '2026-10-23')).toThrow(RangeError);
  });
});

describe('DeliveryRepository.unmarkPaid (Not paid yet)', () => {
  it('clears the paid day of every job and returns their deliveries', () => {
    const { deliveries } = setup();
    const one = delivered(deliveries, 'One');
    const two = delivered(deliveries, 'Two');
    deliveries.markPaid([one, two], '2026-10-23');

    const result = deliveries.unmarkPaid([two, one]);

    expect(result).toEqual({
      ok: true,
      deliveries: [
        expect.objectContaining({ jobId: two, paidOn: null }),
        expect.objectContaining({ jobId: one, paidOn: null }),
      ],
    });
    expect(deliveries.list().map((row) => row.paidOn)).toEqual([null, null]);
  });

  it('refuses all of them, and changes nothing, when one is not paid or not delivered', () => {
    const { deliveries, db } = setup();
    const one = delivered(deliveries, 'One');
    const two = delivered(deliveries, 'Two');
    deliveries.markPaid([one], '2026-10-23');
    const rows = rawRow(db, 'deliveries');

    const result = deliveries.unmarkPaid([one, two, 'nothing0000']);

    expect(result).toEqual({
      ok: false,
      refused: [
        { jobId: two, reason: 'not-paid' },
        { jobId: 'nothing0000', reason: 'not-delivered' },
      ],
    });
    expect(rawRow(db, 'deliveries')).toEqual(rows);
    expect(deliveries.get(one)?.paidOn).toBe('2026-10-23');
  });

  it('keeps the delivery itself: it is still delivered after Not paid yet', () => {
    const { deliveries } = setup();
    const input = delivery('One', { price: 40 });
    deliveries.record(input);
    deliveries.markPaid([input.jobId], '2026-10-23');

    deliveries.unmarkPaid([input.jobId]);

    expect(deliveries.get(input.jobId)).toEqual({
      ...input,
      reviewSec: 0,
      paidOn: null,
      paidAmount: null,
    });
  });

  it('clears what was paid with the day: paid again, it starts from the price', () => {
    const { deliveries } = setup();
    const one = delivered(deliveries, 'One', { price: 40 });
    deliveries.markPaid([one], '2026-10-23', { [one]: 0 });

    deliveries.unmarkPaid([one]);
    expect(deliveries.get(one)).toMatchObject({ price: 40, paidOn: null, paidAmount: null });

    deliveries.markPaid([one], '2026-10-24');
    expect(deliveries.get(one)).toMatchObject({ paidOn: '2026-10-24', paidAmount: 40 });
  });

  it('refuses no jobs at all', () => {
    expect(() => setup().deliveries.unmarkPaid([])).toThrow(RangeError);
  });
});

describe('DeliveryRepository.listUnpaidWithoutJob', () => {
  /** A delivered job whose job row is `kept` or gone. */
  function deliveredJob(
    t: ReturnType<typeof setup>,
    name: string,
    deliveredAt: number,
    { kept }: { kept: boolean },
  ) {
    const jobs = new JobRepository(t.db);
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', name));
    t.deliveries.record(delivery(name, { jobId: job.id, deliveredAt }));
    if (!kept) jobs.remove(job.id);
    return job.id;
  }

  it('lists the unpaid deliveries whose job row is gone, newest first', () => {
    const t = setup();
    const older = deliveredJob(t, 'Older', local(2026, 10, 19), { kept: false });
    const newer = deliveredJob(t, 'Newer', local(2026, 10, 21), { kept: false });

    expect(t.deliveries.listUnpaidWithoutJob().map((d) => d.jobId)).toEqual([newer, older]);
  });

  it('gives the delivery as stored', () => {
    const t = setup();
    const id = deliveredJob(t, 'History check', local(2026, 10, 21), { kept: false });

    expect(t.deliveries.listUnpaidWithoutJob()).toEqual([t.deliveries.get(id)]);
  });

  it('leaves out a delivery whose job is still there', () => {
    const t = setup();
    deliveredJob(t, 'Still here', local(2026, 10, 21), { kept: true });

    expect(t.deliveries.listUnpaidWithoutJob()).toEqual([]);
  });

  it('leaves out a paid one: it stays in the Ledger only', () => {
    const t = setup();
    const id = deliveredJob(t, 'Paid', local(2026, 10, 21), { kept: false });
    t.deliveries.markPaid([id], '2026-10-22');

    expect(t.deliveries.listUnpaidWithoutJob()).toEqual([]);
  });

  it('lists it again once its payment is taken back', () => {
    const t = setup();
    const id = deliveredJob(t, 'Paid', local(2026, 10, 21), { kept: false });
    t.deliveries.markPaid([id], '2026-10-22');
    t.deliveries.unmarkPaid([id]);

    expect(t.deliveries.listUnpaidWithoutJob().map((d) => d.jobId)).toEqual([id]);
  });

  it('is empty with no deliveries at all', () => {
    expect(setup().deliveries.listUnpaidWithoutJob()).toEqual([]);
  });
});

describe('a delivery outlives its job', () => {
  it('stays when the job is removed', () => {
    const { db, deliveries } = setup();
    const jobs = new JobRepository(db);
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
    deliveries.record(delivery('Spring menu', { jobId: job.id }));

    expect(jobs.remove(job.id)).toBe(true);

    expect(jobs.get(job.id)).toBeNull();
    expect(deliveries.get(job.id)).toMatchObject({ name: 'Spring menu', price: 200 });
    expect(deliveries.months()).toHaveLength(1);
  });

  it('is not tied to the jobs table by a foreign key', () => {
    const { db } = setup();

    expect(db.sqlite.prepare("select * from pragma_foreign_key_list('deliveries')").all()).toEqual(
      [],
    );
  });
});
