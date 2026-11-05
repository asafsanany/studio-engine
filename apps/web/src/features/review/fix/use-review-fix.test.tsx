import type { Job, QuickFix } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { renderReview } from '../test-helpers';
import { endedAfter, FIX_JOB_ID, makeFix } from './test-fixtures';
import type { ReviewFix } from './use-review-fix';

// What Review's player (Mac and phone) reads of the job's quick fixes. The fixes themselves are the
// shared hook's (`useJobFixes`, QF6): here it is a stand-in with its public shape.

const state = {
  on: true,
  fixes: [] as QuickFix[],
  asked: [] as [string, boolean][],
};

vi.mock('@/data', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/data')>();
  return {
    ...original,
    useQuickFixesEnabled: () => state.on,
    useJobFixes: (jobId: string, enabled: boolean) => {
      state.asked.push([jobId, enabled]);
      const fixes = enabled ? state.fixes : [];
      const landed = fixes.filter((fix) => fix.status === 'fixed' || fix.status === 'undone');
      const ends = landed.map((fix) => Date.parse(fix.endedAt as string));
      return {
        fixes,
        byNote: new Map(fixes.map((fix) => [fix.noteId, fix])),
        rev: ends.length === 0 ? null : Math.max(...ends),
      };
    },
  };
});

const { useReviewFix } = await import('./use-review-fix');

const notes = [
  makeReviewNote({ id: 'n1', jobId: FIX_JOB_ID, atSec: 12.4 }),
  makeReviewNote({ id: 'n2', jobId: FIX_JOB_ID, atSec: 30 }),
];

function read(
  fixes: QuickFix[],
  { on = true, jobState = 'review' as Job['state'] } = {},
): { fix: ReviewFix; asked: [string, boolean][] } {
  state.on = on;
  state.fixes = fixes;
  state.asked = [];
  let found: ReviewFix | null = null;
  function Probe() {
    found = useReviewFix({ job: { id: FIX_JOB_ID, state: jobState }, notes });
    return null;
  }
  renderReview(<Probe />);
  if (found === null) throw new Error('the hook did not render');
  return { fix: found, asked: state.asked };
}

describe('useReviewFix', () => {
  it('has nothing to show for a job without fixes', () => {
    const { fix } = read([]);
    expect(fix).toEqual({ rev: null, landOn: null, pill: null });
  });

  it('gives the preview’s address the newest end of the fixes that landed', () => {
    const { fix } = read([
      makeFix({ id: 'f1', endedAt: endedAfter(28) }),
      makeFix({ id: 'f2', noteId: 'n2', endedAt: endedAfter(70) }),
    ]);
    expect(fix.rev).toBe(Date.parse(endedAfter(70)));
  });

  it('moves the address’s rev at an Undo, which moves no `endedAt`: the player must load the files that were put back', () => {
    const fixed = makeFix({ endedAt: endedAfter(28) });
    const before = read([fixed]).fix.rev;
    const after = read([{ ...fixed, status: 'undone' }]).fix.rev;
    expect(before).toBe(Date.parse(endedAfter(28)));
    expect(after).toBe(Date.parse(endedAfter(28)) + 1);
  });

  it('draws "Fixing" for the fix that runs and "Changed" for the ones that landed', () => {
    const { fix } = read([
      makeFix({ id: 'f1' }),
      makeFix({ id: 'f2', noteId: 'n2', status: 'running', endedAt: null }),
    ]);
    expect(fix.pill?.running).toEqual({ fixId: 'f2', atSec: 30 });
    expect(fix.pill?.changed.map((moment) => moment.fixId)).toEqual(['f1']);
  });

  it('does not land on a fix it only read: Review opened with a fix already made', () => {
    expect(read([makeFix()]).fix.landOn).toBeNull();
  });

  it('asks for the fixes only while Quick fixes are on and the job is in Review', () => {
    expect(read([makeFix()]).asked).toEqual([[FIX_JOB_ID, true]]);
    expect(read([makeFix()], { on: false }).asked).toEqual([[FIX_JOB_ID, false]]);
    expect(read([makeFix()], { jobState: 'editing' }).asked).toEqual([[FIX_JOB_ID, false]]);
  });

  it('is inert with Quick fixes off, even if fixes are in the cache', () => {
    expect(read([makeFix()], { on: false }).fix).toEqual({ rev: null, landOn: null, pill: null });
  });
});
