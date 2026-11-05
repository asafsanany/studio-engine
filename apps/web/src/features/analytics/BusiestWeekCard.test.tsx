import type { AnalyticsLimitBucket } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_CARDS, cardCopy } from './analytics-copy';
import { BusiestWeekCard } from './BusiestWeekCard';

const DAY = 86_400_000;
// The newest weekly window starts on 17 Oct (it ends on the 24th); the newest day is 22 Oct.
const NEWEST_START = Date.UTC(2026, 9, 17);
const TODAY = Date.UTC(2026, 9, 22);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function windows(
  peaks: (number | null)[],
  hits: number[] = [],
  spent: (number | null)[] = [],
): AnalyticsLimitBucket[] {
  return peaks.map((peak, i) => ({
    start: dayOf(NEWEST_START - 7 * DAY * (peaks.length - 1 - i)),
    peak,
    hitLimit: hits.includes(i),
    current: i === peaks.length - 1,
    apiShare: spent[i] ?? null,
  }));
}

function days(
  peaks: (number | null)[],
  hits: number[] = [],
  spent: (number | null)[] = [],
): AnalyticsLimitBucket[] {
  return peaks.map((peak, i) => ({
    start: dayOf(TODAY - DAY * (peaks.length - 1 - i)),
    peak,
    hitLimit: hits.includes(i),
    current: i === peaks.length - 1,
    apiShare: spent[i] ?? null,
  }));
}

const WEEK_BASE =
  'Plan: the highest use each week. API: what the app spent that week, of the month’s credits.';
const DAY_BASE =
  'Plan: the highest five-hour use each day. API: what the app spent that day, of the month’s credits.';

const render = (weeks: AnalyticsLimitBucket[]) =>
  renderToStaticMarkup(<BusiestWeekCard weeks={weeks} />);

describe('<BusiestWeekCard>', () => {
  // The app spent from the fourth window on (the key came later): 5 bars of blue to 8 of the plan.
  const spent = [null, null, null, 0, 0.04, 0.1, 0.12, 0.2];
  const markup = render(windows([0.52, 0.67, 1, 0.34, 0.3, 0.84, 0.36, 0.32], [2], spent));

  it('is the card of the board, with its title and its subtitle', () => {
    expect(markup).toMatch(/^<section aria-label="Busiest week, last 8 weeks"/);
    expect(markup).toContain(`>${ANALYTICS_CARDS.busiestWeek.title}</h3>`);
    expect(markup).toContain(`>${ANALYTICS_CARDS.busiestWeek.subtitle}</p>`);
  });

  it('has the key of the two budgets, blue for the credits and orange for the plan', () => {
    expect(markup).toContain('API credits');
    expect(markup).toContain('Max plan');
    expect(markup).toContain('background:#3987e5');
    expect(markup).toContain('background:#d95926');
  });

  it('draws one chart that fills its card, an image a screen reader can name', () => {
    expect(markup.match(/data-slot="chart"/g)).toHaveLength(1);
    expect(markup).toMatch(
      /role="img" aria-label="What the app spent of the credits and the plan’s peak weekly use, for the last 8 weeks"/,
    );
    expect(markup).toContain('absolute inset-0');
    expect(markup).toContain('min-h-[400px]');
  });

  it('says which week hit the limit under the chart', () => {
    expect(markup).toContain(`${WEEK_BASE} Week of Sep 12 hit the limit (red).`);
  });

  it('keeps its chart and its words when most weeks have no reading', () => {
    const gaps = render(windows([null, null, 0.4, null, null, null, 0.5, 0.2]));

    expect(gaps).toContain('data-slot="chart"');
    expect(gaps).toContain(WEEK_BASE);
    expect(gaps).not.toContain('hit the limit (red)');
  });

  it('says "No data yet" when no week has a reading and the app spent nothing', () => {
    const empty = render(windows(Array(8).fill(null), [], Array(8).fill(0)));

    expect(empty).toContain('No data yet');
    expect(empty).not.toContain('data-slot="chart"');
    expect(empty).toContain('>Busiest week, last 8 weeks</h3>');
  });

  it('still draws the credits when the plan has no reading yet', () => {
    const onlyApi = render(windows(Array(8).fill(null), [], [0, 0, 0, 0.1, 0.2, 0, 0.3, 0.1]));

    expect(onlyApi).not.toContain('No data yet');
    expect(onlyApi).toContain('data-slot="chart"');
  });
});

describe('<BusiestWeekCard> in the week period', () => {
  const peaks = [0.5, 0.6, null, 0.3, 0.4, 0.5, 0.2, 0.7, 0.8, 1, 0.5, 0.4, 0.6, 0.3];
  // The app spent on the last six days.
  const spent = [null, null, null, null, null, null, null, null, 0, 0.02, 0, 0.05, 0.01, 0.03];
  const markup = renderToStaticMarkup(
    <BusiestWeekCard weeks={days(peaks, [9], spent)} period="week" />,
  );

  it('is "Busiest day, last 14 days", with the subtitle that goes with it', () => {
    expect(markup).toMatch(/^<section aria-label="Busiest day, last 14 days"/);
    expect(markup).toContain(`>${cardCopy('week').busiestWeek.subtitle}</p>`);
    expect(markup).not.toContain('busiest week');
  });

  it('draws one chart, named for a screen reader', () => {
    expect(markup.match(/data-slot="chart"/g)).toHaveLength(1);
    expect(markup).toMatch(
      /role="img" aria-label="What the app spent of the credits and the plan’s peak five-hour use, for the last 14 days"/,
    );
  });

  it('says which day hit the limit under the chart', () => {
    expect(markup).toContain(`${DAY_BASE} Oct 18 hit the limit (red).`);
    expect(markup).not.toContain('>now</text>');
  });

  it('says "No data yet" when no day has a reading', () => {
    const empty = renderToStaticMarkup(
      <BusiestWeekCard weeks={days(Array(14).fill(null))} period="week" />,
    );

    expect(empty).toContain('No data yet');
    expect(empty).toContain('>Busiest day, last 14 days</h3>');
  });
});
