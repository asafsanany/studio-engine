import { type QuickFix, quickFixSchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { FIX_STOPPED_WHY, QuickFixRepository } from './quick-fix-repository.js';
import { fakeClock, memoryDb, rawRow, T0 } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  return { clock, db, repo: new QuickFixRepository(db, { clock }) };
}

/** A fix as the service queues it. */
function queued(id: string, overrides: Partial<QuickFix> = {}): QuickFix {
  return {
    id,
    jobId: 'job-a',
    noteId: `note-${id}`,
    round: 1,
    status: 'queued',
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
    ...overrides,
  };
}

describe('QuickFixRepository.insert and get', () => {
  it('stores a queued fix as it is given and reads it back', () => {
    const { repo } = setup();

    const fix = repo.insert(queued('f1'));

    expect(fix).toEqual(queued('f1'));
    expect(repo.get('f1')).toEqual(fix);
    expect(quickFixSchema.parse(repo.get('f1'))).toEqual(fix);
  });

  it('round-trips every field of a fix that is done', () => {
    const { repo, db } = setup();
    const done = queued('f1', {
      status: 'fixed',
      said: 'The captions are Heebo Bold now.',
      startedAt: '2026-10-25T09:00:00.000Z',
      endedAt: '2026-10-25T09:00:48.000Z',
      durationSec: 48.25,
      hasCompare: true,
    });

    repo.insert(done);

    expect(repo.get('f1')).toEqual(done);
    // Times are integer milliseconds, the flag is 0/1.
    expect(rawRow(db, 'quick_fixes')).toEqual([
      {
        id: 'f1',
        job_id: 'job-a',
        note_id: 'note-f1',
        round: 1,
        status: 'fixed',
        step: null,
        step_label: null,
        said: 'The captions are Heebo Bold now.',
        why: null,
        model: 'sonnet',
        effort: 'medium',
        started_at: Date.parse('2026-10-25T09:00:00.000Z'),
        ended_at: Date.parse('2026-10-25T09:00:48.000Z'),
        duration_sec: 48.25,
        has_compare: 1,
      },
    ]);
  });

  it('keeps Hebrew text exactly', () => {
    const { repo } = setup();
    const said = 'הכתוביות בגופן Heebo Bold עכשיו.';

    repo.insert(queued('f1', { status: 'fixed', said }));

    expect(repo.get('f1')?.said).toBe(said);
  });

  it('is null for an unknown id, and refuses a second fix with the same id', () => {
    const { repo } = setup();
    repo.insert(queued('f1', { stepLabel: 'first' }));

    expect(repo.get('nope')).toBeNull();
    expect(() => repo.insert(queued('f1', { stepLabel: 'second' }))).toThrow();
    expect(repo.get('f1')?.stepLabel).toBe('first');
  });
});

describe('QuickFixRepository.update', () => {
  it('moves a fix on: running, a step, then fixed with its reply and times', () => {
    const { repo } = setup();
    repo.insert(queued('f1'));

    expect(
      repo.update('f1', {
        status: 'running',
        startedAt: T0,
        step: 1,
        stepLabel: 'Changing the caption font',
      }),
    ).toMatchObject({
      status: 'running',
      startedAt: T0,
      step: 1,
      stepLabel: 'Changing the caption font',
    });

    const done = repo.update('f1', {
      status: 'fixed',
      step: null,
      stepLabel: null,
      said: 'The captions are Heebo Bold now.',
      endedAt: '2026-10-20T10:00:48.000Z',
      durationSec: 48,
      hasCompare: true,
    });

    expect(done).toEqual(
      queued('f1', {
        status: 'fixed',
        startedAt: T0,
        said: 'The captions are Heebo Bold now.',
        endedAt: '2026-10-20T10:00:48.000Z',
        durationSec: 48,
        hasCompare: true,
      }),
    );
    expect(repo.get('f1')).toEqual(done);
  });

  it('changes only what the patch names, and null clears a field', () => {
    const { repo } = setup();
    repo.insert(
      queued('f1', { status: 'running', startedAt: T0, step: 2, stepLabel: 'Checking it' }),
    );

    expect(repo.update('f1', { step: null, stepLabel: null })).toEqual(
      queued('f1', { status: 'running', startedAt: T0 }),
    );
    expect(repo.update('f1', {})).toEqual(queued('f1', { status: 'running', startedAt: T0 }));
  });

  it('never moves the id, the job, the note or the round', () => {
    const { repo } = setup();
    repo.insert(queued('f1'));

    // The patch type leaves them out; at run time they are ignored too.
    const patch = { jobId: 'job-z', noteId: 'n-z', round: 9, status: 'escalated' as const };
    repo.update('f1', patch);

    expect(repo.get('f1')).toMatchObject({
      jobId: 'job-a',
      noteId: 'note-f1',
      round: 1,
      status: 'escalated',
    });
  });

  it('is null for an unknown id', () => {
    const { repo } = setup();

    expect(repo.update('nope', { status: 'failed' })).toBeNull();
    expect(repo.update('nope', {})).toBeNull();
  });
});

