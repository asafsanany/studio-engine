import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { NoteRepository } from './note-repository.js';

// Phase 3 W5: the review_notes migration adds the `review_notes` table and its index. These tests
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

/** The journal position of the review_notes migration: how many migrations come before it. */
const REVIEW_NOTES_INDEX = tags().findIndex((tag) => tag.endsWith('_review_notes'));

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

/** A database file as it was before review notes existed, with a job in review and a queued one. */
function seedBeforeReviewNotes(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(REVIEW_NOTES_INDEX) });
  try {
    const insert = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, step, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at, run_kind, "round",
         preview)
       values (@id, 'Northwind Bakery', @id, @relPath, @relPath, @state, @step,
         '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60, @now, @now, @now, @now, 'edit',
         @round, @preview)`,
    );
    for (const job of [
      {
        id: 'review0000',
        state: 'review',
        step: 7,
        round: 1,
        preview: '{"durationSec":28.4,"width":1080,"height":1920}',
      },
      { id: 'queued0000', state: 'queued', step: null, round: 0, preview: null },
    ]) {
      insert.run({ ...job, relPath: `Northwind Bakery/${job.id}`, now: NOW });
    }
  } finally {
    db.close();
  }
}

describe('migration review_notes', () => {
  it('comes after review_state', () => {
    const all = tags();
    expect(REVIEW_NOTES_INDEX).toBeGreaterThan(0);
    const reviewState = all.findIndex((tag) => tag.endsWith('_review_state'));
    expect(reviewState).toBeGreaterThanOrEqual(0);
    expect(reviewState).toBeLessThan(REVIEW_NOTES_INDEX);
  });

  it('is only the review_notes table and its index', () => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${tags()[REVIEW_NOTES_INDEX]}.sql`), 'utf8');
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql.match(/CREATE INDEX/g)).toHaveLength(1);
    expect(sql).not.toMatch(/ALTER TABLE|DROP |`jobs`|`step_runs`|`client_styles`/);
    expect(sql).toContain('CREATE TABLE `review_notes`');
    expect(sql).toContain('CREATE INDEX `review_notes_job_round_idx`');
  });

  it('adds the table with the columns of the plan', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReviewNotes(path);

    const db = track(openDatabase(path));

    expect(
      db.sqlite
        .prepare(
          `select name, type, [notnull] as required, dflt_value as dflt, pk
           from pragma_table_info('review_notes') order by cid`,
        )
        .all(),
    ).toEqual([
      { name: 'id', type: 'TEXT', required: 1, dflt: null, pk: 1 },
      { name: 'job_id', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'round', type: 'INTEGER', required: 0, dflt: null, pk: 0 },
      { name: 'at_sec', type: 'REAL', required: 1, dflt: null, pk: 0 },
      { name: 'kind', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'text', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'audio_file', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'audio_sec', type: 'REAL', required: 0, dflt: null, pk: 0 },
      { name: 'transcript_status', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'add_to_style', type: 'INTEGER', required: 1, dflt: 'false', pk: 0 },
      { name: 'created_at', type: 'INTEGER', required: 1, dflt: null, pk: 0 },
      { name: 'sent_at', type: 'INTEGER', required: 0, dflt: null, pk: 0 },
      // Added later, by 0011_series.
      { name: 'add_to_series', type: 'INTEGER', required: 1, dflt: 'false', pk: 0 },
      // Added later, by 0021_quick_fixes.
      { name: 'route_status', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'route_tier', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'route_kind', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'route_why', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'fix_id', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'fixed_at', type: 'INTEGER', required: 0, dflt: null, pk: 0 },
      // Added later, by 0024_note_format.
      { name: 'format', type: 'TEXT', required: 0, dflt: null, pk: 0 },
    ]);
  });

  it('indexes the job and round, and has no foreign key', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReviewNotes(path);

    const db = track(openDatabase(path));

    expect(
      db.sqlite
        .prepare("select name from pragma_index_info('review_notes_job_round_idx') order by seqno")
        .all(),
    ).toEqual([{ name: 'job_id' }, { name: 'round' }]);
    expect(
      db.sqlite.prepare("select * from pragma_foreign_key_list('review_notes')").all(),
    ).toEqual([]);
  });

  it('opens a database from before it: the jobs read back unchanged and the table is empty', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReviewNotes(path);

    const db = track(openDatabase(path));

    expect(db.sqlite.prepare('select count(*) as n from review_notes').get()).toEqual({ n: 0 });
    const jobs = new JobRepository(db).getAll();
    expect(jobs).toHaveLength(2);
    expect(new JobRepository(db).get('review0000')).toMatchObject({
      state: 'review',
      round: 1,
      preview: { durationSec: 28.4, width: 1080, height: 1920 },
    });
    expect(new JobRepository(db).get('queued0000')).toMatchObject({ state: 'queued', round: 0 });
  });

  it('runs once: opening the migrated database again keeps the notes saved', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReviewNotes(path);
    const first = openDatabase(path);
    new NoteRepository(first).create({
      id: 'n1',
      jobId: 'review0000',
      kind: 'text',
      atSec: 2.4,
      text: 'הכותרת יורדת מהר מדי.',
    });
    first.close();

    const db = track(openDatabase(path));

    expect(new NoteRepository(db).get('n1')).toMatchObject({
      jobId: 'review0000',
      text: 'הכותרת יורדת מהר מדי.',
    });
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: tags().length,
    });
  });
});
