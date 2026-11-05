import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { fakeClock } from './test-utils.js';

// CVP-101: migration 0002_job_note adds the nullable `jobs.note` column. These tests build a
// database as it was before it (migrations 0000 and 0001 applied, jobs in it) and open it with
// the full set of migrations.

const NOW = Date.parse('2026-10-20T13:45:00.000Z');
const OUTPUT = {
  fileName: 'Northwind Bakery/Spring menu.mp4',
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 65_011_712,
};

const STATES = ['arriving', 'queued', 'held', 'editing', 'ready', 'failed', 'cancelled'] as const;

const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** How many migrations the real journal lists, so a later migration does not break this count. */
function migrationCount(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries.length;
}

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

const hasStep = (state: string) => ['editing', 'ready', 'failed'].includes(state);

/** A database file as it was before the note existed, with a job in every state. */
function seedBeforeNote(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(2) });
  try {
    const insert = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, step, failed_at, error,
         inputs, size_bytes, footage_seconds, added_at, updated_at, last_change_at, settled_at, output)
       values (@id, 'Northwind Bakery', @id, @relPath, @relPath, @state, @step, @failedAt, @error,
         '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60, @now, @now, @now, @settledAt, @output)`,
    );
    for (const state of STATES) {
      insert.run({
        id: `${state}0000`,
        relPath: `Northwind Bakery/${state}0000`,
        state,
        step: hasStep(state) ? 5 : null,
        failedAt: state === 'failed' ? 5 : null,
        error: state === 'failed' ? 'boom' : null,
        settledAt: state === 'arriving' || state === 'held' ? null : NOW,
        output: state === 'ready' ? JSON.stringify(OUTPUT) : null,
        now: NOW,
      });
    }
  } finally {
    db.close();
  }
}

describe('migration 0002_job_note', () => {
  it('is the third migration', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).slice(0, 3)).toEqual([
      '0000_init',
      '0001_shift_steps',
      '0002_job_note',
    ]);
  });

  it('adds a nullable note column to an existing database and keeps every job as it was', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeNote(path);

    const db = track(openDatabase(path));

    const column = db.sqlite
      .prepare(
        "select name, type, [notnull] as required from pragma_table_info('jobs') where name = 'note'",
      )
      .all();
    expect(column).toEqual([{ name: 'note', type: 'TEXT', required: 0 }]);
    const rows = db.sqlite
      .prepare('select id, state, step, failed_at, error, note from jobs order by id')
      .all();
    expect(rows).toHaveLength(STATES.length);
    for (const state of STATES) {
      expect(rows).toContainEqual({
        id: `${state}0000`,
        state,
        step: hasStep(state) ? 5 : null,
        failed_at: state === 'failed' ? 5 : null,
        error: state === 'failed' ? 'boom' : null,
        note: null,
      });
    }
  });

  it('shows the old jobs with a null note and lets the note be saved on them', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeNote(path);
    const clock = fakeClock('2026-10-20T14:00:00.000Z');
    const repo = new JobRepository(track(openDatabase(path)), { clock });

    expect(repo.getAll().map((job) => job.note)).toEqual(Array(STATES.length).fill(null));
    expect(repo.setNote('held0000', ' Keep it short ').note).toBe('Keep it short');
    expect(repo.get('held0000')?.note).toBe('Keep it short');
    expect(repo.get('queued0000')?.note).toBeNull();
  });

  it('runs once: opening the migrated database again keeps what was saved', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeNote(path);
    const first = openDatabase(path);
    first.sqlite.prepare("update jobs set note = 'Keep it short' where id = 'held0000'").run();
    first.close();

    const db = track(openDatabase(path));
    expect(db.sqlite.prepare("select note from jobs where id = 'held0000'").get()).toEqual({
      note: 'Keep it short',
    });
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: migrationCount(),
    });
  });

  it('applies together with 0001 on a database from before both', () => {
    const path = join(tempDir(), 'engine.db');
    const zero = openDatabase(path, { migrationsFolder: folderWithFirst(1) });
    zero.sqlite
      .prepare(
        `insert into jobs (id, client, name, rel_path, rel_key, state, step, inputs, size_bytes,
           footage_seconds, added_at, updated_at, last_change_at)
         values ('cut000000001', 'A', 'B', 'A/B', 'A/B', 'editing', 4,
           '{"video":1,"audio":0,"image":0,"doc":0}', 1, 1, 1, 1, 1)`,
      )
      .run();
    zero.close();

    const db = track(openDatabase(path));
    expect(
      db.sqlite.prepare("select step, note from jobs where id = 'cut000000001'").get(),
    ).toEqual({ step: 5, note: null });
  });
});
