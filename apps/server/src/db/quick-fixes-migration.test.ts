import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { NoteRepository } from './note-repository.js';
import { QuickFixRepository } from './quick-fix-repository.js';

// QF0: migration 0021_quick_fixes adds jobs.review_effort and jobs.revise_tier, the route and fix
// columns of review_notes and the quick_fixes table, and copies the effort of every job that is in
// review into review_effort (so a job that was set to High before Auto keeps High). These tests
// build a database as it was before it (jobs and a note in it) and open it with the full set of
// migrations.

const TAG = '0021_quick_fixes';
const NOW = Date.parse('2026-10-25T09:00:00.000Z');

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

function journalEntries(): { tag: string }[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries;
}

/** A migrations folder holding only the migrations before this one. */
function folderBeforeThis(): string {
  const folder = tempDir();
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(
    0,
    journalEntries().findIndex((entry) => entry.tag === TAG),
  );
  for (const entry of journal.entries as { tag: string }[]) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

/** The jobs of the tests: what state they are in and what effort the first edit was given. */
const JOBS = [
  { id: 'review-high', state: 'review', effort: 'high' },
  { id: 'review-xhigh', state: 'review', effort: 'xhigh' },
  { id: 'review-default', state: 'review', effort: null },
  { id: 'queued-medium', state: 'queued', effort: 'medium' },
  { id: 'editing-high', state: 'editing', effort: 'high' },
  { id: 'ready-xhigh', state: 'ready', effort: 'xhigh' },
  { id: 'failed-medium', state: 'failed', effort: 'medium' },
] as const;

function seedBeforeQuickFixes(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderBeforeThis() });
  try {
    const insert = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, effort)
       values (@id, 'Northwind Bakery', @id, @id, @id, @state,
         '{"video":1,"audio":0,"image":0,"doc":0}', 1000, 10, @at, @at, @at, @effort)`,
    );
    for (const job of JOBS) insert.run({ ...job, at: NOW });
    db.sqlite
      .prepare(
        `insert into review_notes (id, job_id, round, at_sec, kind, text, created_at, sent_at)
         values ('n-sent', 'review-high', 1, 2.4, 'text', 'The title goes too fast.', @at, @at),
                ('n-unsent', 'review-high', null, 5, 'text', 'Make the logo bigger.', @at, null)`,
      )
      .run({ at: NOW });
  } finally {
    db.close();
  }
}

function open(path: string): StudioDb {
  const db = openDatabase(path);
  opened.push(db);
  return db;
}

interface ColumnInfo {
  name: string;
  type: string;
  required: number;
  dflt: string | null;
  pk: number;
}

function columns(db: StudioDb, table: string): ColumnInfo[] {
  return db.sqlite
    .prepare(
      `select name, type, [notnull] as required, dflt_value as dflt, pk
       from pragma_table_info('${table}') order by cid`,
    )
    .all() as ColumnInfo[];
}

describe('migration 0021_quick_fixes', () => {
  it('follows the font request dismissal, and nothing else in the journal moved', () => {
    const tags = journalEntries().map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0020_font_request_dismissed') + 1);
  });

  it('adds nullable review_effort and revise_tier to jobs', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeQuickFixes(path);

    const db = open(path);

    const jobsColumns = columns(db, 'jobs');
    expect(jobsColumns.find((column) => column.name === 'review_effort')).toEqual({
      name: 'review_effort',
      type: 'TEXT',
      required: 0,
      dflt: null,
      pk: 0,
    });
    expect(jobsColumns.find((column) => column.name === 'revise_tier')).toEqual({
      name: 'revise_tier',
      type: 'TEXT',
      required: 0,
      dflt: null,
      pk: 0,
    });
    // The first edit's level is still there, alongside.
    expect(jobsColumns.map((column) => column.name)).toContain('effort');
  });

  it('adds the route and fix columns to review_notes, all nullable, and keeps every note as it was', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeQuickFixes(path);

    const db = open(path);

    const added = columns(db, 'review_notes').filter((column) =>
      ['route_status', 'route_tier', 'route_kind', 'route_why', 'fix_id', 'fixed_at'].includes(
        column.name,
      ),
    );
    expect(added).toEqual([
      { name: 'route_status', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'route_tier', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'route_kind', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'route_why', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'fix_id', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'fixed_at', type: 'INTEGER', required: 0, dflt: null, pk: 0 },
    ]);
    expect(
      db.sqlite
        .prepare(
          `select id, round, text, route_status, route_tier, route_kind, route_why, fix_id, fixed_at
           from review_notes order by id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'n-sent',
        round: 1,
        text: 'The title goes too fast.',
        route_status: null,
        route_tier: null,
        route_kind: null,
        route_why: null,
        fix_id: null,
        fixed_at: null,
      },
      {
        id: 'n-unsent',
        round: null,
        text: 'Make the logo bigger.',
        route_status: null,
        route_tier: null,
        route_kind: null,
        route_why: null,
        fix_id: null,
        fixed_at: null,
      },
    ]);
  });

  it('creates the quick_fixes table with the fields of the QuickFix contract, and its indexes', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeQuickFixes(path);

    const db = open(path);

    expect(columns(db, 'quick_fixes')).toEqual([
      { name: 'id', type: 'TEXT', required: 1, dflt: null, pk: 1 },
      { name: 'job_id', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'note_id', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'round', type: 'INTEGER', required: 1, dflt: null, pk: 0 },
      { name: 'status', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'step', type: 'INTEGER', required: 0, dflt: null, pk: 0 },
      { name: 'step_label', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'said', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'why', type: 'TEXT', required: 0, dflt: null, pk: 0 },
      { name: 'model', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'effort', type: 'TEXT', required: 1, dflt: null, pk: 0 },
      { name: 'started_at', type: 'INTEGER', required: 0, dflt: null, pk: 0 },
      { name: 'ended_at', type: 'INTEGER', required: 0, dflt: null, pk: 0 },
      { name: 'duration_sec', type: 'REAL', required: 0, dflt: null, pk: 0 },
      { name: 'has_compare', type: 'INTEGER', required: 1, dflt: 'false', pk: 0 },
    ]);
    expect(
      (db.sqlite.pragma('index_list(quick_fixes)') as { name: string }[])
        .map((index) => index.name)
        .filter((name) => !name.startsWith('sqlite_autoindex'))
        .sort(),
    ).toEqual(['quick_fixes_job_round_idx', 'quick_fixes_note_idx']);
    expect(db.sqlite.prepare('select count(*) as n from quick_fixes').get()).toEqual({ n: 0 });
    // No foreign key, like the other tables: a later rebuild of jobs must not cascade into it.
    expect(db.sqlite.pragma('foreign_key_list(quick_fixes)')).toEqual([]);
  });

  it('copies the effort of a job that is in review into review_effort, and of no other job', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeQuickFixes(path);

    const db = open(path);

    expect(
      db.sqlite
        .prepare('select id, effort, review_effort, revise_tier from jobs order by id')
        .all(),
    ).toEqual([
      { id: 'editing-high', effort: 'high', review_effort: null, revise_tier: null },
      { id: 'failed-medium', effort: 'medium', review_effort: null, revise_tier: null },
      { id: 'queued-medium', effort: 'medium', review_effort: null, revise_tier: null },
      { id: 'ready-xhigh', effort: 'xhigh', review_effort: null, revise_tier: null },
      { id: 'review-default', effort: null, review_effort: null, revise_tier: null },
      { id: 'review-high', effort: 'high', review_effort: 'high', revise_tier: null },
      { id: 'review-xhigh', effort: 'xhigh', review_effort: 'xhigh', revise_tier: null },
    ]);
  });

  it('shows the copied level as the job’s review effort, and a job on Default as Auto (null)', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeQuickFixes(path);
    const db = open(path);
    const jobs = new JobRepository(db);

    expect(jobs.get('review-high')).toMatchObject({ effort: 'high', reviewEffort: 'high' });
    expect(jobs.get('review-default')).toMatchObject({ effort: null, reviewEffort: null });
    expect(jobs.get('queued-medium')).toMatchObject({ effort: 'medium', reviewEffort: null });
    expect(jobs.get('review-high')?.reviseTier).toBeNull();
  });

  it('copies once: a job set back to Auto stays Auto when the database is opened again', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeQuickFixes(path);
    const first = open(path);
    new JobRepository(first).setReviewEffort('review-high', null);
    first.close();

    const second = open(path);

    expect(new JobRepository(second).get('review-high')).toMatchObject({
      effort: 'high',
      reviewEffort: null,
    });
  });

  it('leaves the old notes without a route or a fix, and the new repositories work on them', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeQuickFixes(path);
    const db = open(path);
    const notes = new NoteRepository(db);
    const fixes = new QuickFixRepository(db);

    expect(notes.get('n-unsent')).toMatchObject({
      routeStatus: null,
      route: null,
      fixId: null,
      fixedAt: null,
    });
    expect(notes.setRoute('n-unsent', { status: 'pending' })).toMatchObject({
      routeStatus: 'pending',
    });
    expect(fixes.listForRound('review-high', 2)).toEqual([]);
  });
});
