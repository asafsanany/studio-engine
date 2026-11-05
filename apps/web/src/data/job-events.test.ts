import type { Job, ReviewNote, ServerEvent } from '@studio/shared';
import { MutationObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { jobActionMutationOptions } from './job-action';
import {
  createEngineLink,
  createJobEventsClient,
  EVENTS_URL,
  type JobEventsClientOptions,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECTING_DELAY_MS,
  reconnectDelay,
  STALE_STREAM_MS,
} from './job-events';
import { JOBS_KEY } from './jobs-cache';
import { jobsQueryOptions } from './jobs-query';
import { deleteNoteMutationOptions } from './note-mutations';
import { notesKey } from './notes-cache';
import { notesQueryOptions } from './notes-query';
import {
  BASE_URL,
  cachedJobs,
  createTestQueryClient,
  deferred,
  fakeEventSources,
  makeJob,
  makeReviewNote,
  manualTimers,
  watchJobs,
} from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const a = makeJob({ id: 'a', updatedAt: '2026-10-20T13:00:00.000Z' });
const b = makeJob({ id: 'b', updatedAt: '2026-10-20T14:00:00.000Z' });
const hello: ServerEvent = { type: 'hello' };
const upsert = (job: Job): ServerEvent => ({ type: 'job.upsert', job });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's list, which a test changes between requests; `calls` counts GET /api/jobs. */
function serverJobs(initial: Job[]) {
  const state = { jobs: initial, calls: 0 };
  server.use(
    http.get(`${BASE_URL}/api/jobs`, () => {
      state.calls += 1;
      return HttpResponse.json(state.jobs);
    }),
  );
  return state;
}

/** A started client over fake sources and hand-run timers. */
function startClient(
  options: Pick<JobEventsClientOptions, 'onUnreadableEvent' | 'link' | 'page' | 'now'> = {},
) {
  const sources = fakeEventSources();
  const clock = manualTimers();
  const client = createJobEventsClient({
    queryClient,
    eventSourceFactory: sources.factory,
    timers: clock.timers,
    ...options,
  });
  client.start();
  return { client, sources, clock };
}

describe('upserts and removes', () => {
  it('an SSE upsert updates the cache', async () => {
    const list = serverJobs([b, a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([b, a]));
    const { sources } = startClient();
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(list.calls).toBe(2));

    const editing = { ...a, state: 'editing' as const, step: 3 as const, placeInLine: null };
    sources.latest.emit(upsert(editing));

    expect(cachedJobs(queryClient)?.find((j) => j.id === 'a')).toEqual(editing);
    expect(cachedJobs(queryClient)?.map((j) => j.id)).toEqual(['b', 'a']);
  });

  it('an upsert for a job the list does not have inserts it, newest first', async () => {
    serverJobs([a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    const { sources } = startClient();
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));

    sources.latest.emit(upsert(b));

    expect(cachedJobs(queryClient)).toEqual([b, a]);
  });

  it('a remove drops the job', async () => {
    serverJobs([b, a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toHaveLength(2));
    const { sources } = startClient();
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));

    sources.latest.emit({ type: 'job.remove', id: 'b' });

    expect(cachedJobs(queryClient)).toEqual([a]);
  });

  it('reads a client.upsert without complaint and leaves the jobs alone', async () => {
    const list = serverJobs([b, a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([b, a]));
    const unreadable = vi.fn();
    const { sources } = startClient({ onUnreadableEvent: unreadable });
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(list.calls).toBe(2));

    sources.latest.emit({
      type: 'client.upsert',
      style: {
        clientId: a.clientId,
        client: a.client,
        state: 'analysing',
        version: 1,
        updatedAt: '2026-10-20T14:05:00.000Z',
        error: null,
        sourceJobId: null,
      },
    });

    expect(unreadable).not.toHaveBeenCalled();
    expect(cachedJobs(queryClient)).toEqual([b, a]);
    expect(list.calls).toBe(2);
  });

  it('reads client.added and client.removed without complaint and leaves the jobs alone', async () => {
    const list = serverJobs([b, a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([b, a]));
    const unreadable = vi.fn();
    const { sources } = startClient({ onUnreadableEvent: unreadable });
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(list.calls).toBe(2));

    sources.latest.emit({ type: 'client.added', clientId: a.clientId, client: a.client });
    sources.latest.emit({ type: 'client.removed', clientId: a.clientId, client: a.client });

    expect(unreadable).not.toHaveBeenCalled();
    expect(cachedJobs(queryClient)).toEqual([b, a]);
    expect(list.calls).toBe(2);
  });

  it('opens the events URL', () => {
    const { sources } = startClient();
    expect(sources.sources.map((s) => s.url)).toEqual([EVENTS_URL]);
    expect(EVENTS_URL).toBe('/api/events');
  });

  it('ignores frames it cannot read and says so', async () => {
    serverJobs([a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    const unreadable = vi.fn();
    const { sources } = startClient({ onUnreadableEvent: unreadable });

    sources.latest.emit('not json at all');
    sources.latest.emit('{"type":"job.explode"}');
    sources.latest.emit('{"type":"job.upsert","job":{"id":"x"}}');

    expect(unreadable).toHaveBeenCalledTimes(3);
    expect(cachedJobs(queryClient)).toEqual([a]);
  });
});

describe('hello reloads the list', () => {
  it('the first hello fetches again, so nothing between the first fetch and the connection is lost', async () => {
    const list = serverJobs([a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    expect(list.calls).toBe(1);

    list.jobs = [b, a]; // a job appeared before the stream connected
    const { sources } = startClient();
    sources.latest.emit(hello);

    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([b, a]));
    expect(list.calls).toBe(2);
  });

  it('reconnect refetches: an error, a new connection, a hello, the changes made meanwhile appear', async () => {
    const list = serverJobs([a]);
    watchJobs(queryClient, api);
    const { sources, clock } = startClient();
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const callsBefore = list.calls;

    // The connection breaks, and while it is down the server changes.
    const first = sources.latest;
    first.fail();
    expect(first.closed).toBe(true);
    list.jobs = [b, { ...a, state: 'held', placeInLine: null }];
    expect(cachedJobs(queryClient)).toEqual([a]); // nothing yet: we only know what we were told

    clock.fire();
    expect(sources.sources).toHaveLength(2);
    sources.latest.emit(hello);

    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual(list.jobs));
    expect(list.calls).toBe(callsBefore + 1);
  });

  it('a hello during the very first load restarts it, so the stale answer never lands', async () => {
    const stale = [a];
    const fresh = [b, a];
    const firstAnswer = deferred();
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, async () => {
        calls += 1;
        if (calls === 1) {
          await firstAnswer.promise; // the first load is slow, and read the server before `b` existed
          return HttpResponse.json(stale);
        }
        return HttpResponse.json(fresh);
      }),
    );
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(calls).toBe(1));
    const { sources } = startClient();

    sources.latest.emit(hello);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual(fresh));
    firstAnswer.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cachedJobs(queryClient)).toEqual(fresh);
    expect(calls).toBe(2);
  });

  it('an event that arrives while the list is being fetched triggers one more fetch', async () => {
    const list = serverJobs([a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    const { sources } = startClient();
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const callsBefore = list.calls;

    // A fetch is out (it may have read the server before the event below) ...
    const slow = deferred();
    server.use(
      http.get(`${BASE_URL}/api/jobs`, async () => {
        list.calls += 1;
        if (list.calls === callsBefore + 1) await slow.promise;
        return HttpResponse.json(list.jobs);
      }),
    );
    const refetch = queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    await vi.waitFor(() => expect(list.calls).toBe(callsBefore + 1));
    // ... and a job changes on the server and is announced.
    const changed = { ...a, state: 'held' as const, placeInLine: null };
    list.jobs = [changed];
    sources.latest.emit(upsert(changed));
    slow.resolve();
    await refetch;

    await vi.waitFor(() => expect(list.calls).toBe(callsBefore + 2));
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(cachedJobs(queryClient)).toEqual([changed]);
  });

  it('an event before any list was loaded loads it instead of getting lost', async () => {
    const list = serverJobs([b, a]);
    watchJobs(queryClient, api);
    const { sources } = startClient();
    // No hello yet and the first fetch has not finished: the event cannot be applied to nothing.
    sources.latest.emit(upsert(b));
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([b, a]));
    expect(list.calls).toBeGreaterThanOrEqual(1);
  });

  it('an event for a list nobody shows changes nothing and does not throw', () => {
    const { sources } = startClient();
    expect(() => sources.latest.emit(upsert(a))).not.toThrow();
    expect(cachedJobs(queryClient)).toBeUndefined();
    expect(queryClient.getQueryState(jobsQueryOptions(api).queryKey)).toBeUndefined();
  });
});

