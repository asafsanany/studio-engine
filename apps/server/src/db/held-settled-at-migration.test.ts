import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { fakeClock } from './test-utils.js';

// CVP-140: migration 0003_held_settled_at adds the nullable `jobs.held_settled_at` column. These
// tests build a database as it was before it (migrations 0000 to 0002 applied, jobs in it) and
// open it with the full set of migrations.

const NOW = Date.parse('2026-10-20T13:45:00.000Z');

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

/** A database file as it was before the held place existed: a queued, a held and an arriving job. */
function seedBeforeHeldPlace(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(3) });
  try {
    const insert = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at)
       values (@id, 'Northwind Bakery', @id, @relPath, @relPath, @state,
         '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60, @now, @now, @now, @settledAt)`,
    );
    for (const [state, settledAt] of [
      ['queued', NOW],
      ['held', null],
      ['arriving', null],
    ] as const) {
      insert.run({
        id: `${state}0000`,
        relPath: `Northwind Bakery/${state}0000`,
        state,
        settledAt,
        now: NOW,
      });
    }
  } finally {
    db.close();
  }
}

describe('migration 0003_held_settled_at', () => {
  it('is the fourth migration', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).slice(0, 4)).toEqual([
      '0000_init',
      '0001_shift_steps',
      '0002_job_note',
      '0003_held_settled_at',
    ]);
  });

  it('adds a nullable held_settled_at column and keeps every job as it was', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeHeldPlace(path);

    const db = track(openDatabase(path));

    expect(
      db.sqlite
        .prepare(
          "select name, type, [notnull] as required from pragma_table_info('jobs') where name = 'held_settled_at'",
        )
        .all(),
    ).toEqual([{ name: 'held_settled_at', type: 'INTEGER', required: 0 }]);
    expect(
      db.sqlite
        .prepare('select id, state, settled_at, held_settled_at from jobs order by id')
        .all(),
    ).toEqual([
      { id: 'arriving0000', state: 'arriving', settled_at: null, held_settled_at: null },
      { id: 'held0000', state: 'held', settled_at: null, held_settled_at: null },
      { id: 'queued0000', state: 'queued', settled_at: NOW, held_settled_at: null },
    ]);
  });

  it('shows the old jobs with a null heldSettledAt, and a job held before it releases to the back', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeHeldPlace(path);
    const clock = fakeClock('2026-10-20T14:00:00.000Z');
    const repo = new JobRepository(track(openDatabase(path)), { clock });

    expect(repo.getAll().map((job) => job.heldSettledAt)).toEqual([null, null, null]);

    // No place was remembered for it, so even a release that restores it queues it at the back.
    const released = repo.applyTransition('held0000', { type: 'RELEASE', restorePlace: true });
    expect(released).toMatchObject({
      state: 'queued',
      settledAt: '2026-10-20T14:00:00.000Z',
      heldSettledAt: null,
      placeInLine: 2,
    });
    expect(repo.get('queued0000')?.placeInLine).toBe(1);
  });

  it('runs once: opening the migrated database again keeps what was saved', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeHeldPlace(path);
    const first = openDatabase(path);
    first.sqlite.prepare("update jobs set held_settled_at = 123 where id = 'held0000'").run();
    first.close();

    const db = track(openDatabase(path));
    expect(
      db.sqlite.prepare("select held_settled_at from jobs where id = 'held0000'").get(),
    ).toEqual({ held_settled_at: 123 });
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: migrationCount(),
    });
  });
});
