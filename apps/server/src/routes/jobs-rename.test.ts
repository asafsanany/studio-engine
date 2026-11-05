import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, idFor, makeScan, memoryDb } from '../db/test-utils.js';
import { createRecordDelivery } from '../deliveries/deliveries.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// PUT /api/jobs/:id/name: the job's folder, exports and rows move to the new name.

const opened: StudioDb[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(options: { inUse?: () => string | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-rename-'));
  temps.push(root);
  const inboxPath = join(root, 'inbox');
  const exportsDir = join(inboxPath, '_Exports');
  const logsDir = join(root, 'logs');
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const recordDelivery = createRecordDelivery({
    deliveries,
    jobs,
    priceFor: () => ({ price: 40, currency: 'ILS' }),
    clock,
  });
  const removed: string[] = [];
  const changed: Job[] = [];
  const money = { changed: 0 };
  const app = createApp({
    jobs: {
      jobs,
      exportsDir,
      inboxPath,
      logsDir,
      ...(options.inUse === undefined ? {} : { inUse: options.inUse }),
      onJobChanged: (job) => changed.push(job),
      onJobRemoved: (id) => removed.push(id),
      onMoneyChanged: () => {
        money.changed += 1;
      },
    },
  });

  /** A ready job, delivered and paid when `paid`, with a folder, an export and a log on disk. */
  async function seedReady(name = 'Spring menu', paid = true): Promise<Job> {
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', name));
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    jobs.applyTransition(job.id, { type: 'START' });
    const ready = jobs.applyTransition(job.id, {
      type: 'SUCCEED',
      output: {
        fileName: `Northwind Bakery/${name}.mp4`,
        durationSec: 30,
        width: 1080,
        height: 1920,
        sizeBytes: 1,
      },
    });
    if (paid) {
      recordDelivery(ready);
      deliveries.markPaid([job.id], '2026-10-20');
    }
    await mkdir(join(inboxPath, 'Northwind Bakery', name, 'edit'), { recursive: true });
    await writeFile(join(inboxPath, 'Northwind Bakery', name, 'raw.mp4'), 'raw');
    await mkdir(join(exportsDir, 'Northwind Bakery'), { recursive: true });
    await writeFile(join(exportsDir, 'Northwind Bakery', `${name}.mp4`), 'export');
    await mkdir(join(logsDir, 'jobs'), { recursive: true });
    await writeFile(join(logsDir, 'jobs', `${job.id}.log`), 'log');
    return jobs.get(job.id) as Job;
  }

  function rename(id: string, name: unknown) {
    return app.request(`/api/jobs/${id}/name`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  return {
    app,
    db,
    jobs,
    seedReady,
    rename,
    inboxPath,
    exportsDir,
    logsDir,
    removed,
    changed,
    money,
  };
}

describe('PUT /api/jobs/:id/name', () => {
  it('moves the folder, the export and the log, and keeps the delivery and the payment', async () => {
    const t = await setup();
    const job = await t.seedReady();
    const newId = idFor('Northwind Bakery/Summer menu');

    const res = await t.rename(job.id, 'Summer menu');

    expect(res.status).toBe(200);
    const renamed = (await res.json()) as Job;
    expect(renamed.id).toBe(newId);
    expect(renamed.name).toBe('Summer menu');
    expect(renamed.relPath).toBe('Northwind Bakery/Summer menu');
    expect(renamed.output?.fileName).toBe('Northwind Bakery/Summer menu.mp4');
    expect(renamed.delivery?.paidOn).toBe('2026-10-20');
    expect(renamed.state).toBe('ready');
    expect(t.jobs.get(job.id)).toBeNull();
    expect(t.jobs.get(newId)?.name).toBe('Summer menu');

    const folder = join(t.inboxPath, 'Northwind Bakery');
    expect(existsSync(join(folder, 'Spring menu'))).toBe(false);
    expect(await readFile(join(folder, 'Summer menu', 'raw.mp4'), 'utf8')).toBe('raw');
    expect(existsSync(join(t.exportsDir, 'Northwind Bakery', 'Spring menu.mp4'))).toBe(false);
    expect(await readFile(join(t.exportsDir, 'Northwind Bakery', 'Summer menu.mp4'), 'utf8')).toBe(
      'export',
    );
    expect(existsSync(join(t.logsDir, 'jobs', `${job.id}.log`))).toBe(false);
    expect(await readFile(join(t.logsDir, 'jobs', `${newId}.log`), 'utf8')).toBe('log');

    expect(t.removed).toEqual([job.id]);
    expect(t.changed.map((changed) => changed.id)).toEqual([newId]);
    expect(t.money.changed).toBe(1);
  });

  it('keeps the job’s place in the list: its updatedAt does not change', async () => {
    const t = await setup();
    const job = await t.seedReady('Spring menu', false);

    const res = await t.rename(job.id, 'Summer menu');

    expect(((await res.json()) as Job).updatedAt).toBe(job.updatedAt);
    expect(t.money.changed).toBe(0);
  });

  it('trims the name and answers a name that is already the job’s as it is', async () => {
    const t = await setup();
    const job = await t.seedReady();

    const same = await t.rename(job.id, '  Spring menu ');

    expect(same.status).toBe(200);
    expect(((await same.json()) as Job).id).toBe(job.id);
    expect(t.removed).toEqual([]);
    expect(existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))).toBe(true);

    const res = await t.rename(job.id, '  Summer menu ');
    expect(((await res.json()) as Job).name).toBe('Summer menu');
  });

  it('renames a folder to the same name in other letters', async () => {
    const t = await setup();
    const job = await t.seedReady();

    const res = await t.rename(job.id, 'SPRING MENU');

    expect(res.status).toBe(200);
    expect(((await res.json()) as Job).name).toBe('SPRING MENU');
    expect(t.jobs.get(job.id)).toBeNull();
  });

  it('names a Hebrew job in the export too', async () => {
    const t = await setup();
    const job = await t.seedReady();

    const res = await t.rename(job.id, 'מיתוס או אמת 7');

    expect(res.status).toBe(200);
    expect(existsSync(join(t.exportsDir, 'Northwind Bakery', 'מיתוס או אמת 7.mp4'))).toBe(true);
    expect(((await res.json()) as Job).output?.fileName).toBe(
      'Northwind Bakery/מיתוס או אמת 7.mp4',
    );
  });

  it('refuses a name a folder cannot have', async () => {
    const t = await setup();
    const job = await t.seedReady();

    for (const name of ['', '   ', 'a/b', 'a:b', '.hidden', '_Style', '_series', 'x'.repeat(121)]) {
      const res = await t.rename(job.id, name);
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { error: string }).error).toEqual(expect.any(String));
    }
    const noString = await t.rename(job.id, 7);
    expect(noString.status).toBe(400);
    expect(existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))).toBe(true);
    expect(t.jobs.get(job.id)?.name).toBe('Spring menu');
  });

  it('answers 404 for an unknown job', async () => {
    const t = await setup();

    const res = await t.rename('nope', 'Summer menu');

    expect(res.status).toBe(404);
  });

  it('answers 409 while the job is arriving, queued or editing', async () => {
    const t = await setup();
    const { job } = t.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Fresh'));
    await mkdir(join(t.inboxPath, 'Northwind Bakery', 'Fresh'), { recursive: true });

    const arriving = await t.rename(job.id, 'Fresh 2');
    expect(arriving.status).toBe(409);

    t.jobs.applyTransition(job.id, { type: 'SETTLED' });
    expect((await t.rename(job.id, 'Fresh 2')).status).toBe(409);

    t.jobs.applyTransition(job.id, { type: 'START' });
    expect((await t.rename(job.id, 'Fresh 2')).status).toBe(409);
    expect(existsSync(join(t.inboxPath, 'Northwind Bakery', 'Fresh'))).toBe(true);
  });

  it('answers 409 and changes nothing while the engine works in the folder', async () => {
    const t = await setup({ inUse: () => 'A quick fix is running. Wait for it to finish.' });
    const job = await t.seedReady();

    const res = await t.rename(job.id, 'Summer menu');

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'A quick fix is running. Wait for it to finish.',
    );
    expect(t.jobs.get(job.id)?.name).toBe('Spring menu');
    expect(existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))).toBe(true);
  });

  it('answers 409 when the client already has a video of that name, in the list or on disk', async () => {
    const t = await setup();
    const job = await t.seedReady();
    await t.seedReady('Summer menu', false);

    const inList = await t.rename(job.id, 'Summer menu');
    expect(inList.status).toBe(409);

    await mkdir(join(t.inboxPath, 'Northwind Bakery', 'On disk only'), { recursive: true });
    const onDisk = await t.rename(job.id, 'On disk only');
    expect(onDisk.status).toBe(409);

    expect(existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))).toBe(true);
    expect(t.jobs.get(job.id)?.name).toBe('Spring menu');
  });

  it('answers 409 and moves nothing when an export of the new name is already there', async () => {
    const t = await setup();
    const job = await t.seedReady();
    await writeFile(join(t.exportsDir, 'Northwind Bakery', 'Summer menu.mp4'), 'someone else’s');

    const res = await t.rename(job.id, 'Summer menu');

    expect(res.status).toBe(409);
    expect(existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))).toBe(true);
    expect(existsSync(join(t.exportsDir, 'Northwind Bakery', 'Spring menu.mp4'))).toBe(true);
    expect(await readFile(join(t.exportsDir, 'Northwind Bakery', 'Summer menu.mp4'), 'utf8')).toBe(
      'someone else’s',
    );
  });

  it('renames a job whose folder or export is missing without failing', async () => {
    const t = await setup();
    const job = await t.seedReady('Spring menu', false);
    await rm(join(t.exportsDir, 'Northwind Bakery', 'Spring menu.mp4'));

    const res = await t.rename(job.id, 'Summer menu');

    expect(res.status).toBe(200);
    expect(((await res.json()) as Job).output?.fileName).toBe('Northwind Bakery/Summer menu.mp4');
  });
});
