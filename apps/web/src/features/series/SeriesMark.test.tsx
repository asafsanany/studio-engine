import type { Job, SeriesSummary } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import {
  createTestQueryClient,
  makeEpisodeJob,
  makeFormatJob,
  makeSeriesSummary,
} from '@/data/test-utils';
import { SeriesMark, seriesMarkText } from './SeriesMark';
import { SeriesPageScope } from './series-page-context';

/** The engine's health answer with the Series switch on: the marks show only while series are on. */
const SERIES_ON = { ok: true, version: '0.0.0', settleMs: 60_000, series: true };

const SERIES = makeSeriesSummary();

/** The mark of `job`, with the client's series as the menu and the list would have read them. */
function mark(job: Job, series: SeriesSummary[] | null = [SERIES], onSeriesPage = false) {
  const queryClient = createTestQueryClient();
  if (series !== null) queryClient.setQueryData(clientSeriesKey(job.clientId), series);
  queryClient.setQueryData(HEALTH_KEY, SERIES_ON);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SeriesPageScope value={onSeriesPage}>
          <SeriesMark job={job} />
        </SeriesPageScope>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('seriesMarkText', () => {
  it('names the episode and the series', () => {
    expect(seriesMarkText(makeEpisodeJob(), SERIES)).toEqual({
      lead: 'Episode 6 of ',
      name: 'מיתוס או אמת',
      format: false,
    });
  });

  it('says the format job is the format of the series', () => {
    expect(seriesMarkText(makeFormatJob(), SERIES)).toEqual({
      lead: 'The format of the series ',
      name: 'מיתוס או אמת',
      format: true,
    });
  });

  it('says "In the series" for a job that was put in by hand and has no number in its name', () => {
    expect(seriesMarkText(makeEpisodeJob({ episode: null }), SERIES)).toEqual({
      lead: 'In the series ',
      name: 'מיתוס או אמת',
      format: false,
    });
  });

  it('leaves the name out until the client’s series are loaded', () => {
    expect(seriesMarkText(makeEpisodeJob(), null)).toEqual({
      lead: 'Episode 6 of a series',
      name: null,
      format: false,
    });
    expect(seriesMarkText(makeEpisodeJob({ episode: null }), null).lead).toBe('In a series');
  });
});

describe('<SeriesMark>', () => {
  it('is a muted 14 px Layers2 that says which episode of which series it is', () => {
    const markup = mark(makeEpisodeJob());
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Episode 6 of מיתוס או אמת"');
    expect(markup).toContain('text-muted-foreground');
    expect(markup).toMatch(/<svg[^>]*width="14"[^>]*height="14"/);
    expect(markup).toContain('lucide-layers');
  });

  it('is reachable by the keyboard, like the note’s mark', () => {
    expect(mark(makeEpisodeJob())).toContain('tabindex="0"');
  });

  it('says it is the format on the format job', () => {
    expect(mark(makeFormatJob())).toContain('aria-label="The format of the series מיתוס או אמת"');
  });

  it('draws nothing while the client’s series are on their way, so a row never shows a series it can’t name', () => {
    expect(mark(makeEpisodeJob(), null)).toBe('');
  });

  it('draws nothing for a series the client no longer has (undone, or its folder deleted)', () => {
    expect(mark(makeEpisodeJob(), [])).toBe('');
  });

  it('on a series’ own page the icon gives way to a muted "Format" after the format job’s name', () => {
    const markup = mark(makeFormatJob(), [SERIES], true);
    expect(markup).toContain('>Format</span>');
    expect(markup).toContain('text-muted-foreground');
    expect(markup).not.toContain('<svg');
  });

  it('and draws nothing for the other episodes there', () => {
    expect(mark(makeEpisodeJob(), [SERIES], true)).toBe('');
  });
});
