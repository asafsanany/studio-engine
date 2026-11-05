import {
  type AnalyticsApprovalBucket,
  type AnalyticsFootageBucket,
  type AnalyticsTile,
  addDays,
} from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { ApprovedFirstTimeCard } from './ApprovedFirstTimeCard';
import {
  ANALYTICS_CARDS,
  ANALYTICS_TILE_COPY,
  cardCopy,
  NOW_LABEL,
  tileCopy,
} from './analytics-copy';
import { approvalLabels, approvalSummary } from './approved-first-time-view';
import { FootagePerWeekCard } from './FootagePerWeekCard';
import { footageDaySummary, footageSummary, footageView } from './footage-view';
import { JobsTiles } from './JobsTiles';
import { sparkRows, tileView } from './jobs-tiles-view';
import { TypicalJobCard } from './TypicalJobCard';

// The week period of the Analytics page: the same cards over the last 7 days, with every series by
// day (14 of them, today last). These check the words and numbers the period changes; the cards'
// drawing is covered with the month's in each card's own tests.

/** 14 days from Friday 9 October 2026 to Thursday 22 October (today). */
const START = '2026-10-09';
const dayAt = (i: number) => addDays(START, i);

function footageDays(hours: (number | null)[]): AnalyticsFootageBucket[] {
  return hours.map((value, i) => ({ start: dayAt(i), hours: value }));
}

function approvalDays(shares: (number | null)[]): AnalyticsApprovalBucket[] {
  return shares.map((share, i) => ({
    start: dayAt(i),
    share,
    firstTime: share === null ? 0 : Math.round(share * 2),
    approved: share === null ? 0 : 2,
    medianReruns: share === null ? null : 1,
  }));
}

const NONE = Array.from({ length: 14 }, () => null);

function tile(overrides: Partial<AnalyticsTile>): AnalyticsTile {
  return {
    key: 'jobs-finished',
    unit: 'count',
    value: null,
    previous: null,
    numerator: null,
    denominator: null,
    previousNumerator: null,
    previousDenominator: null,
    series: NONE,
    ...overrides,
  };
}

describe('the words of the week period', () => {
  it('say "7 days" where the month says "30 days", in the tiles', () => {
    expect(tileCopy('month')).toBe(ANALYTICS_TILE_COPY);
    expect(tileCopy('week')['jobs-finished']).toEqual({
      title: 'Jobs finished',
      subtitle: 'Last 7 days',
    });
    expect(tileCopy('week').clients.subtitle).toBe('With a job finished, last 7 days');
    expect(tileCopy('week')['files-in-ready'].subtitle).toBe('Typical job, last 7 days');
    expect(tileCopy('week')['approved-first-time'].subtitle).toBe('Reviewed jobs, last 7 days');
    // Same titles in both periods, so a tile is the same tile.
    for (const key of Object.keys(ANALYTICS_TILE_COPY) as (keyof typeof ANALYTICS_TILE_COPY)[]) {
      expect(tileCopy('week')[key].title).toBe(ANALYTICS_TILE_COPY[key].title);
    }
    expect(tileCopy('week')['editing-time']).toEqual(ANALYTICS_TILE_COPY['editing-time']);
  });

  it('say "day" where the month says "week", in the cards', () => {
    expect(cardCopy('month')).toBe(ANALYTICS_CARDS);
    const week = cardCopy('week');
    expect(week.footagePerWeek.title).toBe('Footage edited per day');
    expect(week.approvedFirstTime.title).toBe('Approved first time, by day');
    expect(week.busiestWeek).toEqual({
      title: 'Busiest day, last 14 days',
      subtitle: 'The plan’s peak five-hour use, and what the app spent of the month’s credits',
    });
    expect(week.typicalJob.subtitle).toBe(
      'The median job, last 7 days; “vs before” is the 7 days before',
    );
  });

  it('say the last 14 days for the deliveries, and the last 7 for the budgets’ chart', () => {
    expect(cardCopy('week').deliveredPerDay).toEqual({
      title: 'Jobs delivered per day',
      subtitle: 'Last 14 days',
    });
    expect(cardCopy('week').creditsThroughMonth).toEqual({
      title: 'API credits and plan through the week',
      subtitle: 'The share of each budget used, last 7 days',
    });
  });

  it('leave the cards that do not change alone, the budgets among them', () => {
    expect(cardCopy('week').noteTopics).toBe(ANALYTICS_CARDS.noteTopics);
    // The two budgets are the current month and the current week whatever the period is.
    expect(cardCopy('week').apiCredits).toBe(ANALYTICS_CARDS.apiCredits);
    expect(cardCopy('week').maxPlan).toBe(ANALYTICS_CARDS.maxPlan);
    expect(cardCopy('week').creditsPaidFor).toBe(ANALYTICS_CARDS.creditsPaidFor);
    expect(cardCopy('week').planUsage).toBe(ANALYTICS_CARDS.planUsage);
  });

  it('end the charts in "now" for the month and "today" for the week', () => {
    expect(NOW_LABEL).toEqual({ month: 'now', week: 'today' });
  });
});

