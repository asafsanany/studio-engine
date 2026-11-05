import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeEpisodeJob, makeSeriesSummary } from '@/data/test-utils';
import { SeriesPageScope } from '@/features/series/series-page-context';
import { canvasJob, textOf } from './cells/test-helpers';
import { JobDetail } from './JobDetail';

/** The engine's health answer with the Series switch on: the marks show only while series are on. */
const SERIES_ON = { ok: true, version: '0.0.0', settleMs: 60_000, series: true };

// An editing job of a series says which episode it follows. A job that is in no series never asks
// for the series (these other tests render it without a query client).

const EDITING = { ...canvasJob('j5'), ...makeEpisodeJob({ state: 'editing' }) };

function detail(job: typeof EDITING, onSeriesPage = false) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(clientSeriesKey(job.clientId), [makeSeriesSummary()]);
  queryClient.setQueryData(HEALTH_KEY, SERIES_ON);
  return textOf(
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SeriesPageScope value={onSeriesPage}>
          <JobDetail job={job} />
        </SeriesPageScope>
      </QueryClientProvider>,
    ),
  );
}

describe('<JobDetail> of an episode', () => {
  it('editing: the step, which episode it follows, then the time left', () => {
    const job = {
      ...EDITING,
      step: canvasJob('j5').step,
      subProgress: 'graphics 2/5',
      etaSec: 240,
    };
    expect(detail(job)).toBe('Cut · graphics 2/5 · follows episode 5 · ~4 min left');
  });

  it('keeps the step label whole, so the table’s step tests still find it', () => {
    const job = {
      ...EDITING,
      step: canvasJob('j5').step,
      subProgress: 'graphics 2/5',
      etaSec: 240,
    };
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(clientSeriesKey(job.clientId), [makeSeriesSummary()]);
    queryClient.setQueryData(HEALTH_KEY, SERIES_ON);
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobDetail job={job} />
      </QueryClientProvider>,
    );
    expect(markup).toContain('<span data-step-label="">Cut · graphics 2/5</span>');
  });

  it('is the plain line on a series’ own page', () => {
    const job = { ...EDITING, step: canvasJob('j5').step, subProgress: null, etaSec: 120 };
    expect(detail(job, true)).toBe('Cut · ~2 min left');
  });

  it('is unchanged for an episode that is not editing', () => {
    expect(detail({ ...EDITING, state: 'queued', placeInLine: 1 })).toBe('Queued · #1 in line');
  });
});