describe('reconnecting', () => {
  it('doubles the delay from 1 s up to the 4 s cap, and stays there', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelay)).toEqual([
      1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000,
    ]);
    expect(RECONNECT_INITIAL_MS).toBe(1_000);
    expect(RECONNECT_MAX_MS).toBe(4_000);
  });

  it('never waits longer than 5 s between attempts: that is how soon a returning engine is found', () => {
    expect(RECONNECT_MAX_MS).toBeLessThanOrEqual(5_000);
    for (let failures = 0; failures < 1_000; failures++) {
      expect(reconnectDelay(failures)).toBeLessThanOrEqual(5_000);
    }
  });

  it('backs off on repeated errors and starts over after a hello', () => {
    const { sources, clock } = startClient();

    for (let i = 0; i < 7; i++) {
      sources.latest.fail();
      clock.fire();
    }
    expect(clock.delays).toEqual([1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
    expect(sources.sources).toHaveLength(8);

    sources.latest.emit(hello); // the connection works again
    sources.latest.fail();
    clock.fire();
    sources.latest.fail();

    expect(clock.delays.slice(7)).toEqual([1_000, 2_000]);
  });

  it('does not reset the delay just because a connection opened (only a hello counts)', () => {
    const { sources, clock } = startClient();
    sources.latest.fail();
    clock.fire();
    sources.latest.fail();
    expect(clock.delays).toEqual([1_000, 2_000]);
  });

  it('closes each broken source and ignores anything it says afterwards', async () => {
    serverJobs([a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    const { sources, clock } = startClient();
    const broken = sources.latest;

    broken.fail();
    clock.fire();
    expect(broken.closed).toBe(true);

    // A late frame or error from the dead source must not act (the callbacks may still be set).
    broken.onmessage?.(new MessageEvent('message', { data: JSON.stringify(upsert(b)) }));
    broken.fail();
    expect(cachedJobs(queryClient)).toEqual([a]);
    expect(clock.pendingCount).toBe(0);
  });
});

describe('start and stop', () => {
  it('starts once', () => {
    const { client, sources } = startClient();
    client.start();
    expect(sources.sources).toHaveLength(1);
  });

  it('stop closes the source and nothing it sends later reaches the cache', async () => {
    serverJobs([a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    const { client, sources } = startClient();
    const source = sources.latest;

    client.stop();

    expect(source.closed).toBe(true);
    expect(source.onmessage).toBeNull();
    expect(source.onerror).toBeNull();
  });

  it('stop cancels a reconnect that is waiting, and start works again afterwards', () => {
    const { client, sources, clock } = startClient();
    sources.latest.fail();
    expect(clock.pendingCount).toBe(1);

    client.stop();
    expect(clock.pendingCount).toBe(0);
    expect(sources.sources).toHaveLength(1);

    client.start();
    expect(sources.sources).toHaveLength(2);
    expect(sources.latest.closed).toBe(false);
  });
});

describe('the page coming back (a phone that slept)', () => {
  /** A document and a window the test drives: real EventTargets, so the client's own filters run. */
  function fakePage() {
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const window = new EventTarget();
    return {
      page: { document, window },
      hide() {
        document.visibilityState = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
      },
      show() {
        document.visibilityState = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      },
      pageshow(persisted: boolean) {
        window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
      },
      online() {
        window.dispatchEvent(new Event('online'));
      },
    };
  }

  /** A started client with a fake page and a clock the test sets (`at(ms)`). */
  function startOnPage() {
    const page = fakePage();
    let time = 0;
    const started = startClient({ page: page.page, now: () => time });
    return {
      ...started,
      ...page,
      at(ms: number) {
        time = ms;
      },
    };
  }

  it('waits 20 s of silence: longer than the 15 s between two pings', () => {
    expect(STALE_STREAM_MS).toBe(20_000);
  });

  it('opens a stream that said nothing for 20 s again when the page is shown, and its hello reloads the list', async () => {
    const list = serverJobs([a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(list.calls).toBe(1));
    const { sources, show, hide, at } = startOnPage();
    const asleep = sources.latest;
    asleep.emit(hello);
    await vi.waitFor(() => expect(list.calls).toBe(2));

    hide();
    at(20_000); // the phone slept; iOS cut the stream and said nothing
    show();

    expect(sources.sources).toHaveLength(2);
    expect(asleep.closed).toBe(true);
    expect(asleep.onmessage).toBeNull();
    expect(asleep.onerror).toBeNull();

    list.jobs = [b, a]; // what changed while the phone slept
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([b, a]));
  });

  it('leaves a stream alone that pinged within the last 20 s', () => {
    const { sources, show, at } = startOnPage();
    at(15_000);
    sources.latest.ping();

    at(34_999);
    show();
    expect(sources.sources).toHaveLength(1);

    at(35_000);
    show();
    expect(sources.sources).toHaveLength(2);
  });

  it('counts any frame like a ping', () => {
    const { sources, show, at } = startOnPage();
    at(19_000);
    sources.latest.emit(upsert(a));

    at(25_000);
    show();

    expect(sources.sources).toHaveLength(1);
  });

  it('a stream opened less than 20 s ago is left alone, even before its first frame', () => {
    const { sources, show, at } = startOnPage();
    at(19_999);
    show();
    expect(sources.sources).toHaveLength(1);
  });

  it('does nothing when the page is hidden', () => {
    const { sources, hide, at } = startOnPage();
    at(60_000);
    hide();
    expect(sources.sources).toHaveLength(1);
  });

  it('opens it again on a pageshow from the back-forward cache, not on a fresh one', () => {
    const { sources, pageshow, at } = startOnPage();
    at(60_000);

    pageshow(false);
    expect(sources.sources).toHaveLength(1);

    pageshow(true);
    expect(sources.sources).toHaveLength(2);
  });

  it('opens it again when the phone is back online', () => {
    const { sources, online, at } = startOnPage();
    at(60_000);
    online();
    expect(sources.sources).toHaveLength(2);
  });

  it('a reconnect that has waited 20 s is made now, and the wait is cancelled', () => {
    const { sources, clock, show, at } = startOnPage();
    sources.latest.fail(); // a reconnect waits 1 s, and the phone falls asleep before it fires
    expect(clock.pendingCount).toBe(1);

    at(30_000);
    show();

    expect(sources.sources).toHaveLength(2);
    expect(clock.pendingCount).toBe(0);
  });

  it('a ping from the stream it let go of counts for nothing', () => {
    const { sources, show, at } = startOnPage();
    const old = sources.latest;
    at(20_000);
    show();

    at(30_000);
    old.ping(); // the old connection was not dead after all; it is closed now
    at(40_000);
    show();

    expect(sources.sources).toHaveLength(3);
  });

  it('stop stops listening to the page', () => {
    const { client, sources, show, online, at } = startOnPage();
    client.stop();

    at(60_000);
    show();
    online();

    expect(sources.sources).toHaveLength(1);
  });
});

describe('together with an action in flight', () => {
  const held = makeJob({
    id: 'h',
    state: 'held',
    placeInLine: null,
    settledAt: null,
    lastChangeAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T13:30:00.000Z',
  });

  it('does not let a stale event flip the optimistic state back; the reload after the action settles it', async () => {
    const list = serverJobs([held, a]);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toHaveLength(2));
    const { sources } = startClient();
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));

    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...held, state: 'queued', placeInLine: 1 });
      }),
    );
    const action = new MutationObserver(
      queryClient,
      jobActionMutationOptions({ queryClient, api, action: 'release' }),
    ).mutate(held.id);
    await vi.waitFor(() =>
      expect(cachedJobs(queryClient)?.find((j) => j.id === 'h')?.state).toBe('queued'),
    );

    // An event from before the action reaches us: skipped for this job ...
    sources.latest.emit(upsert({ ...held, subProgress: null, etaSec: 5 }));
    expect(cachedJobs(queryClient)?.find((j) => j.id === 'h')?.state).toBe('queued');
    // ... but not for other jobs.
    const aMoved = { ...a, state: 'editing' as const, step: 2 as const, placeInLine: null };
    sources.latest.emit(upsert(aMoved));
    expect(cachedJobs(queryClient)?.find((j) => j.id === 'a')).toEqual(aMoved);

    // Meanwhile the worker took the job: the list the server will give after the action.
    list.jobs = [{ ...held, state: 'editing', step: 1, placeInLine: null }, aMoved];
    gate.resolve();
    await action;

    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual(list.jobs));
  });
});

