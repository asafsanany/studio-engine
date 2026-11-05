// CVP-197: what a row does for Archive, Unarchive, Archive all paid, and for Retry, Resume and
// Release on an archived job. The routes are answered by MSW; the messages are sonner's, mocked.
// There is no DOM, so the hook is rendered once to take its actions, which are then called.

import type { Job } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOBS_KEY } from '@/data/jobs-cache';
import {
  BASE_URL,
  cachedJobs,
  createTestQueryClient,
  makeJob,
  makeJobDelivery,
} from '@/data/test-utils';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { useRowActions } = await import('./use-row-actions');
type RowActions = ReturnType<typeof useRowActions>;

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  // The data layer's `api` asks for relative addresses; MSW answers absolute ones.
  const interceptedFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    interceptedFetch(
      typeof input === 'string' && input.startsWith('/') ? `${BASE_URL}${input}` : input,
      init,
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  vi.unstubAllGlobals();
  server.close();
});

const ARCHIVED_AT = '2026-10-21T10:00:00.000Z';
const paid = (id: string, name: string, archivedAt: string | null = null): Job =>
  makeJob({
    id,
    name,
    state: 'ready',
    placeInLine: null,
    delivery: makeJobDelivery({ paidOn: '2026-10-22' }),
    archivedAt,
  });

const one = paid('one', 'מיתוס או אמת 2');
const two = paid('two', 'פתיחת הסניף');
const archived = (job: Job): Job => ({ ...job, archivedAt: ARCHIVED_AT });

let queryClient: QueryClient;
beforeEach(() => {
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
  queryClient = createTestQueryClient();
});

/** The actions of a row for `job`, as `useRowActions` makes them. */
function actionsFor(job: Job): RowActions {
  let actions: RowActions | undefined;
  function Capture() {
    actions = useRowActions(job);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Capture />
    </QueryClientProvider>,
  );
  if (actions === undefined) throw new Error('the hook did not run');
  return actions;
}

/** Answers a route and records the body it was sent. */
function answer(
  path: string,
  body: (request: unknown) => Parameters<typeof HttpResponse.json>[0],
  bodies: unknown[] = [],
) {
  server.use(
    http.post(`${BASE_URL}${path}`, async ({ request }) => {
      const text = await request.text();
      const sent = text === '' ? null : JSON.parse(text);
      bodies.push(sent);
      return HttpResponse.json(body(sent));
    }),
    http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json(cachedJobs(queryClient))),
  );
  return bodies;
}

const lastToast = () => {
  const [message, options] = sonner.toast.mock.calls.at(-1) as [
    unknown,
    { action?: { label: string; onClick: () => void } },
  ];
  return { message, options };
};

describe('useRowActions: archive', () => {
  it('sends the job’s id, and says it was archived, with Undo, once the server has answered', async () => {
    queryClient.setQueryData(JOBS_KEY, [one, two]);
    const bodies = answer('/api/jobs/archive', () => ({ jobs: [archived(one)] }));

    actionsFor(one).archive();

    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledOnce());
    expect(bodies).toEqual([{ ids: ['one'] }]);
    expect(lastToast().options.action?.label).toBe('Undo');
    // Not before: the message follows the answer, it does not guess.
    expect(cachedJobs(queryClient)?.find((job) => job.id === 'one')?.archivedAt).toBe(ARCHIVED_AT);
  });

  it('Undo calls the opposite route with the same id', async () => {
    queryClient.setQueryData(JOBS_KEY, [one]);
    answer('/api/jobs/archive', () => ({ jobs: [archived(one)] }));
    const undone = answer('/api/jobs/unarchive', () => ({ jobs: [one] }));

    actionsFor(one).archive();
    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledOnce());
    lastToast().options.action?.onClick();

    await vi.waitFor(() => expect(undone).toEqual([{ ids: ['one'] }]));
    await vi.waitFor(() =>
      expect(cachedJobs(queryClient)?.find((job) => job.id === 'one')?.archivedAt).toBeNull(),
    );
  });

  it('says nothing when the server refuses (409): the row explains it under its button', async () => {
    queryClient.setQueryData(JOBS_KEY, [one]);
    server.use(
      http.post(`${BASE_URL}/api/jobs/archive`, () =>
        HttpResponse.json({ error: 'Cannot archive “X” while it is editing.' }, { status: 409 }),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([one])),
    );
    actionsFor(one).archive();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sonner.toast).not.toHaveBeenCalled();
    expect(cachedJobs(queryClient)?.find((job) => job.id === 'one')?.archivedAt).toBeNull();
  });
});

