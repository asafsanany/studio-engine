import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEP_LABELS, type StepId, statusDetail } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { StepRunRepository } from './step-run-repository.js';

// CVP-99: Brief became step 1, so migration 0001_shift_steps adds one to every stored step id.
// These tests build a database at the 0000 schema (seven steps), put rows in it, and open it with
// the full set of migrations.

/** The step names at the 0000 schema: the label of old step `n` is `SEVEN_STEPS[n - 1]`. */
const SEVEN_STEPS = ['Transcribe', 'Scan', 'Plan', 'Cut', 'Preview', 'Check', 'Render'] as const;

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

/** A migrations folder holding only `0000_init`, the schema every database had before CVP-99. */
function schemaZeroFolder(): string {
  const folder = tempDir();
  mkdirSync(join(folder, 'meta'));
  copyFileSync(join(MIGRATIONS_FOLDER, '0000_init.sql'), join(folder, '0000_init.sql'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag === '0000_init');
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

interface OldJob {
  id: string;
  state: string;
  step: number | null;
  failedAt?: number | null;
  stoppedAt?: number | null;
  subProgress?: string | null;
  error?: string | null;
  output?: object | null;
}

const OLD_JOBS: OldJob[] = [
  { id: 'queued0000001', state: 'queued', step: null },
  { id: 'transcribe001', state: 'editing', step: 1, subProgress: '6/14' },
  { id: 'cut000000001', state: 'editing', step: 4, subProgress: 'graphics 2/5' },
  { id: 'failedplan001', state: 'failed', step: 3, failedAt: 3, error: 'plan broke' },
  { id: 'failedrender1', state: 'failed', step: 7, failedAt: 7, error: 'disk full' },
  { id: 'cancelled0001', state: 'cancelled', step: 5, stoppedAt: 5 },
  { id: 'ready00000001', state: 'ready', step: 7, output: OUTPUT },
];

/** A database file at the 0000 schema with `OLD_JOBS` and one finished run of every old step. */
function seedSchemaZero(path: string): void {
  const db = openDatabase(path, { migrationsFolder: schemaZeroFolder() });
  try {
    const insertJob = db.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, step, sub_progress, failed_at,
         error, stopped_at, inputs, size_bytes, footage_seconds, added_at, updated_at,
         last_change_at, settled_at, output)
       values (@id, 'Northwind Bakery', @id, @relPath, @relPath, @state, @step, @subProgress,
         @failedAt, @error, @stoppedAt, '{"video":2,"audio":0,"image":0,"doc":0}', 1000, 60,
         @now, @now, @now, @now, @output)`,
    );
    for (const job of OLD_JOBS) {
      insertJob.run({
        subProgress: null,
        failedAt: null,
        stoppedAt: null,
        error: null,
        ...job,
        output: job.output ? JSON.stringify(job.output) : null,
        relPath: `Northwind Bakery/${job.id}`,
        now: NOW,
      });
    }
    // Old step n took n * 10 seconds, for the job that is ready.
    const insertRun = db.sqlite.prepare(
      `insert into step_runs (job_id, step, started_at, ended_at, footage_seconds)
       values ('ready00000001', @step, @startedAt, @endedAt, 60)`,
    );
    for (let step = 1; step <= SEVEN_STEPS.length; step += 1) {
      insertRun.run({ step, startedAt: NOW, endedAt: NOW + step * 10_000 });
    }
    // A step still open when the engine died keeps its open state.
    db.sqlite
      .prepare(
        `insert into step_runs (job_id, step, started_at, footage_seconds)
         values ('cut000000001', 4, @startedAt, 60)`,
      )
      .run({ startedAt: NOW });
  } finally {
    db.close();
  }
}

describe('migration 0001_shift_steps', () => {
  it('is the second migration', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).slice(0, 2)).toEqual([
      '0000_init',
      '0001_shift_steps',
    ]);
  });

  it('moves every stored step up by one, and leaves empty steps empty', () => {
    const path = join(tempDir(), 'engine.db');
    seedSchemaZero(path);

    const db = track(openDatabase(path));
    const row = (id: string) =>
      db.sqlite
        .prepare('select step, failed_at, stopped_at, sub_progress from jobs where id = ?')
        .get(id);
    expect(row('queued0000001')).toEqual({
      step: null,
      failed_at: null,
      stopped_at: null,
      sub_progress: null,
    });
    expect(row('transcribe001')).toMatchObject({ step: 2, failed_at: null, stopped_at: null });
    expect(row('cut000000001')).toMatchObject({ step: 5, sub_progress: 'graphics 2/5' });
    expect(row('failedplan001')).toMatchObject({ step: 4, failed_at: 4, stopped_at: null });
    expect(row('failedrender1')).toMatchObject({ step: 8, failed_at: 8, stopped_at: null });
    expect(row('cancelled0001')).toMatchObject({ step: 6, failed_at: null, stopped_at: 6 });
    expect(row('ready00000001')).toMatchObject({ step: 8 });

    const runs = db.sqlite.prepare('select step from step_runs order by id').all() as {
      step: number;
    }[];
    expect(runs.map((run) => run.step)).toEqual([2, 3, 4, 5, 6, 7, 8, 5]);
  });

  it('keeps every job on the same named step (a job that failed at Render still says so)', () => {
    const path = join(tempDir(), 'engine.db');
    seedSchemaZero(path);

    const repo = new JobRepository(track(openDatabase(path)));
    for (const old of OLD_JOBS) {
      const job = repo.get(old.id);
      expect(job, old.id).not.toBeNull();
      const oldStep = old.step;
      if (oldStep === null) {
        expect(job?.step).toBeNull();
        continue;
      }
      expect(job?.step).toBe(oldStep + 1);
      expect(STEP_LABELS[job?.step as StepId], old.id).toBe(SEVEN_STEPS[oldStep - 1]);
    }
    expect(statusDetail(repo.get('failedrender1') as never, NOW)).toBe('at Render');
    expect(statusDetail(repo.get('failedplan001') as never, NOW)).toBe('at Plan');
    expect(statusDetail(repo.get('cancelled0001') as never, NOW)).toBe('at Preview');
  });

  it('keeps the ETA history of each named step: same durations, one number higher', () => {
    const path = join(tempDir(), 'engine.db');
    seedSchemaZero(path);

    const stepRuns = new StepRunRepository(track(openDatabase(path)));
    expect(stepRuns.recentDurations(1, 10, 'edit'), 'nothing was ever timed at Brief').toEqual([]);
    for (const [index, label] of SEVEN_STEPS.entries()) {
      const step = (index + 2) as StepId;
      expect(STEP_LABELS[step]).toBe(label);
      expect(stepRuns.recentDurations(step, 10, 'edit'), label).toEqual([
        { jobId: 'ready00000001', durationSec: (index + 1) * 10, footageSec: 60 },
      ]);
    }
    // The run that was open for Cut is still open, now as step 5.
    expect(stepRuns.openRunStartedAt('cut000000001', 5)?.getTime()).toBe(NOW);
    expect(stepRuns.openRunStartedAt('cut000000001', 4)).toBeNull();
  });

  it('runs once: opening the migrated database again shifts nothing', () => {
    const path = join(tempDir(), 'engine.db');
    seedSchemaZero(path);
    openDatabase(path).close();

    const db = track(openDatabase(path));
    const failed = db.sqlite
      .prepare("select step, failed_at from jobs where id = 'failedrender1'")
      .get();
    expect(failed).toEqual({ step: 8, failed_at: 8 });
    const applied = db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get();
    expect(applied).toEqual({ n: migrationCount() });
  });

  it('does nothing to an empty database but record itself', () => {
    const db = track(openDatabase(join(tempDir(), 'engine.db')));
    expect(db.sqlite.prepare('select count(*) as n from jobs').get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare('select count(*) as n from step_runs').get()).toEqual({ n: 0 });
  });
});
