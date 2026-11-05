import type { Job, SeriesSummary } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeEpisodeJob, makeSeriesSummary } from '@/data/test-utils';
import { FollowsEpisode, followsEpisodeText } from './FollowsEpisode';
import { SeriesPageScope } from './series-page-context';

/** The engine's health answer with the Series switch on: the marks show only while series are on. */
const SERIES_ON = { ok: true, version: '0.0.0', settleMs: 60_000, series: true };

const SERIES = makeSeriesSummary();

/** What the detail would say for `job`, given the client's series as they are cached. */
function detail(
  job: Job,
  text: string,
  step: string,
  series: SeriesSummary[] | null = [SERIES],
  onSeriesPage = false,
) {
  const queryClient = createTestQueryClient();
  if (series !== null) queryClient.setQueryData(clientSeriesKey(job.clientId), series);
  queryClient.setQueryData(HEALTH_KEY, SERIES_ON);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SeriesPageScope value={onSeriesPage}>
        <FollowsEpisode job={job} text={text} step={step}>
          {(follows) => <span>{follows}</span>}
        </FollowsEpisode>
      </SeriesPageScope>
    </QueryClientProvider>,
  );
}

describe('followsEpisodeText', () => {
  it('puts "follows episode N" after the step, before the time left', () => {
    expect(followsEpisodeText('Cut · ~2 min left', 'Cut', 5)).toBe(
      'Cut · follows episode 5 · ~2 min left',
    );
    expect(followsEpisodeText('Cut · graphics 2/5 · ~4 min left', 'Cut · graphics 2/5', 5)).toBe(
      'Cut · graphics 2/5 · follows episode 5 · ~4 min left',
    );
  });

  it('adds it at the end when there is nothing after the step, or no step', () => {
    expect(followsEpisodeText('Transcribe', 'Transcribe', 12)).toBe(
      'Transcribe · follows episode 12',
    );
    expect(followsEpisodeText('Editing', '', 5)).toBe('Editing · follows episode 5');
  });
});

describe('<FollowsEpisode>', () => {
  const editing = makeEpisodeJob({ state: 'editing' });

  it('says which episode an editing episode follows, from the format job’s number', () => {
    expect(detail(editing, 'Cut · ~2 min left', 'Cut')).toBe(
      '<span>Cut · follows episode 5 · ~2 min left</span>',
    );
  });

  it('follows the format when it changes to another episode', () => {
    const series = [makeSeriesSummary({ formatJob: 'מיתוס או אמת #12' })];
    expect(detail(editing, 'Cut', 'Cut', series)).toBe('<span>Cut · follows episode 12</span>');
  });

  it('leaves the text alone when the format job’s name has no number', () => {
    const series = [makeSeriesSummary({ formatJob: 'Pilot' })];
    expect(detail(editing, 'Cut · ~2 min left', 'Cut', series)).toBe(
      '<span>Cut · ~2 min left</span>',
    );
  });

  it('leaves the text alone until the client’s series are loaded', () => {
    expect(detail(editing, 'Cut · ~2 min left', 'Cut', null)).toBe(
      '<span>Cut · ~2 min left</span>',
    );
  });

  it('leaves the text alone on a series’ own page, where every row is an episode', () => {
    expect(detail(editing, 'Cut · ~2 min left', 'Cut', [SERIES], true)).toBe(
      '<span>Cut · ~2 min left</span>',
    );
  });
});
