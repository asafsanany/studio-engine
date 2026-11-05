import { type OrphanDelivery, orphanAsJob, type ServerEvent } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, UNREADABLE_MESSAGE } from './api';
import { createJobEventsClient } from './job-events';
import { JOBS_KEY } from './jobs-cache';
import {
  applyFolderDeletedJobs,
  applyOrphanChanges,
  ORPHANS_KEY,
  orphanDeliveriesQueryOptions,
  reloadOrphanDeliveries,
} from './orphan-deliveries';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  makeJobDelivery,
  makeOrphanDelivery,
  manualTimers,
} from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

const PAID = makeJobDelivery({ paidOn: '2026-10-23' });

/** The server's list, and how many times it was asked for it. */
function serverOrphans(orphans: OrphanDelivery[]) {
  const state = { orphans, asked: 0 };
  server.use(
    http.get(`${BASE_URL}/api/deliveries/unpaid-without-job`, () => {
      state.asked += 1;
      return HttpResponse.json({ orphans: state.orphans });
    }),
  );
  return state;
}

describe('api.listOrphanDeliveries', () => {
  it('GETs /api/deliveries/unpaid-without-job and returns the videos', async () => {
    const orphans = [makeOrphanDelivery(), makeOrphanDelivery({ id: 'second', name: 'Second' })];
    serverOrphans(orphans);

    await expect(api.listOrphanDeliveries()).resolves.toEqual(orphans);
  });

  it('rejects with an ApiError when the answer is not { orphans }', async () => {
    server.use(
      http.get(`${BASE_URL}/api/deliveries/unpaid-without-job`, () => HttpResponse.json([])),
    );

    const error = await api.listOrphanDeliveries().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: UNREADABLE_MESSAGE });
  });
});

describe('orphanDeliveriesQueryOptions', () => {
  it("caches the list under ['orphan-deliveries'] and keeps it fresh until the server says otherwise", async () => {
    const state = serverOrphans([makeOrphanDelivery()]);
    expect(ORPHANS_KEY).toEqual(['orphan-deliveries']);

    await queryClient.fetchQuery(orphanDeliveriesQueryOptions(api));
    await queryClient.fetchQuery(orphanDeliveriesQueryOptions(api));

    expect(state.asked).toBe(1);
    expect(queryClient.getQueryData(ORPHANS_KEY)).toEqual([makeOrphanDelivery()]);
  });
});

describe('applyOrphanChanges', () => {
  const a = makeOrphanDelivery({ id: 'a', name: 'A' });
  const b = makeOrphanDelivery({ id: 'b', name: 'B' });

  it('takes a paid video off the list', () => {
    const paid = orphanAsJob({ ...a, delivery: PAID });
    expect(applyOrphanChanges([a, b], [paid])).toEqual([b]);
  });

  it('takes off a video whose delivery was taken off (its delivery is null)', () => {
    const gone = { ...orphanAsJob(a), delivery: null };
    expect(applyOrphanChanges([a, b], [gone])).toEqual([b]);
  });

  it('puts a video that is unpaid again back in its place', () => {
    const renamed = { ...a, name: 'A again' };
    expect(applyOrphanChanges([a, b], [orphanAsJob(renamed)])).toEqual([renamed, b]);
  });

  it('adds a newcomer first', () => {
    const c = makeOrphanDelivery({ id: 'c', name: 'C' });
    expect(applyOrphanChanges([a, b], [orphanAsJob(c)])).toEqual([c, a, b]);
  });

  it('leaves the list as it is for no change, and a video it never had that is paid', () => {
    expect(applyOrphanChanges([a, b], [])).toEqual([a, b]);
    expect(applyOrphanChanges([a], [orphanAsJob({ ...b, delivery: PAID })])).toEqual([a]);
  });

  it('does not change the list it was given', () => {
    const list = Object.freeze([a, b]);
    applyOrphanChanges(list, [orphanAsJob({ ...a, delivery: PAID })]);
    expect(list).toEqual([a, b]);
  });
});

describe('applyFolderDeletedJobs', () => {
  const a = makeOrphanDelivery({ id: 'a', name: 'A' });
  const b = makeOrphanDelivery({ id: 'b', name: 'B' });

  it('takes the folder-deleted videos of an answer out of the cached list when they are paid, and loads it again', () => {
    queryClient.setQueryData(ORPHANS_KEY, [a, b]);

    applyFolderDeletedJobs(queryClient, [orphanAsJob({ ...a, delivery: PAID })]);

    expect(queryClient.getQueryData(ORPHANS_KEY)).toEqual([b]);
    expect(queryClient.getQueryState(ORPHANS_KEY)?.isInvalidated).toBe(true);
  });

  it('leaves the other jobs of the answer alone', () => {
    queryClient.setQueryData(ORPHANS_KEY, [a]);

    applyFolderDeletedJobs(queryClient, [makeJob({ id: 'a', state: 'ready' })]);

    expect(queryClient.getQueryData(ORPHANS_KEY)).toEqual([a]);
    expect(queryClient.getQueryState(ORPHANS_KEY)?.isInvalidated).toBe(false);
  });

  it('does not make a list out of nothing: with none cached it only asks for it', () => {
    applyFolderDeletedJobs(queryClient, [orphanAsJob(a)]);

    expect(queryClient.getQueryData(ORPHANS_KEY)).toBeUndefined();
  });
});