describe('the engine link (the "Reconnecting to the engine..." notice)', () => {
  /** A link whose 2 s wait is run by hand, separate from the reconnect timers of the client. */
  function makeLink() {
    const clock = manualTimers();
    const link = createEngineLink({ timers: clock.timers });
    const changes: boolean[] = [];
    link.subscribe(() => changes.push(link.isReconnecting()));
    return { link, clock, changes };
  }

  it('waits 2 s of bad news before it says anything', () => {
    const { link, clock, changes } = makeLink();
    expect(RECONNECTING_DELAY_MS).toBe(2_000);
    expect(link.isReconnecting()).toBe(false);

    link.markDown();
    expect(link.isReconnecting()).toBe(false);
    expect(clock.delays).toEqual([2_000]);
    expect(changes).toEqual([]);

    clock.fire(); // two seconds later, still down
    expect(link.isReconnecting()).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('a short blip never shows: back before the 2 s are up cancels the wait', () => {
    const { link, clock, changes } = makeLink();
    link.markDown();
    link.markUp();

    expect(clock.pendingCount).toBe(0);
    expect(link.isReconnecting()).toBe(false);
    expect(changes).toEqual([]); // nothing flashed, not even a true-then-false
  });

  it('clears the moment the engine answers again', () => {
    const { link, clock, changes } = makeLink();
    link.markDown();
    clock.fire();

    link.markUp();

    expect(link.isReconnecting()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('more bad news does not restart the wait, or stack a second one, or re-announce', () => {
    const { link, clock, changes } = makeLink();
    link.markDown();
    link.markDown();
    link.markDown();
    expect(clock.delays).toEqual([2_000]);
    clock.fire();
    link.markDown();
    expect(clock.delays).toEqual([2_000]);
    expect(changes).toEqual([true]);
  });

  it('starts a fresh wait for the next outage, and "back" while all is well does nothing', () => {
    const { link, clock, changes } = makeLink();
    link.markUp();
    expect(changes).toEqual([]);

    link.markDown();
    clock.fire();
    link.markUp();
    link.markDown();
    expect(link.isReconnecting()).toBe(false);
    expect(clock.delays).toEqual([2_000, 2_000]);
  });

  it('tells nobody once they have unsubscribed', () => {
    const { link, clock } = makeLink();
    const heard = vi.fn();
    const unsubscribe = link.subscribe(heard);
    unsubscribe();
    link.markDown();
    clock.fire();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('the client reports whether the engine can be reached', () => {
  function startWithLink() {
    const clock = manualTimers();
    const link = createEngineLink({ timers: clock.timers });
    const started = startClient({ link });
    return { ...started, link, linkClock: clock };
  }

  it('a broken stream starts the wait; a sustained break shows the notice', () => {
    const { sources, link, linkClock } = startWithLink();
    sources.latest.emit(hello);

    sources.latest.fail();
    expect(link.isReconnecting()).toBe(false);
    linkClock.fire();

    expect(link.isReconnecting()).toBe(true);
  });

  it('a stream that comes back within the wait never shows the notice (a quick restart)', () => {
    const { sources, clock, link, linkClock } = startWithLink();
    sources.latest.emit(hello);

    sources.latest.fail(); // the engine restarts ...
    clock.fire(); // ... the client tries again after 1 s ...
    sources.latest.emit(hello); // ... and is welcomed before the 2 s are up

    expect(linkClock.pendingCount).toBe(0);
    expect(link.isReconnecting()).toBe(false);
  });

  it('keeps the notice across the failed attempts of a long outage, and clears it on the first hello', () => {
    const { sources, clock, link, linkClock } = startWithLink();
    sources.latest.emit(hello);
    sources.latest.fail();
    linkClock.fire();
    expect(link.isReconnecting()).toBe(true);

    for (let i = 0; i < 4; i++) {
      clock.fire();
      sources.latest.fail(); // each new attempt fails too
      expect(link.isReconnecting()).toBe(true);
    }
    clock.fire();
    sources.latest.emit(hello);

    expect(link.isReconnecting()).toBe(false);
  });

  it('after a long outage the notice clears one capped wait after the engine is back, not half a minute', () => {
    const { sources, clock, link, linkClock } = startWithLink();
    sources.latest.emit(hello);
    sources.latest.fail();
    linkClock.fire();

    for (let i = 0; i < 30; i++) {
      clock.fire(); // an attempt every few seconds, for a minute and a half
      sources.latest.fail();
    }
    expect(link.isReconnecting()).toBe(true);
    // The engine comes back now. The attempt that is waiting is at most one cap away ...
    expect(clock.delays.at(-1)).toBe(RECONNECT_MAX_MS);
    // ... and a failed attempt before it is no further than that either.
    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(5_000);

    clock.fire();
    sources.latest.emit(hello);

    expect(link.isReconnecting()).toBe(false);
  });

  it('any frame on the stream counts as the engine being there', () => {
    const { sources, clock, link, linkClock } = startWithLink();
    sources.latest.fail();
    linkClock.fire();
    expect(link.isReconnecting()).toBe(true);

    clock.fire(); // the client connects again
    sources.latest.emit('not even json');
    expect(link.isReconnecting()).toBe(false);
  });

  it('a late error from a source we let go of does not start a wait', () => {
    const { sources, clock, link, linkClock } = startWithLink();
    const first = sources.latest;
    first.fail();
    linkClock.fire();
    clock.fire();
    sources.latest.emit(hello);
    expect(link.isReconnecting()).toBe(false);

    first.fail();

    expect(linkClock.pendingCount).toBe(0);
    expect(link.isReconnecting()).toBe(false);
  });

  it('a failed fetch of the list starts the wait even while the stream looks fine', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.error()));
    const { sources, link, linkClock } = startWithLink();
    sources.latest.emit(hello);
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(linkClock.pendingCount).toBe(1));

    linkClock.fire();
    expect(link.isReconnecting()).toBe(true);
  });

  it("with the app's retry-for-ever queries, each failed attempt counts and the first good one clears", async () => {
    queryClient.setDefaultOptions({
      queries: { retry: true, retryDelay: 10, gcTime: Number.POSITIVE_INFINITY },
    });
    let up = false;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => (up ? HttpResponse.json([a]) : HttpResponse.error())),
    );
    const { link, linkClock } = startWithLink();
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(linkClock.pendingCount).toBe(1)); // the first failed attempt
    linkClock.fire();
    expect(link.isReconnecting()).toBe(true);
    expect(queryClient.getQueryState(JOBS_KEY)?.status).toBe('pending'); // still retrying

    up = true; // the engine is back; the next attempt goes through
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));

    expect(link.isReconnecting()).toBe(false);
  });

  it('a fetch of the list that goes through clears the notice, with the stream still down', async () => {
    const list = serverJobs([a]);
    const { sources, link, linkClock } = startWithLink();
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    sources.latest.fail();
    linkClock.fire();
    expect(link.isReconnecting()).toBe(true);

    list.jobs = [b, a]; // e.g. the person clicked an action, whose answer reloads the list
    await queryClient.invalidateQueries({ queryKey: JOBS_KEY });

    expect(cachedJobs(queryClient)).toEqual([b, a]);
    expect(link.isReconnecting()).toBe(false);
  });

  it('a fetch that goes through also ends the wait for the next reconnect: the stream opens at once', async () => {
    const list = serverJobs([a]);
    const { sources, clock } = startWithLink();
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    sources.latest.fail();
    expect(clock.pendingCount).toBe(1); // a reconnect, up to 30 s away
    expect(sources.sources).toHaveLength(1);

    await queryClient.invalidateQueries({ queryKey: JOBS_KEY });

    expect(list.calls).toBe(3);
    expect(clock.pendingCount).toBe(0);
    expect(sources.sources).toHaveLength(2);
    expect(sources.latest.closed).toBe(false);
  });

  it('an optimistic update or an SSE upsert is not proof of anything: it does not clear the notice', async () => {
    serverJobs([a]);
    const { sources, link, linkClock } = startWithLink();
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([a]));
    sources.latest.emit(hello);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    sources.latest.fail();
    linkClock.fire();
    expect(link.isReconnecting()).toBe(true);

    queryClient.setQueryData(JOBS_KEY, [b, a]); // what an optimistic Release does while the engine is gone

    expect(link.isReconnecting()).toBe(true);
  });

  it('a reload that replaces another fetch (the old one is cancelled) is not a failure', async () => {
    const slow = deferred();
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, async () => {
        calls += 1;
        if (calls === 1) await slow.promise;
        return HttpResponse.json([a]);
      }),
    );
    const { link, linkClock } = startWithLink();
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(calls).toBe(1));

    const reload = queryClient.cancelQueries({ queryKey: JOBS_KEY });
    await reload;
    await queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    slow.resolve();

    expect(linkClock.delays).toEqual([]);
    expect(link.isReconnecting()).toBe(false);
  });

  it('stop clears the notice and stops listening to the fetches', async () => {
    serverJobs([a]);
    const { client, sources, link, linkClock } = startWithLink();
    sources.latest.fail();
    linkClock.fire();
    expect(link.isReconnecting()).toBe(true);

    client.stop();
    expect(link.isReconnecting()).toBe(false);

    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.error()));
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(queryClient.getQueryState(JOBS_KEY)?.status).toBe('error'));
    expect(linkClock.pendingCount).toBe(0);
  });

  it('works without a link (the other tests of this file never pass one)', () => {
    const { sources } = startClient();
    expect(() => sources.latest.fail()).not.toThrow();
  });
});

