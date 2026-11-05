import type { QuickFix, ServerEvent } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOpenFix, makeQuickFix } from '@/features/review/fix-test-helpers';
import { createJobEventsClient } from './job-events';
import { jobFixesKey } from './job-fixes';
import { JOBS_KEY } from './jobs-cache';
import { notesKey } from './notes-cache';
import {
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  makeReviewNote,
  manualTimers,
} from './test-utils';

// A job's fixes follow the job.fix event (Quick fixes, QF6): it carries the whole fix, so it goes
// into the list as it is; a removed job drops its fixes; a hello, and a job whose round or state
// changes, make them be read again.

const JOB = 'a1b2c3d4e5f6';

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function start() {
  const sources = fakeEventSources();
  const onUnreadableEvent = vi.fn();
  createJobEventsClient({
    queryClient,
    eventSourceFactory: sources.factory,
    timers: manualTimers().timers,
    onUnreadableEvent,
    page: null,
  }).start();
  return { sources, onUnreadableEvent };
}

const fixes = () => queryClient.getQueryData<QuickFix[]>(jobFixesKey(JOB));
const fixEvent = (fix: QuickFix): ServerEvent => ({ type: 'job.fix', jobId: fix.jobId, fix });
const review = (overrides = {}) =>
  makeJob({ id: JOB, state: 'review', placeInLine: null, round: 0, ...overrides });

describe('the fixes cache and the job.fix event', () => {
  it('takes a fix that joins the list, then each change of it in place', () => {
    queryClient.setQueryData(jobFixesKey(JOB), []);
    const { sources, onUnreadableEvent } = start();

    sources.latest.emit(fixEvent(makeOpenFix('queued')));
    expect(fixes()?.map((fix) => fix.status)).toEqual(['queued']);
    sources.latest.emit(
      fixEvent(makeOpenFix('running', { step: 0, stepLabel: 'Reading the edit' })),
    );
    sources.latest.emit(fixEvent(makeOpenFix('running', { step: 2, stepLabel: 'Checking it' })));
    expect(fixes()).toHaveLength(1);
    expect(fixes()?.[0]).toMatchObject({ status: 'running', step: 2, stepLabel: 'Checking it' });
    sources.latest.emit(fixEvent(makeQuickFix({ durationSec: 31 })));
    expect(fixes()?.[0]).toMatchObject({ status: 'fixed', durationSec: 31 });
    expect(onUnreadableEvent).not.toHaveBeenCalled();
  });

  it('takes an undone and a cancelled fix as they come', () => {
    queryClient.setQueryData(jobFixesKey(JOB), [
      makeQuickFix(),
      makeOpenFix('queued', { id: 'f2', noteId: 'n2' }),
    ]);
    const { sources } = start();

    sources.latest.emit(fixEvent(makeQuickFix({ status: 'undone', said: null })));
    sources.latest.emit(fixEvent(makeQuickFix({ id: 'f2', noteId: 'n2', status: 'cancelled' })));
    expect(fixes()?.map((fix) => [fix.id, fix.status])).toEqual([
      ['f1', 'undone'],
      ['f2', 'cancelled'],
    ]);
  });

  it('leaves a job nobody asked for alone: whoever loads it reads the server', () => {
    const { sources } = start();
    sources.latest.emit(fixEvent(makeOpenFix('queued')));
    expect(fixes()).toBeUndefined();
  });

  it('keeps a note’s change and its fix apart: note.upsert does not touch the fixes', () => {
    queryClient.setQueryData(jobFixesKey(JOB), [makeQuickFix()]);
    queryClient.setQueryData(notesKey(JOB), [makeReviewNote({ fixId: 'f1' })]);
    const { sources } = start();
    sources.latest.emit({
      type: 'note.upsert',
      note: makeReviewNote({ fixId: null, fixedAt: null }),
    } satisfies ServerEvent);
    expect(fixes()).toEqual([makeQuickFix()]);
  });

  it('drops a removed job’s fixes', () => {
    queryClient.setQueryData(JOBS_KEY, [review()]);
    queryClient.setQueryData(jobFixesKey(JOB), [makeQuickFix()]);
    const { sources } = start();
    sources.latest.emit({ type: 'job.remove', id: JOB } satisfies ServerEvent);
    expect(fixes()).toBeUndefined();
  });

  it('reads every job’s fixes again on a hello', () => {
    queryClient.setQueryData(jobFixesKey(JOB), [makeQuickFix()]);
    queryClient.setQueryData(jobFixesKey('other'), []);
    const { sources } = start();
    sources.latest.emit({ type: 'hello' } satisfies ServerEvent);
    expect(queryClient.getQueryState(jobFixesKey(JOB))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(jobFixesKey('other'))?.isInvalidated).toBe(true);
  });

  it('reads a job’s fixes again when its round or state changes, and not when something else does', () => {
    queryClient.setQueryData(JOBS_KEY, [review()]);
    queryClient.setQueryData(jobFixesKey(JOB), [makeQuickFix()]);
    const { sources } = start();

    // Not the round, not the state: the fixes of this round are still right.
    sources.latest.emit({
      type: 'job.upsert',
      job: review({ reviewEffort: 'high' }),
    } satisfies ServerEvent);
    expect(queryClient.getQueryState(jobFixesKey(JOB))?.isInvalidated).toBe(false);

    // Send ended the round: the rows of the one before no longer show.
    sources.latest.emit({
      type: 'job.upsert',
      job: review({ round: 1 }),
    } satisfies ServerEvent);
    expect(queryClient.getQueryState(jobFixesKey(JOB))?.isInvalidated).toBe(true);
  });

  it('reads them again when the job comes back to Review', () => {
    queryClient.setQueryData(JOBS_KEY, [review({ state: 'editing', step: 5 })]);
    queryClient.setQueryData(jobFixesKey(JOB), []);
    const { sources } = start();
    sources.latest.emit({ type: 'job.upsert', job: review() } satisfies ServerEvent);
    expect(queryClient.getQueryState(jobFixesKey(JOB))?.isInvalidated).toBe(true);
  });
});
