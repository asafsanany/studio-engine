import {
  type ClientRow,
  INSTAGRAM_MESSAGES,
  type JobReel,
  type JobReelResponse,
  type ServerEvent,
} from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import { CLIENTS_KEY, clientsQueryOptions } from './clients-query';
import { clientPhotoSrc, createInstagramApi } from './instagram-api';
import { JOB_REEL_KEY, jobReelKey } from './instagram-cache';
import { jobReelQueryOptions } from './instagram-query';
import { createJobEventsClient } from './job-events';
import { jobsQueryOptions } from './jobs-query';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  manualTimers,
} from './test-utils';

// The reel linked to a job (the job sheet's On Instagram line): its route, its query, and the
// events that load it again. Also the client list's reloads that a client-instagram event causes
// (the photo and the numbers of the Clients table come from the list).

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const instagramApi = createInstagramApi({ baseUrl: BASE_URL });
const api = createApi({ baseUrl: BASE_URL });
const JOB = 'a1b2c3d4e5f6';
const CLIENT = '1c9823704bf5';

const REEL: JobReel = {
  shortcode: 'C9xYz12AbCd',
  url: 'https://www.instagram.com/reel/C9xYz12AbCd/',
  postedAt: '2026-10-20T09:30:00.000Z',
  plays: 27_500,
  likes: 1_640,
  comments: 71,
  shares: 820,
};

const ROW: ClientRow = {
  clientId: CLIENT,
  client: 'Falcon FPV',
  jobs: 1,
  lastJobAt: '2026-10-20T11:02:10.000Z',
  style: { state: 'none', updatedAt: null },
};

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's job reel; `calls` are the job ids asked for. */
function serverReel(answer: JobReelResponse = { jobId: JOB, reel: REEL }) {
  const state = { answer, calls: [] as string[] };
  server.use(
    http.get(`${BASE_URL}/api/jobs/:jobId/reel`, ({ params }) => {
      state.calls.push(String(params.jobId));
      return HttpResponse.json(state.answer);
    }),
  );
  return state;
}

/** The server's client list; `calls` counts GET /api/clients. */
function serverClients() {
  const state = { calls: 0 };
  server.use(
    http.get(`${BASE_URL}/api/clients`, () => {
      state.calls += 1;
      return HttpResponse.json([ROW]);
    }),
  );
  return state;
}

/** A sheet showing the job's reel: an observer on its query, loaded. */
async function showReel(jobId = JOB) {
  const unsubscribe = new QueryObserver(
    queryClient,
    jobReelQueryOptions(instagramApi, jobId),
  ).subscribe(() => {});
  await vi.waitFor(() => expect(queryClient.getQueryData(jobReelKey(jobId))).toBeDefined());
  return unsubscribe;
}

