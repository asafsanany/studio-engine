import type { AnalyticsJobs, AnalyticsTile } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { ANALYTICS_TILE_COPY } from './analytics-copy';
import { JobsTiles } from './JobsTiles';

const weekly = (values: (number | null)[]) => values;

/** The board's five tiles, with its numbers. */
const BOARD: AnalyticsJobs['tiles'] = [
  tile('jobs-finished', 'count', 31, 27, weekly([4, 6, 8, 6, 12, 8, 14, 15])),
  tile('clients', 'count', 6, 5, weekly([1, 3, 3, 5, 3, 5, 6, 6])),
  tile(
    'files-in-ready',
    'duration-sec',
    9600,
    11100,
    weekly([12000, 11500, 11600, 10800, 10700, 10300, 9900, 9600]),
  ),
  tile(
    'editing-time',
    'duration-sec',
    3120,
    4140,
    weekly([5000, 4900, 4700, 4400, 4200, 3800, 3500, 3120]),
  ),
  {
    ...tile(
      'approved-first-time',
      'ratio',
      19 / 24,
      14 / 21,
      weekly([0.5, 0.45, 0.6, 0.7, 0.75, 0.8, 0.82, 0.79]),
    ),
    numerator: 19,
    denominator: 24,
    previousNumerator: 14,
    previousDenominator: 21,
  },
];

function tile(
  key: AnalyticsTile['key'],
  unit: AnalyticsTile['unit'],
  value: number | null,
  previous: number | null,
  weeks: (number | null)[],
): AnalyticsTile {
  return {
    key,
    unit,
    value,
    previous,
    numerator: null,
    denominator: null,
    previousNumerator: null,
    previousDenominator: null,
    series: weeks,
  };
}

describe('<JobsTiles> with the board’s numbers', () => {
  const markup = renderToStaticMarkup(<JobsTiles tiles={BOARD} />);

  it('is five tiles in the order of the board, each with its title and subtitle', () => {
    const titles = [...markup.matchAll(/<section aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual([
      'Jobs finished',
      'Clients',
      'Files in → ready',
      'Editing time',
      'Approved first time',
    ]);
    for (const copy of Object.values(ANALYTICS_TILE_COPY)) {
      expect(markup).toContain(`>${copy.title}</h3>`);
      expect(markup).toContain(`>${copy.subtitle}</p>`);
    }
  });

  it('says the number in 28 px, and then the change line, for each tile', () => {
    const numbers = [...markup.matchAll(/<span class="text-\[28px\][^"]*">([^<]*)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(numbers).toEqual(['31', '6', '2 h 40 m', '52 min', '19 of 24']);
    for (const line of [
      '+4 on the 30 days before',
      '+1 on the 30 days before',
      '25 min faster',
      '17 min faster',
      'was 14 of 21',
    ]) {
      expect(markup).toContain(`>${line}</span>`);
    }
  });

  it('colours a change that got better green', () => {
    expect(markup.match(/text-\[#4ADE80\]/g)).toHaveLength(5);
    expect(markup).not.toContain('text-[#F87171]');
  });

  it('puts a sparkline under each number, full width and 32 px high', () => {
    expect(markup.match(/<div data-slot="chart"[^>]*aria-hidden="true"/g)).toHaveLength(5);
    expect(markup.match(/class="[^"]*\bh-8\b[^"]*\bw-full\b/g)).toHaveLength(5);
  });

  it('draws only the tiles, so the page can lay them out in its own grid', () => {
    expect(markup.startsWith('<section')).toBe(true);
    expect(markup).not.toMatch(/class="[^"]*\bgrid\b/);
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
  });
});

describe('<JobsTiles> when things got worse or stayed', () => {
  it('colours a worse change red and an equal one grey', () => {
    const worse = tile('jobs-finished', 'count', 3, 5, weekly([1, 2, 3, 4, 5, 4, 3, 3]));
    const same = tile('clients', 'count', 4, 4, weekly([4, 4, 4, 4, 4, 4, 4, 4]));
    const markup = renderToStaticMarkup(<JobsTiles tiles={[worse, same]} />);
    expect(markup).toMatch(/text-\[#F87171\][^>]*">(?:<svg.*?<\/svg>)?−2 on the 30 days before</);
    expect(markup).toMatch(
      /text-muted-foreground[^>]*">(?:<svg.*?<\/svg>)?Same as the 30 days before</,
    );
  });
});

describe('<JobsTiles> with nothing to count', () => {
  const answer = makeAnalyticsResponse();
  const markup = renderToStaticMarkup(<JobsTiles tiles={answer.jobs.tiles} />);

  it('shows a dash for each tile, with its title and subtitle', () => {
    const numbers = [...markup.matchAll(/<span class="text-\[28px\][^"]*">([^<]*)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(numbers).toEqual(['—', '—', '—', '—', '—']);
    for (const copy of Object.values(ANALYTICS_TILE_COPY)) {
      expect(markup).toContain(`>${copy.title}</h3>`);
      expect(markup).toContain(`>${copy.subtitle}</p>`);
    }
  });

  it('keeps each sparkline’s height with no numbers to draw', () => {
    expect(markup.match(/class="[^"]*\bh-8\b[^"]*\bw-full\b/g)).toHaveLength(5);
  });
});
