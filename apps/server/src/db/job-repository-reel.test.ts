import { type Job, type JobEvent, jobStage } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioDb } from './database.js';
import { DeliveryRepository } from './delivery-repository.js';
import { InstagramRepository } from './instagram-repository.js';
import { JobRepository } from './job-repository.js';
import { deliveryToJobDelivery } from './mapping.js';
import { fakeClock, makeScan, memoryDb } from './test-utils.js';

// The job read fills `delivery.uploadedAt` and `delivery.reelUrl` from the reel that links the job
// (Clients × Instagram, IG5): derived as the job is read, never stored in the delivery.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  vi.restoreAllMocks();
});

const CLIENT = 'Northwind Bakery';
const CLIENT_ID = 'c-northwind';
const POSTED = '2026-10-20T09:30:00.000Z';
const OUTPUT = { fileName: 'x.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 };
const TO_READY: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'SUCCEED', output: OUTPUT },
];

function setup() {
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const instagram = new InstagramRepository(db, { clock });
  const scan = instagram.startScan({ clientId: CLIENT_ID, handle: 'northwind' });

  /** A ready job; delivered too unless `deliver` is false. */
  function job(name: string, deliver = true): Job {
    const { job: created } = jobs.upsertFromScan(makeScan(CLIENT, name));
    for (const event of TO_READY) {
      clock.tick();
      jobs.applyTransition(created.id, event);
    }
    if (deliver) {
      deliveries.record({
        jobId: created.id,
        clientId: created.clientId,
        client: CLIENT,
        name,
        relPath: created.relPath,
        deliveredAt: clock().getTime(),
        price: 40,
        currency: 'ILS',
      });
    }
    return jobs.get(created.id) as Job;
  }

  /** A reel of the client's own, posted at `postedAt`, with the plays its scan read. */
  function reel(shortcode: string, postedAt = POSTED, plays = 100): void {
    instagram.upsertReels(scan.id, [
      {
        shortcode,
        clientId: CLIENT_ID,
        url: `https://www.instagram.com/reel/${shortcode}/`,
        postedAt: Date.parse(postedAt),
        plays,
        likes: 10,
        comments: 1,
      },
    ]);
  }

  return { db, jobs, deliveries, instagram, job, reel };
}

describe('a delivery’s reelPlays', () => {
  it('are the plays of the reel that links the job, as its latest scan read them', () => {
    const t = setup();
    const job = t.job('Spring menu');
    t.reel('C-spring', POSTED, 27_500);
    t.instagram.linkReel('C-spring', job.id);
    expect(t.jobs.get(job.id)?.delivery?.reelPlays).toBe(27_500);

    // A later scan reads the reel again: the row follows it, nothing is stored in the delivery.
    t.reel('C-spring', POSTED, 31_200);
    expect(t.jobs.get(job.id)?.delivery?.reelPlays).toBe(31_200);
    expect(t.jobs.getAll().find((one) => one.id === job.id)?.delivery?.reelPlays).toBe(31_200);
    expect(t.deliveries.get(job.id)).not.toHaveProperty('reelPlays');
  });

  it('are 0 for a reel nobody has watched, and absent while no reel links the job', () => {
    const t = setup();
    const job = t.job('Spring menu');
    t.reel('C-spring', POSTED, 0);
    expect(t.jobs.get(job.id)?.delivery).not.toHaveProperty('reelPlays');

    t.instagram.linkReel('C-spring', job.id);
    expect(t.jobs.get(job.id)?.delivery?.reelPlays).toBe(0);

    t.instagram.unlinkReel('C-spring');
    expect(t.jobs.get(job.id)?.delivery).not.toHaveProperty('reelPlays');
  });
});

describe('deliveryToJobDelivery with a reel', () => {
  const stored = {
    jobId: 'job-1',
    clientId: CLIENT_ID,
    client: CLIENT,
    name: 'Spring menu',
    relPath: `${CLIENT}/Spring menu`,
    deliveredAt: Date.parse('2026-10-21T08:00:00.000Z'),
    price: 40,
    currency: 'ILS',
    reviewSec: 0,
    paidOn: null,
    paidAmount: null,
  };
  const link = {
    shortcode: 'C-spring',
    url: 'https://www.instagram.com/reel/C-spring/',
    postedAt: Date.parse(POSTED),
  };

  it('says where the reel is, when it was posted and its plays', () => {
    expect(deliveryToJobDelivery(stored, { ...link, plays: 27_500 })).toEqual({
      deliveredAt: '2026-10-21T08:00:00.000Z',
      price: 40,
      currency: 'ILS',
      paidOn: null,
      paidAmount: null,
      uploadedAt: POSTED,
      reelUrl: link.url,
      reelPlays: 27_500,
    });
  });

  it('writes no plays for a reel whose plays are not known', () => {
    const delivery = deliveryToJobDelivery(stored, { ...link, plays: null });
    expect(delivery).toMatchObject({ uploadedAt: POSTED, reelUrl: link.url });
    expect(delivery).not.toHaveProperty('reelPlays');
  });

  it('writes none of the three for a job no reel links', () => {
    for (const delivery of [deliveryToJobDelivery(stored), deliveryToJobDelivery(stored, null)]) {
      expect(delivery).not.toHaveProperty('uploadedAt');
      expect(delivery).not.toHaveProperty('reelUrl');
      expect(delivery).not.toHaveProperty('reelPlays');
    }
  });
});

