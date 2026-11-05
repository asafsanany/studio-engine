import type { AnalyticsApprovalBucket } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { ApprovedFirstTimeCard } from './ApprovedFirstTimeCard';
import { ANALYTICS_CARDS } from './analytics-copy';
import { CHART_BLUE } from './charts/chart-colors';

const empty = makeAnalyticsResponse().reviews.approvedFirstTime;

/** The 12 empty weeks of the test answer with `results` by index put in: [first time, approved]. */
function weeksWith(results: Record<number, [number, number]>): AnalyticsApprovalBucket[] {
  return empty.map((week, i) => {
    const [firstTime, approved] = results[i] ?? [0, 0];
    return { ...week, firstTime, approved, share: approved === 0 ? null : firstTime / approved };
  });
}

describe('<ApprovedFirstTimeCard>', () => {
  const weeks = weeksWith({
    0: [11, 20],
    1: [6, 10],
    3: [4, 6],
    4: [5, 7],
    5: [6, 8],
    7: [3, 4],
    8: [7, 9],
    9: [8, 10],
    10: [9, 11],
    11: [19, 24],
  });
  const markup = renderToStaticMarkup(<ApprovedFirstTimeCard weeks={weeks} />);

  it('is the card of the board: its title and subtitle, 500 px tall, half the row', () => {
    expect(markup).toContain(`aria-label="${ANALYTICS_CARDS.approvedFirstTime.title}"`);
    expect(markup).toContain('>Approved first time, by week</h3>');
    expect(markup).toContain('>Share of reviewed jobs you approved without notes</p>');
    expect(markup).toContain('h-[500px]');
    expect(markup).toContain('min-[1000px]:col-span-3');
  });

  it('draws one blue line chart named for a screen reader, as wide as its card', () => {
    expect(markup.match(/data-slot="chart"/g)).toHaveLength(1);
    expect(markup).toMatch(
      /<div data-slot="chart"[^>]*role="img" aria-label="First-time approval by week"/,
    );
    expect(markup).toContain(`--color-value: ${CHART_BLUE}`);
  });

  it('says in one muted line where the share went', () => {
    expect(markup).toContain('>Up from 55% to 79% since Aug 2.</p>');
    expect(markup).toMatch(/<p class="[^"]*text-xs[^"]*text-muted-foreground[^"]*">Up from/);
  });

  it('lets the chart take what height the card has left and keeps the summary in view', () => {
    expect(markup).toContain('absolute inset-0');
    expect(markup).toContain('shrink-0');
  });

  it('is read-only', () => {
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('<input');
  });

  it('says a single week of approvals with its count in the line under the chart', () => {
    const one = renderToStaticMarkup(<ApprovedFirstTimeCard weeks={weeksWith({ 11: [2, 3] })} />);

    expect(one).toContain('>2 of 3 jobs approved first time this week.</p>');
  });

  it('draws a week where nothing was first time as a real 0%, not a gap', () => {
    const zero = renderToStaticMarkup(
      <ApprovedFirstTimeCard weeks={weeksWith({ 10: [0, 2], 11: [1, 2] })} />,
    );

    expect(zero).toContain('>Up from 0% to 50% since Oct 11.</p>');
  });

  it('says "No data yet" and draws no chart when no job was approved in the 12 weeks', () => {
    const none = renderToStaticMarkup(<ApprovedFirstTimeCard weeks={empty} />);

    expect(none).toContain('>Approved first time, by week</h3>');
    expect(none).toContain('>No data yet</p>');
    expect(none).not.toContain('<svg');
  });
});
