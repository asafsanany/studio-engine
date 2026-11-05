import { QueryClient } from '@tanstack/react-query';

/** The first retry of a failed query waits this long; each next one waits twice as long... */
export const RETRY_DELAY_MIN_MS = 500;
/** ...up to this, so a server that comes back is found again within two seconds. */
export const RETRY_DELAY_MAX_MS = 2_000;

/**
 * How long to wait before retry number `failureCount + 1`: 0.5 s, 1 s, 2 s, then every 2 s. The
 * engine is on this machine, so asking again is cheap, and a short wait is what lets the page
 * find the engine again soon after it is back.
 */
export function retryDelay(failureCount: number): number {
  return Math.min(RETRY_DELAY_MAX_MS, RETRY_DELAY_MIN_MS * 2 ** failureCount);
}

/**
 * The app's query client.
 *
 * Queries never give up: a failed fetch is asked again after {@link retryDelay}, for as long as
 * the page is open, so a page opened while the engine is down or restarting fills in by itself
 * when it is back. TanStack keeps such a query `pending` while it retries, with `failureCount`
 * above 0 after the first failure; that is what lets the page say "Can't reach the engine." after
 * one failed fetch (see `jobsUnreachable`) instead of after the last of three slow retries (about
 * seven seconds). `networkMode: 'always'` because the engine is local: the browser being offline
 * must not hold the first fetch back, which would show a skeleton forever instead of the message.
 *
 * A failed action is not retried: the person sees the error and decides.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: true, retryDelay, networkMode: 'always' },
      mutations: { retry: false },
    },
  });
}

/** The one client of the running app (main.tsx provides it). */
export const queryClient = createQueryClient();