/** A page showing the client list: an observer on its query, loaded. */
async function showClients() {
  const unsubscribe = new QueryObserver(queryClient, clientsQueryOptions(api)).subscribe(() => {});
  await vi.waitFor(() => expect(queryClient.getQueryData(CLIENTS_KEY)).toBeDefined());
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

const upsert = (job: ReturnType<typeof makeJob>): ServerEvent => ({ type: 'job.upsert', job });

describe('GET /api/jobs/:jobId/reel', () => {
  it('answers the reel linked to the job, with its numbers', async () => {
    const state = serverReel();
    await expect(instagramApi.getJobReel(JOB)).resolves.toEqual({ jobId: JOB, reel: REEL });
    expect(state.calls).toEqual([JOB]);
  });

  it('answers a null reel for a job none links', async () => {
    serverReel({ jobId: JOB, reel: null });
    await expect(instagramApi.getJobReel(JOB)).resolves.toEqual({ jobId: JOB, reel: null });
  });

  it('keeps the shares a scan could not read as null', async () => {
    serverReel({ jobId: JOB, reel: { ...REEL, shares: null } });
    const answer = await instagramApi.getJobReel(JOB);
    expect(answer.reel?.shares).toBeNull();
  });

  it('rejects with the engine’s words when Instagram is off', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:jobId/reel`, () =>
        HttpResponse.json({ error: INSTAGRAM_MESSAGES.off }, { status: 404 }),
      ),
    );
    await expect(instagramApi.getJobReel(JOB)).rejects.toMatchObject({
      status: 404,
      message: INSTAGRAM_MESSAGES.off,
    });
  });

  it('rejects an answer that is not a reel with the unreadable message', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:jobId/reel`, () =>
        HttpResponse.json({ jobId: JOB, reel: { shortcode: 'x' } }),
      ),
    );
    await expect(instagramApi.getJobReel(JOB)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('the job reel query', () => {
  it('keeps each job’s reel under a key of its own, below one root', async () => {
    serverReel();
    await showReel(JOB);
    await showReel('b2c3d4e5f6a1');
    expect(queryClient.getQueryData(jobReelKey(JOB))).toBeDefined();
    expect(queryClient.getQueryData(jobReelKey('b2c3d4e5f6a1'))).toBeDefined();
    expect(JOB_REEL_KEY).toEqual(['job-reel']);
    expect(queryClient.getQueriesData({ queryKey: JOB_REEL_KEY })).toHaveLength(2);
  });

  it('is fresh until an event says otherwise', async () => {
    const state = serverReel();
    await showReel();
    await showReel();
    expect(state.calls).toEqual([JOB]);
    expect(queryClient.getQueryState(jobReelKey(JOB))?.isInvalidated).toBe(false);
  });

  it('asks nothing while disabled (Instagram is off, or the job is not delivered)', async () => {
    // The server has no handler: an unhandled request would fail the test.
    const observer = new QueryObserver(queryClient, jobReelQueryOptions(instagramApi, JOB, false));
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observer.getCurrentResult().fetchStatus).toBe('idle');
    expect(observer.getCurrentResult().data).toBeUndefined();
    unsubscribe();
  });

  it('is not asked again after a 4xx', () => {
    const retry = jobReelQueryOptions(instagramApi, JOB).retry as (
      count: number,
      error: Error,
    ) => boolean;
    expect(retry(0, new ApiError(404, INSTAGRAM_MESSAGES.off))).toBe(false);
    expect(retry(0, new ApiError(0, 'Cannot reach the Studio Engine server.'))).toBe(true);
  });
});

describe('the events that load the job reel again', () => {
  it('a client-instagram event (a scan read new numbers) loads every open job reel again', async () => {
    const state = serverReel();
    await showReel();
    const sources = startEvents();

    sources.latest.emit({ type: 'client-instagram', clientId: CLIENT });

    await vi.waitFor(() => expect(state.calls).toEqual([JOB, JOB]));
  });

  it('a client-instagram event loads the client list again, for the photo and the numbers', async () => {
    const clients = serverClients();
    await showClients();
    expect(clients.calls).toBe(1);
    const sources = startEvents();

    sources.latest.emit({ type: 'client-instagram', clientId: CLIENT });

    await vi.waitFor(() => expect(clients.calls).toBe(2));
  });

  it('a client-instagram event loads the job list again while a video of the client has a reel linked, for the plays on its row', async () => {
    const uploaded = makeJob({
      id: JOB,
      clientId: CLIENT,
      state: 'ready',
      delivery: {
        deliveredAt: '2026-10-21T09:00:00.000Z',
        uploadedAt: '2026-10-20T09:30:00.000Z',
        reelPlays: 27_500,
      },
    });
    const calls = { jobs: 0 };
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => {
        calls.jobs += 1;
        return HttpResponse.json([uploaded]);
      }),
    );
    const unsubscribe = new QueryObserver(queryClient, jobsQueryOptions(api)).subscribe(() => {});
    await vi.waitFor(() => expect(calls.jobs).toBe(1));
    const sources = startEvents();

    // Another client's scan changes nothing on this client's rows.
    sources.latest.emit({ type: 'client-instagram', clientId: 'ffffffffffff' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.jobs).toBe(1);

    sources.latest.emit({ type: 'client-instagram', clientId: CLIENT });
    await vi.waitFor(() => expect(calls.jobs).toBe(2));
    unsubscribe();
  });

  it('leaves the job list alone when no video of the client has a reel linked', async () => {
    const delivered = makeJob({
      id: JOB,
      clientId: CLIENT,
      state: 'ready',
      delivery: { deliveredAt: '2026-10-21T09:00:00.000Z' },
    });
    const calls = { jobs: 0 };
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => {
        calls.jobs += 1;
        return HttpResponse.json([delivered]);
      }),
    );
    const unsubscribe = new QueryObserver(queryClient, jobsQueryOptions(api)).subscribe(() => {});
    await vi.waitFor(() => expect(calls.jobs).toBe(1));
    const sources = startEvents();

    sources.latest.emit({ type: 'client-instagram', clientId: CLIENT });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.jobs).toBe(1);
    unsubscribe();
  });

  it('a job that gains a reel link (uploadedAt) loads its reel again', async () => {
    const state = serverReel();
    await showReel();
    const job = makeJob({ id: JOB });
    queryClient.setQueryData(['jobs'], [job]);
    const sources = startEvents();

    sources.latest.emit(
      upsert({
        ...job,
        delivery: {
          deliveredAt: '2026-10-21T09:00:00.000Z',
          uploadedAt: '2026-10-20T09:30:00.000Z',
        },
      }),
    );

    await vi.waitFor(() => expect(state.calls).toEqual([JOB, JOB]));
  });

  it('a job whose reel link moved (reelUrl) loads its reel again, and no other job’s', async () => {
    const state = serverReel();
    await showReel();
    await showReel('b2c3d4e5f6a1');
    expect(state.calls).toHaveLength(2);
    const job = makeJob({
      id: JOB,
      delivery: {
        deliveredAt: '2026-10-21T09:00:00.000Z',
        uploadedAt: '2026-10-20T09:30:00.000Z',
        reelUrl: 'https://www.instagram.com/reel/Old/',
      },
    });
    queryClient.setQueryData(['jobs'], [job]);
    const sources = startEvents();

    sources.latest.emit(
      upsert({
        ...job,
        delivery: {
          deliveredAt: '2026-10-21T09:00:00.000Z',
          uploadedAt: '2026-10-20T09:30:00.000Z',
          reelUrl: 'https://www.instagram.com/reel/New/',
        },
      }),
    );

    await vi.waitFor(() => expect(state.calls).toHaveLength(3));
    expect(state.calls.slice(2)).toEqual([JOB]);
  });

  it('the progress tick of a job does not', async () => {
    const state = serverReel();
    await showReel();
    const job = makeJob({ id: JOB });
    queryClient.setQueryData(['jobs'], [job]);
    const sources = startEvents();

    sources.latest.emit(
      upsert({ ...job, state: 'editing', step: 3, updatedAt: '2026-10-20T14:00:00.000Z' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(state.calls).toEqual([JOB]);
  });
});

describe('clientPhotoSrc', () => {
  it('asks the photo route for the time the picture was saved, in milliseconds', () => {
    const photoAt = '2026-10-30T10:05:00.000Z';
    expect(clientPhotoSrc(CLIENT, photoAt)).toBe(
      `/api/clients/${CLIENT}/photo?v=${Date.parse(photoAt)}`,
    );
  });

  it('is a new address when a new picture is saved, so the old one is not shown', () => {
    expect(clientPhotoSrc(CLIENT, '2026-10-30T10:05:00.000Z')).not.toBe(
      clientPhotoSrc(CLIENT, '2026-11-06T10:05:00.000Z'),
    );
  });

  it('falls back to the plain route for a time it cannot read', () => {
    expect(clientPhotoSrc(CLIENT, 'not a time')).toBe(`/api/clients/${CLIENT}/photo`);
  });
});
