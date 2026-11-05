import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, rawRow } from '../db/test-utils.js';
import { createRecordDelivery } from '../deliveries/deliveries.js';
import type { ActionWorker } from './jobs.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// DELETE /api/jobs/:id: the job, its folder, export, log and every row about it are gone.

const opened: StudioDb[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(
  options: {
    stopMusic?: (id: string) => Promise<void>;
    stopFixes?: (id: string) => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'studio-delete-'));
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
  const cancelled: string[] = [];
  const worker: ActionWorker = {
    cancel: async (id) => {
      cancelled.push(id);
      return null;
    },
    notify: () => {},
  };
  const removed: string[] = [];
  const money = { changed: 0 };
  const app = createApp({
    jobs: {
      jobs,
      worker,
      exportsDir,
      inboxPath,
      logsDir,
      ...(options.stopMusic === undefined ? {} : { stopMusic: options.stopMusic }),
      ...(options.stopFixes === undefined ? {} : { stopFixes: options.stopFixes }),
      onJobRemoved: (id) => removed.push(id),
      onMoneyChanged: () => {
        money.changed += 1;
      },
    },
  });

  /** A paid, delivered job with a folder, an export and a log on disk. */
  async function seedPaid(): Promise<Job> {
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    jobs.applyTransition(job.id, { type: 'START' });
    const ready = jobs.applyTransition(job.id, {
      type: 'SUCCEED',
      output: {
        fileName: 'Northwind Bakery/Spring menu.mp4',
        durationSec: 30,
        width: 1080,
        height: 1920,
        sizeBytes: 1,
      },
    });
    recordDelivery(ready);
    deliveries.markPaid([job.id], '2026-10-20');
    await mkdir(join(inboxPath, 'Northwind Bakery', 'Spring menu', 'edit'), { recursive: true });
    await writeFile(join(inboxPath, 'Northwind Bakery', 'Spring menu', 'raw.mp4'), 'x');
    await mkdir(join(exportsDir, 'Northwind Bakery'), { recursive: true });
    await writeFile(join(exportsDir, 'Northwind Bakery', 'Spring menu.mp4'), 'x');
    await mkdir(join(logsDir, 'jobs'), { recursive: true });
    await writeFile(join(logsDir, 'jobs', `${job.id}.log`), 'x');
    return jobs.get(job.id) as Job;
  }

  return { app, db, jobs, seedPaid, inboxPath, exportsDir, logsDir, cancelled, removed, money };
}

describe('DELETE /api/jobs/:id', () => {
  it('deletes the job, its folder, export, log, delivery and payment', async () => {
    const t = await setup();
    const job = await t.seedPaid();

    const res = await t.app.request(`/api/jobs/${job.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: job.id });
    expect(t.jobs.get(job.id)).toBeNull();
    for (const table of ['jobs', 'deliveries', 'step_runs', 'review_notes'] as const) {
      expect(rawRow(t.db, table).length).toBe(0);
    }
    expect(existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))).toBe(false);
    expect(existsSync(join(t.exportsDir, 'Northwind Bakery', 'Spring menu.mp4'))).toBe(false);
    expect(existsSync(join(t.logsDir, 'jobs', `${job.id}.log`))).toBe(false);
    expect(t.cancelled).toEqual([job.id]);
    expect(t.removed).toEqual([job.id]);
    expect(t.money.changed).toBe(1);
  });

  it('stops what the engine runs for the job’s music before anything goes, and deletes anyway if it cannot', async () => {
    for (const stopMusic of [
      async () => {},
      async () => {
        throw new Error('no process');
      },
    ]) {
      const order: string[] = [];
      const t = await setup({
        stopMusic: async (id) => {
          order.push(`stop-music ${id}`);
          order.push(
            `folder-exists ${existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))}`,
          );
          await stopMusic();
        },
      });
      const job = await t.seedPaid();

      const res = await t.app.request(`/api/jobs/${job.id}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(order).toEqual([`stop-music ${job.id}`, 'folder-exists true']);
      expect(t.jobs.get(job.id)).toBeNull();
      expect(existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))).toBe(false);
    }
  });

  it('stops the job’s quick fixes before anything goes, and deletes anyway if it cannot', async () => {
    for (const stopFixes of [
      async () => {},
      async () => {
        throw new Error('no copy');
      },
    ]) {
      const order: string[] = [];
      const t = await setup({
        stopFixes: async (id) => {
          order.push(`stop-fixes ${id}`);
          order.push(
            `folder-exists ${existsSync(join(t.inboxPath, 'Northwind Bakery', 'Spring menu'))}`,
          );
          await stopFixes();
        },
      });
      const job = await t.seedPaid();

      const res = await t.app.request(`/api/jobs/${job.id}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(order).toEqual([`stop-fixes ${job.id}`, 'folder-exists true']);
      expect(t.jobs.get(job.id)).toBeNull();
    }
  });

  it('deletes a delivery whose job and folder are already gone', async () => {
    const t = await setup();
    const job = await t.seedPaid();
    t.jobs.remove(job.id);

    const res = await t.app.request(`/api/jobs/${job.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(rawRow(t.db, 'deliveries').length).toBe(0);
  });

  it('answers 404 for an unknown job and touches nothing', async () => {
    const t = await setup();
    const job = await t.seedPaid();

    const res = await t.app.request('/api/jobs/nope', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(t.jobs.get(job.id)).not.toBeNull();
    expect(t.removed).toEqual([]);
  });
});
