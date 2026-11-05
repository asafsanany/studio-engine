import type { Job, SeriesSummary } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeEpisodeJob, makeSeriesSummary } from '@/data/test-utils';
import { useEpisodeSeriesName } from './use-episode-series';

/** The engine's health answer; the Series switch is what the toggle follows. */
const health = (series: boolean) => ({ ok: true, version: '0.0.0', settleMs: 60_000, series });

const MYTH = makeSeriesSummary();

interface World {
  /** The Series switch; `null` leaves the health answer out (not heard yet). */
  on?: boolean | null;
  /** The client's series; `null` leaves the list out (not loaded yet). */
  series?: SeriesSummary[] | null;
}

/** What the hook says for `job`, with the data the server would have sent. */
function nameFor(job: Pick<Job, 'clientId' | 'seriesId'>, { on = true, series = [MYTH] }: World) {
  const queryClient = createTestQueryClient();
  if (on !== null) queryClient.setQueryData(HEALTH_KEY, health(on));
  if (series !== null) queryClient.setQueryData(clientSeriesKey(job.clientId), series);
  let name: string | null | undefined;
  function Capture() {
    name = useEpisodeSeriesName(job);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Capture />
    </QueryClientProvider>,
  );
  return name;
}

describe('useEpisodeSeriesName', () => {
  it('names the series of an episode while series are on', () => {
    expect(nameFor(makeEpisodeJob(), {})).toBe('מיתוס או אמת');
  });

  it('picks the job’s own series out of the client’s list', () => {
    const faq = makeSeriesSummary({ id: 'b1b1b1b1b1b1', name: 'שאלות נפוצות' });
    expect(nameFor(makeEpisodeJob({ seriesId: faq.id }), { series: [MYTH, faq] })).toBe(
      'שאלות נפוצות',
    );
  });

  it('is null while series are off, or before the health answer is in', () => {
    expect(nameFor(makeEpisodeJob(), { on: false })).toBeNull();
    expect(nameFor(makeEpisodeJob(), { on: null })).toBeNull();
  });

  it('is null for a job in no series', () => {
    expect(nameFor(makeEpisodeJob({ seriesId: null, episode: null }), {})).toBeNull();
  });

  it('is null until the client’s series are loaded, and when the list does not hold the series', () => {
    expect(nameFor(makeEpisodeJob(), { series: null })).toBeNull();
    expect(nameFor(makeEpisodeJob(), { series: [] })).toBeNull();
    expect(
      nameFor(makeEpisodeJob(), { series: [makeSeriesSummary({ id: 'b1b1b1b1b1b1' })] }),
    ).toBeNull();
  });
});