describe('the tiles in the week period', () => {
  it('say the change against "the 7 days before"', () => {
    expect(tileView(tile({ value: 5, previous: 3 }), 'week')).toMatchObject({
      change: '+2 on the 7 days before',
      tone: 'better',
    });
    expect(tileView(tile({ value: 2, previous: 5 }), 'week').change).toBe(
      '−3 on the 7 days before',
    );
    expect(tileView(tile({ value: 4, previous: 4 }), 'week').change).toBe(
      'Same as the 7 days before',
    );
    expect(
      tileView(
        tile({ key: 'files-in-ready', unit: 'duration-sec', value: 3000, previous: 3600 }),
        'week',
      ).change,
    ).toBe('10 min faster');
  });

  it('say "the 30 days before" for the month, and when no period is given', () => {
    expect(tileView(tile({ value: 5, previous: 3 })).change).toBe('+2 on the 30 days before');
    expect(tileView(tile({ value: 5, previous: 3 }), 'month').change).toBe(
      '+2 on the 30 days before',
    );
    expect(tileView(tile({ value: 4, previous: 4 })).change).toBe('Same as the 30 days before');
  });

  it('render with 14-value sparklines, the week’s words and its change line', () => {
    const answer = makeAnalyticsResponse({ period: 'week' });
    const tiles = answer.jobs.tiles.map((t) =>
      t.key === 'jobs-finished'
        ? { ...t, value: 5, previous: 3, series: [0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0] }
        : t,
    );
    const markup = renderToStaticMarkup(<JobsTiles tiles={tiles} period="week" />);

    expect(markup).toContain('>Last 7 days</p>');
    expect(markup).toContain('+2 on the 7 days before');
    expect(markup).not.toContain('30 days');
    // The sparkline of the first tile: 14 values make 14 points on its line, each a day.
    expect(sparkRows(tiles[0] as AnalyticsTile, 'week')).toHaveLength(14);
  });
});

describe('footage per day', () => {
  const steady = footageDays([1, 0, 0, 1.2, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0.5]);

  it('has a column per day, a date under every third one and "today" under the last', () => {
    const view = footageView(steady, 'week');

    expect(view.values).toHaveLength(14);
    expect(view.labels).toEqual([
      'Oct 9',
      '',
      '',
      'Oct 12',
      '',
      '',
      'Oct 15',
      '',
      '',
      'Oct 18',
      '',
      '',
      '',
      'today',
    ]);
    expect(view.ariaLabel).toBe('Footage hours per day');
    expect(footageView(steady).labels.at(-1)).toBe('now');
    expect(footageView(steady).ariaLabel).toBe('Footage hours per week');
  });

  it('counts minutes while every day is under an hour', () => {
    const view = footageView(footageDays(Array.from({ length: 14 }, () => 0.25)), 'week');

    expect(view.unit).toBe('min');
    expect(view.ariaLabel).toBe('Footage minutes per day');
    expect(view.values[0]).toBe(15);
  });

  it('is a card called "Footage edited per day" with its line and its tint', () => {
    const markup = renderToStaticMarkup(<FootagePerWeekCard weeks={steady} period="week" />);

    expect(markup).toMatch(/^<section aria-label="Footage edited per day"/);
    expect(markup).toContain('>Footage edited per day</h3>');
    expect(markup).toContain('aria-label="Footage hours per day"');
    expect(markup).toContain('data-slot="chart"');
    expect(markup).not.toContain('per week');
  });

  it('says the day in the hover card, and today as today', () => {
    const view = footageView(steady, 'week');
    expect(view.rows[0]).toMatchObject({ id: '2026-10-09', title: 'Oct 9', value: 1 });
    expect(view.rows.at(-1)).toMatchObject({ title: 'Oct 22 · today', value: 0.5 });
    expect(footageView(steady).rows.at(-1)?.title).toBe('Week of Oct 22 · so far');
  });

  it('gives the axis minutes, with room for "60 min", while every day is under an hour', () => {
    const minutes = footageView(
      footageDays([0, 0.5, 0.9, 0.7, 0, 0, 0.6, 0.8, 0.9, 0.5, 0, 0, 0.7, 0.2]),
      'week',
    );
    expect(minutes.unit).toBe('min');
    expect(minutes.scale.ticks.at(-1)).toBeGreaterThanOrEqual(54);
    expect(footageView(steady, 'week').unit).toBe('h');
  });

  describe('the line under the chart', () => {
    const half = (before: number, latest: number, today?: number) =>
      footageDays([
        ...Array.from({ length: 7 }, () => before),
        ...Array.from({ length: 6 }, () => latest),
        today ?? latest,
      ]);

    it('says "Doubled on the 7 days before." when the last 7 days are twice the 7 before', () => {
      expect(footageDaySummary(half(1, 2))).toBe('Doubled on the 7 days before.');
      expect(footageView(half(1, 2), 'week').summary).toBe('Doubled on the 7 days before.');
    });

    it('says Tripled, and Up 2.5× or 4×', () => {
      expect(footageDaySummary(half(1, 3))).toBe('Tripled on the 7 days before.');
      expect(footageDaySummary(half(1, 2.5))).toBe('Up 2.5× on the 7 days before.');
      expect(footageDaySummary(half(1, 4))).toBe('Up 4× on the 7 days before.');
    });

    it('says Halved, and Down by more than half', () => {
      expect(footageDaySummary(half(2, 1))).toBe('Halved on the 7 days before.');
      expect(footageDaySummary(half(2, 0.7))).toBe('Down by more than half on the 7 days before.');
    });

    it('says nothing for a change that is not big', () => {
      expect(footageDaySummary(half(1, 1.4))).toBeNull();
      expect(footageDaySummary(half(1, 0.8))).toBeNull();
    });

    it('does not let today, which is not over, make the line smaller', () => {
      // Today has barely begun: 0.1 h. Counted as an average day of the other six it is 1 h, and
      // the week is the same as the one before, not "Halved".
      expect(footageDaySummary(half(1, 1, 0.1))).toBeNull();
      // Six full days of 0.5 h against 1 h a day is a halving whatever today turns out to be.
      expect(footageDaySummary(half(1, 0.5, 0))).toBe('Halved on the 7 days before.');
    });

    it('says nothing without a fair amount of footage in the 7 days before', () => {
      expect(footageDaySummary(half(0.02, 2))).toBeNull();
      expect(footageDaySummary(half(0, 2))).toBeNull();
    });

    it('says nothing when some day has no data, or there are fewer than 14 days', () => {
      expect(
        footageDaySummary(footageDays([null, ...Array.from({ length: 13 }, () => 1)])),
      ).toBeNull();
      expect(footageDaySummary(footageDays([1, 1, 1, 2, 2, 2]))).toBeNull();
      expect(footageDaySummary([])).toBeNull();
    });

    it('is not the month’s line: it never says "since August"', () => {
      expect(footageSummary(half(1, 2))).toBeNull();
      expect(footageDaySummary(half(1, 2))).not.toContain('since');
    });
  });
});

