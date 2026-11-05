import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobStage } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { DeliveryRepository } from './delivery-repository.js';
import { JobRepository } from './job-repository.js';
import { SAMPLE_PREVIEW } from './test-utils.js';

// CVP-171: migration 0009_paid_on adds `deliveries.paid_on` (the day a delivery was paid) and
// deletes the deliveries recorded so far: they were written automatically when an export finished,
// at the old default price, so those jobs go back to Approved. These tests build a database as it
// was before it (migrations 0000 to 0008 applied, ready jobs with deliveries in it) and open it
// with the full set of migrations.

const NOW = Date.parse('2026-10-21T10:00:00.000Z');

/** How many migrations the real journal lists, so a later migration does not break this count. */
function migrationCount(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries.length;
}

function tags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries.map((entry: { tag: string }) => entry.tag);
}

const PAID_ON_INDEX = tags().indexOf('0009_paid_on');

const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-migration-'));
  dirs.push(dir);
  return dir;
}

function track(db: StudioDb): StudioDb {
  opened.push(db);
  return db;
}

/** A migrations folder holding only the first `count` migrations of the real one. */
function folderWithFirst(count: number): string {
  const folder = tempDir();
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, count);
  for (const entry of journal.entries as { tag: string }[]) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

/** A database file as it was before paid_on: two ready jobs with automatic deliveries, one in review. */
function seedBeforePaidOn(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(PAID_ON_INDEX) });
  try {
    const insert = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at, preview, output)
       values (@id, 'Northwind Bakery', @id, @relPath, @relPath, @state,
         '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60, @now, @now, @now, @now, @preview,
         @output)`,
    );
    for (const [id, state] of [
      ['ready0001', 'ready'],
      ['ready0002', 'ready'],
      ['review001', 'review'],
    ] as const) {
      insert.run({
        id,
        relPath: `Northwind Bakery/${id}`,
        state,
        now: NOW,
        preview: JSON.stringify(SAMPLE_PREVIEW),
        output:
          state === 'ready'
            ? JSON.stringify({
                fileName: `Northwind Bakery/${id}.mp4`,
                durationSec: 30,
                width: 1080,
                height: 1920,
                sizeBytes: 1000,
              })
            : null,
      });
    }
    const delivery = db.sqlite.prepare(
      `insert into deliveries (job_id, client_id, client, name, rel_path, delivered_at, price,
         currency, review_sec)
       values (@id, 'c1', 'Northwind Bakery', @id, @relPath, @now, 200, 'ILS', 30)`,
    );
    for (const id of ['ready0001', 'ready0002']) {
      delivery.run({ id, relPath: `Northwind Bakery/${id}`, now: NOW });
    }
  } finally {
    db.close();
  }
}

describe('migration 0009_paid_on', () => {
  it('follows 0008_review_sec', () => {
    expect(tags().slice(8, 10)).toEqual(['0008_review_sec', '0009_paid_on']);
  });

  it('is the paid_on column and the deletion of the deliveries, nothing else', () => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, '0009_paid_on.sql'), 'utf8');
    expect(sql).toContain('ALTER TABLE `deliveries` ADD `paid_on` text');
    expect(sql).toContain('DELETE FROM `deliveries`');
    expect(sql).not.toMatch(/DROP |CREATE |`jobs`|`step_runs`|`client_styles`|`review_notes`/);
  });

  it('adds a nullable paid_on column', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforePaidOn(path);

    const db = track(openDatabase(path));

    expect(
      db.sqlite
        .prepare(
          "select name, type, [notnull] as required, dflt_value as dflt from pragma_table_info('deliveries') where name = 'paid_on'",
        )
        .all(),
    ).toEqual([{ name: 'paid_on', type: 'TEXT', required: 0, dflt: null }]);
  });

  it('deletes every delivery recorded before it, and leaves the jobs as they were', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforePaidOn(path);

    const db = track(openDatabase(path));

    expect(db.sqlite.prepare('select count(*) as n from deliveries').get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare('select id, state from jobs order by id').all()).toEqual([
      { id: 'ready0001', state: 'ready' },
      { id: 'ready0002', state: 'ready' },
      { id: 'review001', state: 'review' },
    ]);
  });

  it('puts those ready jobs back to Approved: they are ready with no delivery', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforePaidOn(path);
    const jobs = new JobRepository(track(openDatabase(path)));

    const ready = jobs.getAll().filter((job) => job.state === 'ready');

    expect(ready).toHaveLength(2);
    expect(ready.map((job) => job.delivery)).toEqual([null, null]);
    expect(ready.map((job) => jobStage(job))).toEqual(['approved', 'approved']);
  });

  it('runs once: a delivery recorded afterwards survives the next boot, paid day included', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforePaidOn(path);
    const first = openDatabase(path);
    const deliveries = new DeliveryRepository(first);
    deliveries.record({
      jobId: 'ready0001',
      clientId: 'c1',
      client: 'Northwind Bakery',
      name: 'ready0001',
      relPath: 'Northwind Bakery/ready0001',
      deliveredAt: NOW,
      price: 40,
      currency: 'ILS',
    });
    deliveries.markPaid(['ready0001'], '2026-10-23');
    first.close();

    const db = track(openDatabase(path));

    expect(new DeliveryRepository(db).list()).toEqual([
      expect.objectContaining({ jobId: 'ready0001', price: 40, paidOn: '2026-10-23' }),
    ]);
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: migrationCount(),
    });
  });

  it('works on a database without deliveries too', () => {
    const db = track(openDatabase(':memory:'));

    expect(db.sqlite.prepare('select count(*) as n from deliveries').get()).toEqual({ n: 0 });
  });
});
