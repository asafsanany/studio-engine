import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { fakeClock, SAMPLE_PREVIEW } from './test-utils.js';

// CVP-149: migration 0008_review_sec adds `jobs.review_sec`, the seconds the owner spent in the Review
// dialog (default 0). These tests build a database as it was before it (migrations 0000 to 0007
// applied, jobs and a delivery in it) and open it with the full set of migrations.

const NOW = Date.parse('2026-10-21T10:00:00.000Z');

/** How many migrations the real journal lists, so a later migration does not break this count. */
function migrationCount(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries.length;
}

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

/** A database file as it was before review time existed: a job in review and a delivered one. */
function seedBeforeReviewTime(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(8) });
  try {
    const insert = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at, preview)
       values (@id, 'Northwind Bakery', @id, @relPath, @relPath, @state,
         '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60, @now, @now, @now, @now, @preview)`,
    );
    for (const state of ['review', 'ready'] as const) {
      insert.run({
        id: `${state}0000`,
        relPath: `Northwind Bakery/${state}0000`,
        state,
        now: NOW,
        preview: JSON.stringify(SAMPLE_PREVIEW),
      });
    }
    db.sqlite
      .prepare(
        `insert into deliveries (job_id, client_id, client, name, rel_path, delivered_at, price,
           currency, review_sec)
         values ('ready0000', 'c1', 'Northwind Bakery', 'ready0000', 'Northwind Bakery/ready0000',
           @now, 200, 'ILS', 0)`,
      )
      .run({ now: NOW });
  } finally {
    db.close();
  }
}

describe('migration 0008_review_sec', () => {
  it('follows 0007_deliveries', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).slice(7, 9)).toEqual([
      '0007_deliveries',
      '0008_review_sec',
    ]);
  });

  it('adds a review_sec column that is never null and starts at 0, for the jobs already there', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReviewTime(path);

    const db = track(openDatabase(path));

    expect(
      db.sqlite
        .prepare(
          "select name, type, [notnull] as required, dflt_value as dflt from pragma_table_info('jobs') where name = 'review_sec'",
        )
        .all(),
    ).toEqual([{ name: 'review_sec', type: 'INTEGER', required: 1, dflt: '0' }]);
    expect(db.sqlite.prepare('select id, state, review_sec from jobs order by id').all()).toEqual([
      { id: 'ready0000', state: 'ready', review_sec: 0 },
      { id: 'review0000', state: 'review', review_sec: 0 },
    ]);
  });

  it('leaves the deliveries as they were', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReviewTime(path);

    // Through 0008 only: the later 0009_paid_on deletes the deliveries recorded before it.
    const db = track(openDatabase(path, { migrationsFolder: folderWithFirst(9) }));

    expect(db.sqlite.prepare('select job_id, price, review_sec from deliveries').all()).toEqual([
      { job_id: 'ready0000', price: 200, review_sec: 0 },
    ]);
  });

  it('lets a job that was in review before it start counting', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReviewTime(path);
    const repo = new JobRepository(track(openDatabase(path)), { clock: fakeClock() });

    expect(repo.addReviewSec('review0000', 15)).toBe(15);
    expect(repo.getMeta('review0000')?.reviewSec).toBe(15);
    expect(repo.getMeta('ready0000')?.reviewSec).toBe(0);
  });

  it('runs once: opening the migrated database again keeps what was saved', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReviewTime(path);
    const first = openDatabase(path);
    first.sqlite.prepare("update jobs set review_sec = 123 where id = 'review0000'").run();
    first.close();

    const db = track(openDatabase(path));
    expect(db.sqlite.prepare("select review_sec from jobs where id = 'review0000'").get()).toEqual({
      review_sec: 123,
    });
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: migrationCount(),
    });
  });
});
