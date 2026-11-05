import type { AnalyticsApprovalBucket } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { hasReruns, rerunRows, rerunSummary, reruns, rerunValues } from './rerun-view';

function week(medianReruns: number | null, approved: number): AnalyticsApprovalBucket {
  return { start: '2026-10-18', share: null, firstTime: 0, approved, medianReruns };
}

describe('rerun view', () => {
  it('keeps a week with no approvals as a gap', () => {
    expect(rerunValues([week(null, 0), week(1.5, 2)])).toEqual([null, 1.5]);
    expect(hasReruns([week(null, 0)])).toBe(false);
    expect(hasReruns([week(0, 1)])).toBe(true);
  });

  it('writes medians plainly', () => {
    expect(reruns(1)).toBe('1');
    expect(reruns(1.5)).toBe('1.5');
  });

  it('summarises the latest week', () => {
    expect(rerunSummary([week(null, 0)])).toBeNull();
    expect(rerunSummary([week(2, 3), week(1, 1)])).toContain('Latest: 1 re-run (median)');
  });
});

describe('rerunRows', () => {
  it('has a row per week with the median and the jobs it is across', () => {
    const rows = rerunRows([week(1.5, 2), week(null, 0), week(0, 1)]);
    expect(rows.map((row) => row.value)).toEqual([1.5, null, 0]);
    expect(rows[0]?.note).toBe('across 2 approved jobs');
    expect(rows[2]?.note).toBe('across 1 approved job');
    expect(rows[0]?.title).toBe('Week of Oct 18');
  });

  it('names the days in the week period', () => {
    expect(rerunRows([week(1, 1)], 'week')[0]?.title).toBe('Oct 18 · today');
  });
});