describe('reloadOrphanDeliveries', () => {
  it('loads the list again while somebody shows it, and does nothing otherwise', async () => {
    const state = serverOrphans([makeOrphanDelivery()]);
    await queryClient.fetchQuery(orphanDeliveriesQueryOptions(api));
    await reloadOrphanDeliveries(queryClient);
    expect(state.asked).toBe(1);

    new QueryObserver(queryClient, orphanDeliveriesQueryOptions(api)).subscribe(() => {});
    await vi.waitFor(() => expect(state.asked).toBe(2));
    await reloadOrphanDeliveries(queryClient);
    expect(state.asked).toBe(3);
  });
});

describe('the events client and the videos without a folder', () => {
  function start() {
    const sources = fakeEventSources();
    createJobEventsClient({
      queryClient,
      eventSourceFactory: sources.factory,
      timers: manualTimers().timers,
    }).start();
    return sources;
  }

  /** A page showing the list: an observer on its query, loaded. */
  async function showList(state: { asked: number }) {
    new QueryObserver(queryClient, orphanDeliveriesQueryOptions(api)).subscribe(() => {});
    await vi.waitFor(() => expect(queryClient.getQueryData(ORPHANS_KEY)).toBeDefined());
    expect(state.asked).toBe(1);
  }

  const changed: ServerEvent = { type: 'money.changed' };

  it('money.changed loads the list again: a payment or a take-back of such a video has no job.upsert', async () => {
    const state = serverOrphans([makeOrphanDelivery()]);
    await showList(state);
    const sources = start();

    state.orphans = [];
    sources.latest.emit(changed);

    await vi.waitFor(() => expect(queryClient.getQueryData(ORPHANS_KEY)).toEqual([]));
    expect(state.asked).toBe(2);
  });

  it('every hello loads it again too', async () => {
    const state = serverOrphans([makeOrphanDelivery()]);
    await showList(state);
    const sources = start();
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([])),
      http.get(`${BASE_URL}/api/clients`, () => HttpResponse.json([])),
    );

    sources.latest.emit({ type: 'hello' });

    await vi.waitFor(() => expect(state.asked).toBe(2));
  });

  describe('job.remove', () => {
    const removeEvent: ServerEvent = { type: 'job.remove', id: 'gone' };

    it('loads it again when the job that was removed was delivered: its delivery is what is left', async () => {
      const state = serverOrphans([]);
      await showList(state);
      queryClient.setQueryData(JOBS_KEY, [
        makeJob({ id: 'gone', state: 'ready', delivery: makeJobDelivery() }),
      ]);
      const sources = start();

      state.orphans = [makeOrphanDelivery({ id: 'gone' })];
      sources.latest.emit(removeEvent);

      await vi.waitFor(() =>
        expect(queryClient.getQueryData<OrphanDelivery[]>(ORPHANS_KEY)?.map((o) => o.id)).toEqual([
          'gone',
        ]),
      );
    });

    it('loads it again for a job the page did not know either', async () => {
      const state = serverOrphans([]);
      await showList(state);
      queryClient.setQueryData(JOBS_KEY, []);
      const sources = start();

      sources.latest.emit(removeEvent);

      await vi.waitFor(() => expect(state.asked).toBe(2));
    });

    it('does not ask when the job that was removed was never delivered', async () => {
      const state = serverOrphans([]);
      await showList(state);
      queryClient.setQueryData(JOBS_KEY, [makeJob({ id: 'gone' })]);
      const sources = start();

      sources.latest.emit(removeEvent);
      await Promise.resolve();

      expect(state.asked).toBe(1);
    });
  });

  it('a job.upsert does not ask: every edit step sends one, and the list does not depend on them', async () => {
    const state = serverOrphans([makeOrphanDelivery()]);
    await showList(state);
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: 'x' })]);
    const sources = start();

    sources.latest.emit({ type: 'job.upsert', job: makeJob({ id: 'x', name: 'Renamed' }) });
    await Promise.resolve();

    expect(state.asked).toBe(1);
  });

  it('does nothing when no Jobs page is open', async () => {
    const state = serverOrphans([makeOrphanDelivery()]);
    const sources = start();

    sources.latest.emit(changed);
    await Promise.resolve();

    expect(state.asked).toBe(0);
  });
});