describe('QuickFixRepository.listForRound', () => {
  it('lists the fixes of one job and round, in the order they were queued', () => {
    const { repo } = setup();
    // Ids that sort the other way round than they were queued.
    repo.insert(queued('f3'));
    repo.insert(queued('f1'));
    repo.insert(queued('f2'));

    expect(repo.listForRound('job-a', 1).map((fix) => fix.id)).toEqual(['f3', 'f1', 'f2']);
  });

  it('keeps the order when a fix is updated', () => {
    const { repo } = setup();
    repo.insert(queued('f1'));
    repo.insert(queued('f2'));
    repo.update('f1', { status: 'fixed' });
    repo.update('f2', { status: 'running' });
    repo.update('f1', { status: 'undone' });

    expect(repo.listForRound('job-a', 1).map((fix) => fix.id)).toEqual(['f1', 'f2']);
  });

  it('leaves out other jobs and other rounds', () => {
    const { repo } = setup();
    repo.insert(queued('f1'));
    repo.insert(queued('f2', { round: 2 }));
    repo.insert(queued('f3', { jobId: 'job-b' }));

    expect(repo.listForRound('job-a', 1).map((fix) => fix.id)).toEqual(['f1']);
    expect(repo.listForRound('job-a', 2).map((fix) => fix.id)).toEqual(['f2']);
    expect(repo.listForRound('job-b', 1).map((fix) => fix.id)).toEqual(['f3']);
    expect(repo.listForRound('job-a', 3)).toEqual([]);
    expect(repo.listForRound('nope', 1)).toEqual([]);
  });

  it('includes fixes of every status', () => {
    const { repo } = setup();
    const statuses = [
      'queued',
      'running',
      'fixed',
      'escalated',
      'failed',
      'undone',
      'cancelled',
    ] as const;
    for (const status of statuses) repo.insert(queued(`f-${status}`, { status }));

    expect(repo.listForRound('job-a', 1).map((fix) => fix.status)).toEqual([...statuses]);
  });
});

describe('QuickFixRepository.listQueued', () => {
  it('lists the queued fixes of every job in the order they were queued', () => {
    const { repo } = setup();
    repo.insert(queued('f1', { jobId: 'job-b' }));
    repo.insert(queued('f2', { status: 'running' }));
    repo.insert(queued('f3'));
    repo.insert(queued('f4', { status: 'fixed' }));
    repo.insert(queued('f5', { jobId: 'job-c' }));

    expect(repo.listQueued().map((fix) => fix.id)).toEqual(['f1', 'f3', 'f5']);
    repo.update('f1', { status: 'cancelled' });
    expect(repo.listQueued().map((fix) => fix.id)).toEqual(['f3', 'f5']);
  });
});

