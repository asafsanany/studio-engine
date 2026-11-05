import { generateStateSchema, jobSchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { GenerateRepository } from './generate-repository.js';
import { JobRepository } from './job-repository.js';
import { fakeClock, makeScan, memoryDb, rawRow } from './test-utils.js';

// Generated videos, GN0: a job with a Generate stage carries `generate` when it is read, only while
// the Generate switch is on; any other job's shape is what it always was.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup(generate: boolean) {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock, generate });
  const generated = new GenerateRepository(db, { clock });
  const withRow = jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad')).job;
  const without = jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo 2')).job;
  generated.start(withRow.id, 3);
  generated.update(withRow.id, { phase: 'voice', voice: { done: 3, total: 7 } });
  return { db, jobs, generated, withRow, without };
}

describe('Job.generate', () => {
  it('is the job’s Generate state while the switch is on, on get, getAll and getByRelPath', () => {
    const { jobs, withRow } = setup(true);

    const state = jobs.get(withRow.id)?.generate;

    expect(state).toEqual({
      phase: 'voice',
      counts: {
        voice: { done: 3, total: 7 },
        looks: { done: 0, total: 0 },
        keyframes: { done: 0, total: 0 },
        clips: { done: 0, total: 0 },
        belowBar: 0,
      },
      spendUsd: 0,
      budgetUsd: 3,
    });
    expect(generateStateSchema.safeParse(state).success).toBe(true);
    expect(jobs.getAll().find((job) => job.id === withRow.id)?.generate).toEqual(state);
    expect(jobs.getByRelPath(withRow.relPath)?.generate).toEqual(state);
    expect(jobSchema.safeParse(jobs.get(withRow.id)).success).toBe(true);
  });

  it('is absent, not null, for a job without a row: its shape is what it always was', () => {
    const { jobs, without } = setup(true);
    expect(jobs.get(without.id)).not.toHaveProperty('generate');
  });

  it('is absent for every job while the switch is off, whatever the table holds', () => {
    const { jobs, withRow, without, db } = setup(false);
    expect(rawRow(db, 'job_generate')).toHaveLength(1);
    expect(jobs.get(withRow.id)).not.toHaveProperty('generate');
    expect(jobs.get(without.id)).not.toHaveProperty('generate');
    for (const job of jobs.getAll()) expect(job).not.toHaveProperty('generate');
  });

  it('follows the row as the run moves on', () => {
    const { jobs, generated, withRow } = setup(true);
    generated.update(withRow.id, { phase: 'clips', clips: { done: 4, total: 6 } });
    generated.addSpend(withRow.id, 1.65);
    expect(jobs.get(withRow.id)?.generate).toMatchObject({
      phase: 'clips',
      counts: { clips: { done: 4, total: 6 } },
      spendUsd: 1.65,
    });
  });

  it('does not change what a transition stores: the job saves and reads back the same', () => {
    const { jobs, withRow } = setup(true);
    const before = jobs.get(withRow.id);
    const after = jobs.applyTransition(withRow.id, { type: 'SETTLED' });
    expect(after.generate).toEqual(before?.generate);
    expect(jobs.get(withRow.id)?.generate).toEqual(before?.generate);
  });

  it('goes with the job: remove and purge delete the row', () => {
    const removed = setup(true);
    expect(removed.jobs.remove(removed.withRow.id)).toBe(true);
    expect(rawRow(removed.db, 'job_generate')).toEqual([]);

    const purged = setup(true);
    expect(purged.jobs.purge(purged.withRow.id)).toBe(true);
    expect(rawRow(purged.db, 'job_generate')).toEqual([]);
  });

  it('leaves the row of another job alone when one is removed', () => {
    const { jobs, generated, withRow, without } = setup(true);
    generated.start(without.id, 3);
    jobs.remove(withRow.id);
    expect(generated.get(without.id)).not.toBeNull();
    expect(generated.get(withRow.id)).toBeNull();
  });
});