describe('useRowActions: archive all paid', () => {
  it('sends all the ids in one request, and says how many; Undo unarchives exactly those', async () => {
    queryClient.setQueryData(JOBS_KEY, [one, two]);
    const bodies = answer('/api/jobs/archive', () => ({ jobs: [archived(one), archived(two)] }));
    const undone = answer('/api/jobs/unarchive', () => ({ jobs: [one, two] }));

    actionsFor(one).archiveAllPaid(['one', 'two']);
    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledOnce());
    expect(bodies).toEqual([{ ids: ['one', 'two'] }]);
    expect(lastToast().message).toBe('Archived 2 paid videos · they still count on Money');

    lastToast().options.action?.onClick();
    await vi.waitFor(() => expect(undone).toEqual([{ ids: ['one', 'two'] }]));
  });
});

describe('useRowActions: unarchive', () => {
  it('sends the job’s id and says which tab it is back in, with Undo (Archive)', async () => {
    queryClient.setQueryData(JOBS_KEY, [archived(one)]);
    const bodies = answer('/api/jobs/unarchive', () => ({ jobs: [one] }));
    const again = answer('/api/jobs/archive', () => ({ jobs: [archived(one)] }));

    actionsFor(archived(one)).unarchive();
    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledOnce());
    expect(bodies).toEqual([{ ids: ['one'] }]);

    lastToast().options.action?.onClick();
    await vi.waitFor(() => expect(again).toEqual([{ ids: ['one'] }]));
  });
});

describe('useRowActions: Retry, Resume and Release on an archived job', () => {
  const failed = makeJob({
    id: 'failed',
    name: 'בדיקת סאונד',
    state: 'failed',
    placeInLine: null,
    failedAt: 5,
    error: 'boom',
  });
  const queuedAgain = { ...failed, state: 'queued' as const, failedAt: null, error: null };

  it('says the job left the archive, in the state it is in now, with no Undo', async () => {
    const job = archived(failed);
    queryClient.setQueryData(JOBS_KEY, [job]);
    const sent = answer('/api/jobs/failed/retry', () => queuedAgain);

    actionsFor(job).run({ kind: 'retry', label: 'Retry from Cut' });

    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledOnce());
    expect(sent).toEqual([null]); // one request, with no body
    expect(lastToast().options.action).toBeUndefined();
    const { message } = lastToast();
    expect(renderToStaticMarkup(message as React.ReactElement)).toBe(
      'Left the archive: “<bdi>בדיקת סאונד</bdi>” is queued again',
    );
  });

  it('says nothing extra for the same action on a job that is not archived', async () => {
    queryClient.setQueryData(JOBS_KEY, [failed]);
    answer('/api/jobs/failed/retry', () => queuedAgain);
    actionsFor(failed).run({ kind: 'retry', label: 'Retry from Cut' });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sonner.toast).not.toHaveBeenCalled();
  });

  it('does it for Resume and Release too', async () => {
    const cancelled = archived(
      makeJob({ id: 'cancelled', name: 'טיוטה ישנה', state: 'cancelled', placeInLine: null }),
    );
    const held = archived(makeJob({ id: 'held', name: 'מוחזק', state: 'held', placeInLine: null }));
    queryClient.setQueryData(JOBS_KEY, [cancelled, held]);
    answer('/api/jobs/cancelled/resume', () => ({
      ...cancelled,
      state: 'queued',
      archivedAt: null,
    }));
    answer('/api/jobs/held/release', () => ({ ...held, state: 'queued', archivedAt: null }));

    actionsFor(cancelled).run({ kind: 'resume', label: 'Resume' });
    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledTimes(1));
    actionsFor(held).run({ kind: 'release', label: 'Release' });
    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledTimes(2));
  });
});
