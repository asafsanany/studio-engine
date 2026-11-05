import type { NoSongStatus, ServerEvent } from '@studio/shared';
import { MutationObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, noSongDownloadUrl } from './api';
import { createJobEventsClient } from './job-events';
import {
  NO_SONG_KEY,
  noSongKey,
  noSongQueryOptions,
  RETRY_NO_SONG_TOAST_ID,
  retryNoSongMutationOptions,
} from './no-song';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  manualTimers,
} from './test-utils';

// The job's second file, the one without the song (Songs, SG9): the two calls, the
// ['no-song', jobId] query, and how the engine's republishing of the job keeps it current.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

const READY: NoSongStatus = {
  state: 'ready',
  file: 'Demo 2 · no song.mp4',
  at: '2026-10-25T21:24:00.000Z',
};

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The engine's status of two jobs; `calls` counts GET /api/jobs/:id/no-song per job. */
function serverStatus() {
  const calls = { [A]: 0, [B]: 0 } as Record<string, number>;
  const status = { [A]: READY, [B]: { state: 'making' } } as Record<string, NoSongStatus>;
  server.use(
    http.get(`${BASE_URL}/api/jobs/:id/no-song`, ({ params }) => {
      const id = String(params.id);
      calls[id] = (calls[id] ?? 0) + 1;
      return HttpResponse.json(status[id] ?? { state: 'none' });
    }),
  );
  return { calls, status };
}

/** What `useNoSong(id)` does in a component: an observer on the query. */
function watch(jobId: string) {
  const observer = new QueryObserver(queryClient, noSongQueryOptions(api, jobId));
  const stop = observer.subscribe(() => {});
  return { observer, stop };
}

function start() {
  const sources = fakeEventSources();
  createJobEventsClient({
    queryClient,
    eventSourceFactory: sources.factory,
    timers: manualTimers().timers,
  }).start();
  return sources;
}

const upsert = (id: string): ServerEvent => ({ type: 'job.upsert', job: makeJob({ id }) });

describe('the calls', () => {
  it('asks GET /api/jobs/:id/no-song and reads each of the five states', async () => {
    const states: NoSongStatus[] = [
      { state: 'none' },
      { state: 'idle' },
      { state: 'making' },
      { state: 'failed', message: 'Chrome did not start.' },
      READY,
    ];
    for (const state of states) {
      server.use(http.get(`${BASE_URL}/api/jobs/${A}/no-song`, () => HttpResponse.json(state)));
      await expect(api.getNoSong(A)).resolves.toEqual(state);
    }
  });

  it('asks POST /api/jobs/:id/no-song for Try again and reads the status it answers', async () => {
    let method = '';
    server.use(
      http.post(`${BASE_URL}/api/jobs/${A}/no-song`, ({ request }) => {
        method = request.method;
        return HttpResponse.json({ state: 'making' });
      }),
    );
    await expect(api.retryNoSong(A)).resolves.toEqual({ state: 'making' });
    expect(method).toBe('POST');
  });

  it('rejects with the engine’s words: no such file to make (409), Songs off (404)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/${A}/no-song`, () =>
        HttpResponse.json(
          { error: 'This job has no file without the song to make.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs/${B}/no-song`, () =>
        HttpResponse.json({ error: 'Not found' }, { status: 404 }),
      ),
    );
    await expect(api.retryNoSong(A)).rejects.toMatchObject({
      status: 409,
      message: 'This job has no file without the song to make.',
    });
    await expect(api.getNoSong(B)).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses an answer that is not a status', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/${A}/no-song`, () => HttpResponse.json({ state: 'lost' })),
    );
    await expect(api.getNoSong(A)).rejects.toBeInstanceOf(Error);
  });
});

describe('noSongDownloadUrl', () => {
  it('is the download link with ?file=no-song, the job’s id encoded', () => {
    expect(noSongDownloadUrl('a1b2c3d4e5f6')).toBe('/api/jobs/a1b2c3d4e5f6/download?file=no-song');
    expect(noSongDownloadUrl('a/b c', BASE_URL)).toBe(
      `${BASE_URL}/api/jobs/a%2Fb%20c/download?file=no-song`,
    );
  });
});

describe('noSongKey', () => {
  it('is one key per job under its own root', () => {
    expect(noSongKey(A)).toEqual(['no-song', A]);
    expect(noSongKey(A)).not.toEqual(noSongKey(B));
    expect(NO_SONG_KEY).toEqual(['no-song']);
  });
});

