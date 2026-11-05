import { EFFORT_LEVELS, type Job, jobSchema, REVISE_TIERS } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { JobNotFoundError, JobRepository } from './job-repository.js';
import { NoteRepository } from './note-repository.js';
import { QuickFixRepository } from './quick-fix-repository.js';
import { fakeClock, makeScan, memoryDb, rawRow, SAMPLE_PREVIEW } from './test-utils.js';

// QF0: the review effort (`jobs.review_effort`, null = Auto) and the revise tier of a Send with Auto
// (`jobs.revise_tier`) are saved with `setReviewEffort` and `setReviseTier`, and a job's quick fixes
// go with the job.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  return {
    clock,
    db,
    repo: new JobRepository(db, { clock }),
    notes: new NoteRepository(db, { clock }),
    fixes: new QuickFixRepository(db, { clock }),
  };
}

/** A job in review, through real events. */
function jobInReview(
  repo: JobRepository,
  clock: ReturnType<typeof fakeClock>,
  name = 'Review',
): string {
  const { job } = repo.upsertFromScan(makeScan('A', name));
  for (const event of [
    { type: 'SETTLED' },
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ] as const) {
    clock.tick();
    repo.applyTransition(job.id, event);
  }
  return job.id;
}

describe('the review effort and the revise tier of a new job', () => {
  it('are both null: Auto, and no Send with Auto yet', () => {
    const { repo } = setup();
    const { job } = repo.upsertFromScan(makeScan());

    expect(job.reviewEffort).toBeNull();
    expect(job.reviseTier).toBeNull();
    expect(repo.getAll()[0]).toMatchObject({ reviewEffort: null, reviseTier: null });
  });
});

describe('setReviewEffort', () => {
  it.each(EFFORT_LEVELS)('stores %s, returns the job and bumps updatedAt', (level) => {
    const { repo, clock } = setup();
    const id = jobInReview(repo, clock);
    const before = repo.get(id) as Job;
    clock.tick(5_000);

    const saved = repo.setReviewEffort(id, level);

    expect(saved.reviewEffort).toBe(level);
    expect(saved.updatedAt).toBe(clock().toISOString());
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    expect(repo.get(id)).toEqual(saved);
    expect(repo.getAll().find((job) => job.id === id)?.reviewEffort).toBe(level);
    expect(jobSchema.parse(saved)).toEqual(saved);
  });

  it('null puts the job back on Auto', () => {
    const { repo, clock } = setup();
    const id = jobInReview(repo, clock);
    repo.setReviewEffort(id, 'high');
    clock.tick();

    expect(repo.setReviewEffort(id, null).reviewEffort).toBeNull();
    expect(repo.get(id)?.reviewEffort).toBeNull();
  });

  it('leaves the effort of the first edit, the state and everything else alone', () => {
    const { repo, clock } = setup();
    const id = jobInReview(repo, clock);
    repo.setEffort(id, 'xhigh');
    clock.tick(5_000);
    const before = repo.get(id) as Job;

    const saved = repo.setReviewEffort(id, 'medium');

    expect(saved).toEqual({
      ...before,
      reviewEffort: 'medium',
      updatedAt: clock().toISOString(),
    });
    expect(saved).toMatchObject({ effort: 'xhigh', state: 'review', round: 0 });
    // And the other way round: the first edit's level does not move the review's.
    clock.tick();
    expect(repo.setEffort(id, 'high')).toMatchObject({ effort: 'high', reviewEffort: 'medium' });
  });

  it('survives a state change: Send keeps the level of the Review dialog', () => {
    const { repo, clock } = setup();
    const id = jobInReview(repo, clock);
    repo.setReviewEffort(id, 'high');
    clock.tick();

    const sent = repo.applyTransition(id, { type: 'SEND_NOTES' });

    expect(sent).toMatchObject({ state: 'queued', runKind: 'revise', reviewEffort: 'high' });
  });

  it('writes the column review_effort', () => {
    const { repo, clock, db } = setup();
    const id = jobInReview(repo, clock);
    repo.setReviewEffort(id, 'high');

    expect(rawRow(db, 'jobs', `id = '${id}'`)).toEqual([
      expect.objectContaining({ review_effort: 'high', revise_tier: null, effort: null }),
    ]);
  });

  it('throws JobNotFoundError for an unknown id and writes nothing', () => {
    const { repo, db } = setup();

    expect(() => repo.setReviewEffort('nope', 'high')).toThrow(JobNotFoundError);
    expect(rawRow(db, 'jobs')).toEqual([]);
  });
});

describe('setReviseTier', () => {
  it.each(REVISE_TIERS)('stores %s, returns the job and bumps updatedAt', (tier) => {
    const { repo, clock } = setup();
    const id = jobInReview(repo, clock);
    clock.tick(5_000);

    const saved = repo.setReviseTier(id, tier);

    expect(saved.reviseTier).toBe(tier);
    expect(saved.updatedAt).toBe(clock().toISOString());
    expect(repo.get(id)).toEqual(saved);
    expect(jobSchema.parse(saved)).toEqual(saved);
  });

  it('null clears it', () => {
    const { repo, clock } = setup();
    const id = jobInReview(repo, clock);
    repo.setReviseTier(id, 'full');
    clock.tick();

    expect(repo.setReviseTier(id, null).reviseTier).toBeNull();
    expect(repo.get(id)?.reviseTier).toBeNull();
  });

  it('leaves the review effort and the state alone, and the review effort leaves the tier alone', () => {
    const { repo, clock } = setup();
    const id = jobInReview(repo, clock);
    repo.setReviewEffort(id, null);
    clock.tick();

    expect(repo.setReviseTier(id, 'revise')).toMatchObject({
      reviseTier: 'revise',
      reviewEffort: null,
      state: 'review',
    });
    clock.tick();
    expect(repo.setReviewEffort(id, 'high')).toMatchObject({
      reviseTier: 'revise',
      reviewEffort: 'high',
    });
  });

  it('throws JobNotFoundError for an unknown id', () => {
    const { repo } = setup();

    expect(() => repo.setReviseTier('nope', 'full')).toThrow(JobNotFoundError);
  });
});

describe('a job’s quick fixes go with the job', () => {
  function withAFix() {
    const context = setup();
    const id = jobInReview(context.repo, context.clock, 'One');
    const other = jobInReview(context.repo, context.clock, 'Other');
    for (const jobId of [id, other]) {
      context.notes.create({ id: `n-${jobId}`, jobId, kind: 'text', atSec: 1, text: 'Heebo Bold' });
      context.fixes.insert({
        id: `f-${jobId}`,
        jobId,
        noteId: `n-${jobId}`,
        round: 1,
        status: 'fixed',
        step: null,
        stepLabel: null,
        said: 'Done.',
        why: null,
        model: 'sonnet',
        effort: 'medium',
        startedAt: '2026-10-25T09:00:00.000Z',
        endedAt: '2026-10-25T09:00:48.000Z',
        durationSec: 48,
        hasCompare: true,
      });
    }
    return { ...context, id, other };
  }

  it('remove deletes the fixes of the job and no other', () => {
    const { repo, fixes, id, other } = withAFix();

    expect(repo.remove(id)).toBe(true);

    expect(fixes.get(`f-${id}`)).toBeNull();
    expect(fixes.get(`f-${other}`)).not.toBeNull();
  });

  it('purge deletes them too', () => {
    const { repo, fixes, id, other } = withAFix();

    expect(repo.purge(id)).toBe(true);

    expect(fixes.get(`f-${id}`)).toBeNull();
    expect(fixes.get(`f-${other}`)).not.toBeNull();
  });
});
