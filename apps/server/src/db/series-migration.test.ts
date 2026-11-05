import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { NoteRepository } from './note-repository.js';
import { SeriesRepository } from './series-repository.js';

// CVP-188 (K0): migration NNNN_series is the one series migration: the `series` table,
// `jobs.series_id`, `episode` and `series_pinned`, and `review_notes.add_to_series`. These tests
// build a database as it was before it (every earlier migration applied, a job with a note in it)
// and open it with the full set of migrations. They find it by its tag, so a renumbering on merge
// (another migration landing first) does not break them.

const NOW = Date.parse('2026-10-21T10:00:00.000Z');

function tags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries.map((entry: { tag: string }) => entry.tag);
}

const SERIES_TAG = tags().find((tag) => /^\d{4}_series$/.test(tag)) ?? 'missing';
const SERIES_INDEX = tags().indexOf(SERIES_TAG);

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

/** A database file as it was before series: one queued job with one note marked Add to style. */
function seedBeforeSeries(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(SERIES_INDEX) });
  try {
    db.sqlite
      .prepare(
        `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
           footage_seconds, added_at, updated_at, last_change_at, settled_at)
         values ('job000000001', 'Acme', 'Weekly 6', 'Acme/Weekly 6', 'Acme/Weekly 6', 'queued',
           '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60, @now, @now, @now, @now)`,
      )
      .run({ now: NOW });
    db.sqlite
      .prepare(
        `insert into review_notes (id, job_id, at_sec, kind, text, add_to_style, created_at)
         values ('n1', 'job000000001', 1.5, 'text', 'Slower', 1, @now)`,
      )
      .run({ now: NOW });
  } finally {
    db.close();
  }
}

function columns(db: StudioDb, table: string, names: readonly string[]) {
  return db.sqlite
    .prepare(
      `select name, type, [notnull] as required, dflt_value as dflt
       from pragma_table_info('${table}') order by cid`,
    )
    .all()
    .filter((column) => names.includes((column as { name: string }).name));
}

describe('migration NNNN_series', () => {
  it('comes after 0009_paid_on', () => {
    expect(SERIES_INDEX).toBeGreaterThan(tags().indexOf('0009_paid_on'));
    expect(tags().indexOf('0009_paid_on')).toBeGreaterThan(0);
  });

  it('is the series table and the new columns, nothing dropped or rebuilt', () => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${SERIES_TAG}.sql`), 'utf8');
    expect(sql).toContain('CREATE TABLE `series`');
    expect(sql).toContain('ALTER TABLE `jobs` ADD `series_id` text');
    expect(sql).toContain('ALTER TABLE `jobs` ADD `episode` integer');
    expect(sql).toContain('ALTER TABLE `jobs` ADD `series_pinned` integer DEFAULT false NOT NULL');
    expect(sql).toContain(
      'ALTER TABLE `review_notes` ADD `add_to_series` integer DEFAULT false NOT NULL',
    );
    expect(sql).not.toMatch(/DROP |__new_|DELETE /);
  });

  it('adds the columns of the plan', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeSeries(path);
    const db = track(openDatabase(path));

    expect(columns(db, 'jobs', ['series_id', 'episode', 'series_pinned'])).toEqual([
      { name: 'series_id', type: 'TEXT', required: 0, dflt: null },
      { name: 'episode', type: 'INTEGER', required: 0, dflt: null },
      { name: 'series_pinned', type: 'INTEGER', required: 1, dflt: 'false' },
    ]);
    expect(columns(db, 'review_notes', ['add_to_series'])).toEqual([
      { name: 'add_to_series', type: 'INTEGER', required: 1, dflt: 'false' },
    ]);
    expect(
      db.sqlite
        .prepare("select name from pragma_table_info('series') order by cid")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual([
      'id',
      'client_id',
      'client',
      'name',
      'name_key',
      'format_job_id',
      'format_job',
      'state',
      'error',
      'version',
      'last_pass',
      'created_at',
      'updated_at',
      // Added later, by 0014_series_waiting_notes (C26).
      'waiting_notes',
    ]);
  });

  it('keeps the jobs and notes there were: in no series, not pinned, not marked Series', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeSeries(path);
    const db = track(openDatabase(path));
    const jobs = new JobRepository(db);

    expect(jobs.get('job000000001')).toMatchObject({
      state: 'queued',
      name: 'Weekly 6',
      seriesId: null,
      episode: null,
    });
    expect(jobs.getMeta('job000000001')?.seriesPinned).toBe(false);
    expect(new NoteRepository(db).get('n1')).toMatchObject({
      addToStyle: true,
      addToSeries: false,
    });
    expect(new SeriesRepository(db).list()).toEqual([]);
  });

  it('allows one series per name and client, whatever its case', () => {
    const db = track(openDatabase(':memory:'));
    const insert = db.sqlite.prepare(
      `insert into series (id, client_id, client, name, name_key, format_job_id, format_job, state,
         created_at, updated_at)
       values (@id, @clientId, 'Acme', @name, @key, 'j1', 'Weekly 5', 'learning', 1, 1)`,
    );
    insert.run({ id: 's1', clientId: 'c1', name: 'Weekly', key: 'weekly' });
    insert.run({ id: 's2', clientId: 'c2', name: 'Weekly', key: 'weekly' });
    expect(() => insert.run({ id: 's3', clientId: 'c1', name: 'WEEKLY', key: 'weekly' })).toThrow(
      /UNIQUE/,
    );
  });
});