describe('review notes (W5)', () => {
  const JOB = 'a1b2c3d4e5f6';
  const n1 = makeReviewNote({ id: 'n1', jobId: JOB, atSec: 1, text: 'First' });
  const n2 = makeReviewNote({ id: 'n2', jobId: JOB, atSec: 5, text: 'Second' });
  const noteUpsert = (note: ReviewNote): ServerEvent => ({ type: 'note.upsert', note });
  const noteRemove = (noteId: string, jobId = JOB): ServerEvent => ({
    type: 'note.remove',
    jobId,
    noteId,
  });
  const cachedNotes = (jobId = JOB) => queryClient.getQueryData<ReviewNote[]>(notesKey(jobId));

  /** The server's notes of one job, which a test changes between requests; `calls` counts the GETs. */
  function serverNotes(initial: ReviewNote[], jobId = JOB) {
    const state = { notes: initial, calls: 0 };
    server.use(
      http.get(`${BASE_URL}/api/jobs/${jobId}/notes`, () => {
        state.calls += 1;
        return HttpResponse.json(state.notes);
      }),
    );
    return state;
  }

  it('note.upsert inserts a new note in order and replaces one that is there', () => {
    queryClient.setQueryData(notesKey(JOB), [n1, n2]);
    const { sources } = startClient();

    const between = makeReviewNote({ id: 'n3', jobId: JOB, atSec: 3, text: 'Between' });
    sources.latest.emit(noteUpsert(between));
    expect(cachedNotes()?.map((note) => note.id)).toEqual(['n1', 'n3', 'n2']);

    const transcribed = { ...between, text: 'Edited', addToStyle: true };
    sources.latest.emit(noteUpsert(transcribed));
    expect(cachedNotes()).toEqual([n1, transcribed, n2]);
  });

  it('note.upsert for a note that was sent takes it out of the list', () => {
    queryClient.setQueryData(notesKey(JOB), [n1, n2]);
    const { sources } = startClient();

    sources.latest.emit(noteUpsert({ ...n2, round: 1, sentAt: '2026-10-20T14:30:00.000Z' }));

    expect(cachedNotes()).toEqual([n1]);
  });

  it('note.upsert does nothing when the notes are not cached: whoever loads them reads the server', () => {
    const { sources } = startClient();

    sources.latest.emit(noteUpsert(n1));

    expect(cachedNotes()).toBeUndefined();
    expect(queryClient.getQueryCache().find({ queryKey: notesKey(JOB) })).toBeUndefined();
  });

  it('note.remove removes the note', () => {
    queryClient.setQueryData(notesKey(JOB), [n1, n2]);
    const { sources } = startClient();

    sources.latest.emit(noteRemove('n1'));
    sources.latest.emit(noteRemove('nobody'));

    expect(cachedNotes()).toEqual([n2]);
  });

  it('a note event only touches the notes of its own job', () => {
    const other = makeReviewNote({ id: 'o1', jobId: 'other-job' });
    queryClient.setQueryData(notesKey(JOB), [n1]);
    queryClient.setQueryData(notesKey('other-job'), [other]);
    const { sources } = startClient();

    sources.latest.emit(noteUpsert(n2));
    sources.latest.emit(noteRemove('n1'));

    expect(cachedNotes()).toEqual([n2]);
    expect(cachedNotes('other-job')).toEqual([other]);
  });

  it('note.upsert is ignored while the delete of that note is on its way', async () => {
    queryClient.setQueryData(notesKey(JOB), [n1, n2]);
    const { sources } = startClient();
    const gate = deferred();
    server.use(
      http.delete(`${BASE_URL}/api/jobs/${JOB}/notes/n1`, async () => {
        await gate.promise;
        return HttpResponse.json({ ok: true });
      }),
    );
    const deleting = new MutationObserver(
      queryClient,
      deleteNoteMutationOptions({ queryClient, api, jobId: JOB }),
    ).mutate('n1');
    await vi.waitFor(() => expect(cachedNotes()).toEqual([n2]));

    // An event from before the delete reaches us: the note must not come back ...
    sources.latest.emit(noteUpsert({ ...n1, addToStyle: true }));
    expect(cachedNotes()).toEqual([n2]);
    // ... but another note is applied as usual.
    const n3 = makeReviewNote({ id: 'n3', jobId: JOB, atSec: 9 });
    sources.latest.emit(noteUpsert(n3));
    expect(cachedNotes()).toEqual([n2, n3]);

    gate.resolve();
    await deleting;
    // Once it is over, events count again.
    sources.latest.emit(noteUpsert(n1));
    expect(cachedNotes()?.map((note) => note.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('a note event refreshes the notes while they are being fetched: the fetch may predate it', async () => {
    const list = serverNotes([n1]);
    const watching = new QueryObserver(queryClient, notesQueryOptions(api, JOB));
    const stop = watching.subscribe(() => {});
    await vi.waitFor(() => expect(cachedNotes()).toEqual([n1]));
    const { sources } = startClient();
    const gate = deferred();
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/notes`, async () => {
        list.calls += 1;
        // The first answer is the stale one, held back; later ones are the truth.
        if (list.calls === 2) {
          await gate.promise;
          return HttpResponse.json([n1]);
        }
        return HttpResponse.json(list.notes);
      }),
    );
    void queryClient.invalidateQueries({ queryKey: notesKey(JOB) });
    await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: notesKey(JOB) })).toBe(1));

    // The fetch has reached the server and is held there: it will answer with the old list.
    await vi.waitFor(() => expect(list.calls).toBe(2));

    list.notes = [n1, n2];
    sources.latest.emit(noteUpsert(n2));
    gate.resolve();

    await vi.waitFor(() => expect(list.calls).toBe(3));
    await vi.waitFor(() => expect(cachedNotes()).toEqual([n1, n2]));
    stop();
  });

  it('every hello makes the notes in use load again', async () => {
    const list = serverNotes([n1]);
    const watching = new QueryObserver(queryClient, notesQueryOptions(api, JOB));
    const stop = watching.subscribe(() => {});
    await vi.waitFor(() => expect(cachedNotes()).toEqual([n1]));
    expect(list.calls).toBe(1);
    serverJobs([]);
    const { sources } = startClient();

    list.notes = [n1, n2]; // a note arrived while we were not connected
    sources.latest.emit(hello);

    await vi.waitFor(() => expect(cachedNotes()).toEqual([n1, n2]));
    expect(list.calls).toBe(2);
    stop();
  });

  it('job.remove drops the notes of that job and no other', () => {
    queryClient.setQueryData(JOBS_KEY, [a, b]);
    queryClient.setQueryData(notesKey('a'), [makeReviewNote({ id: 'x', jobId: 'a' })]);
    queryClient.setQueryData(notesKey('b'), [makeReviewNote({ id: 'y', jobId: 'b' })]);
    const { sources } = startClient();

    sources.latest.emit({ type: 'job.remove', id: 'a' });

    expect(cachedNotes('a')).toBeUndefined();
    expect(cachedNotes('b')).toHaveLength(1);
    expect(cachedJobs(queryClient)?.map((job) => job.id)).toEqual(['b']);
  });

  it('note events leave the jobs alone, and job events leave the notes alone', () => {
    queryClient.setQueryData(JOBS_KEY, [b, a]);
    queryClient.setQueryData(notesKey(JOB), [n1]);
    const { sources } = startClient();

    sources.latest.emit(noteUpsert(n2));
    sources.latest.emit(noteRemove('n1'));
    expect(cachedJobs(queryClient)).toEqual([b, a]);

    const held = { ...a, state: 'held' as const, placeInLine: null };
    sources.latest.emit(upsert(held));
    expect(cachedNotes()).toEqual([n2]);
    expect(queryClient.getQueryState(JOBS_KEY)?.isInvalidated).toBe(false);
  });
});
