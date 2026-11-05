import { type ClientInstagram, INSTAGRAM_MESSAGES, noClientInstagram } from '@studio/shared';
import { MutationObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import { createInstagramApi } from './instagram-api';
import { clientInstagramKey } from './instagram-cache';
import {
  deleteClientInstagramMutationOptions,
  linkReelMutationOptions,
  scanClientInstagramMutationOptions,
  setClientInstagramMutationOptions,
  unlinkReelMutationOptions,
} from './instagram-mutations';
import { clientInstagramQueryOptions } from './instagram-query';
import { makeClientInstagram, makeInstagramReel } from './instagram-test-utils';
import { createJobEventsClient } from './job-events';
import { JOBS_KEY } from './jobs-cache';
import { jobsQueryOptions } from './jobs-query';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  manualTimers,
} from './test-utils';

// A client's Instagram follows its own events: `client-instagram` loads it again, in every range
// that somebody has loaded, and for that client only. The actions write what they answer.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const instagramApi = createInstagramApi({ baseUrl: BASE_URL });
const CLIENT = '1c9823704bf5';
const OTHER = 'b2c3d4e5f6a1';

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's Instagram answers; `calls` are the paths asked, with their range. */
function serverInstagram(answer: ClientInstagram = makeClientInstagram()) {
  const state = { answer, calls: [] as string[] };
  server.use(
    http.get(`${BASE_URL}/api/clients/:clientId/instagram`, ({ request, params }) => {
      const url = new URL(request.url);
      state.calls.push(`${String(params.clientId)}?${url.searchParams.get('range')}`);
      return HttpResponse.json(state.answer);
    }),
  );
  return state;
}

/** A page showing a client's Instagram in a range: an observer on its query, loaded. */
async function show(clientId: string, range: 'since' | '90' | '30' = 'since') {
  const observer = new QueryObserver(
    queryClient,
    clientInstagramQueryOptions(instagramApi, clientId, range),
  );
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() =>
    expect(queryClient.getQueryData(clientInstagramKey(clientId, range))).toBeDefined(),
  );
  return unsubscribe;
}

function startEvents() {
  const sources = fakeEventSources();
  createJobEventsClient({
    queryClient,
    eventSourceFactory: sources.factory,
    timers: manualTimers().timers,
  }).start();
  return sources;
}

