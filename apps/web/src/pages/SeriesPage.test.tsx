// CVP-183: a series' page. A header (icon box, name, what it holds), the ghost tabs Episodes N |
// Format, the Episodes tab (the client's Jobs list narrowed to the series) and the Format tab
// (series.md, or what the series is doing). Plus the states without a series to show.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@/data/api';
import { HEALTH_KEY } from '@/data/health-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { seriesKey } from '@/data/series-cache';
import { makeSeries, makeSeriesResponse, seriesByState } from '@/data/test-utils';
import { MYTH_JOBS, SERIES_CLIENT, SERIES_JOBS, seriesWorld } from '@/features/series/test-series';
import { renderApp, renderAt } from '@/lib/test-router';
import { jobsUiStore } from '@/stores/jobs-ui';
import { SeriesPage } from './SeriesPage';

beforeAll(() => {
  // zustand's server render reads the store's initial state; point it at the current one.
  jobsUiStore.getInitialState = () => jobsUiStore.getState();
});
afterEach(() => {
  jobsUiStore.getState().setShowArchived(false);
});

const CLIENT_ID = SERIES_CLIENT.clientId;
const SERIES_ID = '622212180eef';
const PATH = `/clients/${CLIENT_ID}/series/${SERIES_ID}`;

/** The page's own part: what is inside <main>. */
const main = (markup: string) => markup.slice(markup.indexOf('<main'));

/** The series page through the app's router, as the address opens it. */
const seriesPage = async (options?: Parameters<typeof seriesWorld>[0]) =>
  main(await renderApp(PATH, seriesWorld(options)));

/** The series page on its own, opened on `initialTab`, over the same data. */
const seriesTab = async (
  initialTab: 'episodes' | 'format',
  options?: Parameters<typeof seriesWorld>[0],
) =>
  renderAt(
    PATH.replace(/\/series.*/, ''),
    <SeriesPage clientId={CLIENT_ID} seriesId={SERIES_ID} initialTab={initialTab} />,
    seriesWorld(options),
  );

/** The job ids in the order the rows are on the page. */
const rowIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);

describe('the series page: the header', () => {
  it('has the icon box, the name and what the series holds', async () => {
    const markup = await seriesPage();
    expect(markup).toMatch(/<h1[^>]*dir="auto"[^>]*>מיתוס או אמת<\/h1>/);
    expect(markup).toMatch(/size-10[^"]*rounded-\[10px\][^"]*bg-muted/);
    expect(markup).toContain('lucide-layers-2');
    expect(markup).toContain('3 episodes · format from <bdi>מיתוס או אמת 5</bdi> · started 21 Oct');
  });

  it('puts the icon box first, then the name above the line about the series', async () => {
    const markup = await seriesPage();
    expect(markup.indexOf('rounded-[10px]')).toBeLessThan(markup.indexOf('<h1'));
    expect(markup.indexOf('<h1')).toBeLessThan(markup.indexOf('3 episodes'));
  });

  it('says "1 episode" for one', async () => {
    const markup = await seriesPage({ jobs: MYTH_JOBS.slice(0, 1) });
    expect(markup).toContain('1 episode · format from');
    expect(markup).not.toContain('1 episodes');
  });

  it('leaves the count out until the job list has loaded, rather than guessing', async () => {
    const client = seriesWorld();
    client.removeQueries({ queryKey: JOBS_KEY });
    const markup = main(await renderApp(PATH, client));
    expect(markup).toContain('format from <bdi>מיתוס או אמת 5</bdi> · started 21 Oct');
    expect(markup).not.toContain('episodes ·');
    expect(markup).not.toContain('data-slot="tabs-trigger-count"');
  });

  it('is Clients › <client> › Series in the header’s trail, the last step the page', async () => {
    const markup = await renderApp(PATH, seriesWorld());
    const start = markup.indexOf('data-slot="breadcrumb"');
    const crumbs = markup.slice(start, markup.indexOf('</nav>', start));
    expect(crumbs).toContain('href="/clients"');
    expect(crumbs).toContain('>עו״ד דוד לוי</a>');
    expect(crumbs).toContain(`href="/clients/${CLIENT_ID}"`);
    expect(crumbs).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Series<\/span>/);
  });

  it('is built from the address alone, so a reload comes back to the same page', async () => {
    const markup = await seriesPage();
    expect(markup).toMatch(/<h1[^>]*>מיתוס או אמת<\/h1>/);
  });
});