describe('approved first time, by day', () => {
  const days = approvalDays([null, 0, null, null, 0.5, 1, 1, 1, 1, null, null, 1, 0.5, null]);

  it('labels every third day and "today" under the last', () => {
    expect(approvalLabels(days, 'week')).toEqual([
      'Oct 9',
      '',
      '',
      'Oct 12',
      '',
      '',
      'Oct 15',
      '',
      '',
      'Oct 18',
      '',
      '',
      '',
      'today',
    ]);
    expect(approvalLabels(days).at(-1)).toBe('now');
  });

  it('totals the last 7 days against the 7 before, like the tile', () => {
    expect(approvalSummary(days, 'week')).toBe(
      '7 of 8 approved first time in the last 7 days, was 5 of 8.',
    );
    expect(
      approvalSummary(approvalDays([...Array.from({ length: 12 }, () => null), 1, 0.5]), 'week'),
    ).toBe('3 of 4 approved first time in the last 7 days.');
  });

  it('counts a single day in the last 7 days the same way; Month still names the week', () => {
    const today = approvalDays([...Array.from({ length: 13 }, () => null), 1]);
    expect(approvalSummary(today, 'week')).toBe('2 of 2 approved first time in the last 7 days.');
    expect(approvalSummary(today)).toBe('2 of 2 jobs approved first time this week.');
    const earlier = approvalDays([
      ...Array.from({ length: 10 }, () => null),
      0.5,
      ...[null, null, null],
    ]);
    expect(approvalSummary(earlier, 'week')).toBe('1 of 2 approved first time in the last 7 days.');
    expect(approvalSummary(earlier)).toBe('1 of 2 jobs approved first time the week of Oct 19.');
  });

  it('is a card called "Approved first time, by day"', () => {
    const markup = renderToStaticMarkup(<ApprovedFirstTimeCard weeks={days} period="week" />);

    expect(markup).toMatch(/^<section aria-label="Approved first time, by day"/);
    expect(markup).toContain('aria-label="First-time approval by day"');
    expect(markup).toContain('data-slot="chart"');
    expect(markup).toContain('7 of 8 approved first time in the last 7 days, was 5 of 8.');
  });

  it('says "No data yet" when no job was approved in the 14 days', () => {
    const markup = renderToStaticMarkup(
      <ApprovedFirstTimeCard weeks={approvalDays(NONE)} period="week" />,
    );

    expect(markup).toContain('No data yet');
    expect(markup).toContain('>Approved first time, by day</h3>');
  });
});

describe('A typical job in the week period', () => {
  it('says the last 7 days and the 7 days before in its subtitle', () => {
    const markup = renderToStaticMarkup(
      <TypicalJobCard
        typicalJob={makeAnalyticsResponse({ period: 'week' }).typicalJob}
        period="week"
      />,
    );

    expect(markup).toContain('The median job, last 7 days; “vs before” is the 7 days before');
    expect(markup).toContain('Not enough finished jobs yet');
  });

  it('says the last 30 days for the month', () => {
    const markup = renderToStaticMarkup(
      <TypicalJobCard typicalJob={makeAnalyticsResponse().typicalJob} />,
    );

    expect(markup).toContain('The median job, last 30 days; “vs before” is the 30 days before');
  });
});
