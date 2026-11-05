import { describe, expect, it } from 'vitest';
import { groupOf, jobSchema, jobStage } from './job.ts';
import {
  isFolderDeleted,
  orphanAsJob,
  orphanDeliverySchema,
  withFolderDeleted,
  withoutOrphanMoney,
} from './orphan-delivery.ts';
import { makeJob, makeOrphanDelivery } from './test-fixtures.ts';

describe('orphanDeliverySchema', () => {
  it('parses a delivery whose job is gone, paid or not', () => {
    const unpaid = makeOrphanDelivery();
    expect(orphanDeliverySchema.parse(unpaid)).toEqual(unpaid);
    const paid = makeOrphanDelivery({ delivery: { ...unpaid.delivery, paidOn: '2026-10-22' } });
    expect(orphanDeliverySchema.parse(paid)).toEqual(paid);
  });

  it('keeps Hebrew names as they are', () => {
    const hebrew = makeOrphanDelivery({
      client: 'מאפיית הצפון',
      name: 'סרטון גיוס – Hiring video',
      relPath: 'מאפיית הצפון/סרטון גיוס – Hiring video',
    });
    expect(orphanDeliverySchema.parse(hebrew)).toEqual(hebrew);
  });

  it.each([
    [{ ...makeOrphanDelivery(), id: '' }],
    [{ ...makeOrphanDelivery(), delivery: null }],
    [{ ...makeOrphanDelivery(), delivery: { price: 40 } }],
    [{ id: 'x' }],
    [makeJob()],
  ])('rejects %j', (value) => {
    expect(orphanDeliverySchema.safeParse(value).success).toBe(false);
  });
});

describe('orphanAsJob', () => {
  it('takes the delivery row’s name, client and times', () => {
    const orphan = makeOrphanDelivery();

    const job = orphanAsJob(orphan);

    expect(job).toMatchObject({
      id: orphan.id,
      clientId: orphan.clientId,
      client: orphan.client,
      name: orphan.name,
      relPath: orphan.relPath,
      delivery: orphan.delivery,
      addedAt: orphan.delivery.deliveredAt,
      lastChangeAt: orphan.delivery.deliveredAt,
      updatedAt: orphan.delivery.deliveredAt,
    });
  });

  it('is a valid job a ready, unarchived one, with nothing a folder would give it', () => {
    const job = orphanAsJob(makeOrphanDelivery());

    expect(jobSchema.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({
      state: 'ready',
      output: null,
      preview: null,
      note: null,
      effort: null,
      archivedAt: null,
      seriesId: null,
      sizeBytes: 0,
      inputs: { video: 0, audio: 0, image: 0, doc: 0 },
    });
  });

  it('is delivered while unpaid and paid once its delivery is', () => {
    const orphan = makeOrphanDelivery();
    expect(jobStage(orphanAsJob(orphan))).toBe('delivered');
    expect(groupOf(orphanAsJob(orphan))).toBe('delivered');

    const paid = makeOrphanDelivery({ delivery: { ...orphan.delivery, paidOn: '2026-10-22' } });
    expect(jobStage(orphanAsJob(paid))).toBe('paid');
  });

  it('carries the folderDeleted marker, which no job from the server has', () => {
    expect(isFolderDeleted(orphanAsJob(makeOrphanDelivery()))).toBe(true);
    expect(isFolderDeleted(makeJob({ state: 'ready' }))).toBe(false);
    expect(isFolderDeleted(makeJob({ delivery: makeOrphanDelivery().delivery }))).toBe(false);
  });
});

describe('withFolderDeleted', () => {
  it('lists the jobs first, in their order, then the videos without a folder', () => {
    const jobs = [makeJob({ id: 'a' }), makeJob({ id: 'b' })];
    const gone = [makeOrphanDelivery({ id: 'x' }), makeOrphanDelivery({ id: 'y' })];

    const listed = withFolderDeleted(jobs, gone);

    expect(listed.map((job) => job.id)).toEqual(['a', 'b', 'x', 'y']);
    expect(listed.slice(0, 2)).toEqual(jobs);
    expect(listed.map(isFolderDeleted)).toEqual([false, false, true, true]);
  });

  it('leaves out a paid one: it leaves the Jobs page and stays in the Ledger', () => {
    const base = makeOrphanDelivery();
    const paid = makeOrphanDelivery({
      id: 'paid',
      delivery: { ...base.delivery, paidOn: '2026-10-22' },
    });

    expect(withFolderDeleted([], [paid, base]).map((job) => job.id)).toEqual([base.id]);
  });

  it('leaves out a video whose id the job list has again: the real job wins', () => {
    const orphan = makeOrphanDelivery({ id: 'back' });
    const job = makeJob({ id: 'back', name: 'Folder put back' });

    expect(withFolderDeleted([job], [orphan])).toEqual([job]);
  });

  it('is the job list when there is nothing to add', () => {
    const jobs = [makeJob()];
    expect(withFolderDeleted(jobs, [])).toEqual(jobs);
    expect(withFolderDeleted([], [])).toEqual([]);
  });
});

describe('withoutOrphanMoney', () => {
  it('keeps who it was for and when it was delivered, and drops the price, currency and pay date', () => {
    const orphan = makeOrphanDelivery();
    const seen = withoutOrphanMoney(orphan);
    expect(seen).toEqual({ ...orphan, delivery: { deliveredAt: orphan.delivery.deliveredAt } });
    expect(orphanDeliverySchema.parse(JSON.parse(JSON.stringify(seen)))).toEqual(seen);
    expect(orphan.delivery.price).toBe(40);
  });
});
