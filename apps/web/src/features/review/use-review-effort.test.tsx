// `useReviewEffort`: the level the Effort button shows for a job in Review and how it is saved. With
// Quick fixes off it is the job's `effort` (PUT /effort, Default is null); with them on it is the
// job's `reviewEffort` (PUT /review-effort, Auto is null). There is no DOM, so the hook is rendered
// once to take what it returns, and the requests go to a mocked server.

import type { HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { BASE_URL, createTestQueryClient, makeJob } from '@/data/test-utils';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError }) }));

const { useReviewEffort } = await import('./use-review-effort');

const server = setupServer();
// MSW replaces the global `fetch` when it starts listening, so the one to wrap is taken after that.
let realFetch = globalThis.fetch;
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  realFetch = globalThis.fetch;
});
beforeEach(() => {
  toastError.mockClear();
  // The data layer's `api` asks for relative addresses; MSW answers absolute ones.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(
      typeof input === 'string' && input.startsWith('/') ? `${BASE_URL}${input}` : input,
      init,
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

const health = (quickFixes: boolean): HealthResponse => ({
  ok: true,
  version: '0.42.7',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes,
});

const review = makeJob({
  id: 'review-one',
  state: 'review',
  placeInLine: null,
  effort: 'high',
  reviewEffort: 'medium',
});
const autoReview = { ...review, reviewEffort: null };

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [review]);
});

/** What `useReviewEffort(job)` returns with the switch `quickFixes` (not yet heard when `undefined`). */
function controlFor(job = review, quickFixes?: boolean) {
  if (quickFixes !== undefined) queryClient.setQueryData(HEALTH_KEY, health(quickFixes));
  let control: ReturnType<typeof useReviewEffort> | undefined;
  function Capture() {
    control = useReviewEffort(job);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Capture />
    </QueryClientProvider>,
  );
  if (control === undefined) throw new Error('the hook did not run');
  return control;
}

describe('useReviewEffort with Quick fixes off', () => {
  it('shows the job’s effort, with Default for null, and no Auto', () => {
    expect(controlFor(review, false)).toMatchObject({ value: 'high', auto: false });
    expect(controlFor({ ...review, effort: null }, false)).toMatchObject({
      value: null,
      auto: false,
    });
  });

  it('is off until the health answer is in', () => {
    expect(controlFor(review)).toMatchObject({ value: 'high', auto: false });
  });

  it('saves the effort with PUT /effort, and null for Default', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(review);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([review])),
    );
    const control = controlFor(review, false);
    control.onChange('medium');
    control.onChange(null);
    await vi.waitFor(() => expect(bodies).toEqual([{ effort: 'medium' }, { effort: null }]));
  });
});

describe('useReviewEffort with Quick fixes on', () => {
  it('shows the job’s review effort, with Auto for null', () => {
    expect(controlFor(review, true)).toMatchObject({ value: 'medium', auto: true });
    expect(controlFor(autoReview, true)).toMatchObject({ value: null, auto: true });
  });

  it('saves the review effort with PUT /review-effort, and "auto" for null', async () => {
    const bodies: unknown[] = [];
    const efforts: unknown[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(review);
      }),
      http.put(`${BASE_URL}/api/jobs/:id/effort`, async ({ request }) => {
        efforts.push(await request.json());
        return HttpResponse.json(review);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([review])),
    );
    const control = controlFor(review, true);
    control.onChange('xhigh');
    control.onChange(null);
    await vi.waitFor(() => expect(bodies).toEqual([{ effort: 'xhigh' }, { effort: 'auto' }]));
    // The edit’s own level is left alone.
    expect(efforts).toEqual([]);
  });

  it('shows the new choice on the job in the cache at once', async () => {
    const gate = new Promise<void>(() => {});
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async () => {
        await gate;
        return HttpResponse.json(review);
      }),
    );
    controlFor(review, true).onChange('xhigh');
    await vi.waitFor(() =>
      expect(queryClient.getQueryData<(typeof review)[]>(JOBS_KEY)?.[0]?.reviewEffort).toBe(
        'xhigh',
      ),
    );
  });

  it('says why in a toast, and puts the old level back, when the server refuses', async () => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, () =>
        HttpResponse.json(
          { error: 'Cannot change the effort of a job that is not in Review.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([review])),
    );
    controlFor(review, true).onChange('xhigh');
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not change the effort', {
        description: 'Cannot change the effort of a job that is not in Review.',
      }),
    );
    expect(queryClient.getQueryData<(typeof review)[]>(JOBS_KEY)?.[0]?.reviewEffort).toBe('medium');
  });
});
