// CVP-216 (JS3): `busy` of `useRowActions` is the job's, not the hook's. The row and the job sheet
// each call the hook for the same job; a request sent through one holds back the other's buttons.
// There is no DOM, so the hook is rendered once to take what it returns.

import type { Job } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOBS_KEY } from '@/data/jobs-cache';
import {
  BASE_URL,
  createTestQueryClient,
  deferred,
  makeJob,
  makeJobDelivery,
} from '@/data/test-utils';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const { isRequestForJob, useRowActions } = await import('./use-row-actions');
type RowActions = ReturnType<typeof useRowActions>;

const server = setupServer();
const realFetch = globalThis.fetch;
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
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

const paid = (id: string): Job =>
  makeJob({
    id,
    state: 'ready',
    placeInLine: null,
    delivery: makeJobDelivery({ paidOn: '2026-10-22' }),
  });
const one = paid('one');
const two = paid('two');
const held = makeJob({ id: 'held', state: 'held', placeInLine: null });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [one, two, held]);
});

/** The actions of one hook for `job`: what a row, or a sheet, gets from `useRowActions(job)`. */
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

const busy = (job: Job) => actionsFor(job).busy;

/** An answer to `POST path` that waits for the test. */
function hold(path: string, answer: Parameters<typeof HttpResponse.json>[0]) {
  const gate = deferred();
  server.use(
    http.post(`${BASE_URL}${path}`, async () => {
      await gate.promise;
      return HttpResponse.json(answer);
    }),
  );
  return gate;
}

describe('isRequestForJob', () => {
  const mutation = (key: string, variables: unknown) => ({
    options: { mutationKey: [key] },
    state: { variables },
  });

  it('takes a job action or stage change of the job: the id is its variable', () => {
    expect(isRequestForJob(mutation('job-action', 'one'), 'one')).toBe(true);
    expect(isRequestForJob(mutation('job-action', 'two'), 'one')).toBe(false);
  });

  it('takes an archive or unarchive that covers the job, one of several or alone', () => {
    for (const key of ['archive-jobs', 'unarchive-jobs']) {
      expect(isRequestForJob(mutation(key, ['one']), 'one'), key).toBe(true);
      expect(isRequestForJob(mutation(key, ['two', 'one', 'three']), 'one'), key).toBe(true);
      expect(isRequestForJob(mutation(key, ['two']), 'one'), key).toBe(false);
    }
  });

  it('leaves out what never held a row back: the effort, Mark paid, a mutation with no key', () => {
    expect(isRequestForJob(mutation('save-effort', { id: 'one', effort: 'high' }), 'one')).toBe(
      false,
    );
    expect(isRequestForJob(mutation('mark-paid', { jobIds: ['one'], paidOn: 'x' }), 'one')).toBe(
      false,
    );
    expect(isRequestForJob({ options: {}, state: { variables: 'one' } }, 'one')).toBe(false);
  });
});

describe('useRowActions: busy is shared by every hook of the same job', () => {
  it('is free when nothing is on its way', () => {
    expect(busy(one)).toBe(false);
  });

  it('is held by a request sent through another hook for the job, and freed by its answer', async () => {
    const gate = hold('/api/jobs/held/release', { ...held, state: 'queued', placeInLine: 1 });

    actionsFor(held).run({ kind: 'release', label: 'Release' });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));

    expect(busy(held)).toBe(true);
    gate.resolve();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(busy(held)).toBe(false);
  });

  it('is not held by a request for another job', async () => {
    const gate = hold('/api/jobs/held/release', { ...held, state: 'queued', placeInLine: 1 });

    actionsFor(held).run({ kind: 'release', label: 'Release' });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));

    expect(busy(one)).toBe(false);
    gate.resolve();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
  });

  it('is held by a stage change, which waits for the server like the others', async () => {
    const ready = makeJob({ id: 'ready', state: 'ready', placeInLine: null });
    queryClient.setQueryData(JOBS_KEY, [ready]);
    const gate = hold('/api/jobs/ready/deliver', { ...ready, delivery: makeJobDelivery() });

    actionsFor(ready).run({ kind: 'deliver', label: 'Mark delivered' });
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));

    expect(busy(ready)).toBe(true);
    gate.resolve();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
  });

  it('is held by an archive, and by Archive all paid for every job it covers', async () => {
    const archived = (job: Job) => ({ ...job, archivedAt: '2026-10-22T10:00:00.000Z' });
    const gate = hold('/api/jobs/archive', { jobs: [archived(one), archived(two)] });

    actionsFor(one).archiveAllPaid(['one', 'two']);
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));

    expect(busy(one)).toBe(true);
    expect(busy(two)).toBe(true);
    expect(busy(held)).toBe(false);
    gate.resolve();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(busy(two)).toBe(false);
  });

  it('is not held by saving the effort, as before', async () => {
    const gate = deferred();
    server.use(
      http.put(`${BASE_URL}/api/jobs/held/effort`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...held, effort: 'high' });
      }),
    );

    actionsFor(held).setEffort('high');
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));

    expect(busy(held)).toBe(false);
    gate.resolve();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
  });
});
