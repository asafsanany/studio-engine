import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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

// The jobs query while it retries after a failed fetch: TanStack keeps it `pending` (not `error`)
// and counts the failures. A server render cannot build that state from a real query (mounting
// starts a fetch, which resets the count), so the hook the page reads (`useListedJobs`: the jobs
// and the videos whose folder is gone) is replaced by the result it would give.
vi.mock('@/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data')>()),
  useListedJobs: () => ({ data: undefined, isError: false, failureCount: 1, refetch: vi.fn() }),
}));

describe('<JobsPage> while the jobs query retries after a failed fetch', () => {
  // The page's cancel dialog host (P7) uses a mutation, so it needs a client; nothing is fetched.
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <JobsPage />
    </QueryClientProvider>,
  );

  it('says "Can\'t reach the engine." with Try again, without waiting for the last retry', () => {
    expect(markup).toContain('Can&#x27;t reach the engine.');
    expect(markup).toContain('>Try again</button>');
    expect(markup).not.toContain('data-skeleton-row');
  });

  it('leaves the counts out of the tabs and the pagination out of the table', () => {
    expect(markup).toContain('role="tablist"');
    expect(markup).not.toContain('data-slot="tabs-trigger-count"');
    expect(markup).not.toContain('aria-label="pagination"');
  });
});
