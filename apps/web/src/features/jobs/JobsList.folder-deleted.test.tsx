// CVP-204: a delivered video whose folder was deleted is still payable, so the Jobs page lists it:
// in All and Delivered, as a muted row with the Delivered icon, "Folder deleted · Delivered 21 Oct ·
// ₪40 not paid" for its detail and Mark paid… for its next step. These render the rows as the page
// gets them from `useListedJobs`: the job list followed by `orphanAsJob` rows.

import { type Job, orphanAsJob, withFolderDeleted } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import {
  createTestQueryClient,
  makeJob,
  makeJobDelivery,
  makeOrphanDelivery,
} from '@/data/test-utils';
import type { JobsUiStore, StatusTab } from '@/stores/jobs-ui';
import { textOf } from './cells/test-helpers';
import { JobsList } from './JobsList';
import { JobsToolbar } from './JobsToolbar';
import { createTestStore } from './test-jobs';

// Rows link the client's name to its page; these tests render without a router, so a link is a plain anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

const DELIVERED = makeJob({
  id: 'delivered1',
  name: 'Spring menu',
  state: 'ready',
  placeInLine: null,
  delivery: makeJobDelivery({ deliveredAt: '2026-10-19T09:00:00.000Z' }),
  updatedAt: '2026-10-19T10:00:00.000Z',
});
const QUEUED = makeJob({
  id: 'queued1',
  name: 'Queued one',
  updatedAt: '2026-10-20T13:41:00.000Z',
});
const GONE = makeOrphanDelivery({
  id: 'gone1',
  name: 'History check',
  delivery: makeJobDelivery({ deliveredAt: '2026-10-21T09:00:00.000Z' }),
});

/** What the page lists: the jobs, then the videos whose folder is gone. */
const LISTED: readonly Job[] = withFolderDeleted([QUEUED, DELIVERED], [GONE]);

const storeOn = (tab: StatusTab = 'all', search = '') => {
  const store = createTestStore();
  store.getState().setStatusTab(tab);
  if (search !== '') store.getState().setSearch(search);
  return store;
};

const render = (store: StoreApi<JobsUiStore>, jobs: readonly Job[] = LISTED, clientId?: string) =>
  renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <JobsList jobs={jobs} store={store} clientId={clientId} />
    </QueryClientProvider>,
  );

const rowIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);