describe('the client Instagram query', () => {
  it('asks for the range it is given, and keeps the answer fresh', async () => {
    const state = serverInstagram();
    await show(CLIENT, '90');
    expect(state.calls).toEqual([`${CLIENT}?90`]);
    expect(queryClient.getQueryData(clientInstagramKey(CLIENT, '90'))).toEqual(state.answer);
    expect(queryClient.getQueryState(clientInstagramKey(CLIENT, '90'))?.isInvalidated).toBe(false);
  });

  it('keeps each client and range in a key of its own', async () => {
    serverInstagram();
    await show(CLIENT, 'since');
    await show(CLIENT, '30');
    await show(OTHER, 'since');
    expect(queryClient.getQueryData(clientInstagramKey(CLIENT, 'since'))).toBeDefined();
    expect(queryClient.getQueryData(clientInstagramKey(CLIENT, '30'))).toBeDefined();
    expect(queryClient.getQueryData(clientInstagramKey(OTHER, 'since'))).toBeDefined();
    expect(queryClient.getQueryData(clientInstagramKey(OTHER, '90'))).toBeUndefined();
  });

  it('asks nothing while Instagram is off', async () => {
    // The server has no handler: an unhandled request would fail the test.
    const observer = new QueryObserver(
      queryClient,
      clientInstagramQueryOptions(instagramApi, CLIENT, 'since', false),
    );
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observer.getCurrentResult().fetchStatus).toBe('idle');
    expect(observer.getCurrentResult().data).toBeUndefined();
    unsubscribe();
  });

  it('is not asked again after a 4xx', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/clients/:clientId/instagram`, () => {
        calls += 1;
        return HttpResponse.json({ error: INSTAGRAM_MESSAGES.off }, { status: 404 });
      }),
    );
    const options = clientInstagramQueryOptions(instagramApi, CLIENT);
    const retry = options.retry as (count: number, error: Error) => boolean;
    expect(retry(0, new ApiError(404, INSTAGRAM_MESSAGES.off))).toBe(false);
    expect(retry(0, new ApiError(0, 'Cannot reach the Studio Engine server.'))).toBe(true);

    const result = await queryClient
      .fetchQuery({ ...options, retry: false })
      .catch((error) => error);
    expect(result).toMatchObject({ status: 404 });
    expect(calls).toBe(1);
  });
});

describe('the client-instagram event', () => {
  it('loads the client’s Instagram again, in every range that is loaded, and no other client’s', async () => {
    const state = serverInstagram();
    await show(CLIENT, 'since');
    await show(CLIENT, '30');
    await show(OTHER, 'since');
    expect(state.calls).toHaveLength(3);
    const sources = startEvents();

    sources.latest.emit({ type: 'client-instagram', clientId: CLIENT });

    await vi.waitFor(() => expect(state.calls).toHaveLength(5));
    expect(state.calls.slice(3).sort()).toEqual([`${CLIENT}?30`, `${CLIENT}?since`]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls).toHaveLength(5);
  });

  it('shows what the server then answers', async () => {
    const state = serverInstagram(noClientInstagram());
    await show(CLIENT);
    const sources = startEvents();

    state.answer = makeClientInstagram({ scanning: true });
    sources.latest.emit({ type: 'client-instagram', clientId: CLIENT });

    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData<ClientInstagram>(clientInstagramKey(CLIENT, 'since')),
      ).toEqual(state.answer),
    );
  });

  it('does nothing for a client nobody has loaded', async () => {
    const state = serverInstagram();
    await show(CLIENT);
    const sources = startEvents();

    sources.latest.emit({ type: 'client-instagram', clientId: OTHER });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(state.calls).toEqual([`${CLIENT}?since`]);
    expect(queryClient.getQueryData(clientInstagramKey(OTHER, 'since'))).toBeUndefined();
  });

  it('is loaded again for every client on a hello (what happened while we were away)', async () => {
    const state = serverInstagram();
    await show(CLIENT);
    await show(OTHER, '90');
    const sources = startEvents();
    // The list that a hello reloads.
    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([])));
    server.use(http.get(`${BASE_URL}/api/clients`, () => HttpResponse.json([])));
    server.use(http.get(`${BASE_URL}/api/money`, () => HttpResponse.json({})));

    sources.latest.emit({ type: 'hello' });

    await vi.waitFor(() => expect(state.calls.length).toBeGreaterThanOrEqual(4));
    expect(state.calls.slice(2).sort()).toEqual([`${CLIENT}?since`, `${OTHER}?90`]);
  });
});

describe('the actions', () => {
  const api = createInstagramApi({ baseUrl: BASE_URL });
  const params = () => ({ queryClient, api });

  it('set the account: the answer is written over the default range, and the client loads again', async () => {
    const state = serverInstagram(noClientInstagram());
    await show(CLIENT);
    const scanning = makeClientInstagram({ scanning: true });
    let body: unknown;
    server.use(
      http.put(`${BASE_URL}/api/clients/:clientId/instagram`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(scanning);
      }),
    );
    state.answer = scanning;

    const answer = await new MutationObserver(
      queryClient,
      setClientInstagramMutationOptions(params()),
    ).mutate({ clientId: CLIENT, account: { handle: '@Falcon.FPV', since: null } });

    expect(answer).toEqual(scanning);
    expect(body).toEqual({ handle: '@Falcon.FPV', since: null });
    expect(queryClient.getQueryData(clientInstagramKey(CLIENT, 'since'))).toEqual(scanning);
    await vi.waitFor(() => expect(state.calls).toHaveLength(2));
  });

  it('say why a handle is refused, and leave the cache as it was', async () => {
    const state = serverInstagram(noClientInstagram());
    await show(CLIENT);
    server.use(
      http.put(`${BASE_URL}/api/clients/:clientId/instagram`, () =>
        HttpResponse.json({ error: 'An Instagram handle has no spaces.' }, { status: 400 }),
      ),
    );

    await expect(
      new MutationObserver(queryClient, setClientInstagramMutationOptions(params())).mutate({
        clientId: CLIENT,
        account: { handle: 'falcon fpv' },
      }),
    ).rejects.toMatchObject({ status: 400, message: 'An Instagram handle has no spaces.' });

    expect(queryClient.getQueryData(clientInstagramKey(CLIENT, 'since'))).toEqual(
      noClientInstagram(),
    );
    expect(state.calls).toHaveLength(1);
  });

  it('scan now: the answer is written over the default range, and the client loads again', async () => {
    const state = serverInstagram(noClientInstagram());
    await show(CLIENT);
    const scanning = makeClientInstagram({ scanning: true });
    server.use(
      http.post(`${BASE_URL}/api/clients/:clientId/instagram/scan`, () =>
        HttpResponse.json(scanning, { status: 202 }),
      ),
    );
    state.answer = scanning;

    await new MutationObserver(queryClient, scanClientInstagramMutationOptions(params())).mutate(
      CLIENT,
    );

    expect(queryClient.getQueryData(clientInstagramKey(CLIENT, 'since'))).toEqual(scanning);
    await vi.waitFor(() => expect(state.calls).toHaveLength(2));
  });

  it('remove the account: the client loads again', async () => {
    const state = serverInstagram();
    await show(CLIENT);
    server.use(
      http.delete(`${BASE_URL}/api/clients/:clientId/instagram`, () =>
        HttpResponse.json({ ok: true }),
      ),
    );
    state.answer = noClientInstagram();

    await new MutationObserver(queryClient, deleteClientInstagramMutationOptions(params())).mutate(
      CLIENT,
    );

    await vi.waitFor(() =>
      expect(queryClient.getQueryData(clientInstagramKey(CLIENT, 'since'))).toEqual(
        noClientInstagram(),
      ),
    );
  });

  it('link and unlink: every client’s Instagram and the jobs load again', async () => {
    const state = serverInstagram();
    await show(CLIENT);
    let jobCalls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => {
        jobCalls += 1;
        return HttpResponse.json([makeJob({ id: 'a1b2c3d4e5f6' })]);
      }),
      http.post(`${BASE_URL}/api/instagram/reels/:shortcode/link`, () =>
        HttpResponse.json(makeInstagramReel()),
      ),
      http.delete(`${BASE_URL}/api/instagram/reels/:shortcode/link`, () =>
        HttpResponse.json(makeInstagramReel({ job: null })),
      ),
    );
    new QueryObserver(queryClient, jobsQueryOptions(createApi({ baseUrl: BASE_URL }))).subscribe(
      () => {},
    );
    await vi.waitFor(() => expect(queryClient.getQueryData(JOBS_KEY)).toBeDefined());
    expect(jobCalls).toBe(1);

    const linked = await new MutationObserver(
      queryClient,
      linkReelMutationOptions(params()),
    ).mutate({
      shortcode: 'C9xYz12AbCd',
      jobId: 'a1b2c3d4e5f6',
    });
    expect(linked).toEqual(makeInstagramReel());
    await vi.waitFor(() => expect(state.calls).toHaveLength(2));
    await vi.waitFor(() => expect(jobCalls).toBe(2));

    const freed = await new MutationObserver(
      queryClient,
      unlinkReelMutationOptions(params()),
    ).mutate('C9xYz12AbCd');
    expect(freed).toEqual(makeInstagramReel({ job: null }));
    await vi.waitFor(() => expect(state.calls).toHaveLength(3));
    await vi.waitFor(() => expect(jobCalls).toBe(3));
  });
});
