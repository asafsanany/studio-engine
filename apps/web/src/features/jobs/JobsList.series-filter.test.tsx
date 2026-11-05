// CVP-183: the series filter of the Jobs list. A series page passes the client and the series, and
// the list holds only that series' episodes: the rows, "No jobs yet." and the archive line.

import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { createTestQueryClient } from '@/data/test-utils';
import {
  FAQ_SERIES_ID,
  MYTH_JOBS,
  SERIES_CLIENT,
  SERIES_JOBS,
} from '@/features/series/test-series';
import type { JobsUiStore } from '@/stores/jobs-ui';
import { textOf } from './cells/test-helpers';
import { JobsList } from './JobsList';
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

const MYTH_ID = '622212180eef';

const render = (
  store: StoreApi<JobsUiStore>,
  options: { jobs?: readonly Job[]; clientId?: string; seriesId?: string },
) =>
  renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <JobsList
        jobs={options.jobs ?? SERIES_JOBS}
        store={store}
        clientId={options.clientId}
        seriesId={options.seriesId}
      />
    </QueryClientProvider>,
  );

const rowIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);

describe('the Jobs list narrowed to a series', () => {
  it('holds only the episodes of that series, last updated first', () => {
    const markup = render(createTestStore(), {
      clientId: SERIES_CLIENT.clientId,
      seriesId: MYTH_ID,
    });
    expect(rowIds(markup)).toEqual(['myth7myth7ab', '6554b401d32d', '947ef344672b']);
  });

  it('holds the other series’ episodes under that series, and none of these', () => {
    const markup = render(createTestStore(), {
      clientId: SERIES_CLIENT.clientId,
      seriesId: FAQ_SERIES_ID,
    });
    expect(rowIds(markup)).toEqual(['faq5faq5faq5']);
  });

  it('is the client’s whole list without a series, as before', () => {
    const markup = render(createTestStore(), { clientId: SERIES_CLIENT.clientId });
    expect(rowIds(markup)).toHaveLength(5);
  });

  it('is the Jobs page’s list, every client’s, without a client', () => {
    expect(rowIds(render(createTestStore(), {}))).toHaveLength(SERIES_JOBS.length);
  });

  it('ignores a status tab and a search left on the Jobs page', () => {
    const store = createTestStore();
    store.getState().setStatusTab('attention');
    store.getState().setSearch('nothing matches this');
    const markup = render(store, { clientId: SERIES_CLIENT.clientId, seriesId: MYTH_ID });
    expect(rowIds(markup)).toHaveLength(3);
  });

  it('says "No jobs yet." for a series with no episode in the list', () => {
    const markup = render(createTestStore(), {
      clientId: SERIES_CLIENT.clientId,
      seriesId: MYTH_ID,
      jobs: SERIES_JOBS.filter((job) => job.seriesId !== MYTH_ID),
    });
    expect(markup).toContain('No jobs yet.');
    expect(rowIds(markup)).toEqual([]);
  });

  it('says "No matching jobs." for a series whose episodes are all archived, and offers them', () => {
    const jobs = MYTH_JOBS.map((job) => ({ ...job, archivedAt: '2026-10-21T12:00:00.000Z' }));
    const markup = render(createTestStore(), {
      clientId: SERIES_CLIENT.clientId,
      seriesId: MYTH_ID,
      jobs,
    });
    expect(markup).toContain('No matching jobs.');
    expect(textOf(markup)).toContain('3 archived');
  });

  it('counts only this series’ archived episodes in the line that offers the archive', () => {
    const jobs = SERIES_JOBS.map((job) =>
      job.id === '947ef344672b' || job.id === 'faq5faq5faq5'
        ? { ...job, archivedAt: '2026-10-21T12:00:00.000Z' }
        : job,
    );
    const markup = render(createTestStore(), {
      clientId: SERIES_CLIENT.clientId,
      seriesId: MYTH_ID,
      jobs,
    });
    expect(rowIds(markup)).toEqual(['myth7myth7ab', '6554b401d32d']);
    expect(textOf(markup)).toContain('1 archived');
    expect(textOf(markup)).not.toContain('2 archived');
  });
});
