// CVP-197: the header's to-dos leave archived jobs out. An archived failed video does not ask for
// the person, and an archived review job is not waiting to be reviewed.

import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { countEngine } from './engine-summary';

const ARCHIVED_AT = '2026-10-21T10:00:00.000Z';
const archived = (state: Parameters<typeof makeJob>[0] = {}) =>
  makeJob({ ...state, archivedAt: ARCHIVED_AT });

describe('countEngine: archived jobs', () => {
  it('does not count an archived failed, cancelled or held job as needing attention', () => {
    const jobs = [
      makeJob({ state: 'failed', placeInLine: null }),
      archived({ state: 'failed', placeInLine: null }),
      archived({ state: 'cancelled', placeInLine: null }),
      archived({ state: 'held', placeInLine: null }),
    ];
    expect(countEngine(jobs)).toEqual({ editing: 0, queued: 0, review: 0, attention: 1 });
  });

  it('does not count an archived job in review', () => {
    const jobs = [
      makeJob({ state: 'review', placeInLine: null }),
      archived({ state: 'review', placeInLine: null }),
    ];
    expect(countEngine(jobs).review).toBe(1);
  });

  it('counts a job again once it is out of the archive', () => {
    const job = makeJob({ state: 'failed', placeInLine: null });
    expect(countEngine([archived({ state: 'failed', placeInLine: null })]).attention).toBe(0);
    expect(countEngine([job]).attention).toBe(1);
  });

  it('is all zeros for a list of only archived jobs', () => {
    const jobs = (['failed', 'review', 'held', 'cancelled', 'ready'] as const).map((state) =>
      archived({ state, placeInLine: null }),
    );
    expect(countEngine(jobs)).toEqual({ editing: 0, queued: 0, review: 0, attention: 0 });
  });

  it('counts a job given without the field as not archived (the summary takes narrow jobs)', () => {
    expect(countEngine([{ state: 'failed', delivery: null }]).attention).toBe(1);
  });
});
