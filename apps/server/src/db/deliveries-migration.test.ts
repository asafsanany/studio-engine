import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { DeliveryRepository } from './delivery-repository.js';
import { JobRepository } from './job-repository.js';

// Phase 4 M1: the deliveries migration adds the `deliveries` table and its index. These tests
// build a database as it was before it (every earlier migration applied, jobs in it) and open it
// with the full set of migrations. The migration is found by its tag, so they keep working when
// another migration lands after it.

const NOW = Date.parse('2026-10-20T13:45:00.000Z');

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

function tags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries.map((entry: { tag: string }) => entry.tag);
}

/** The journal position of the deliveries migration: how many migrations come before it. */
const DELIVERIES_INDEX = tags().findIndex((tag) => tag.endsWith('_deliveries'));

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

/** A database file as it was before deliveries existed, with a finished job and a queued one. */
function seedBeforeDeliveries(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(DELIVERIES_INDEX) });
  try {
    const insert = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, step, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at, finished_at, run_kind,
         "round")
       values (@id, 'Northwind Bakery', @id, @relPath, @relPath, @state, @step,
         '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60, @now, @now, @now, @now, @finishedAt,
         'edit', 0)`,
    );
    for (const job of [
      { id: 'ready00000', state: 'ready', step: 8, finishedAt: NOW },
      { id: 'queued0000', state: 'queued', step: null, finishedAt: null },
    ]) {
      insert.run({ ...job, relPath: `Northwind Bakery/${job.id}`, now: NOW });
    }
  } finally {
    db.close();
  }
}

describe('migration deliveries', () => {
  it('comes after review_notes', () => {
    const all = tags();
    expect(DELIVERIES_INDEX).toBeGreaterThan(0);
    const reviewNotes = all.findIndex((tag) => tag.endsWith('_review_notes'));
    expect(reviewNotes).toBeGreaterThanOrEqual(0);
    expect(reviewNotes).toBeLessThan(DELIVERIES_INDEX);
  });

  it('is only the deliveries table and its index', () => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${tags()[DELIVERIES_INDEX]}.sql`), 'utf8');
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql.match(/CREATE INDEX/g)).toHaveLength(1);
    expect(sql).not.toMatch(
      /ALTER TABLE|DROP |`jobs`|`step_runs`|`client_styles`|`review_notes`|REFERENCES/,
    );
    expect(sql).toContain('CREATE TABLE `deliveries`');
    expect(sql).toContain('CREATE INDEX `deliveries_delivered_at_idx`');
  });

  it('adds the table with the columns of the plan', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeDeliveries(path);

    const db = track(openDatabase(path));

    expect(
      db.sqlite
        .prepare(
          `select name, type, [notnull] as required, dflt_value as dflt, pk
           from pragma_table_info('deliveries') order by cid`,
        )
        .all(),
    ).toEqual([
      { name: 'job_id', type: 'TEXT', required: 1, dflt: null, pk: 1 },
      { name: 'client_id', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'client', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'name', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'rel_path', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'delivered_at', type: 'INTEGER', required: 1, dflt: null, pk: 0 },
      { name: 'price', type: 'REAL', required: 1, dflt: null, pk: 0 },
      { name: 'currency', type: 'TEXT', required: 1, dflt: "'ILS'", pk: 0 },
      { name: 'review_sec', type: 'INTEGER', required: 1, dflt: '0', pk: 0 },
      // Added by 0009_paid_on, which the full set of migrations includes.
      { name: 'paid_on', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      // Added by 0025_paid_amount.
      { name: 'paid_amount', type: 'REAL', required: 0, dflt: null, pk: 0 },
    ]);
  });

  it('indexes the delivery time, and has no foreign key', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeDeliveries(path);

    const db = track(openDatabase(path));

    expect(
      db.sqlite
        .prepare("select name from pragma_index_info('deliveries_delivered_at_idx') order by seqno")
        .all(),
    ).toEqual([{ name: 'delivered_at' }]);
    expect(db.sqlite.prepare("select * from pragma_foreign_key_list('deliveries')").all()).toEqual(
      [],
    );
  });

  it('opens a database from before it: the jobs read back unchanged and the table is empty', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeDeliveries(path);

    const db = track(openDatabase(path));

    expect(db.sqlite.prepare('select count(*) as n from deliveries').get()).toEqual({ n: 0 });
    const jobs = new JobRepository(db);
    expect(jobs.getAll()).toHaveLength(2);
    expect(jobs.get('ready00000')).toMatchObject({ state: 'ready', step: 8 });
    expect(jobs.get('queued0000')).toMatchObject({ state: 'queued' });
  });

  it('defaults the currency to ILS and the review time to 0', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeDeliveries(path);
    const db = track(openDatabase(path));

    db.sqlite
      .prepare(
        `insert into deliveries (job_id, client_id, client, name, rel_path, delivered_at, price)
         values ('ready00000', 'client000001', 'Northwind Bakery', 'ready00000',
           'Northwind Bakery/ready00000', ${NOW}, 200)`,
      )
      .run();

    expect(new DeliveryRepository(db).get('ready00000')).toMatchObject({
      currency: 'ILS',
      reviewSec: 0,
      price: 200,
    });
  });

  it('runs once: opening the migrated database again keeps the deliveries saved', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeDeliveries(path);
    const first = openDatabase(path);
    new DeliveryRepository(first).record({
      jobId: 'ready00000',
      clientId: 'client000001',
      client: 'Northwind Bakery',
      name: 'ready00000',
      relPath: 'Northwind Bakery/ready00000',
      deliveredAt: NOW,
      price: 200,
      currency: 'ILS',
    });
    first.close();

    const db = track(openDatabase(path));

    expect(new DeliveryRepository(db).get('ready00000')).toMatchObject({
      deliveredAt: NOW,
      price: 200,
    });
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: tags().length,
    });
  });
});