/** The `<li>` of one job's row. */
function rowOf(markup: string, id: string): string {
  const row = markup.match(new RegExp(`<li [^>]*data-job-id="${id}"[\\s\\S]*?</li>`))?.[0];
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

/** The detail text of a row: what is after the name, before the time. */
const detailOf = (row: string) => {
  const start = row.lastIndexOf('<', row.indexOf('data-slot="job-detail"'));
  const end = row.indexOf('<div class="text-right text-[13px] whitespace-nowrap"><time', start);
  return textOf(row.slice(start, end));
};

const nameClasses = (row: string, name: string) =>
  row.match(new RegExp(`<span dir="auto" class="([^"]*)">${name}<`))?.[1];

describe('<JobsList>: a video whose folder was deleted', () => {
  const markup = render(storeOn());
  const row = rowOf(markup, 'gone1');

  it('is in All and in Delivered, and in no other tab', () => {
    expect(rowIds(markup)).toContain('gone1');
    expect(rowIds(render(storeOn('delivered')))).toEqual(['gone1', 'delivered1']);
    for (const tab of ['progress', 'review', 'approved', 'paid', 'attention'] as const) {
      expect(rowIds(render(storeOn(tab))), tab).not.toContain('gone1');
    }
  });

  it('is sorted by the day it was delivered, among the jobs', () => {
    // 21 October (the video without a folder), 19 October (Spring menu), and the queued job from 20 October 13:41 comes between them.
    expect(rowIds(markup)).toEqual(['gone1', 'queued1', 'delivered1']);
  });

  it('has the Delivered icon', () => {
    const icon = row.match(/<svg[^>]*>/)?.[0] ?? '';
    expect(icon).toContain('aria-label="Delivered"');
    expect(icon).toContain('data-stage="delivered"');
  });

  it('reads its name and client from the delivery row, the name muted', () => {
    expect(textOf(row)).toContain('History check');
    expect(textOf(row)).toContain('Northwind Bakery');
    expect(nameClasses(row, 'History check')).toContain('text-muted-foreground');
    // A delivered video that has its folder keeps its ordinary name.
    expect(nameClasses(rowOf(markup, 'delivered1'), 'Spring menu')).not.toContain(
      'text-muted-foreground',
    );
  });

  it('says "Folder deleted · Delivered 21 Oct · ₪40 not paid"', () => {
    expect(detailOf(row)).toBe('Folder deleted · Delivered 21 Oct · ₪40 not paid');
    expect(detailOf(rowOf(markup, 'delivered1'))).toBe('Delivered 19 Oct · ₪40 not paid');
  });

  it('has Mark paid… as its next step, and the row says its folder is deleted', () => {
    const buttons = [
      ...row.slice(row.indexOf('data-row-actions')).matchAll(/aria-label="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(buttons).toEqual(['Mark paid…']);
    expect(row).toContain('data-folder-deleted=""');
    expect(rowOf(markup, 'delivered1')).not.toContain('data-folder-deleted');
  });

  it('is 44 px high on the same grid as every row, and has the time of its delivery', () => {
    expect(row).toContain('grid h-11 grid-cols-[16px_minmax(0,1fr)_auto_80px_32px]');
    expect(row).toContain('dateTime="2026-10-21T09:00:00.000Z"');
  });

  it('is found by the search', () => {
    expect(rowIds(render(storeOn('all', 'history')))).toEqual(['gone1']);
  });

  it('is not archived and offers no note, no effort and no archive marker', () => {
    expect(row).not.toContain('aria-label="Archived"');
    expect(row).not.toContain('data-archived=""');
    expect(row).not.toContain('Your note');
  });

  it('is on a client’s page too, under that client only, without the client’s name in the row', () => {
    const own = render(storeOn(), LISTED, GONE.clientId);
    expect(rowIds(own)).toContain('gone1');
    expect(textOf(rowOf(own, 'gone1'))).not.toContain('Northwind Bakery');

    const another = render(storeOn(), LISTED, 'someone-else');
    expect(rowIds(another)).toEqual([]);
  });

  it('is not listed once it is paid: it leaves the page', () => {
    const paid = makeOrphanDelivery({
      ...GONE,
      delivery: makeJobDelivery({ paidOn: '2026-10-23' }),
    });
    const listed = withFolderDeleted([QUEUED, DELIVERED], [paid]);

    expect(rowIds(render(storeOn(), listed))).not.toContain('gone1');
  });

  it('is the only row of a page of only such videos (the page is not "No jobs yet.")', () => {
    const only = [orphanAsJob(GONE)];
    const alone = render(storeOn(), only);

    expect(rowIds(alone)).toEqual(['gone1']);
    expect(alone).not.toContain('No jobs yet.');
  });
});

describe('<JobsToolbar>: the counts with a video whose folder was deleted', () => {
  const countsOf = (jobs: readonly Job[]) =>
    [
      ...renderToStaticMarkup(<JobsToolbar jobs={jobs} store={createTestStore()} />).matchAll(
        /data-slot="tabs-trigger-count"[^>]*>([^<]*)</g,
      ),
    ].map((m) => m[1]);

  // All, In progress, Review, Approved, Delivered, Uploaded, Paid, Needs attention
  it('counts it in All and in Delivered', () => {
    expect(countsOf([QUEUED, DELIVERED])).toEqual(['2', '1', '0', '0', '1', '0', '0', '0']);
    expect(countsOf(LISTED)).toEqual(['3', '1', '0', '0', '2', '0', '0', '0']);
  });
});
