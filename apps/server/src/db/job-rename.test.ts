import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { GenerateRepository } from './generate-repository.js';
import { JobNotFoundError, JobRenameConflictError, JobRepository } from './job-repository.js';
import { StepRunRepository } from './step-run-repository.js';
import { fakeClock, idFor, makeScan, memoryDb, rawRow } from './test-utils.js';

// JobRepository.rename: a new name is a new id, and every row about the job follows it.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup(withSeries = false) {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock, generate: true });
  const { job } = jobs.upsertFromScan(makeScan('Pinewood', 'Ad 6'));
  const other = jobs.upsertFromScan(makeScan('Pinewood', 'Ad 7')).job;
  if (withSeries) jobs.setSeries(job.id, { seriesId: 's1', episode: 6, pinned: false });
  return { db, jobs, clock, job, other };
}

function renameTo(name: string) {
  const relPath = `Pinewood/${name}`;
  return { name, relPath, newId: idFor(relPath), output: null };
}

describe('JobRepository.rename', () => {
  it('moves the job’s row to the new name, path and id and leaves its place in the list', () => {
    const { jobs, job } = setup();

    const renamed = jobs.rename(job.id, renameTo('Ad 8'));

    expect(renamed).toMatchObject({
      id: idFor('Pinewood/Ad 8'),
      name: 'Ad 8',
      relPath: 'Pinewood/Ad 8',
      client: 'Pinewood',
      updatedAt: job.updatedAt,
      addedAt: job.addedAt,
      state: job.state,
    });
    expect(jobs.get(job.id)).toBeNull();
    expect(jobs.getByRelPath('Pinewood/Ad 8')?.id).toBe(renamed.id);
    expect(jobs.getByRelPath('Pinewood/Ad 6')).toBeNull();
  });

  it('rewrites the names of the export files it is given', () => {
    const { jobs, job } = setup();
    const output = {
      fileName: 'Pinewood/Ad 8.mp4',
      durationSec: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 5,
    };

    const renamed = jobs.rename(job.id, { ...renameTo('Ad 8'), output });

    expect(renamed.output).toEqual(output);
  });

  it('moves every row about the job to the new id', () => {
    const { db, jobs, job } = setup();
    const steps = new StepRunRepository(db, { clock: fakeClock() });
    steps.start(job.id, 2);
    new GenerateRepository(db, { clock: fakeClock() }).start(job.id, 3);
    const insert = (sql: string, ...values: unknown[]) => db.sqlite.prepare(sql).run(...values);
    insert(
      "insert into review_notes (id, job_id, at_sec, kind, created_at) values ('n1', ?, 1.5, 'text', 1)",
      job.id,
    );
    insert(
      "insert into quick_fixes (id, job_id, note_id, round, status, model, effort) values ('f1', ?, 'n1', 1, 'fixed', 'sonnet', 'high')",
      job.id,
    );
    insert(
      "insert into graphic_uses (graphic_id, job_id, version, at) values ('g1', ?, 1, 1)",
      job.id,
    );
    insert("insert into lut_uses (lut_key, job_id, round, at) values ('l1', ?, 0, 1)", job.id);
    insert(
      "insert into font_uses (id, family, weight, italic, job_id, round, source, at) values ('u1', 'Heebo', 700, 0, ?, 0, 'token', 1)",
      job.id,
    );
    insert(
      "insert into font_requests (id, name, job_id, round, at) values ('r1', 'Rubik', ?, 1, 1)",
      job.id,
    );
    insert(
      "insert into deliveries (job_id, client_id, client, name, rel_path, delivered_at, price, paid_on) values (?, 'c1', 'Pinewood', 'Ad 6', 'Pinewood/Ad 6', 1, 40, '2026-10-20')",
      job.id,
    );
    insert(
      "insert into client_styles (client_id, client, updated_at, source_job_id) values ('c1', 'Pinewood', 1, ?)",
      job.id,
    );
    insert(
      "insert into series (id, client_id, client, name, name_key, format_job_id, format_job, state, created_at, updated_at, waiting_notes) values ('s1', 'c1', 'Pinewood', 'Ad', 'ad', ?, 'Ad 6', 'ready', 1, 1, ?)",
      job.id,
      JSON.stringify([{ jobId: job.id, name: 'notes.md', size: 4 }]),
    );

    const { id } = jobs.rename(job.id, renameTo('Ad 8'));

    const mine = `job_id = '${id}'`;
    const old = `job_id = '${job.id}'`;
    for (const table of [
      'step_runs',
      'job_generate',
      'review_notes',
      'quick_fixes',
      'graphic_uses',
      'lut_uses',
      'font_uses',
      'font_requests',
      'deliveries',
    ] as const) {
      expect(rawRow(db, table, mine).length, table).toBe(1);
      expect(rawRow(db, table, old).length, table).toBe(0);
    }
    expect(rawRow(db, 'deliveries', mine)).toMatchObject([
      { name: 'Ad 8', rel_path: 'Pinewood/Ad 8', price: 40, paid_on: '2026-10-20' },
    ]);
    expect(jobs.get(id)?.delivery).toMatchObject({ paidOn: '2026-10-20' });
    expect(db.sqlite.prepare('select source_job_id from client_styles').get()).toEqual({
      source_job_id: id,
    });
    const series = db.sqlite
      .prepare('select format_job_id, format_job, waiting_notes from series')
      .get() as { format_job_id: string; format_job: string; waiting_notes: string };
    expect(series.format_job_id).toBe(id);
    expect(series.format_job).toBe('Ad 8');
    expect(JSON.parse(series.waiting_notes)).toEqual([{ jobId: id, name: 'notes.md', size: 4 }]);
  });

  it('leaves the other jobs’ rows alone', () => {
    const { db, jobs, job, other } = setup();
    new StepRunRepository(db, { clock: fakeClock() }).start(other.id, 2);

    jobs.rename(job.id, renameTo('Ad 8'));

    expect(rawRow(db, 'step_runs', `job_id = '${other.id}'`).length).toBe(1);
    expect(jobs.get(other.id)?.name).toBe('Ad 7');
  });

  it('reads an episode’s number again from the new name', () => {
    const { jobs, job } = setup(true);

    expect(jobs.get(job.id)?.episode).toBe(6);
    const renamed = jobs.rename(job.id, renameTo('Ad 9'));

    expect(renamed.seriesId).toBe('s1');
    expect(renamed.episode).toBe(9);
  });

  it('gives a job outside a series no episode', () => {
    const { jobs, job } = setup();

    expect(jobs.rename(job.id, renameTo('Ad 9')).episode).toBeNull();
  });

  it('refuses a name another job has, and an unknown job, and changes nothing', () => {
    const { db, jobs, job, other } = setup();
    new StepRunRepository(db, { clock: fakeClock() }).start(job.id, 2);

    expect(() => jobs.rename(job.id, renameTo('Ad 7'))).toThrow(JobRenameConflictError);
    expect(() => jobs.rename('nope', renameTo('Ad 8'))).toThrow(JobNotFoundError);

    expect(jobs.get(job.id)?.name).toBe('Ad 6');
    expect(jobs.get(other.id)?.name).toBe('Ad 7');
    expect(rawRow(db, 'step_runs', `job_id = '${job.id}'`).length).toBe(1);
  });
});