describe('the series page: the tabs', () => {
  it('has the ghost tabs Episodes N | Format, with Episodes selected to begin with', async () => {
    const markup = await seriesPage();
    const tabs = markup.match(/<div[^>]*role="tablist"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(tabs).toContain('data-variant="ghost"');
    expect(tabs).toContain('aria-label="Series"');
    const [episodes, format] = tabs.match(/<button[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(episodes).toContain('aria-selected="true"');
    expect(episodes).toMatch(/Episodes<span[^>]*data-slot="tabs-trigger-count"[^>]*>3<\/span>/);
    expect(format).toContain('aria-selected="false"');
    expect(format).toMatch(/>Format<\/button>$/);
  });

  it('opens on the Format tab when asked to', async () => {
    const tabs = (await seriesTab('format')).match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabs[0]).toContain('aria-selected="false"');
    expect(tabs[1]).toContain('aria-selected="true"');
  });
});

describe('the series page: the Episodes tab', () => {
  it('is the Jobs list narrowed to the series: its episodes, newest first, and no others', async () => {
    const ids = rowIds(await seriesPage());
    expect(ids).toEqual(['myth7myth7ab', '6554b401d32d', '947ef344672b']);
  });

  it('leaves the client’s name out of the rows, and has no status tabs or search', async () => {
    const markup = await seriesPage();
    expect(markup).not.toContain('text-[13px] text-muted-foreground">עו״ד דוד לוי</span>');
    expect(markup).not.toContain('aria-label="Filter by status"');
    expect(markup).not.toContain('type="search"');
  });

  it('has the row menu and the dialogs of the Jobs list: it is the same list', async () => {
    const markup = await seriesPage();
    expect(markup).toMatch(/<li [^>]*data-job-id="6554b401d32d"/);
    expect(markup).toContain('aria-label="Jobs"');
  });

  it('is a series’ own page for its rows: "Format" after the format job’s name and no Layers2 mark', async () => {
    const markup = await seriesPage();
    // The header's icon box is the only Layers2 on the page: no row repeats it.
    expect(markup.match(/lucide-layers-2/g)).toHaveLength(1);
    expect(markup.match(/text-\[13px\] text-muted-foreground">Format<\/span>/g)).toHaveLength(1);
  });

  it('says what a right-click offers, under the list', async () => {
    const markup = await seriesPage();
    expect(markup).toContain(
      'Right-click an episode to make it the format, or to take it out of the series before its edit starts.',
    );
    expect(markup.indexOf('<ul aria-label="Jobs"')).toBeLessThan(markup.indexOf('Right-click'));
  });

  it('says "No jobs yet." for a series none of whose episodes is in the list', async () => {
    const markup = await seriesPage({ jobs: [] });
    expect(markup).toContain('No jobs yet.');
    expect(markup).not.toContain('Right-click an episode');
  });

  it('shows the archived episodes only with Show archived on', async () => {
    const archived = SERIES_JOBS.map((job) =>
      job.id === '947ef344672b' ? { ...job, archivedAt: '2026-10-21T12:00:00.000Z' } : job,
    );
    expect(rowIds(await seriesPage({ jobs: archived }))).toEqual(['myth7myth7ab', '6554b401d32d']);
    jobsUiStore.getState().setShowArchived(true);
    expect(rowIds(await seriesPage({ jobs: archived }))).toContain('947ef344672b');
  });
});

describe('the series page: the Format tab', () => {
  it('renders series.md under "series.md · learned 21 Oct from <job>"', async () => {
    const markup = await seriesTab('format');
    expect(markup).toContain('series.md · learned 21 Oct from <bdi>מיתוס או אמת 5</bdi>');
    expect(markup).toMatch(/<h2[^>]*>Flow<\/h2>/);
    expect(markup).not.toContain('<ul aria-label="Jobs"');
    expect(markup).not.toContain('Right-click an episode');
  });

  it('says "Learning the format from <job>…" while it learns', async () => {
    const markup = await seriesTab('format', {
      detail: makeSeriesResponse({ series: seriesByState.learning, markdown: null }),
    });
    expect(markup).toMatch(/Learning the format from <bdi>מיתוס או אמת 5<\/bdi>…/);
    expect(markup).not.toContain('series.md · learned');
  });

  it('shows the error and Retry when it failed', async () => {
    const markup = await seriesTab('format', {
      detail: makeSeriesResponse({ series: seriesByState.failed, markdown: null }),
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Series stopped: series.md.new was not written.');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
  });
});

/**
 * A query client in which the series has been asked for and failed with `error`. A query that
 * failed is asked again when a page mounts (and looks "loading" meanwhile); this one is left as it
 * is, which is how it looks once the second try has failed too.
 */
function failed(error: ApiError) {
  const client = seriesWorld({ detail: null });
  client.setQueryDefaults(seriesKey(SERIES_ID), { retryOnMount: false });
  client
    .getQueryCache()
    .build(client, { queryKey: seriesKey(SERIES_ID) })
    .setState({ status: 'error', fetchStatus: 'idle', error, data: undefined });
  return client;
}

describe('the series page: without a series to show', () => {
  it('shows nothing until the series has loaded, and no skeleton before the usual delay', async () => {
    const markup = await seriesPage({ detail: null });
    expect(markup).not.toContain('<h1');
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('No such series.');
    expect(markup).not.toContain('data-slot="skeleton"');
  });

  it('says "No such series." with a link back to the client for a series the engine does not know', async () => {
    const client = failed(new ApiError(404, 'Series 622212180eef not found'));
    const markup = main(await renderApp(PATH, client));
    expect(markup).toContain('No such series.');
    expect(markup).toMatch(
      new RegExp(`<a[^>]*href="/clients/${CLIENT_ID}"[^>]*>Back to the client</a>`),
    );
    expect(markup).not.toContain('role="tablist"');
  });

  it('says "No such series." for a series of another client', async () => {
    const other = makeSeriesResponse({
      series: makeSeries({ clientId: 'aaaaaaaaaaaa', client: 'Someone Else' }),
    });
    const markup = await seriesPage({ detail: other });
    expect(markup).toContain('No such series.');
    expect(markup).not.toContain('<h1');
  });

  it('says "No such series." while the Series switch is off, even for an address that once worked', async () => {
    const markup = await seriesPage({ on: false });
    expect(markup).toContain('No such series.');
    expect(markup).not.toContain('<h1');
  });

  it('waits, rather than saying "No such series.", until the engine says whether series are on', async () => {
    const client = seriesWorld({ detail: null });
    client.removeQueries({ queryKey: HEALTH_KEY });
    const markup = main(await renderApp(PATH, client));
    expect(markup).not.toContain('No such series.');
  });

  it('says "Can’t reach the engine." when the series cannot be fetched', async () => {
    const client = failed(new ApiError(0, 'Cannot reach the Studio Engine server.'));
    const markup = main(await renderApp(PATH, client));
    expect(markup).toMatch(/<p[^>]*role="alert"[^>]*>Can&#x27;t reach the engine\.<\/p>/);
    expect(markup).not.toContain('No such series.');
  });
});
