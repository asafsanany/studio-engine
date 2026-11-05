import { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/lib/test-router';
import { AnalyticsPage } from './AnalyticsPage';

// The analytics query while it retries after a failed fetch: TanStack keeps it `pending` (not
// `error`) and counts the failures. A server render cannot build that state from a real query
// (mounting starts a fetch, which resets the count), so the hook is replaced by the result it
// would give.
vi.mock('@/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data')>()),
  useAnalytics: () => ({ data: undefined, isError: false, failureCount: 1, refetch: vi.fn() }),
}));

describe('<AnalyticsPage> while the analytics query retries after a failed fetch', () => {
  let markup = '';
  beforeAll(async () => {
    markup = await renderAt('/analytics', <AnalyticsPage skeletonDelayMs={0} />, new QueryClient());
  });

  it('says "Can\'t reach the engine." with Try again, without waiting for the last retry', () => {
    expect(markup).toContain('Can&#x27;t reach the engine.');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('>Try again</button>');
  });

  it('draws no skeleton and no cards', () => {
    expect(markup).not.toContain('data-skeleton-card');
    expect(markup).not.toContain('aria-label="Jobs finished"');
    expect(markup).not.toContain('No data yet');
  });

  it('keeps the title and the Week | Month switch, and leaves out the sections', () => {
    expect(markup).toMatch(/<h1[^>]*>Analytics<\/h1>/);
    expect(markup).toContain('aria-label="Period"');
    expect(markup).not.toContain('>Jobs</h2>');
    expect(markup).not.toContain('>Reviews</h2>');
  });
});
