import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MoneyPage } from './MoneyPage';

// The money query while it retries after a failed fetch: TanStack keeps it `pending` (not `error`)
// and counts the failures. A server render cannot build that state from a real query (mounting
// starts a fetch, which resets the count), so the hook is replaced by the result it would give.
vi.mock('@/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data')>()),
  useMoney: () => ({ data: undefined, isError: false, failureCount: 1, refetch: vi.fn() }),
}));

describe('<MoneyPage> while the money query retries after a failed fetch', () => {
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MoneyPage skeletonDelayMs={0} />
    </QueryClientProvider>,
  );

  it('says "Can\'t reach the engine." with Try again, without waiting for the last retry', () => {
    expect(markup).toContain('Can&#x27;t reach the engine.');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('>Try again</button>');
  });

  it('draws no skeleton and no banners', () => {
    expect(markup).not.toContain('data-skeleton-banner');
    expect(markup).not.toContain('data-banner=');
  });

  it('keeps the title and the month picker, and leaves out the Ledger and the Expenses', () => {
    expect(markup).toMatch(/<h1[^>]*>Money<\/h1>/);
    expect(markup).toContain('aria-label="Month"');
    expect(markup).not.toContain('>Ledger</h2>');
    expect(markup).not.toContain('>Expenses</h2>');
  });
});
