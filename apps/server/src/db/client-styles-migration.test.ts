import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientStyleRepository } from './client-style-repository.js';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';

// CVP-109: migration 0004_client_styles adds the `client_styles` table. These tests build a
// database as it was before it (migrations 0000 to 0003 applied, jobs in it) and open it with the
// full set of migrations.

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

/** A database file as it was before client styles existed, with a queued and a held job. */
function seedBeforeClientStyles(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(4) });
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

describe('migration 0004_client_styles', () => {
  it('is the fifth migration', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).slice(0, 5)).toEqual([
      '0000_init',
      '0001_shift_steps',
      '0002_job_note',
      '0003_held_settled_at',
      '0004_client_styles',
    ]);
  });

  it('adds an empty client_styles table and keeps every job as it was', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeClientStyles(path);

    const db = track(openDatabase(path));

    expect(db.sqlite.prepare('select count(*) as n from client_styles').get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare('select id, state, settled_at from jobs order by id').all()).toEqual([
      { id: 'held0000', state: 'held', settled_at: null },
      { id: 'queued0000', state: 'queued', settled_at: NOW },
    ]);
  });

  it('gives the old jobs a client id, and leaves every client without a style', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeClientStyles(path);
    const db = track(openDatabase(path));

    const jobs = new JobRepository(db).getAll();
    const styles = new ClientStyleRepository(db);

    expect(jobs.map((job) => job.clientId)).toEqual(['1c9823704bf5', '1c9823704bf5']);
    expect(styles.get('1c9823704bf5')).toBeNull();
    expect(styles.list()).toEqual([]);
  });

  it('runs once: opening the migrated database again keeps what was saved', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeClientStyles(path);
    const first = openDatabase(path);
    new ClientStyleRepository(first).upsert({
      clientId: '1c9823704bf5',
      client: 'Northwind Bakery',
      state: 'ready',
      version: 1,
    });
    first.close();

    const db = track(openDatabase(path));

    expect(new ClientStyleRepository(db).get('1c9823704bf5')).toMatchObject({
      client: 'Northwind Bakery',
      state: 'ready',
      version: 1,
    });
    // Every migration ran once, whatever others are added after this one.
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: journal.entries.length,
    });
  });
});
