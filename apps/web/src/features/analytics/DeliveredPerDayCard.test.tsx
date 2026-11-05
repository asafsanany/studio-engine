import { type AnalyticsDay, addDays } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { ANALYTICS_CARDS } from './analytics-copy';
import { DeliveredPerDayCard } from './DeliveredPerDayCard';
import { DELIVERY_LEGEND_COLORS } from './delivery-calendar-view';

/** 91 days from Sunday 26 July 2026; days up to 22 October are real counts, the rest have not come. */
function days(count: (i: number) => number): AnalyticsDay[] {
  return Array.from({ length: 91 }, (_, i) => {
    const date = addDays('2026-07-26', i);
    return { date, count: date > '2026-10-22' ? null : count(i) };
  });
}

describe('<DeliveredPerDayCard> with deliveries', () => {
  const markup = renderToStaticMarkup(<DeliveredPerDayCard days={days((i) => i % 4)} />);

  it('has the title and subtitle of the board', () => {
    expect(markup).toContain(`aria-label="${ANALYTICS_CARDS.deliveredPerDay.title}"`);
    expect(markup).toContain('>Jobs delivered per day</h3>');
    expect(markup).toContain('>Last 13 weeks</p>');
  });

  it('labels the seven weekdays and the months', () => {
    for (const weekday of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(markup).toContain(`>${weekday}</span>`);
    }
    for (const month of ['Aug', 'Sep', 'Oct']) expect(markup).toContain(`>${month}</span>`);
  });

  it('draws a cell for each of the 91 days, each deeper blue for more jobs', () => {
    expect(markup.match(/class="h-full w-full rounded-\[3px\]"/g)).toHaveLength(91);
    // Day 0 (Sunday 26 July) has 0 jobs: the faint tint; day 1 has 1; day 2 has 2; day 3 has 3.
    for (const color of ['#256abf', '#5598e7', '#86b6ef']) {
      expect(markup).toContain(`background:${color}`);
    }
    expect(markup).toContain('background:rgba(255,255,255,0.05)');
  });

  it('makes the days that have come a hover target, and leaves the days to come empty', () => {
    // Friday 23 and Saturday 24 October have no colour and no hover card.
    const cells = markup.match(/<span[^>]*class="h-full w-full rounded-\[3px\]"[^>]*>/g) ?? [];
    expect(cells.filter((cell) => !cell.includes('style='))).toHaveLength(2);
    expect(cells.filter((cell) => cell.includes('data-state="closed"'))).toHaveLength(89);
  });

  it('ends with the 0 … 3+ legend', () => {
    expect(markup).toMatch(/>0(<span[^>]*size-3[^>]*><\/span>){9}3\+</);
    for (const color of DELIVERY_LEGEND_COLORS) expect(markup).toContain(`background:${color}`);
  });

  it('tells a screen reader the total, and has nothing to click', () => {
    expect(markup).toMatch(/role="img" aria-label="\d+ jobs delivered in the last 13 weeks"/);
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
  });
});

describe('<DeliveredPerDayCard> with nothing recorded', () => {
  it('says "No data yet" under its title', () => {
    const answer = makeAnalyticsResponse();
    const markup = renderToStaticMarkup(<DeliveredPerDayCard days={answer.jobs.deliveredPerDay} />);
    expect(markup).toContain('>Jobs delivered per day</h3>');
    expect(markup).toContain('No data yet');
    expect(markup).not.toContain('rounded-[3px]');
  });
});

describe('<DeliveredPerDayCard> with a quiet quarter', () => {
  it('draws the empty calendar, since zero jobs is a real answer', () => {
    const markup = renderToStaticMarkup(<DeliveredPerDayCard days={days(() => 0)} />);
    expect(markup).not.toContain('No data yet');
    expect(markup).toContain('aria-label="No jobs delivered in the last 13 weeks"');
    expect(markup.match(/class="h-full w-full rounded-\[3px\]"/g)).toHaveLength(91);
  });
});

describe('<DeliveredPerDayCard> in the week period', () => {
  const markup = renderToStaticMarkup(
    <DeliveredPerDayCard days={days((i) => i % 4)} period="week" />,
  );

  it('is the last 14 days as a bar each, in place of the calendar', () => {
    expect(markup).toContain('aria-label="Jobs delivered per day"');
    expect(markup).toContain('>Last 14 days</p>');
    expect(markup).toContain(
      'role="img" aria-label="Jobs delivered per day, for the last 14 days"',
    );
    expect(markup).not.toContain('>Sun</span>');
    expect(markup).not.toContain('Last 13 weeks');
  });

  it('says "No data yet" with nothing recorded', () => {
    const none = renderToStaticMarkup(
      <DeliveredPerDayCard days={makeAnalyticsResponse().jobs.deliveredPerDay} period="week" />,
    );
    expect(none).toContain('No data yet');
  });
});