describe('QuickFixRepository.newestFixed', () => {
  it('is the newest fix of the round that is fixed', () => {
    const { repo } = setup();
    repo.insert(queued('f1', { status: 'fixed' }));
    repo.insert(queued('f2', { status: 'fixed' }));

    expect(repo.newestFixed('job-a', 1)?.id).toBe('f2');
  });

  it('skips the fixes that are not in effect: undone, failed, escalated, running and queued', () => {
    const { repo } = setup();
    repo.insert(queued('f1', { status: 'fixed' }));
    for (const status of [
      'undone',
      'failed',
      'escalated',
      'running',
      'queued',
      'cancelled',
    ] as const) {
      repo.insert(queued(`f-${status}`, { status }));
    }

    expect(repo.newestFixed('job-a', 1)?.id).toBe('f1');
  });

  it('moves back to the one before when the newest is undone', () => {
    const { repo } = setup();
    repo.insert(queued('f1', { status: 'fixed' }));
    repo.insert(queued('f2', { status: 'fixed' }));
    repo.update('f2', { status: 'undone' });

    expect(repo.newestFixed('job-a', 1)?.id).toBe('f1');
    repo.update('f1', { status: 'undone' });
    expect(repo.newestFixed('job-a', 1)).toBeNull();
  });

  it('is the last to have ended, not the last queued: fixes run in the order of their notes', () => {
    const { repo } = setup();
    // f1 was queued first (its note answered first) but ran second.
    repo.insert(queued('f1', { status: 'fixed', endedAt: '2026-10-25T09:02:00.000Z' }));
    repo.insert(queued('f2', { status: 'fixed', endedAt: '2026-10-25T09:01:00.000Z' }));

    expect(repo.newestFixed('job-a', 1)?.id).toBe('f1');
    repo.update('f1', { status: 'undone' });
    expect(repo.newestFixed('job-a', 1)?.id).toBe('f2');
  });

  it('is null when there is none, and looks only at its job and round', () => {
    const { repo } = setup();
    repo.insert(queued('f1', { status: 'fixed', round: 2 }));
    repo.insert(queued('f2', { status: 'fixed', jobId: 'job-b' }));

    expect(repo.newestFixed('job-a', 1)).toBeNull();
    expect(repo.newestFixed('job-a', 2)?.id).toBe('f1');
    expect(repo.newestFixed('job-b', 1)?.id).toBe('f2');
    expect(repo.newestFixed('nope', 1)).toBeNull();
  });
});

describe('QuickFixRepository.markRunningFailed', () => {
  it('marks a fix that was running failed, ended now, with the reason', () => {
    const { repo, clock } = setup();
    repo.insert(
      queued('f1', {
        status: 'running',
        startedAt: '2026-10-20T10:00:00.000Z',
        step: 1,
        stepLabel: 'Changing the caption font',
      }),
    );
    clock.tick(30_000);

    const changed = repo.markRunningFailed();

    expect(changed).toEqual([
      queued('f1', {
        status: 'failed',
        startedAt: '2026-10-20T10:00:00.000Z',
        endedAt: '2026-10-20T10:00:30.000Z',
        durationSec: 30,
        why: FIX_STOPPED_WHY,
      }),
    ]);
    expect(repo.get('f1')).toEqual(changed[0]);
    expect(quickFixSchema.parse(changed[0])).toEqual(changed[0]);
  });

  it('touches only the running ones, and returns them oldest first', () => {
    const { repo } = setup();
    repo.insert(queued('f1', { status: 'fixed' }));
    repo.insert(queued('f2', { status: 'running', startedAt: T0 }));
    repo.insert(queued('f3', { status: 'queued' }));
    repo.insert(queued('f4', { status: 'running', startedAt: T0, jobId: 'job-b' }));
    repo.insert(queued('f5', { status: 'undone' }));

    const changed = repo.markRunningFailed();

    expect(changed.map((fix) => fix.id)).toEqual(['f2', 'f4']);
    expect(repo.listForRound('job-a', 1).map((fix) => `${fix.id}:${fix.status}`)).toEqual([
      'f1:fixed',
      'f2:failed',
      'f3:queued',
      'f5:undone',
    ]);
  });

  it('has nothing to do on a clean start, and a second call finds nothing', () => {
    const { repo } = setup();
    expect(repo.markRunningFailed()).toEqual([]);

    repo.insert(queued('f1', { status: 'running', startedAt: T0 }));
    expect(repo.markRunningFailed()).toHaveLength(1);
    expect(repo.markRunningFailed()).toEqual([]);
  });

  it('gives a running fix with no start time no duration', () => {
    const { repo } = setup();
    repo.insert(queued('f1', { status: 'running' }));

    expect(repo.markRunningFailed()[0]).toMatchObject({ status: 'failed', durationSec: null });
  });
});
