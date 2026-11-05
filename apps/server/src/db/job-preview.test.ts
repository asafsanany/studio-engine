import { type Job, jobSchema } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { JobNotFoundError, JobRepository } from './job-repository.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from './test-utils.js';

// CVP-327 (VE1): `setPreview` saves the preview of the job's live composition after Restore puts an
// earlier version back.

const EARLIER = { durationSec: 12, width: 1080, height: 1080 };

function reviewJob() {
  const clock = fakeClock();
  const repo = new JobRepository(memoryDb(), { clock });
  const { job } = repo.upsertFromScan(makeScan());
  for (const event of [
    { type: 'SETTLED' },
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ] as const) {
    clock.tick();
    repo.applyTransition(job.id, event);
  }
  return { repo, clock, id: job.id };
}

describe('setPreview', () => {
  it('stores the preview in the existing column, returns the job and moves updatedAt', () => {
    const { repo, clock, id } = reviewJob();
    const before = repo.get(id) as Job;
    clock.tick(5_000);

    const saved = repo.setPreview(id, EARLIER);

    expect(jobSchema.parse(saved).preview).toEqual(EARLIER);
    expect(repo.get(id)?.preview).toEqual(EARLIER);
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  it('changes nothing else: state, round and the run it came from', () => {
    const { repo, id } = reviewJob();
    const before = repo.get(id) as Job;

    const saved = repo.setPreview(id, EARLIER);

    expect({ ...saved, preview: null, updatedAt: '' }).toEqual({
      ...before,
      preview: null,
      updatedAt: '',
    });
  });

  it('throws JobNotFoundError for an unknown id', () => {
    const { repo } = reviewJob();

    expect(() => repo.setPreview('nope', EARLIER)).toThrow(JobNotFoundError);
  });
});