describe('a delivery’s uploadedAt and reelUrl', () => {
  it('are the posted time and address of the reel that links the job', () => {
    const t = setup();
    const linked = t.job('Spring menu');
    t.reel('C-spring');
    t.instagram.linkReel('C-spring', linked.id);

    const delivery = t.jobs.get(linked.id)?.delivery;

    expect(delivery).toMatchObject({
      uploadedAt: POSTED,
      reelUrl: 'https://www.instagram.com/reel/C-spring/',
    });
    expect(jobStage(t.jobs.get(linked.id) as Job)).toBe('uploaded');
  });

  it('are absent while no reel links the job, and again after an unlink', () => {
    const t = setup();
    const job = t.job('Spring menu');
    t.reel('C-spring');
    expect(t.jobs.get(job.id)?.delivery).not.toHaveProperty('uploadedAt');
    expect(t.jobs.get(job.id)?.delivery).not.toHaveProperty('reelUrl');

    t.instagram.linkReel('C-spring', job.id);
    expect(t.jobs.get(job.id)?.delivery?.uploadedAt).toBe(POSTED);

    t.instagram.unlinkReel('C-spring');
    expect(t.jobs.get(job.id)?.delivery).not.toHaveProperty('uploadedAt');
    expect(t.jobs.get(job.id)?.delivery).not.toHaveProperty('reelUrl');
    expect(jobStage(t.jobs.get(job.id) as Job)).toBe('delivered');
  });

  it('follow the reel, not a copy: a reel read again with another time moves uploadedAt', () => {
    const t = setup();
    const job = t.job('Spring menu');
    t.reel('C-spring');
    t.instagram.linkReel('C-spring', job.id);

    t.reel('C-spring', '2026-10-21T10:00:00.000Z');

    expect(t.jobs.get(job.id)?.delivery?.uploadedAt).toBe('2026-10-21T10:00:00.000Z');
  });

  it('are not written into the deliveries table', () => {
    const t = setup();
    const job = t.job('Spring menu');
    t.reel('C-spring');
    t.instagram.linkReel('C-spring', job.id);

    expect(t.deliveries.get(job.id)).not.toHaveProperty('uploadedAt');
    expect(t.deliveries.get(job.id)).not.toHaveProperty('reelUrl');
    const columns = t.db.sqlite.prepare('pragma table_info(deliveries)').all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).not.toContain('uploaded_at');
  });

  it('are on the paid job as well, and on every read of the job', () => {
    const t = setup();
    const job = t.job('Spring menu');
    t.deliveries.markPaid([job.id], '2026-10-22');
    t.reel('C-spring');
    t.instagram.linkReel('C-spring', job.id);

    const fromGet = t.jobs.get(job.id);
    const fromList = t.jobs.getAll().find((one) => one.id === job.id);

    expect(fromGet?.delivery).toMatchObject({ paidOn: '2026-10-22', uploadedAt: POSTED });
    expect(fromList).toEqual(fromGet);
    expect(jobStage(fromGet as Job)).toBe('paid');
  });

  it('are left off a job that has no delivery, whatever links it', () => {
    const t = setup();
    const job = t.job('Spring menu', false);
    t.reel('C-spring');
    t.instagram.linkReel('C-spring', job.id);

    expect(t.jobs.get(job.id)?.delivery).toBeNull();
  });

  it('are filled for a whole list with one read of the reels', () => {
    const t = setup();
    const one = t.job('One');
    const two = t.job('Two');
    const three = t.job('Three');
    t.job('Four', false);
    t.reel('C-one');
    t.reel('C-two', '2026-10-19T08:00:00.000Z');
    t.instagram.linkReel('C-one', one.id);
    t.instagram.linkReel('C-two', two.id);
    const prepare = vi.spyOn(t.db.sqlite, 'prepare');

    const list = t.jobs.getAll();

    const reelReads = prepare.mock.calls.filter(([sql]) => sql.includes('"instagram_reels"'));
    expect(reelReads).toHaveLength(1);
    const uploaded = (job: Job) => list.find((one) => one.id === job.id)?.delivery?.uploadedAt;
    expect(uploaded(one)).toBe(POSTED);
    expect(uploaded(two)).toBe('2026-10-19T08:00:00.000Z');
    expect(uploaded(three)).toBeUndefined();
  });

  it('are not looked up at all when no job has a delivery', () => {
    const t = setup();
    t.job('One', false);
    const prepare = vi.spyOn(t.db.sqlite, 'prepare');

    t.jobs.getAll();

    expect(prepare.mock.calls.filter(([sql]) => sql.includes('"instagram_reels"'))).toHaveLength(0);
  });
});

describe('InstagramRepository.reelLinksOfJobs', () => {
  it('maps each job that a reel links to the reel, and leaves the others out', () => {
    const t = setup();
    t.reel('C-one');
    t.reel('C-two');
    t.reel('C-free');
    t.instagram.linkReel('C-one', 'job-1');
    t.instagram.linkReel('C-two', 'job-2');

    const links = t.instagram.reelLinksOfJobs(['job-1', 'job-2', 'job-3']);

    expect([...links.keys()].sort()).toEqual(['job-1', 'job-2']);
    expect(links.get('job-1')).toEqual({
      shortcode: 'C-one',
      url: 'https://www.instagram.com/reel/C-one/',
      postedAt: Date.parse(POSTED),
      plays: 100,
    });
    expect(t.instagram.reelLinksOfJobs([]).size).toBe(0);
  });

  it('reads a list longer than one query’s ids', () => {
    const t = setup();
    t.reel('C-first');
    t.reel('C-last');
    const ids = Array.from({ length: 1200 }, (_, index) => `job-${index}`);
    t.instagram.linkReel('C-first', 'job-3');
    t.instagram.linkReel('C-last', 'job-1199');

    const links = t.instagram.reelLinksOfJobs(ids);

    expect([...links.keys()].sort()).toEqual(['job-1199', 'job-3']);
  });
});
