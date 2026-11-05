import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import { JOBS_KEY } from '@/data/jobs-cache';
import { createQueryClient } from '@/data/query-client';
import { CANVAS_JOBS } from '@/features/jobs/test-jobs';
import { JobsPage } from './JobsPage';

// Rows link the client's name to its page; these tests render without a router, so a link is a plain anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

function page(jobs?: unknown) {
  const client = createQueryClient();
  if (jobs !== undefined) client.setQueryData(JOBS_KEY, jobs);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <JobsPage />
    </QueryClientProvider>,
  );
}

const LIST = '<ul aria-label="Jobs"';

describe('<JobsPage>', () => {
  it('shows the title, then the jobs list with the live job list', () => {
    const markup = page(CANVAS_JOBS);
    expect(markup.indexOf('<h1')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('<h1')).toBeLessThan(markup.indexOf(LIST));
    expect(markup).not.toContain('<table');
    expect(markup).toContain('Coach intro reel');
    expect(markup).toContain('1–10 of 12');
  });

  it('puts the toolbar (tabs with counts, View menu, search) between the title and the list, with no Columns menu', () => {
    const markup = page(CANVAS_JOBS);
    const title = markup.indexOf('<h1');
    const tabs = markup.indexOf('role="tablist"');
    const view = markup.indexOf('aria-haspopup="menu"');
    const search = markup.indexOf('type="search"');
    const list = markup.indexOf(LIST);
    expect(title).toBeLessThan(tabs);
    expect(tabs).toBeLessThan(view);
    expect(view).toBeLessThan(search);
    expect(search).toBeLessThan(list);
    expect(markup).toContain('data-slot="tabs-trigger-count"');
    expect(markup).not.toContain('Columns');
  });

  it('uses the designed rows: status icons, details, times and row actions', () => {
    const markup = page(CANVAS_JOBS);
    expect(markup).toContain('data-status="queued"');
    expect(markup).toContain('data-status="editing" data-done="4"');
    expect(markup).toContain('<span data-step-label="">Cut · graphics 2/5</span> · ~4 min left');
    // No avatar, no badge and no segment bar in a row.
    expect(markup).not.toContain('data-slot="avatar"');
    expect(markup).not.toContain('data-slot="badge"');
    expect(markup).not.toContain('data-segment');
    // The right column holds only the next step (Start now on the arriving job); Hold and Cancel… are in the menu.
    expect(markup).toContain('aria-label="Start now"');
    expect(markup).not.toContain('aria-label="Hold"');
    expect(markup).not.toContain('aria-label="Cancel…"');
  });

  it('has a place for the notes that say why a row action was refused after its row moved away', () => {
    const markup = page(CANVAS_JOBS);
    expect(markup).toContain('aria-label="Notifications');
    expect(markup).not.toContain('role="alert"');
  });

  it('shows the list, with its skeleton rows held back for a moment, before the first answer', () => {
    const markup = page();
    expect(markup).toContain(LIST);
    expect(markup).not.toContain('data-skeleton-row');
  });
});

/**
 * The page with the jobs query in its failed state (the server could not be reached). A server
 * render starts a fetch for a failed query unless `retryOnMount` is off, so it is off here.
 */
function failedPage(jobs?: unknown) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retryOnMount: false } });
  if (jobs !== undefined) client.setQueryData(JOBS_KEY, jobs);
  const query = client.getQueryCache().build(client, { queryKey: JOBS_KEY });
  query.setState({
    ...query.state,
    status: 'error',
    error: new ApiError(0, 'Cannot reach the Studio Engine server.'),
    errorUpdateCount: 1,
    errorUpdatedAt: Date.now(),
    fetchStatus: 'idle',
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <JobsPage />
    </QueryClientProvider>,
  );
}

describe('<JobsPage>: the states of the list', () => {
  it('with no jobs: the title and the toolbar stay, the list says "No jobs yet."', () => {
    const markup = page([]);
    expect(markup).toContain('<h1');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('type="search"');
    expect(markup).toContain('No jobs yet.');
    expect(markup).toContain('Studio Inbox/&lt;Client&gt;/&lt;Job&gt;');
    expect(markup).not.toContain(LIST);
    expect(markup).not.toContain('aria-label="pagination"');
  });

  it('with no jobs the tabs say 0, which is true', () => {
    const counts = [...page([]).matchAll(/data-slot="tabs-trigger-count"[^>]*>(\d+)</g)];
    expect(counts.map((m) => m[1])).toEqual(['0', '0', '0', '0', '0', '0', '0', '0']);
  });

  it('while loading: an empty list (the skeleton waits a moment), no counts on the tabs', () => {
    const markup = page();
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('data-skeleton-row');
    expect(markup).not.toContain('data-slot="tabs-trigger-count"');
    expect(markup).not.toContain('aria-label="pagination"');
  });

  it('with the engine unreachable and nothing loaded: "Can\'t reach the engine." and Try again', () => {
    const markup = failedPage();
    expect(markup).toContain('<h1');
    expect(markup).toContain('Can&#x27;t reach the engine.');
    expect(markup).toContain('>Try again</button>');
    expect(markup).not.toContain('data-skeleton-row');
    expect(markup).not.toContain('aria-label="pagination"');
  });

  it('with the engine unreachable after the list loaded: the list stays as it was', () => {
    const markup = failedPage(CANVAS_JOBS);
    expect(markup).toContain('Coach intro reel');
    expect(markup).toContain('1–10 of 12');
    expect(markup).not.toContain('reach the engine');
  });
});

describe('<JobsPage>: the pager', () => {
  it('is not there when everything fits on one page', () => {
    const markup = page(CANVAS_JOBS.slice(0, 10));
    expect(markup).toContain('Coach intro reel');
    expect(markup).not.toContain('aria-label="pagination"');
  });

  it('is there from the 11th job on', () => {
    const markup = page(CANVAS_JOBS.slice(0, 11));
    expect(markup).toContain('aria-label="pagination"');
    expect(markup).toContain('1–10 of 11');
  });
});
