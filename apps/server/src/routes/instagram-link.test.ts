import {
  apiErrorSchema,
  INSTAGRAM_LINK_MESSAGES,
  INSTAGRAM_LINK_REFUSALS,
  INSTAGRAM_MESSAGES,
  type InstagramLinkRefusalReason,
  instagramLinkRefusalSchema,
  instagramLinkResponseSchema,
  type Job,
  type JobEvent,
  jobSchema,
  jobStage,
  paymentResponseSchema,
  undeliverRefusedResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { InstagramRepository, JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { createRecordDelivery } from '../deliveries/deliveries.js';
import { clientIdFor } from '../inbox/scan.js';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Link a reel to a job and unlink it (IG5) on the real repositories over an in-memory database and
// the real routes, `app.request` for the HTTP. The job is delivered by the real
// `createRecordDelivery`; the reel is written the way a scan writes it.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  vi.clearAllMocks();
});

const CLIENT = 'Northwind Bakery';
const OTHER_CLIENT = 'Harbor Studio';
const POSTED_AT = '2026-10-20T09:30:00.000Z';

const OUTPUT = { fileName: 'x.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 };
const TO_READY: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'SUCCEED', output: OUTPUT },
];

function setup(options: { throwing?: boolean; off?: boolean } = {}) {
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const instagram = new InstagramRepository(db, { clock });
  const recordDelivery = createRecordDelivery({
    deliveries,
    jobs,
    priceFor: () => ({ price: 40, currency: 'ILS' }),
    clock,
  });
  /** The news in the order it was sent. */
  const events: string[] = [];
  const throwIfAsked = (): void => {
    if (options.throwing) throw new Error('listener broke');
  };
  const app = createApp({
    instagram: !options.off,
    instagramRoutes: {
      clients: { jobs, clientStyles: { get: () => null } },
      link: {
        jobs,
        instagram,
        onJobChanged: (job) => {
          events.push(`job.upsert:${job.id}:${job.delivery?.uploadedAt ?? 'no uploadedAt'}`);
          throwIfAsked();
        },
        onClientInstagramChanged: (clientId) => {
          events.push(`client-instagram:${clientId}`);
          throwIfAsked();
        },
      },
    },
    delivery: {
      jobs,
      deliveries,
      recordDelivery,
      onJobChanged: (job) => events.push(`delivery.job.upsert:${job.id}`),
      onMoneyChanged: () => events.push('money.changed'),
    },
  });

  /** An approved job: a ready job nobody marked delivered. */
  function approved(name = 'Spring menu', client = CLIENT): Job {
    const { job } = jobs.upsertFromScan(makeScan(client, name));
    let current = job;
    for (const event of TO_READY) {
      clock.tick();
      current = jobs.applyTransition(job.id, event);
    }
    return current;
  }

  /** A job marked delivered. */
  function delivered(name = 'Spring menu', client = CLIENT): Job {
    const job = approved(name, client);
    clock.tick();
    recordDelivery(job);
    return jobs.get(job.id) as Job;
  }

  /** A reel of the client's own, not linked to anything. */
  function reel(shortcode: string, client = CLIENT, postedAt = POSTED_AT): void {
    const clientId = clientIdFor(client);
    const scan = instagram.startScan({ clientId, handle: 'northwind' });
    instagram.upsertReels(scan.id, [
      {
        shortcode,
        clientId,
        url: `https://www.instagram.com/reel/${shortcode}/`,
        postedAt: Date.parse(postedAt),
        caption: 'Spring menu is here',
        durationSec: 28.4,
        plays: 1200,
        likes: 90,
        comments: 4,
        shares: 7,
        sound: 'Original audio',
        hashtags: ['food'],
      },
    ]);
  }

  return { app, db, clock, jobs, deliveries, instagram, events, approved, delivered, reel };
}

type Setup = ReturnType<typeof setup>;

