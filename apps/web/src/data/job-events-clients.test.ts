import type { ClientRow, Job, ServerEvent } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { CLIENTS_KEY, clientsQueryOptions } from './clients-query';
import { createJobEventsClient } from './job-events';
import { JOBS_KEY } from './jobs-cache';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  manualTimers,
} from './test-utils';

// The client list follows the job and client events: it is loaded again when one of them can have
// changed a row, and only then. The events do not carry rows, so each is a "ask again".

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const ROW: ClientRow = {
  clientId: '1c9823704bf5',
  client: 'Northwind Bakery',
  jobs: 1,
  lastJobAt: '2026-10-20T11:02:10.000Z',
  style: { state: 'none', updatedAt: null },
};
const job = makeJob({ id: 'a' });
const upsert = (j: Job): ServerEvent => ({ type: 'job.upsert', job: j });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's client list; `calls` counts GET /api/clients. */
function serverClients(rows: ClientRow[] = [ROW]) {
  const state = { rows, calls: 0 };
  server.use(
    http.get(`${BASE_URL}/api/clients`, () => {
      state.calls += 1;
      return HttpResponse.json(state.rows);
    }),
  );
  return state;
}

/** A page showing the client list: an observer on its query, loaded. */
async function showClients(state: { calls: number }) {
  new QueryObserver(queryClient, clientsQueryOptions(api)).subscribe(() => {});
  await vi.waitFor(() => expect(queryClient.getQueryData(CLIENTS_KEY)).toBeDefined());
  expect(state.calls).toBe(1);
}

function start(onUnreadableEvent = vi.fn()) {
  const sources = fakeEventSources();
  const client = createJobEventsClient({
    queryClient,
    eventSourceFactory: sources.factory,
    timers: manualTimers().timers,
    onUnreadableEvent,
  });
  client.start();
  return { sources, onUnreadableEvent };
}

describe('the client list and the events', () => {
  it('loads the list again for a job it has not counted (a new job, or one that moved client)', async () => {
    const state = serverClients();
    await showClients(state);
    queryClient.setQueryData<Job[]>(JOBS_KEY, [job]);
    const { sources } = start();

    sources.latest.emit(upsert(makeJob({ id: 'new' })));
    await vi.waitFor(() => expect(state.calls).toBe(2));

    sources.latest.emit(upsert({ ...job, clientId: 'bbbbbbbbbbbb', client: 'Other' }));
    await vi.waitFor(() => expect(state.calls).toBe(3));
  });

  it('loads the list again for a job event when the job list is not there yet', async () => {
    const state = serverClients();
    await showClients(state);
    const { sources } = start();

    sources.latest.emit(upsert(job));
    await vi.waitFor(() => expect(state.calls).toBe(2));
  });

  it('does not, for the progress tick of a job it already counted', async () => {
    const state = serverClients();
    await showClients(state);
    queryClient.setQueryData<Job[]>(JOBS_KEY, [job]);
    const { sources } = start();

    sources.latest.emit(
      upsert({ ...job, state: 'editing', step: 3, updatedAt: '2026-10-20T14:00:00.000Z' }),
    );
    sources.latest.emit(
      upsert({ ...job, state: 'editing', step: 4, updatedAt: '2026-10-20T14:00:05.000Z' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.calls).toBe(1);
  });

  it('loads the list again when a job is removed', async () => {
    const state = serverClients();
    await showClients(state);
    queryClient.setQueryData<Job[]>(JOBS_KEY, [job]);
    const { sources } = start();

    sources.latest.emit({ type: 'job.remove', id: job.id });
    await vi.waitFor(() => expect(state.calls).toBe(2));
  });

  it('loads the list again when a client’s style changes (the row has its state)', async () => {
    const state = serverClients();
    await showClients(state);
    const { sources } = start();

    sources.latest.emit({
      type: 'client.upsert',
      style: {
        clientId: ROW.clientId,
        client: ROW.client,
        state: 'ready',
        version: 1,
        updatedAt: '2026-10-20T14:05:00.000Z',
        error: null,
        sourceJobId: null,
      },
    });
    await vi.waitFor(() => expect(state.calls).toBe(2));
  });

  it.each(['client.added', 'client.removed'] as const)(
    'loads the list again on %s, and reads the event without complaint',
    async (type) => {
      const state = serverClients();
      await showClients(state);
      const { sources, onUnreadableEvent } = start();

      sources.latest.emit({ type, clientId: 'bbbbbbbbbbbb', client: 'Fresh Co' });
      await vi.waitFor(() => expect(state.calls).toBe(2));
      expect(onUnreadableEvent).not.toHaveBeenCalled();
    },
  );

  it('shows the new list once it has come', async () => {
    const state = serverClients();
    await showClients(state);
    const { sources } = start();

    const fresh: ClientRow = {
      ...ROW,
      clientId: 'bbbbbbbbbbbb',
      client: 'Fresh Co',
      jobs: 0,
      lastJobAt: null,
    };
    state.rows = [ROW, fresh];
    sources.latest.emit({ type: 'client.added', clientId: fresh.clientId, client: fresh.client });
    await vi.waitFor(() => expect(queryClient.getQueryData(CLIENTS_KEY)).toEqual([ROW, fresh]));
  });

  it('loads the list again on every hello: whatever happened while disconnected is in it', async () => {
    const state = serverClients();
    await showClients(state);
    const { sources } = start();

    sources.latest.emit({ type: 'hello' });
    await vi.waitFor(() => expect(state.calls).toBe(2));
  });

  it('fetches nothing for a list nobody has asked for', async () => {
    const state = serverClients();
    const { sources } = start();

    sources.latest.emit({ type: 'client.added', clientId: 'bbbbbbbbbbbb', client: 'Fresh Co' });
    sources.latest.emit({ type: 'job.remove', id: 'gone' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.calls).toBe(0);
  });
});
