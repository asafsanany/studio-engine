import type { QuickFix } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { NoteRepository } from './note-repository.js';
import { NO_FIX_SUMMARY, QuickFixRepository } from './quick-fix-repository.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from './test-utils.js';

// C57: the Jobs list says "Review · fixing a note at 0:12…" and "Review · cut 2 · 1 fixed here", so a
// job in Review carries `fixing` (the time of the note being fixed) and `fixedCount` (the notes fixed
// in the round being written), read from `quick_fixes` whenever the job is read, and only while the
// Quick fixes switch is on (the `quickFixes` option of the repository).

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
    jobs: new JobRepository(db, { clock, quickFixes: true }),
    jobsOff: new JobRepository(db, { clock }),
    notes: new NoteRepository(db, { clock }),
    fixes: new QuickFixRepository(db, { clock }),
  };
}

type Harness = ReturnType<typeof setup>;

/** A job in Review, through real events; `rounds` Send-notes rounds have gone by. */
function jobInReview(h: Harness, name = 'Review', rounds = 0): string {
  const { job } = h.jobs.upsertFromScan(makeScan('A', name));
  const path = [
    { type: 'SETTLED' },
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ] as const;
  for (const event of path) {
    h.clock.tick();
    h.jobs.applyTransition(job.id, event);
  }
  for (let round = 0; round < rounds; round += 1) {
    for (const event of [{ type: 'SEND_NOTES' }, { type: 'START' }, path[2]] as const) {
      h.clock.tick();
      h.jobs.applyTransition(job.id, event);
    }
  }
  return job.id;
}

let noteCount = 0;

/** A note of the job at `atSec` with a fix in `status` for `round` (the job's round + 1 by default). */
function fix(
  h: Harness,
  jobId: string,
  atSec: number,
  status: QuickFix['status'],
  round = 1,
): QuickFix {
  noteCount += 1;
  const note = h.notes.create({
    id: `note-${noteCount}`,
    jobId,
    kind: 'text',
    atSec,
    text: `note at ${atSec}`,
  });
  return h.fixes.insert({
    id: `fix-${noteCount}`,
    jobId,
    noteId: note.id,
    round,
    status,
    step: null,
    stepLabel: null,
    said: null,
    why: null,
    model: 'sonnet',
    effort: 'medium',
    startedAt: null,
    endedAt: null,
    durationSec: null,
    hasCompare: false,
  });
}

