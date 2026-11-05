import type { AnalyticsApprovalBucket } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SCALE,
  approvalLabels,
  approvalRows,
  approvalSummary,
  approvalValues,
  bucketTitle,
  hasApprovals,
  percent,
  weekLabel,
} from './approved-first-time-view';

/** The 12 weeks of Thursday 22 October 2026 (Sundays, oldest first), with `results` by index: [first time, approved]. */
function twelveWeeks(results: Record<number, [number, number]> = {}): AnalyticsApprovalBucket[] {
  const sundays = [
    '2026-08-02',
    '2026-08-09',
    '2026-08-16',
    '2026-08-23',
    '2026-08-30',
    '2026-09-06',
    '2026-09-13',
    '2026-09-20',
    '2026-09-27',
    '2026-10-04',
    '2026-10-11',
    '2026-10-18',
  ];
  return sundays.map((start, i) => {
    const [firstTime, approved] = results[i] ?? [0, 0];
    return {
      start,
      share: approved === 0 ? null : firstTime / approved,
      firstTime,
      approved,
      medianReruns: null,
    };
  });
}

describe('weekLabel', () => {
  it('writes a Sunday the way the board does, month then day without a leading zero', () => {
    expect(weekLabel('2026-08-02')).toBe('Aug 2');
    expect(weekLabel('2026-10-18')).toBe('Oct 18');
    expect(weekLabel('2027-01-03')).toBe('Jan 3');
    expect(weekLabel('2026-12-27')).toBe('Dec 27');
  });

  it('leaves what it cannot read as it is', () => {
    expect(weekLabel('soon')).toBe('soon');
  });
});

describe('percent', () => {
  it('writes a share as a whole percent', () => {
    expect(percent(0)).toBe('0%');
    expect(percent(0.25)).toBe('25%');
    expect(percent(0.79)).toBe('79%');
    expect(percent(2 / 3)).toBe('67%');
    expect(percent(1)).toBe('100%');
  });
});

describe('approvalValues', () => {
  it('is the share of each week, with a gap (null) where nothing was approved and a real 0 where nothing was first time', () => {
    expect(approvalValues(twelveWeeks({ 0: [1, 2], 2: [0, 3], 11: [3, 3] }))).toEqual([
      0.5,
      null,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
    ]);
  });
});

describe('approvalLabels', () => {
  it('names every third week by its Sunday and the last one "now"', () => {
    expect(approvalLabels(twelveWeeks())).toEqual([
      'Aug 2',
      '',
      '',
      'Aug 23',
      '',
      '',
      'Sep 13',
      '',
      '',
      'Oct 4',
      '',
      'now',
    ]);
  });

  it('leaves out a dated week that would sit next to "now"', () => {
    const labels = approvalLabels(twelveWeeks().slice(0, 10));
    expect(labels.at(-1)).toBe('now');
    expect(labels.at(-2)).toBe('');
    expect(labels[0]).toBe('Aug 2');
    expect(labels[6]).toBe('Sep 13');
  });

  it('says only "now" for a single week', () => {
    expect(approvalLabels(twelveWeeks().slice(-1))).toEqual(['now']);
  });
});

describe('hasApprovals', () => {
  it('is false for 12 weeks with no approval and true for one', () => {
    expect(hasApprovals(twelveWeeks())).toBe(false);
    expect(hasApprovals(twelveWeeks({ 4: [0, 1] }))).toBe(true);
  });
});