function send(app: Hono, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

const link = (t: Setup, shortcode: string, jobId: string) =>
  send(t.app, 'POST', `/api/instagram/reels/${shortcode}/link`, { jobId });
const unlink = (t: Setup, shortcode: string) =>
  send(t.app, 'DELETE', `/api/instagram/reels/${shortcode}/link`);

/** The job as the Jobs page reads it. */
function jobNow(t: Setup, id: string): Job {
  return t.jobs.get(id) as Job;
}

async function expectRefusal(
  res: Response,
  reason: InstagramLinkRefusalReason,
  status = 409,
): Promise<void> {
  expect(res.status).toBe(status);
  const body = instagramLinkRefusalSchema.parse(await res.json());
  expect(body).toEqual({ error: INSTAGRAM_LINK_MESSAGES[reason], reason });
}

describe('POST /api/instagram/reels/:shortcode/link', () => {
  it('links a delivered job and answers the reel as it is now', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');

    const res = await link(t, 'C-spring', job.id);

    expect(res.status).toBe(200);
    expect(instagramLinkResponseSchema.parse(await res.json())).toEqual({
      shortcode: 'C-spring',
      url: 'https://www.instagram.com/reel/C-spring/',
      postedAt: POSTED_AT,
      caption: 'Spring menu is here',
      durationSec: 28.4,
      plays: 1200,
      likes: 90,
      comments: 4,
      shares: 7,
      sound: 'Original audio',
      coauthors: [],
      hashtags: ['food'],
      pinned: false,
      paidPartnership: false,
      job: { id: job.id, name: 'Spring menu' },
      timesUsual: null,
    });
    expect(t.instagram.getReel('C-spring')).toMatchObject({
      jobId: job.id,
      linkedAt: t.clock().getTime(),
    });
  });

  it('turns the job Uploaded: its delivery gains the reel’s posted time and address', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');
    expect(jobStage(jobNow(t, job.id))).toBe('delivered');

    await link(t, 'C-spring', job.id);

    const after = jobNow(t, job.id);
    expect(jobStage(after)).toBe('uploaded');
    expect(after.delivery).toMatchObject({
      uploadedAt: POSTED_AT,
      reelUrl: 'https://www.instagram.com/reel/C-spring/',
    });
    // The job row did not change: only what its delivery shows.
    expect(after.updatedAt).toBe(job.updatedAt);
    expect(jobSchema.parse(after)).toEqual(after);
  });

  it('tells the job’s update (already Uploaded) and then the client’s Instagram', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');

    await link(t, 'C-spring', job.id);

    expect(t.events).toEqual([
      `job.upsert:${job.id}:${POSTED_AT}`,
      `client-instagram:${clientIdFor(CLIENT)}`,
    ]);
  });

  it('links a paid job, which stays Paid but now knows its reel', async () => {
    const t = setup();
    const job = t.delivered();
    t.deliveries.markPaid([job.id], '2026-10-22');
    t.reel('C-spring');

    const res = await link(t, 'C-spring', job.id);

    expect(res.status).toBe(200);
    const after = jobNow(t, job.id);
    expect(jobStage(after)).toBe('paid');
    expect(after.delivery?.uploadedAt).toBe(POSTED_AT);
  });

  it('links a collab reel to the job of the other client whose scan read it, and tells both pages', async () => {
    const t = setup();
    const job = t.delivered('Harbor day', OTHER_CLIENT);
    // The reel is Northwind's (its scan read it first); Harbor's scan read it too.
    t.reel('C-collab');
    const harbor = clientIdFor(OTHER_CLIENT);
    const scan = t.instagram.startScan({ clientId: harbor, handle: 'harbor' });
    t.instagram.addReelReads(scan.id, [
      { shortcode: 'C-collab', plays: 1300, likes: 90, comments: 4 },
    ]);

    const res = await link(t, 'C-collab', job.id);

    expect(res.status).toBe(200);
    expect(t.instagram.getReel('C-collab')?.jobId).toBe(job.id);
    expect(jobStage(jobNow(t, job.id))).toBe('uploaded');
    expect(t.events).toEqual([
      `job.upsert:${job.id}:${POSTED_AT}`,
      `client-instagram:${clientIdFor(CLIENT)}`,
      `client-instagram:${harbor}`,
    ]);
  });

  it('answers 200 and tells nobody when the pair is linked already', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');
    await link(t, 'C-spring', job.id);
    const linkedAt = t.instagram.getReel('C-spring')?.linkedAt;
    t.events.length = 0;
    t.clock.tick(60_000);

    const res = await link(t, 'C-spring', job.id);

    expect(res.status).toBe(200);
    expect(t.instagram.getReel('C-spring')?.linkedAt).toBe(linkedAt);
    expect(t.events).toEqual([]);
  });

  it('still answers when a listener throws, and logs it', async () => {
    const t = setup({ throwing: true });
    const job = t.delivered();
    t.reel('C-spring');

    const res = await link(t, 'C-spring', job.id);

    expect(res.status).toBe(200);
    expect(t.instagram.getReel('C-spring')?.jobId).toBe(job.id);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  describe('refuses with a 409, its reason and its words, and changes nothing', () => {
    it('no-reel: there is no such reel', async () => {
      const t = setup();
      const job = t.delivered();

      await expectRefusal(await link(t, 'C-nothing', job.id), 'no-reel');

      expect(jobNow(t, job.id).delivery?.uploadedAt).toBeUndefined();
      expect(t.events).toEqual([]);
    });

    it('not-this-client: the job is another client’s', async () => {
      const t = setup();
      const job = t.delivered('Harbor day', OTHER_CLIENT);
      t.reel('C-spring');

      await expectRefusal(await link(t, 'C-spring', job.id), 'not-this-client');

      expect(t.instagram.getReel('C-spring')?.jobId).toBeNull();
      expect(t.events).toEqual([]);
    });

    it('not-delivered: the job is approved but not marked delivered', async () => {
      const t = setup();
      const job = t.approved();
      t.reel('C-spring');

      await expectRefusal(await link(t, 'C-spring', job.id), 'not-delivered');

      expect(t.instagram.getReel('C-spring')?.jobId).toBeNull();
      expect(t.events).toEqual([]);
    });

    it('not-delivered: the job is not even approved yet', async () => {
      const t = setup();
      const { job } = t.jobs.upsertFromScan(makeScan(CLIENT, 'Autumn'));
      t.reel('C-spring');

      await expectRefusal(await link(t, 'C-spring', job.id), 'not-delivered');
    });

    it('reel-linked: the reel is linked to another job (unlink it first)', async () => {
      const t = setup();
      const first = t.delivered('Spring menu');
      const second = t.delivered('Summer menu');
      t.reel('C-spring');
      await link(t, 'C-spring', first.id);
      t.events.length = 0;

      await expectRefusal(await link(t, 'C-spring', second.id), 'reel-linked');

      expect(t.instagram.getReel('C-spring')?.jobId).toBe(first.id);
      expect(jobNow(t, second.id).delivery?.uploadedAt).toBeUndefined();
      expect(t.events).toEqual([]);
    });

    it('job-linked: another reel is linked to the job (one reel, one job)', async () => {
      const t = setup();
      const job = t.delivered();
      t.reel('C-spring');
      t.reel('C-other');
      await link(t, 'C-spring', job.id);
      t.events.length = 0;

      await expectRefusal(await link(t, 'C-other', job.id), 'job-linked');

      expect(t.instagram.getReel('C-other')?.jobId).toBeNull();
      expect(t.instagram.reelOfJob(job.id)?.shortcode).toBe('C-spring');
      expect(t.events).toEqual([]);
    });

    it('has a message for every reason the contract names', () => {
      for (const reason of INSTAGRAM_LINK_REFUSALS) {
        expect(INSTAGRAM_LINK_MESSAGES[reason]).not.toBe('');
      }
    });
  });

  it('says 404 for a job that does not exist', async () => {
    const t = setup();
    t.reel('C-spring');

    const res = await link(t, 'C-spring', 'nosuchjob');

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: 'Job nosuchjob not found' });
  });

  it('says 400 for a body that is not { jobId }', async () => {
    const t = setup();
    t.reel('C-spring');

    for (const body of [{}, { jobId: '' }, { jobId: 7 }, { job: 'x' }]) {
      const res = await send(t.app, 'POST', '/api/instagram/reels/C-spring/link', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(apiErrorSchema.parse(await res.json())).toEqual({
        error: INSTAGRAM_MESSAGES.linkBody,
      });
    }
    const noJson = await t.app.request('/api/instagram/reels/C-spring/link', {
      method: 'POST',
      body: 'jobId=x',
    });
    expect(noJson.status).toBe(400);
  });

  it('says the switch is off (404) when it is off', async () => {
    const t = setup({ off: true });

    const res = await link(t, 'C-spring', 'x');

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.off });
  });
});