describe('Job.fixing and Job.fixedCount', () => {
  it('are null and 0 for a job in Review with no fixes', () => {
    const h = setup();
    const id = jobInReview(h);

    expect(h.jobs.get(id)).toMatchObject({ fixing: null, fixedCount: 0 });
  });

  it('give the time of the note whose fix is running', () => {
    const h = setup();
    const id = jobInReview(h);
    fix(h, id, 12.9, 'running');

    expect(h.jobs.get(id)).toMatchObject({ fixing: { atSec: 12.9 }, fixedCount: 0 });
    expect(h.jobs.getAll().find((job) => job.id === id)).toMatchObject({
      fixing: { atSec: 12.9 },
    });
  });

  it('count a queued fix that is next in line as being fixed, behind the one that runs', () => {
    const h = setup();
    const id = jobInReview(h);
    fix(h, id, 30, 'queued');
    expect(h.jobs.get(id)?.fixing).toEqual({ atSec: 30 });

    fix(h, id, 5, 'queued');
    // Two queued: the one queued first is next.
    expect(h.jobs.get(id)?.fixing).toEqual({ atSec: 30 });

    fix(h, id, 21, 'running');
    expect(h.jobs.get(id)?.fixing).toEqual({ atSec: 21 });
  });

  it('count the notes with a fix that landed, and not an undone, failed or escalated one', () => {
    const h = setup();
    const id = jobInReview(h);
    fix(h, id, 12, 'fixed');
    fix(h, id, 18, 'fixed');
    fix(h, id, 20, 'undone');
    fix(h, id, 22, 'failed');
    fix(h, id, 24, 'escalated');
    fix(h, id, 26, 'cancelled');

    expect(h.jobs.get(id)).toMatchObject({ fixing: null, fixedCount: 2 });
  });

  it('say both together: one fixed, one running', () => {
    const h = setup();
    const id = jobInReview(h);
    fix(h, id, 12, 'fixed');
    fix(h, id, 33, 'running');

    expect(h.jobs.get(id)).toMatchObject({ fixing: { atSec: 33 }, fixedCount: 1 });
  });

  it('only look at the round being written (the job round + 1)', () => {
    const h = setup();
    const id = jobInReview(h, 'Second cut', 1);
    expect(h.jobs.get(id)?.round).toBe(1);
    // The first round's fixes are over, whatever their status.
    fix(h, id, 12, 'fixed', 1);
    fix(h, id, 14, 'running', 1);
    expect(h.jobs.get(id)).toMatchObject({ fixing: null, fixedCount: 0 });

    fix(h, id, 40, 'fixed', 2);
    expect(h.jobs.get(id)).toMatchObject({ fixing: null, fixedCount: 1 });
  });

  it('are per job, in one read of the whole list', () => {
    const h = setup();
    const a = jobInReview(h, 'A job');
    const b = jobInReview(h, 'B job');
    const c = jobInReview(h, 'C job');
    fix(h, a, 12, 'running');
    fix(h, b, 7, 'fixed');

    const all = new Map(h.jobs.getAll().map((job) => [job.id, job]));
    expect(all.get(a)).toMatchObject({ fixing: { atSec: 12 }, fixedCount: 0 });
    expect(all.get(b)).toMatchObject({ fixing: null, fixedCount: 1 });
    expect(all.get(c)).toMatchObject({ fixing: null, fixedCount: 0 });
  });

  it('are empty once the job is not in Review (Send notes starts the next round)', () => {
    const h = setup();
    const id = jobInReview(h);
    fix(h, id, 12, 'fixed');
    expect(h.jobs.get(id)?.fixedCount).toBe(1);

    h.clock.tick();
    h.jobs.applyTransition(id, { type: 'SEND_NOTES' });

    expect(h.jobs.get(id)).toMatchObject({ state: 'queued', fixing: null, fixedCount: 0 });
  });

  it('are always null and 0 while the Quick fixes switch is off', () => {
    const h = setup();
    const id = jobInReview(h);
    fix(h, id, 12, 'running');
    fix(h, id, 18, 'fixed');

    expect(h.jobsOff.get(id)).toMatchObject({ fixing: null, fixedCount: 0 });
    expect(h.jobsOff.getAll()[0]).toMatchObject({ fixing: null, fixedCount: 0 });
  });

  it('do not move updatedAt: a fix is not an update of the job', () => {
    const h = setup();
    const id = jobInReview(h);
    const before = h.jobs.get(id)?.updatedAt;

    fix(h, id, 12, 'running');

    expect(h.jobs.get(id)?.updatedAt).toBe(before);
  });
});

describe('QuickFixRepository.summaries', () => {
  it('leaves out a job with nothing to say, and answers for no jobs with an empty map', () => {
    const h = setup();
    const id = jobInReview(h);
    expect(h.fixes.summaries([]).size).toBe(0);
    expect(h.fixes.summaries([{ id, round: 1 }]).size).toBe(0);
    expect(NO_FIX_SUMMARY).toEqual({ fixing: null, fixedCount: 0 });
  });

  it('counts a note once even when it was fixed, undone and fixed again', () => {
    const h = setup();
    const id = jobInReview(h);
    const first = fix(h, id, 12, 'undone');
    h.fixes.insert({ ...first, id: 'again', status: 'fixed' });
    h.fixes.insert({ ...first, id: 'and-again', status: 'fixed' });

    expect(h.fixes.summaries([{ id, round: 1 }]).get(id)).toEqual({ fixing: null, fixedCount: 1 });
  });
});
