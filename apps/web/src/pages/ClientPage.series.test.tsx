// CVP-183: the client page's Series list. With series on, a client that has series shows a quiet
// "Series" list above its jobs, with a "Jobs" heading over the list; with none, or with the
// switch off, the page is exactly as it was.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSeriesSummary } from '@/data/test-utils';
import {
  FAQ_SERIES_ID,
  SERIES_CLIENT,
  SERIES_JOBS,
  seriesWorld,
} from '@/features/series/test-series';
import { renderApp } from '@/lib/test-router';
import { jobsUiStore } from '@/stores/jobs-ui';

beforeAll(() => {
  // zustand's server render reads the store's initial state; point it at the current one.
  jobsUiStore.getInitialState = () => jobsUiStore.getState();
});
afterEach(() => {
  jobsUiStore.getState().setShowArchived(false);
});

const PATH = `/clients/${SERIES_CLIENT.clientId}`;

/** The page's own part: what is inside <main>. */
const main = (markup: string) => markup.slice(markup.indexOf('<main'));

const clientPage = async (options?: Parameters<typeof seriesWorld>[0]) =>
  main(await renderApp(PATH, seriesWorld(options)));

/** The job ids in the order the rows are on the page. */
const rowIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);

describe("a client's page: with series", () => {
  it('shows a "Series" list above the jobs, and a "Jobs" heading over the list', async () => {
    const markup = await clientPage();
    const series = markup.indexOf('id="client-series"');
    const jobs = markup.indexOf('id="client-jobs"');
    const list = markup.indexOf('<ul aria-label="Jobs"');
    expect(markup).toMatch(/<h2[^>]*id="client-series"[^>]*>Series<\/h2>/);
    expect(markup).toMatch(/<h2[^>]*id="client-jobs"[^>]*>Jobs<\/h2>/);
    expect(markup.indexOf('<h1')).toBeLessThan(series);
    expect(series).toBeLessThan(jobs);
    expect(jobs).toBeLessThan(list);
  });

  it('lists each series as a row that opens its page, the newest episode first', async () => {
    const markup = await clientPage();
    const mythHref = `href="${PATH}/series/622212180eef"`;
    const faqHref = `href="${PATH}/series/${FAQ_SERIES_ID}"`;
    expect(markup).toContain(mythHref);
    expect(markup).toContain(faqHref);
    expect(markup.indexOf(mythHref)).toBeLessThan(markup.indexOf(faqHref));
  });

  it('says how many episodes each has and which episode the format is from', async () => {
    const markup = await clientPage();
    expect(markup).toContain('3 episodes · format from episode 5');
    expect(markup).toContain('1 episode · format from episode 5');
    expect(markup).toContain('<time dateTime="2026-10-21T10:55:00.000Z">');
  });

  it('counts the series in the header: "4 jobs · 2 series · last job …"', async () => {
    const markup = await clientPage();
    expect(markup).toContain('5 jobs · 2 series · last job <time');
  });

  it('says "1 series" for one', async () => {
    const markup = await clientPage({ summaries: [makeSeriesSummary()] });
    expect(markup).toContain('5 jobs · 1 series · last job');
  });

  it('keeps every job of the client in the list below, episodes included', async () => {
    const markup = await clientPage();
    const ids = rowIds(markup);
    expect(ids).toHaveLength(5);
    expect(ids).toContain('6554b401d32d');
    expect(ids).toContain('plainjob0001');
    expect(ids).not.toContain('northwind001');
  });

  it('puts 28 px between the header, the Series list and the Jobs list', async () => {
    const markup = await clientPage();
    expect(markup).toMatch(
      /<div class="flex flex-col gap-7"><div class="flex items-center justify-between/,
    );
  });

  it('keeps Hebrew series names in their own direction', async () => {
    const markup = await clientPage();
    expect(markup).toMatch(/dir="auto"[^>]*>מיתוס או אמת<\/span>/);
  });
});

describe("a client's page: without series, or with the switch off", () => {
  /** The page as it is today: no series data at all and no health answer. */
  const asToday = async () => {
    const client = seriesWorld({ summaries: null, detail: null });
    client.removeQueries({ queryKey: ['health'] });
    return main(await renderApp(PATH, client));
  };

  it('is as it was for a client with no series: neither heading', async () => {
    const markup = await clientPage({ summaries: [] });
    expect(markup).not.toContain('client-series');
    expect(markup).not.toContain('client-jobs');
    expect(markup).not.toContain('>Series<');
    expect(markup).toContain('5 jobs · last job');
    expect(markup).not.toContain(' series');
    expect(markup).toMatch(
      /<div class="flex flex-col gap-6"><div class="flex items-center justify-between/,
    );
    expect(markup).toBe(await asToday());
  });

  it('is as it was until the list of series has arrived', async () => {
    expect(await clientPage({ summaries: null })).toBe(await asToday());
  });

  it('is as it was while the switch is off, even with a series list in the cache', async () => {
    const markup = await clientPage({ on: false });
    expect(markup).not.toContain('client-series');
    expect(markup).not.toContain('client-jobs');
    expect(markup).not.toContain('episodes');
    expect(markup).toBe(await asToday());
  });

  it('is as it was before the engine has said whether series are on', async () => {
    const client = seriesWorld();
    client.removeQueries({ queryKey: ['health'] });
    expect(main(await renderApp(PATH, client))).toBe(await asToday());
  });

  it('still lists all of the client’s jobs', async () => {
    const ids = rowIds(await clientPage({ on: false }));
    expect(ids).toHaveLength(
      SERIES_JOBS.filter((job) => job.clientId === SERIES_CLIENT.clientId).length,
    );
  });
});