describe('the query', () => {
  it('holds the status, fresh until an event says otherwise', async () => {
    const state = serverStatus();
    const { observer, stop } = watch(A);
    await expect.poll(() => observer.getCurrentResult().data).toEqual(READY);
    expect(state.calls[A]).toBe(1);
    stop();
  });

  it('does not retry a 4xx: Songs off or a job that is gone will not change', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/${A}/no-song`, () => {
        calls += 1;
        return HttpResponse.json({ error: 'Not found' }, { status: 404 });
      }),
    );
    const { observer, stop } = watch(A);
    await expect.poll(() => observer.getCurrentResult().isError).toBe(true);
    expect(calls).toBe(1);
    stop();
  });
});

describe('the status and the events', () => {
  it('reads an open sheet’s status again when that job changes (the render starts, ends), and only that job’s', async () => {
    const state = serverStatus();
    const open = watch(A);
    const other = watch(B);
    await expect.poll(() => open.observer.getCurrentResult().isSuccess).toBe(true);
    await expect.poll(() => other.observer.getCurrentResult().isSuccess).toBe(true);
    const sources = start();

    // The render of A began: the engine announces the job, unchanged.
    state.status[A] = { state: 'making' };
    sources.latest.emit(upsert(A));

    await expect.poll(() => open.observer.getCurrentResult().data).toEqual({ state: 'making' });
    expect(state.calls[A]).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[B]).toBe(1);
    open.stop();
    other.stop();
  });

  it('only marks the status of a closed sheet stale: it is read when the sheet opens', async () => {
    const state = serverStatus();
    await queryClient.fetchQuery(noSongQueryOptions(api, A));
    const sources = start();

    sources.latest.emit(upsert(A));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(state.calls[A]).toBe(1);
    expect(queryClient.getQueryState(noSongKey(A))?.isInvalidated).toBe(true);
    const { stop } = watch(A);
    await expect.poll(() => state.calls[A]).toBe(2);
    stop();
  });

  it('leaves the status of a job alone when another job changes', async () => {
    serverStatus();
    await queryClient.fetchQuery(noSongQueryOptions(api, A));
    await queryClient.fetchQuery(noSongQueryOptions(api, B));
    const sources = start();

    sources.latest.emit(upsert(B));

    await expect.poll(() => queryClient.getQueryState(noSongKey(B))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(noSongKey(A))?.isInvalidated).toBe(false);
  });

  it('marks every job’s status stale on a hello (events missed while disconnected)', async () => {
    serverStatus();
    await queryClient.fetchQuery(noSongQueryOptions(api, A));
    await queryClient.fetchQuery(noSongQueryOptions(api, B));
    const sources = start();

    sources.latest.emit({ type: 'hello' });

    await expect.poll(() => queryClient.getQueryState(noSongKey(A))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(noSongKey(B))?.isInvalidated).toBe(true);
  });

  it('drops the status of a job that was removed', async () => {
    serverStatus();
    await queryClient.fetchQuery(noSongQueryOptions(api, A));
    const sources = start();

    sources.latest.emit({ type: 'job.remove', id: A });

    await expect.poll(() => queryClient.getQueryData(noSongKey(A))).toBeUndefined();
  });
});

describe('Try again', () => {
  const notify = { error: vi.fn() };
  beforeEach(() => notify.error.mockClear());

  function retry() {
    return new MutationObserver(
      queryClient,
      retryNoSongMutationOptions({ api, queryClient, jobId: A, notify }),
    );
  }

  it('puts the status the engine answers (making) in the cache as it is', async () => {
    queryClient.setQueryData(noSongKey(A), { state: 'failed', message: 'No.' });
    server.use(
      http.post(`${BASE_URL}/api/jobs/${A}/no-song`, () => HttpResponse.json({ state: 'making' })),
    );

    await retry().mutate();

    expect(queryClient.getQueryData(noSongKey(A))).toEqual({ state: 'making' });
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('says what the engine refused in a toast, and leaves the status as it was', async () => {
    queryClient.setQueryData(noSongKey(A), { state: 'idle' });
    server.use(
      http.post(`${BASE_URL}/api/jobs/${A}/no-song`, () =>
        HttpResponse.json(
          { error: 'This job has no file without the song to make.' },
          { status: 409 },
        ),
      ),
    );

    await expect(retry().mutate()).rejects.toMatchObject({ status: 409 });

    expect(queryClient.getQueryData(noSongKey(A))).toEqual({ state: 'idle' });
    expect(notify.error).toHaveBeenCalledWith('Couldn’t make the file again', {
      id: RETRY_NO_SONG_TOAST_ID,
      description: 'This job has no file without the song to make.',
    });
  });
});