describe('approvalSummary', () => {
  it('has nothing to say when no job was approved', () => {
    expect(approvalSummary(twelveWeeks())).toBeNull();
  });

  it('says how far the share went up, from the first week with approvals to the last', () => {
    const weeks = twelveWeeks({ 1: [11, 20], 5: [2, 5], 11: [19, 24] });
    expect(approvalSummary(weeks)).toBe('Up from 55% to 79% since Aug 9.');
  });

  it('says how far it went down', () => {
    const weeks = twelveWeeks({ 0: [4, 4], 10: [1, 2] });
    expect(approvalSummary(weeks)).toBe('Down from 100% to 50% since Aug 2.');
  });

  it('says steady when both ends read the same', () => {
    const weeks = twelveWeeks({ 2: [3, 4], 11: [6, 8] });
    expect(approvalSummary(weeks)).toBe('Steady at 75% since Aug 16.');
  });

  it('says steady when the two ends only differ below a whole percent', () => {
    const weeks = twelveWeeks({ 2: [1000, 1001], 11: [999, 1000] });
    expect(approvalSummary(weeks)).toBe('Steady at 100% since Aug 16.');
  });

  it('counts the jobs of the one week it has, "this week" when that is the current one', () => {
    expect(approvalSummary(twelveWeeks({ 11: [1, 3] }))).toBe(
      '1 of 3 jobs approved first time this week.',
    );
    expect(approvalSummary(twelveWeeks({ 11: [1, 1] }))).toBe(
      '1 of 1 job approved first time this week.',
    );
  });

  it('names an older single week by its Sunday', () => {
    expect(approvalSummary(twelveWeeks({ 6: [0, 2] }))).toBe(
      '0 of 2 jobs approved first time the week of Sep 13.',
    );
  });

  it('reads past weeks with no approvals', () => {
    const weeks = twelveWeeks({ 3: [0, 2], 8: [2, 2] });
    expect(approvalSummary(weeks)).toBe('Up from 0% to 100% since Aug 23.');
  });

  it('totals the last 7 days against the 7 before in the Week period', () => {
    const days = fourteenDays({
      2: [1, 1],
      5: [2, 3],
      8: [1, 1],
      10: [0, 1],
      12: [2, 2],
      13: [1, 1],
    });
    expect(approvalSummary(days, 'week')).toBe(
      '4 of 5 approved first time in the last 7 days, was 3 of 4.',
    );
  });

  it('leaves out the 7 days before when none was approved then, and says nothing with none now', () => {
    expect(approvalSummary(fourteenDays({ 13: [0, 2] }), 'week')).toBe(
      '0 of 2 approved first time in the last 7 days.',
    );
    expect(approvalSummary(fourteenDays({ 3: [1, 1] }), 'week')).toBeNull();
  });
});

/** The 14 days up to Thursday 22 October 2026, oldest first, with `results` by index: [first time, approved]. */
function fourteenDays(results: Record<number, [number, number]> = {}): AnalyticsApprovalBucket[] {
  return Array.from({ length: 14 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 9, 9 + i)).toISOString().slice(0, 10);
    const [firstTime, approved] = results[i] ?? [0, 0];
    return {
      start: day,
      share: approved === 0 ? null : firstTime / approved,
      firstTime,
      approved,
      medianReruns: null,
    };
  });
}

describe('bucketTitle', () => {
  it('calls a week by its Sunday, and the one that is not over says so', () => {
    expect(bucketTitle('2026-10-11', 'month', false)).toBe('Week of Oct 11');
    expect(bucketTitle('2026-10-18', 'month', true)).toBe('Week of Oct 18 · so far');
  });

  it('calls a day by its date, and today by name', () => {
    expect(bucketTitle('2026-10-21', 'week', false)).toBe('Oct 21');
    expect(bucketTitle('2026-10-22', 'week', true)).toBe('Oct 22 · today');
  });
});

describe('approvalRows', () => {
  const buckets: AnalyticsApprovalBucket[] = [
    { start: '2026-10-11', share: 0.75, firstTime: 3, approved: 4, medianReruns: 1 },
    { start: '2026-10-18', share: null, firstTime: 0, approved: 0, medianReruns: null },
  ];

  it('has a row per week with the share and how many jobs it is of', () => {
    const rows = approvalRows(buckets);
    expect(rows.map((row) => row.value)).toEqual([0.75, null]);
    expect(rows[0]).toMatchObject({
      id: '2026-10-11',
      title: 'Week of Oct 11',
      note: '3 of 4 jobs approved with no notes',
    });
    expect(rows[1]?.title).toBe('Week of Oct 18 · so far');
  });

  it('says a single job in the singular, and a day as a day', () => {
    const one = approvalRows(
      [{ start: '2026-10-22', share: 1, firstTime: 1, approved: 1, medianReruns: 0 }],
      'week',
    );
    expect(one[0]).toMatchObject({
      title: 'Oct 22 · today',
      note: '1 of 1 job approved with no notes',
    });
  });

  it('draws 0 to 100% in quarters', () => {
    expect(APPROVAL_SCALE.ticks).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});