describe('DELETE /api/instagram/reels/:shortcode/link', () => {
  it('unlinks the reel, which is theirs again, and the job is Delivered again', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');
    await link(t, 'C-spring', job.id);
    expect(jobStage(jobNow(t, job.id))).toBe('uploaded');

    const res = await unlink(t, 'C-spring');

    expect(res.status).toBe(200);
    const body = instagramLinkResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ shortcode: 'C-spring', job: null, timesUsual: null });
    expect(t.instagram.getReel('C-spring')).toMatchObject({ jobId: null, linkedAt: null });
    const after = jobNow(t, job.id);
    expect(jobStage(after)).toBe('delivered');
    expect(after.delivery).not.toHaveProperty('uploadedAt');
    expect(after.delivery).not.toHaveProperty('reelUrl');
  });

  it('tells the job’s update (no longer Uploaded) and then the client’s Instagram', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');
    await link(t, 'C-spring', job.id);
    t.events.length = 0;

    await unlink(t, 'C-spring');

    expect(t.events).toEqual([
      `job.upsert:${job.id}:no uploadedAt`,
      `client-instagram:${clientIdFor(CLIENT)}`,
    ]);
  });

  it('lets the job be linked to another reel afterwards', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');
    t.reel('C-other', CLIENT, '2026-10-21T08:00:00.000Z');
    await link(t, 'C-spring', job.id);
    await unlink(t, 'C-spring');

    const res = await link(t, 'C-other', job.id);

    expect(res.status).toBe(200);
    expect(jobNow(t, job.id).delivery?.uploadedAt).toBe('2026-10-21T08:00:00.000Z');
  });

  it('says 404 for a reel that is not linked, and changes nothing', async () => {
    const t = setup();
    t.reel('C-spring');

    const res = await unlink(t, 'C-spring');

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.notLinked });
    expect(t.events).toEqual([]);
  });

  it('says 404 no-reel for a reel that does not exist', async () => {
    const t = setup();

    await expectRefusal(await unlink(t, 'C-nothing'), 'no-reel', 404);
  });

  it('still answers when the job is gone (its folder was deleted)', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');
    await link(t, 'C-spring', job.id);
    t.jobs.remove(job.id);
    t.events.length = 0;

    const res = await unlink(t, 'C-spring');

    expect(res.status).toBe(200);
    expect(t.instagram.getReel('C-spring')?.jobId).toBeNull();
    // No job left to tell about: only the client's page changes.
    expect(t.events).toEqual([`client-instagram:${clientIdFor(CLIENT)}`]);
  });

  it('says the switch is off (404) when it is off', async () => {
    const t = setup({ off: true });

    const res = await unlink(t, 'C-spring');

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.off });
  });
});

