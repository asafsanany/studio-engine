import type { ReviewNote, SentNotesResponse, ServerEvent } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { createJobEventsClient } from './job-events';
import { JOBS_KEY } from './jobs-cache';
import { SENT_NOTES_KEY, sentNotesKey, sentNotesQueryOptions } from './sent-notes';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  makeReviewNote,
  manualTimers,
} from './test-utils';

// The job sheet's sent-notes query: asked only while somebody watches it, and asked again when
// that job (and no other) changes. Sending a round of notes is a change of the job.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

const sent = (jobId: string, round: number): ReviewNote =>
  makeReviewNote({
    id: `${jobId}-${round}`,
    jobId,
    round,
    sentAt: '2026-10-22T12:31:00.000Z',
  });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's sent notes of two jobs; `calls` counts GET /api/jobs/:id/sent-notes per job. */
function serverNotes() {
  const calls = { [A]: 0, [B]: 0 } as Record<string, number>;
  const notes = { [A]: [sent(A, 1)], [B]: [sent(B, 1)] } as Record<string, ReviewNote[]>;
  server.use(
    http.get(`${BASE_URL}/api/jobs/:id/sent-notes`, ({ params }) => {
      const id = String(params.id);
      calls[id] = (calls[id] ?? 0) + 1;
      const body: SentNotesResponse = { jobId: id, notes: notes[id] ?? [] };
      return HttpResponse.json(body);
    }),
  );
  return { calls, notes };
}

/** What `useSentNotes(id, { enabled })` does in a component: an observer on the query. */
function watch(jobId: string, enabled = true) {
  const observer = new QueryObserver(queryClient, {
    ...sentNotesQueryOptions(api, jobId),
    enabled,
  });
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
const hello: ServerEvent = { type: 'hello' };

describe('sentNotesKey', () => {
  it('is [sent-notes, jobId] under its own root, apart from the unsent notes', () => {
    expect(SENT_NOTES_KEY).toEqual(['sent-notes']);
    expect(sentNotesKey(A)).toEqual(['sent-notes', A]);
    expect(sentNotesKey(A)).not.toEqual(sentNotesKey(B));
    expect(sentNotesKey(A)[0]).not.toBe('notes');
  });
});

describe('sentNotesQueryOptions', () => {
  it('reads the job’s sent notes under [sent-notes, jobId] and keeps them fresh until an event says otherwise', async () => {
    serverNotes();
    const options = sentNotesQueryOptions(api, A);

    await queryClient.fetchQuery(options);

    expect(options.queryKey).toEqual(['sent-notes', A]);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(queryClient.getQueryData(sentNotesKey(A))).toEqual({ jobId: A, notes: [sent(A, 1)] });
  });

  it('asks nothing while disabled (a closed sheet)', async () => {
    const state = serverNotes();
    const { stop } = watch(A, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[A]).toBe(0);
    stop();
  });

  it.each([404, 400])(
    'does not ask again after a %s: it will not change by asking',
    async (status) => {
      let calls = 0;
      server.use(
        http.get(`${BASE_URL}/api/jobs/${A}/sent-notes`, () => {
          calls += 1;
          return HttpResponse.json({ error: 'No.' }, { status });
        }),
      );
      // The app's own settings: queries retry for ever; this query must not after a 4xx.
      queryClient.setDefaultOptions({ queries: { retry: true, retryDelay: 1, gcTime: Infinity } });
      const { observer, stop } = watch(A);

      await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toBe(1);
      expect(observer.getCurrentResult().error).toMatchObject({ status, message: 'No.' });
      stop();
    },
  );

  it('asks again after a failure that is not the server saying no (a 500)', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/${A}/sent-notes`, () => {
        calls += 1;
        return calls < 3
          ? HttpResponse.json({ error: 'Oops' }, { status: 500 })
          : HttpResponse.json({ jobId: A, notes: [] });
      }),
    );
    queryClient.setDefaultOptions({ queries: { retry: true, retryDelay: 1, gcTime: Infinity } });
    const { observer, stop } = watch(A);

    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));

    expect(calls).toBe(3);
    stop();
  });
});

describe('the sent notes and the events', () => {
  it('reads an open sheet’s sent notes again when that job changes, and only that job’s', async () => {
    const state = serverNotes();
    const open = watch(A);
    const other = watch(B);
    await vi.waitFor(() => expect(open.observer.getCurrentResult().isSuccess).toBe(true));
    await vi.waitFor(() => expect(other.observer.getCurrentResult().isSuccess).toBe(true));
    expect(state.calls).toEqual({ [A]: 1, [B]: 1 });
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: A }), makeJob({ id: B })]);
    const sources = start();

    // Send notes: a second round is sent, and the job is announced.
    state.notes[A] = [sent(A, 1), sent(A, 2)];
    sources.latest.emit(upsert(A));

    await vi.waitFor(() => expect(state.calls[A]).toBe(2));
    expect(open.observer.getCurrentResult().data?.notes).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[B]).toBe(1);
    open.stop();
    other.stop();
  });

  it('only marks the sent notes of a closed sheet stale: they are read when it opens', async () => {
    const state = serverNotes();
    await queryClient.fetchQuery(sentNotesQueryOptions(api, A));
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: A })]);
    const sources = start();

    sources.latest.emit(upsert(A));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(state.calls[A]).toBe(1);
    expect(queryClient.getQueryState(sentNotesKey(A))?.isInvalidated).toBe(true);
    // The sheet opens: the stale notes are read again.
    const { stop } = watch(A);
    await vi.waitFor(() => expect(state.calls[A]).toBe(2));
    stop();
  });

  it('leaves the sent notes of a job alone when another job changes', async () => {
    serverNotes();
    await queryClient.fetchQuery(sentNotesQueryOptions(api, A));
    await queryClient.fetchQuery(sentNotesQueryOptions(api, B));
    const sources = start();

    sources.latest.emit(upsert(B));

    await vi.waitFor(() =>
      expect(queryClient.getQueryState(sentNotesKey(B))?.isInvalidated).toBe(true),
    );
    expect(queryClient.getQueryState(sentNotesKey(A))?.isInvalidated).toBe(false);
  });

  it('marks every job’s sent notes stale on a hello (events missed while disconnected)', async () => {
    serverNotes();
    await queryClient.fetchQuery(sentNotesQueryOptions(api, A));
    await queryClient.fetchQuery(sentNotesQueryOptions(api, B));
    const sources = start();

    sources.latest.emit(hello);

    await vi.waitFor(() =>
      expect(queryClient.getQueryState(sentNotesKey(A))?.isInvalidated).toBe(true),
    );
    expect(queryClient.getQueryState(sentNotesKey(B))?.isInvalidated).toBe(true);
  });

  it('does not touch the sent notes for a note event: sent notes never change', async () => {
    serverNotes();
    await queryClient.fetchQuery(sentNotesQueryOptions(api, A));
    const sources = start();

    sources.latest.emit({ type: 'note.upsert', note: makeReviewNote({ jobId: A }) });
    sources.latest.emit({ type: 'note.remove', jobId: A, noteId: 'n1' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(queryClient.getQueryState(sentNotesKey(A))?.isInvalidated).toBe(false);
  });
});
