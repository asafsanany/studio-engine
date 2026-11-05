import { type AnalyticsFootageBucket, addDays } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { ANALYTICS_CARDS } from './analytics-copy';
import { CHART_GREEN } from './charts/chart-colors';
import { FootagePerWeekCard } from './FootagePerWeekCard';

/** 12 weeks from Sunday 2 August 2026 to this week (18 October), with these hours. */
function weeks(hours: (number | null)[]): AnalyticsFootageBucket[] {
  return hours.map((value, i) => ({ start: addDays('2026-08-02', 7 * i), hours: value }));
}

const BOARD = weeks([2.1, 2.5, 2.3, 3, 2.9, 3.4, 3.1, 3.7, 3.4, 4, 3.8, 4.2]);

describe('<FootagePerWeekCard> with footage', () => {
  const markup = renderToStaticMarkup(<FootagePerWeekCard weeks={BOARD} />);

  it('has the title and subtitle of the board', () => {
    expect(markup).toContain(`aria-label="${ANALYTICS_CARDS.footagePerWeek.title}"`);
    expect(markup).toContain('>Footage edited per week</h3>');
    expect(markup).toContain('>Hours of raw footage the editor went through</p>');
  });

  it('draws one chart in green, named for a screen reader, as wide as its card', () => {
    expect(markup).toMatch(
      /<div data-slot="chart"[^>]*role="img" aria-label="Footage hours per week"/,
    );
    expect(markup.match(/data-slot="chart"/g)).toHaveLength(1);
    expect(markup).toContain(`--color-value: ${CHART_GREEN}`);
    expect(markup).toContain('absolute inset-0');
  });

  it('says one plain line under the chart when it is true', () => {
    expect(markup).toContain('>Doubled since August.</p>');
  });
});

describe('<FootagePerWeekCard> with a change that is not worth a line', () => {
  it('has no line under the chart', () => {
    const markup = renderToStaticMarkup(
      <FootagePerWeekCard weeks={weeks([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2.2])} />,
    );
    expect(markup).toContain('data-slot="chart"');
    expect(markup).not.toContain('since');
  });
});

describe('<FootagePerWeekCard> with a few minutes of footage', () => {
  it('counts the axis in minutes, with room for "60 min" on the left', () => {
    const markup = renderToStaticMarkup(
      <FootagePerWeekCard
        weeks={weeks([null, null, null, null, null, null, null, null, null, null, null, 0.1])}
      />,
    );
    expect(markup).toContain('aria-label="Footage minutes per week"');
    expect(markup).toContain('data-slot="chart"');
  });
});

describe('<FootagePerWeekCard> with nothing recorded', () => {
  it('says "No data yet" under its title', () => {
    const answer = makeAnalyticsResponse();
    const markup = renderToStaticMarkup(<FootagePerWeekCard weeks={answer.jobs.footage} />);
    expect(markup).toContain('>Footage edited per week</h3>');
    expect(markup).toContain('No data yet');
    expect(markup).not.toContain('<svg');
  });

  it('read nothing but its numbers and has nothing to click', () => {
    const markup = renderToStaticMarkup(<FootagePerWeekCard weeks={BOARD} />);
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
  });
});