describe('the Uploaded job on the Jobs routes', () => {
  it('refuses Not delivered yet while a reel links the job, and allows it after unlinking', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');
    await link(t, 'C-spring', job.id);

    const refused = await send(t.app, 'POST', `/api/jobs/${job.id}/undeliver`);

    expect(refused.status).toBe(409);
    expect(undeliverRefusedResponseSchema.parse(await refused.json())).toMatchObject({
      reason: 'uploaded',
    });
    expect(jobNow(t, job.id).delivery).not.toBeNull();

    await unlink(t, 'C-spring');
    const allowed = await send(t.app, 'POST', `/api/jobs/${job.id}/undeliver`);

    expect(allowed.status).toBe(200);
    expect(jobSchema.parse(await allowed.json()).delivery).toBeNull();
  });

  it('marks an Uploaded job paid, which then stays linked', async () => {
    const t = setup();
    const job = t.delivered();
    t.reel('C-spring');
    await link(t, 'C-spring', job.id);
    expect(jobStage(jobNow(t, job.id))).toBe('uploaded');

    const res = await send(t.app, 'POST', '/api/payments', {
      jobIds: [job.id],
      paidOn: '2026-10-23',
    });

    expect(res.status).toBe(200);
    const [paid] = paymentResponseSchema.parse(await res.json()).jobs;
    expect(paid && jobStage(paid)).toBe('paid');
    expect(paid?.delivery?.uploadedAt).toBe(POSTED_AT);
    expect(paid?.delivery?.reelUrl).toBe('https://www.instagram.com/reel/C-spring/');
    expect(t.instagram.getReel('C-spring')?.jobId).toBe(job.id);
  });
});
