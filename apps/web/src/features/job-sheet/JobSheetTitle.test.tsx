import { type Job, jobStage } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sheet } from '@/components/ui/sheet';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeSeriesSummary } from '@/data/test-utils';
import { archivedDay } from '@/features/jobs/delivery-text';
import { type JobSheetScope, JobSheetTitle } from './JobSheetTitle';
import { jobSheetJobs } from './test-fixtures';

interface Options {
  /** Where the router stands, so a link to this very page is plain text. */
  path?: string;
  series?: boolean;
}

/** The title inside an open sheet (it names the sheet's dialog), on a page of the app. */
async function inSheet(node: ReactNode, { path = '/jobs', series = false }: Options = {}) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, {
    ok: true,
    version: '0.0.0',
    settleMs: 60_000,
    series,
    jobSheet: true,
  });
  if (series) {
    queryClient.setQueryData(clientSeriesKey(jobSheetJobs.editing.clientId), [makeSeriesSummary()]);
  }
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <Sheet open>{node}</Sheet>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/jobs', '/clients/$clientId', '/clients/$clientId/series/$seriesId'].map((routePath) =>
        createRoute({ getParentRoute: () => rootRoute, path: routePath }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The attribute of the first element of the markup that has `attr`'s value. */
const tag = (markup: string, needle: string) =>
  markup.match(new RegExp(`<[^>]*${needle}[^>]*>`))?.[0] ?? '';

const titled = (job: Job, scope: JobSheetScope = {}, options?: Options) =>
  inSheet(<JobSheetTitle job={job} scope={scope} />, options);

const sheetOf = (job: Job, options?: Options) => titled(job, {}, options);

describe('<JobSheetTitle>', () => {
  const titleOf = (markup: string) => markup.match(/<h2[^>]*>.*?<\/h2>/)?.[0] ?? '';

  it('is the name, 18 px semibold, in its own direction, and wraps instead of being cut off', async () => {
    const h2 = titleOf(await sheetOf(jobSheetJobs.review));
    expect(h2).toContain('dir="auto"');
    expect(h2).toContain('text-[18px]');
    expect(h2).toContain('font-semibold');
    expect(h2).toContain('whitespace-normal');
    expect(h2).toContain('overflow-visible');
    expect(h2).toContain('wrap-anywhere');
    expect(text(h2)).toBe(jobSheetJobs.review.name);
  });

  it('is the sheet’s name for assistive technology', async () => {
    const markup = await sheetOf(jobSheetJobs.review);
    const id = titleOf(markup).match(/id="([^"]*)"/)?.[1];
    expect(id).toBeDefined();
    expect(markup).toContain('data-slot="sheet-title"');
  });

  it('keeps a long, mixed name whole', async () => {
    const name = 'סרטון תדמית – Q4 Launch, גרסה ארוכה לאתר ולמסכים בלובי';
    const markup = await sheetOf({ ...jobSheetJobs.approved, name });
    expect(text(titleOf(markup))).toBe(name);
  });

  it('is muted once the job is paid, and only then', async () => {
    expect(titleOf(await sheetOf(jobSheetJobs.paid))).toContain('text-muted-foreground');
    for (const state of ['review', 'approved', 'delivered', 'failed'] as const) {
      expect(titleOf(await sheetOf(jobSheetJobs[state])), state).not.toContain(
        'text-muted-foreground',
      );
    }
  });

  it('names the client under it, as a link to the client’s page', async () => {
    const job = jobSheetJobs.review;
    const markup = await sheetOf(job);
    const link = tag(markup, 'data-slot="job-sheet-client"');
    expect(link.startsWith('<a ')).toBe(true);
    expect(link).toContain(`href="/clients/${job.clientId}"`);
    expect(text(markup.match(/<a [^>]*job-sheet-client[^>]*>.*?<\/a>/)?.[0] ?? '')).toBe(
      job.client,
    );
  });

  it('names the client in plain text on that client’s own page', async () => {
    const job = jobSheetJobs.review;
    const markup = await titled(job, { clientId: job.clientId });
    const client = tag(markup, 'data-slot="job-sheet-client"');
    expect(client.startsWith('<bdi')).toBe(true);
    expect(markup).not.toContain('<a ');
    expect(markup).toContain(job.client);
  });

  it('keeps the client a link on a series page, which is not the client’s own page', async () => {
    const job = jobSheetJobs.editing;
    const markup = await titled(
      job,
      { clientId: job.clientId, seriesId: '622212180eef' },
      { series: true },
    );
    expect(tag(markup, 'data-slot="job-sheet-client"').startsWith('<a ')).toBe(true);
  });

  it('says the series and the episode, linking to the series’ page, for an episode', async () => {
    const job = jobSheetJobs.editing;
    const markup = await sheetOf(job, { series: true });
    const link = markup.match(/<a [^>]*job-sheet-series[^>]*>.*?<\/a>/)?.[0] ?? '';
    expect(link).toContain(`href="/clients/${job.clientId}/series/${job.seriesId}"`);
    expect(text(link)).toBe('מיתוס או אמת · episode 6');
  });

  it('says only the series’ name for an episode with no number', async () => {
    const markup = await sheetOf({ ...jobSheetJobs.editing, episode: null }, { series: true });
    const link = markup.match(/<a [^>]*job-sheet-series[^>]*>.*?<\/a>/)?.[0] ?? '';
    expect(text(link)).toBe('מיתוס או אמת');
  });

  it('draws the series as plain text on its own page', async () => {
    const job = jobSheetJobs.editing;
    const markup = await titled(
      job,
      { clientId: job.clientId, seriesId: job.seriesId ?? undefined },
      { series: true },
    );
    expect(tag(markup, 'data-slot="job-sheet-series"').startsWith('<span')).toBe(true);
    expect(text(markup.match(/<span [^>]*job-sheet-series[^>]*>.*?<\/span>/)?.[0] ?? '')).toBe(
      'מיתוס או אמת · episode 6',
    );
  });

  it('names no series while series are off, or for a job that is in none', async () => {
    expect(await sheetOf(jobSheetJobs.editing, { series: false })).not.toContain(
      'job-sheet-series',
    );
    expect(await sheetOf(jobSheetJobs.review, { series: true })).not.toContain('job-sheet-series');
  });

  it('says when an archived job was archived, with the archive icon', async () => {
    const job = jobSheetJobs.archived;
    const markup = await sheetOf(job);
    const line = markup.match(/<span [^>]*job-sheet-archived[^>]*>.*?<\/span>/)?.[0] ?? '';
    expect(text(line)).toBe(`Archived ${archivedDay(job.archivedAt ?? '')}`);
    expect(line).toContain('lucide-archive');
  });

  it('says nothing about the archive for a job that is not', async () => {
    expect(await sheetOf(jobSheetJobs.paid)).not.toContain('job-sheet-archived');
    expect(jobStage(jobSheetJobs.paid)).toBe('paid');
  });
});
