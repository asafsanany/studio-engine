import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobSchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { fakeClock } from './test-utils.js';

// Phase 3 W1: the review_state migration adds jobs.run_kind, round, preview and approved_at, and
// step_runs.run_kind. These tests build a database as it was before it (every earlier migration
// applied, jobs in it) and open it with the full set of migrations. The migration is found by its
// tag, so they keep working when another migration (Phase 2's clients, say) lands before it.

const NOW = Date.parse('2026-10-20T13:45:00.000Z');
const OUTPUT = {
  fileName: 'Northwind Bakery/Spring menu.mp4',
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 65_011_712,
};

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

/** The journal position of the review_state migration: how many migrations come before it. */
const REVIEW_STATE_INDEX = tags().findIndex((tag) => tag.endsWith('_review_state'));

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

/**
 * A database file as it was before the review state: a ready job with its export, a job that
 * failed at Render, a job editing at Cut and a queued job, and one finished step run.
 */
function seedBeforeReview(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(REVIEW_STATE_INDEX) });
  try {
    const insert = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, step, failed_at, error,
         inputs, size_bytes, footage_seconds, added_at, updated_at, last_change_at, settled_at,
         started_at, finished_at, output, attempt)
       values (@id, 'Northwind Bakery', @id, @relPath, @relPath, @state, @step, @failedAt, @error,
         '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60, @now, @now, @now, @settledAt,
         @startedAt, @finishedAt, @output, @attempt)`,
    );
    const jobs = [
      {
        id: 'ready0000',
        state: 'ready',
        step: 8,
        failedAt: null,
        error: null,
        output: JSON.stringify(OUTPUT),
        attempt: 1,
        finished: true,
      },
      {
        id: 'failed0000',
        state: 'failed',
        step: 8,
        failedAt: 8,
        error: 'ffmpeg exited with code 1',
        output: null,
        attempt: 2,
        finished: true,
      },
      {
        id: 'editing0000',
        state: 'editing',
        step: 5,
        failedAt: null,
        error: null,
        output: null,
        attempt: 1,
        finished: false,
      },
      {
        id: 'queued0000',
        state: 'queued',
        step: null,
        failedAt: null,
        error: null,
        output: null,
        attempt: 1,
        finished: false,
      },
    ];
    for (const job of jobs) {
      insert.run({
        id: job.id,
        relPath: `Northwind Bakery/${job.id}`,
        state: job.state,
        step: job.step,
        failedAt: job.failedAt,
        error: job.error,
        settledAt: NOW,
        startedAt: job.state === 'queued' ? null : NOW,
        finishedAt: job.finished ? NOW : null,
        output: job.output,
        attempt: job.attempt,
        now: NOW,
      });
    }
    db.sqlite
      .prepare(
        `insert into step_runs (job_id, step, started_at, ended_at, footage_seconds)
         values ('ready0000', 5, @start, @end, 60)`,
      )
      .run({ start: NOW - 60_000, end: NOW });
  } finally {
    db.close();
  }
}

describe('migration review_state', () => {
  it('comes after 0003_held_settled_at', () => {
    const all = tags();
    expect(REVIEW_STATE_INDEX).toBeGreaterThanOrEqual(4);
    expect(all.slice(0, 4)).toEqual([
      '0000_init',
      '0001_shift_steps',
      '0002_job_note',
      '0003_held_settled_at',
    ]);
    expect(all.indexOf('0003_held_settled_at')).toBeLessThan(REVIEW_STATE_INDEX);
  });

  it('adds the run kind, round, preview and approval columns', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReview(path);

    const db = track(openDatabase(path));

    const columns = (table: string, names: string[]) =>
      db.sqlite
        .prepare(
          `select name, type, [notnull] as required, dflt_value as dflt
           from pragma_table_info('${table}') where name in (${names.map((n) => `'${n}'`).join(', ')})
           order by cid`,
        )
        .all();
    expect(columns('jobs', ['run_kind', 'round', 'preview', 'approved_at'])).toEqual([
      { name: 'run_kind', type: 'TEXT', required: 1, dflt: "'edit'" },
      { name: 'round', type: 'INTEGER', required: 1, dflt: '0' },
      { name: 'preview', type: 'TEXT', required: 0, dflt: null },
      { name: 'approved_at', type: 'INTEGER', required: 0, dflt: null },
    ]);
    expect(columns('step_runs', ['run_kind'])).toEqual([
      { name: 'run_kind', type: 'TEXT', required: 1, dflt: "'edit'" },
    ]);
  });

  it('shows every old job as an edit run in round 0 and keeps its other fields', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReview(path);
    const repo = new JobRepository(track(openDatabase(path)), {
      clock: fakeClock('2026-10-20T14:00:00.000Z'),
    });

    const jobs = repo.getAll();
    expect(jobs).toHaveLength(4);
    for (const job of jobs) {
      expect(job).toMatchObject({
        runKind: 'edit',
        round: 0,
        preview: null,
        approvedAt: null,
      });
      expect(jobSchema.safeParse(job).success, job.id).toBe(true);
    }
    expect(repo.get('ready0000')).toMatchObject({ state: 'ready', step: 8, output: OUTPUT });
    expect(repo.get('failed0000')).toMatchObject({
      state: 'failed',
      step: 8,
      failedAt: 8,
      error: 'ffmpeg exited with code 1',
    });
    expect(repo.get('editing0000')).toMatchObject({ state: 'editing', step: 5 });
    expect(repo.get('queued0000')).toMatchObject({ state: 'queued', step: null, placeInLine: 1 });
    expect(repo.getMeta('failed0000')?.attempt).toBe(2);
  });

  it('gives the old step runs the run kind edit', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReview(path);

    const db = track(openDatabase(path));

    expect(db.sqlite.prepare('select job_id, step, run_kind from step_runs').all()).toEqual([
      { job_id: 'ready0000', step: 5, run_kind: 'edit' },
    ]);
  });

  it('runs once: opening the migrated database again keeps what was saved', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeReview(path);
    const first = openDatabase(path);
    first.sqlite.prepare('update jobs set "round" = 2 where id = \'ready0000\'').run();
    first.close();

    const db = track(openDatabase(path));
    expect(db.sqlite.prepare('select "round" from jobs where id = \'ready0000\'').get()).toEqual({
      round: 2,
    });
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: tags().length,
    });
  });

  it('applies together with every older migration on a database from before them all', () => {
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
      db.sqlite
        .prepare('select step, note, run_kind, "round" from jobs where id = \'cut000000001\'')
        .get(),
    ).toEqual({ step: 5, note: null, run_kind: 'edit', round: 0 });
  });
});
