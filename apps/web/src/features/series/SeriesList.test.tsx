import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeSeriesSummary, SERIES_CLIENT } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { SeriesList, SeriesMeta } from './SeriesList';

const MYTH = makeSeriesSummary({
  id: '622212180eef',
  name: 'מיתוס או אמת',
  episodeCount: 4,
  lastEpisodeAt: '2026-10-21T11:00:00.000Z',
});
const FAQ = makeSeriesSummary({
  id: 'b1b1b1b1b1b1',
  name: 'שאלות נפוצות',
  formatJob: 'שאלות נפוצות 5',
  episodeCount: 2,
  lastEpisodeAt: '2026-10-21T10:55:00.000Z',
});

const list = (series = [MYTH, FAQ]) =>
  renderAt(
    `/clients/${SERIES_CLIENT.clientId}`,
    <SeriesList clientId={SERIES_CLIENT.clientId} series={series} />,
  );

/** What a series' meta text says, as plain text. */
const meta = (summary: Parameters<typeof SeriesMeta>[0]['series']) =>
  renderToStaticMarkup(<SeriesMeta series={summary} />).replace(/<\/?bdi>/g, '');

describe('the client page’s Series list', () => {
  it('is a "Series" section with one row per series', async () => {
    const markup = await list();
    expect(markup).toMatch(/<h2[^>]*id="client-series"[^>]*>Series<\/h2>/);
    expect(markup).toContain('aria-labelledby="client-series"');
    expect(markup.match(/<li>/g)).toHaveLength(2);
  });

  it('opens the series page from a row: a link to the client’s series address', async () => {
    const markup = await list();
    expect(markup).toContain(`href="/clients/${SERIES_CLIENT.clientId}/series/622212180eef"`);
    expect(markup).toContain(`href="/clients/${SERIES_CLIENT.clientId}/series/b1b1b1b1b1b1"`);
  });

  it('draws a row as the Jobs list’s own grid, with the Layers2 icon, the name and a chevron', async () => {
    const row = (await list()).match(/<a [^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
    expect(row).toContain('grid h-11 grid-cols-[16px_minmax(0,1fr)_auto_80px_32px]');
    expect(row).toContain('lucide-layers-2');
    expect(row).toContain('lucide-chevron-right');
    expect(row).toMatch(/dir="auto"[^>]*>מיתוס או אמת<\/span>/);
    expect(row).toContain('font-medium');
  });

  it('shows the time of the last episode, and nothing for a series without one', async () => {
    const markup = await list([
      MYTH,
      makeSeriesSummary({ id: 'z', name: 'Empty', lastEpisodeAt: null }),
    ]);
    expect(markup).toContain('<time dateTime="2026-10-21T11:00:00.000Z">');
    expect(markup.match(/<time /g)).toHaveLength(1);
  });

  it('lists the series with the newest episode first', async () => {
    const markup = await list([FAQ, MYTH]);
    expect(markup.indexOf('מיתוס או אמת')).toBeLessThan(markup.indexOf('שאלות נפוצות'));
  });

  it('is a pointer, with a quiet hover, no lines and no blue ring', async () => {
    const row = (await list()).match(/<a [^>]*>/)?.[0] ?? '';
    expect(row).toContain('cursor-pointer');
    expect(row).toContain('hover:bg-muted/60');
    expect(row).toContain('ease-in-out');
    expect(row).toContain('outline-none');
    expect(row).toContain('focus-visible:ring-ring/35');
    expect(row).not.toMatch(/border|blue|3b82f6/);
  });
});

describe('what a series’ row says after its name', () => {
  it('says how many episodes and which episode the format is from', () => {
    expect(meta(MYTH)).toBe('4 episodes · format from episode 5');
  });

  it('says "1 episode" for one', () => {
    expect(meta({ ...MYTH, episodeCount: 1 })).toBe('1 episode · format from episode 5');
  });

  it('names a format job that has no episode number', () => {
    const markup = renderToStaticMarkup(<SeriesMeta series={{ ...MYTH, formatJob: 'Pilot' }} />);
    expect(markup).toBe('4 episodes · format from <bdi>Pilot</bdi>');
  });

  it('says the format is being learned, or that it failed', () => {
    expect(meta({ ...MYTH, state: 'learning' })).toBe('4 episodes · learning the format');
    expect(meta({ ...MYTH, state: 'failed', error: 'Series stopped.' })).toBe(
      '4 episodes · format failed',
    );
  });
});
