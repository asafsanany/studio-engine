import { describe, expect, it } from 'vitest';
import { JobRepository } from '../db/job-repository.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { runModeFor } from './run-mode.js';

describe('runModeFor', () => {
  it('is start for a job that has never run', () => {
    expect(runModeFor({ step: null }, { attempt: 1 })).toBe('start');
  });

  it('is start for a job with no step even if its attempt counter is higher', () => {
    expect(runModeFor({ step: null }, { attempt: 3 })).toBe('start');
  });

  it('is retry for a job that ran and was retried', () => {
    expect(runModeFor({ step: 4 }, { attempt: 2 })).toBe('retry');
    expect(runModeFor({ step: 8 }, { attempt: 5 })).toBe('retry');
  });

  it('is resume for a job that ran, was cancelled and never retried', () => {
    expect(runModeFor({ step: 4 }, { attempt: 1 })).toBe('resume');
  });

  it('calls a retried job that was later cancelled and resumed retry (the documented limit)', () => {
    // RETRY and RESUME leave the same state apart from `attempt`, so this case cannot be told
    // from a plain retry. Both carry on from the existing workspace.
    expect(runModeFor({ step: 5 }, { attempt: 2 })).toBe('retry');
  });
});

// Walks a job through a real repository, so the answer comes from what is stored.
describe('runModeFor across run kinds', () => {
  function setup() {
    const clock = fakeClock();
    const repo = new JobRepository(memoryDb(), { clock });
    const { job } = repo.upsertFromScan(makeScan());
    const apply = (...events: Parameters<JobRepository['applyTransition']>[1][]) => {
      for (const event of events) {
        clock.tick();
        repo.applyTransition(job.id, event);
      }
    };
    const mode = () => {
      const current = repo.get(job.id);
      const meta = repo.getMeta(job.id);
      if (current === null || meta === null) throw new Error('job is gone');
      return runModeFor(current, meta);
    };
    return { repo, apply, mode, id: job.id };
  }

  const TO_REVIEW = [
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ] as const;

  it('is start for a revise run queued by SEND_NOTES, even after the edit was retried twice', () => {
    const { apply, mode, repo, id } = setup();
    apply(
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'FAIL', step: 5, error: 'boom' },
      { type: 'RETRY' },
      { type: 'START' },
      { type: 'FAIL', step: 5, error: 'boom' },
      { type: 'RETRY' },
      ...TO_REVIEW,
    );
    expect(repo.getMeta(id)?.attempt).toBe(3);

    apply({ type: 'SEND_NOTES' });

    expect(repo.get(id)).toMatchObject({ state: 'queued', runKind: 'revise', step: null });
    expect(mode()).toBe('start');
  });

  it('is retry for that revise run when it failed at Preview and was retried', () => {
    const { apply, mode, repo, id } = setup();
    apply({ type: 'SETTLED' }, ...TO_REVIEW, { type: 'SEND_NOTES' }, { type: 'START' });
    apply({ type: 'FAIL', step: 6, error: 'boom' }, { type: 'RETRY' });

    expect(repo.get(id)).toMatchObject({ state: 'queued', runKind: 'revise', step: 6 });
    expect(mode()).toBe('retry');
  });

  it('is start for a render run queued by APPROVE', () => {
    const { apply, mode, repo, id } = setup();
    apply({ type: 'SETTLED' }, ...TO_REVIEW, { type: 'APPROVE' });

    expect(repo.get(id)).toMatchObject({ state: 'queued', runKind: 'render', step: null });
    expect(mode()).toBe('start');
  });

  it('is resume for that render run when it was cancelled at Render and resumed', () => {
    const { apply, mode, repo, id } = setup();
    apply({ type: 'SETTLED' }, ...TO_REVIEW, { type: 'APPROVE' }, { type: 'START' });
    apply({ type: 'CANCEL' }, { type: 'RESUME' });

    expect(repo.get(id)).toMatchObject({ state: 'queued', runKind: 'render', step: 8 });
    expect(mode()).toBe('resume');
  });
});
