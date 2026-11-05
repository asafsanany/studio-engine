import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import {
  createTestQueryClient,
  makeEpisodeJob,
  makeFormatJob,
  makeJob,
  makeSeriesSummary,
} from '@/data/test-utils';
import { SeriesPageScope } from '@/features/series/series-page-context';
import { JobsList } from './JobsList';
import { createTestStore } from './test-jobs';

/** The engine's health answer with the Series switch on: the marks show only while series are on. */
const SERIES_ON = { ok: true, version: '0.0.0', settleMs: 60_000, series: true };

// Rows link the client's name to its page; these tests render without a router, so a link is a plain anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

// Series in the list: an episode has the Layers2 mark between its name and its client. A job in no
// series has none, and a page with series off has no episodes.

const SERIES = makeSeriesSummary();

function list(
  jobs: Job[],
  { clientId, onSeriesPage = false } = {} as {
    clientId?: string;
    onSeriesPage?: boolean;
  },
) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(clientSeriesKey(makeEpisodeJob().clientId), [SERIES]);
  queryClient.setQueryData(HEALTH_KEY, SERIES_ON);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SeriesPageScope value={onSeriesPage}>
        <JobsList jobs={jobs} store={createTestStore()} clientId={clientId} />
      </SeriesPageScope>
    </QueryClientProvider>,
  );
}

/** The `<li>` of one job's row. */
function rowOf(markup: string, id: string): string {
  const row = markup.match(new RegExp(`<li [^>]*data-job-id="${id}"[\\s\\S]*?</li>`))?.[0];
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe('<JobsList> with series', () => {
  it('marks an episode between its name and its client', () => {
    const episode = makeEpisodeJob();
    const row = rowOf(list([episode]), episode.id);
    const name = row.indexOf('מיתוס או אמת 6');
    const mark = row.indexOf('aria-label="Episode 6 of מיתוס או אמת"');
    const client = row.indexOf('עו״ד דוד לוי');
    expect(name).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(name);
    expect(client).toBeGreaterThan(mark);
  });

  it('marks the format job as the format of the series', () => {
    const format = makeFormatJob();
    expect(rowOf(list([format]), format.id)).toContain(
      'aria-label="The format of the series מיתוס או אמת"',
    );
  });

  it('marks no job that is in no series', () => {
    const job = makeJob({ id: 'plain' });
    const row = rowOf(list([job]), 'plain');
    expect(row).not.toContain('lucide-layers');
    expect(row).not.toContain('Episode');
  });

  it('a client’s page marks its episodes too', () => {
    const episode = makeEpisodeJob();
    expect(rowOf(list([episode], { clientId: episode.clientId }), episode.id)).toContain(
      'aria-label="Episode 6 of מיתוס או אמת"',
    );
  });

  it('a series’ own page has no mark, only "Format" after the format job’s name', () => {
    const episode = makeEpisodeJob();
    const format = makeFormatJob();
    const markup = list([episode, format], { clientId: episode.clientId, onSeriesPage: true });
    expect(rowOf(markup, episode.id)).not.toContain('lucide-layers');
    expect(rowOf(markup, format.id)).not.toContain('lucide-layers');
    expect(rowOf(markup, format.id)).toContain('>Format</span>');
    expect(rowOf(markup, episode.id)).not.toContain('>Format</span>');
  });
});
