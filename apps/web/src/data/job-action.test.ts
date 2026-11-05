import type { Job, ReviewNote } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import { HEALTH_KEY } from './health-query';
import { isJobActionPending, jobActionMutationOptions } from './job-action';
import { JOBS_KEY } from './jobs-cache';
import { notesKey } from './notes-cache';
import {
  BASE_URL,
  cachedJobs,
  createTestQueryClient,
  deferred,
  makeJob,
  makeReviewNote,
  watchJobs,
} from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const NOW = new Date('2026-10-20T14:00:00.000Z');

const held = makeJob({
  id: 'held-one',
  state: 'held',
  placeInLine: null,
  settledAt: null,
  lastChangeAt: '2026-10-20T13:00:00.000Z',
  updatedAt: '2026-10-20T13:30:00.000Z',
});
const other = makeJob({ id: 'other', updatedAt: '2026-10-20T13:10:00.000Z' });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function actionObserver(action: Parameters<typeof jobActionMutationOptions>[0]['action']) {
  return new MutationObserver(
    queryClient,
    jobActionMutationOptions({ queryClient, api, action, now: () => NOW }),
  );
}

function seed(jobs: Job[]) {
  queryClient.setQueryData(JOBS_KEY, jobs);
}

function stateOf(id: string) {
  return cachedJobs(queryClient)?.find((j) => j.id === id)?.state;
}

describe('optimistic update', () => {
  it('moves the job to its next state before the server has answered', async () => {
    seed([held, other]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...held, state: 'queued', placeInLine: 1 });
      }),
    );

    const done = actionObserver('release').mutate(held.id);

    // Release on a job whose files were quiet for an hour goes straight to the queue.
    await vi.waitFor(() => expect(stateOf(held.id)).toBe('queued'));
    const optimistic = cachedJobs(queryClient)?.find((j) => j.id === held.id);
    expect(optimistic).toMatchObject({
      state: 'queued',
      placeInLine: null, // derived, so unknown until the server answers
      settledAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(isJobActionPending(queryClient, held.id)).toBe(true);
    expect(isJobActionPending(queryClient, other.id)).toBe(false);

    gate.resolve();
    await done;
    expect(isJobActionPending(queryClient, held.id)).toBe(false);
  });

  it("replaces the optimistic job with the server's answer", async () => {
    seed([held, other]);
    const fromServer = makeJob({
      ...held,
      state: 'queued',
      placeInLine: 1,
      settledAt: '2026-10-20T14:00:00.250Z',
      updatedAt: '2026-10-20T14:00:00.250Z',
    });
    server.use(http.post(`${BASE_URL}/api/jobs/:id/release`, () => HttpResponse.json(fromServer)));

    await expect(actionObserver('release').mutate(held.id)).resolves.toEqual(fromServer);

    expect(cachedJobs(queryClient)).toEqual([fromServer, other]);
  });

  it('uses the machine for every action (hold sends a queued job to held)', async () => {
    seed([other]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/hold`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...other, state: 'held', placeInLine: null });
      }),
    );
    const done = actionObserver('hold').mutate(other.id);
    await vi.waitFor(() => expect(stateOf(other.id)).toBe('held'));
    gate.resolve();
    await done;
  });

  it('Approve shows a review job queued for its render run at once', async () => {
    const review = makeJob({
      id: 'review-one',
      state: 'review',
      step: 7,
      placeInLine: null,
      preview: { durationSec: 28.4, width: 1080, height: 1920 },
    });
    seed([review, other]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/approve`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...review, state: 'queued', runKind: 'render' });
      }),
    );

    const done = actionObserver('approve').mutate(review.id);

    await vi.waitFor(() => expect(stateOf(review.id)).toBe('queued'));
    expect(cachedJobs(queryClient)?.find((j) => j.id === review.id)).toMatchObject({
      state: 'queued',
      runKind: 'render',
      step: null,
      approvedAt: NOW.toISOString(),
      settledAt: NOW.toISOString(),
      preview: review.preview,
    });
    gate.resolve();
    await done;
  });

  it('Start now queues an arriving job at once, however fresh its files are', async () => {
    const arriving = makeJob({
      id: 'arriving-one',
      state: 'arriving',
      placeInLine: null,
      settledAt: null,
      lastChangeAt: new Date(NOW.getTime() - 5_000).toISOString(),
      settlesAt: new Date(NOW.getTime() + 55_000).toISOString(),
    });
    seed([arriving, other]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/start`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...arriving, state: 'queued', placeInLine: 2, settlesAt: null });
      }),
    );

    const done = actionObserver('start').mutate(arriving.id);

    await vi.waitFor(() => expect(stateOf(arriving.id)).toBe('queued'));
    expect(cachedJobs(queryClient)?.find((j) => j.id === arriving.id)).toMatchObject({
      state: 'queued',
      settlesAt: null,
      settledAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    gate.resolve();
    await done;
    expect(stateOf(arriving.id)).toBe('queued');
  });
});

// CVP-140: a Release that restores the place (the note dialog's) shows the place at once.
describe('optimistic Release that restores the place in line', () => {
  const JOINED = '2026-10-20T13:31:00.000Z';
  // Held by the note dialog; it was first in line. Its files changed long before NOW.
  const heldFirst = makeJob({
    id: 'held-first',
    state: 'held',
    placeInLine: null,
    settledAt: null,
    heldSettledAt: JOINED,
    lastChangeAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T13:50:00.000Z',
  });
  const second = makeJob({
    id: 'second',
    state: 'queued',
    placeInLine: 1, // it moved up to #1 while the first one was held
    settledAt: '2026-10-20T13:35:00.000Z',
    updatedAt: '2026-10-20T13:20:00.000Z',
  });
  const third = makeJob({
    id: 'third',
    state: 'queued',
    placeInLine: 2,
    settledAt: '2026-10-20T13:40:00.000Z',
    updatedAt: '2026-10-20T13:10:00.000Z',
  });

  function restoringObserver() {
    return new MutationObserver(
      queryClient,
      jobActionMutationOptions({
        queryClient,
        api,
        action: 'release',
        restorePlace: true,
        now: () => NOW,
      }),
    );
  }

  /** Restoring Release of `heldFirst`: the cache while the server has not answered, and the request. */
  async function optimisticList(list: Job[]) {
    seed(list);
    const gate = deferred();
    const requests: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, async ({ request }) => {
        const url = new URL(request.url);
        requests.push(url.pathname + url.search);
        await gate.promise;
        return HttpResponse.json({ ...heldFirst, state: 'queued', placeInLine: 1 });
      }),
    );
    const done = restoringObserver().mutate(heldFirst.id);
    await vi.waitFor(() => expect(stateOf(heldFirst.id)).toBe('queued'));
    const shown = cachedJobs(queryClient);
    gate.resolve();
    await done;
    return { shown, requests };
  }

  it('shows the job back at its old place, and the others behind it, at once', async () => {
    const { shown, requests } = await optimisticList([heldFirst, second, third]);

    const place = (id: string) => shown?.find((j) => j.id === id);
    expect(place(heldFirst.id)).toMatchObject({
      state: 'queued',
      settledAt: JOINED,
      heldSettledAt: null,
      placeInLine: 1,
      updatedAt: NOW.toISOString(),
    });
    expect(place(second.id)?.placeInLine).toBe(2);
    expect(place(third.id)?.placeInLine).toBe(3);
    expect(requests).toEqual(['/api/jobs/held-first/release?restore=1']);
  });

  it('shows the job at the back of the line when the held job remembers no place', async () => {
    const { shown } = await optimisticList([{ ...heldFirst, heldSettledAt: null }, second, third]);

    expect(shown?.find((j) => j.id === heldFirst.id)).toMatchObject({
      settledAt: NOW.toISOString(),
      placeInLine: 3,
    });
    expect(shown?.find((j) => j.id === second.id)?.placeInLine).toBe(1);
  });

  it('a plain Release still shows the job without a place, and leaves the others alone', async () => {
    seed([heldFirst, second, third]);
    const gate = deferred();
    const requests: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, async ({ request }) => {
        const url = new URL(request.url);
        requests.push(url.pathname + url.search);
        await gate.promise;
        return HttpResponse.json({ ...heldFirst, state: 'queued', placeInLine: 3 });
      }),
    );
    const done = actionObserver('release').mutate(heldFirst.id);
    await vi.waitFor(() => expect(stateOf(heldFirst.id)).toBe('queued'));

    const shown = cachedJobs(queryClient);
    expect(shown?.find((j) => j.id === heldFirst.id)).toMatchObject({
      settledAt: NOW.toISOString(),
      placeInLine: null,
    });
    expect(shown?.find((j) => j.id === second.id)?.placeInLine).toBe(1);
    gate.resolve();
    await done;
    expect(requests).toEqual(['/api/jobs/held-first/release']);
  });

  it('puts the job back as it was when the server refuses', async () => {
    seed([heldFirst, second, third]);
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, () =>
        HttpResponse.json({ error: 'Cannot release a job that is queued.' }, { status: 409 }),
      ),
    );
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([heldFirst, second, third])),
    );

    await expect(restoringObserver().mutate(heldFirst.id)).rejects.toMatchObject({ status: 409 });

    expect(stateOf(heldFirst.id)).toBe('held');
  });
});

// The instant Release must pick arriving or queued like the server: files changed less than the
// settle delay ago means arriving, else queued. The delay is the server's (`/api/health`), and the
// 60 s default until the page knows it.
describe('optimistic Release and the settle delay', () => {
  /** A held job whose files last changed `agoMs` before NOW. */
  function heldChangedAgo(agoMs: number) {
    return makeJob({
      id: 'held-recent',
      state: 'held',
      placeInLine: null,
      settledAt: null,
      lastChangeAt: new Date(NOW.getTime() - agoMs).toISOString(),
      updatedAt: '2026-10-20T13:30:00.000Z',
    });
  }

  function knowSettleMs(settleMs: number) {
    queryClient.setQueryData(HEALTH_KEY, { ok: true, version: '0.1.6', settleMs });
  }

  /** Releases the job and returns what the cache shows while the server has not answered yet. */
  async function optimisticRelease(job: Job): Promise<Job | undefined> {
    seed([job]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...job, state: 'queued', placeInLine: 1 });
      }),
    );
    const done = actionObserver('release').mutate(job.id);
    await vi.waitFor(() => expect(stateOf(job.id)).not.toBe('held'));
    const shown = cachedJobs(queryClient)?.find((j) => j.id === job.id);
    gate.resolve();
    await done;
    return shown;
  }

  describe('with the server settle delay of 5 s', () => {
    beforeEach(() => knowSettleMs(5000));

    it('keeps a job whose files changed 4 s ago arriving', async () => {
      const shown = await optimisticRelease(heldChangedAgo(4000));
      expect(shown).toMatchObject({
        state: 'arriving',
        settlesAt: new Date(NOW.getTime() + 1000).toISOString(), // 5 s after the change
      });
    });

    it('sends a job whose files changed 6 s ago to the queue', async () => {
      const shown = await optimisticRelease(heldChangedAgo(6000));
      expect(shown).toMatchObject({ state: 'queued', settlesAt: null });
    });

    it('sends a job to the queue exactly when the delay has passed', async () => {
      const shown = await optimisticRelease(heldChangedAgo(5000));
      expect(shown?.state).toBe('queued');
    });
  });

  describe('with a settle delay of 0', () => {
    it('queues even a job that changed this very moment', async () => {
      knowSettleMs(0);
      const shown = await optimisticRelease(heldChangedAgo(0));
      expect(shown?.state).toBe('queued');
    });
  });

  describe('before the server settle delay is known', () => {
    it('falls back to 60 s: a job that changed 59 s ago is arriving', async () => {
      const shown = await optimisticRelease(heldChangedAgo(59_000));
      expect(shown).toMatchObject({
        state: 'arriving',
        settlesAt: new Date(NOW.getTime() + 1000).toISOString(),
      });
    });

    it('falls back to 60 s: a job that changed 61 s ago is queued', async () => {
      const shown = await optimisticRelease(heldChangedAgo(61_000));
      expect(shown?.state).toBe('queued');
    });

    it('does not use a 5 s delay it was never told: a job that changed 6 s ago is arriving', async () => {
      const shown = await optimisticRelease(heldChangedAgo(6000));
      expect(shown?.state).toBe('arriving');
    });
  });

  it('uses the delay as it is when the action starts, so an answer that came in meanwhile counts', async () => {
    const job = heldChangedAgo(6000);
    expect((await optimisticRelease(job))?.state).toBe('arriving'); // not known yet: 60 s

    knowSettleMs(5000); // the health answer arrives
    expect((await optimisticRelease(job))?.state).toBe('queued');
  });
});

describe('failed mutation', () => {
  it('rolls the job back and exposes the 409 text on the mutation', async () => {
    seed([held, other]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, async () => {
        await gate.promise;
        return HttpResponse.json(
          { error: 'Cannot release a job that is queued.' },
          { status: 409 },
        );
      }),
    );
    const observer = actionObserver('release');

    const done = observer.mutate(held.id);
    const failure = done.catch((e: unknown) => e);
    await vi.waitFor(() => expect(stateOf(held.id)).toBe('queued'));
    gate.resolve();

    const error = await failure;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'Cannot release a job that is queued.' });
    expect(observer.getCurrentResult().error).toBe(error);
    // Back to exactly what was there before.
    expect(cachedJobs(queryClient)).toEqual([held, other]);
  });

  it('rolls back on a network failure too', async () => {
    seed([held]);
    server.use(http.post(`${BASE_URL}/api/jobs/:id/release`, () => HttpResponse.error()));
    await expect(actionObserver('release').mutate(held.id)).rejects.toMatchObject({ status: 0 });
    expect(cachedJobs(queryClient)).toEqual([held]);
  });

  it('puts back only the job it changed, not other jobs that were updated meanwhile', async () => {
    seed([held, other]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, async () => {
        await gate.promise;
        return HttpResponse.json(
          { error: 'Cannot release a job that is queued.' },
          { status: 409 },
        );
      }),
    );
    const failure = actionObserver('release')
      .mutate(held.id)
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(stateOf(held.id)).toBe('queued'));

    // Another job moves on while the request is out (an SSE upsert).
    const otherMoved = { ...other, state: 'editing' as const, placeInLine: null };
    queryClient.setQueryData<Job[]>(JOBS_KEY, (list) =>
      list?.map((j) => (j.id === other.id ? otherMoved : j)),
    );
    gate.resolve();
    await failure;

    expect(cachedJobs(queryClient)).toEqual([otherMoved, held].sort(byUpdatedDesc));
  });

  it('leaves a job alone that a reload already replaced with the truth', async () => {
    seed([held]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/release`, async () => {
        await gate.promise;
        return HttpResponse.json(
          { error: 'Cannot release a job that is editing.' },
          { status: 409 },
        );
      }),
    );
    const failure = actionObserver('release')
      .mutate(held.id)
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(stateOf(held.id)).toBe('queued'));

    const truth = { ...held, state: 'editing' as const, step: 2 as const, placeInLine: null };
    queryClient.setQueryData<Job[]>(JOBS_KEY, [truth]);
    gate.resolve();
    await failure;

    expect(cachedJobs(queryClient)).toEqual([truth]);
  });
});

describe('an action the state machine refuses for the cached job', () => {
  const ready = makeJob({
    id: 'ready-one',
    state: 'ready',
    placeInLine: null,
    step: 7,
    updatedAt: '2026-10-20T13:50:00.000Z',
  });

  it('changes nothing optimistically but still asks the server, which gets the last word', async () => {
    seed([ready]);
    const gate = deferred();
    let requests = 0;
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/hold`, async () => {
        requests += 1;
        await gate.promise;
        return HttpResponse.json({ error: 'Cannot hold a job that is ready.' }, { status: 409 });
      }),
    );
    const failure = actionObserver('hold')
      .mutate(ready.id)
      .catch((e: unknown) => e);

    await vi.waitFor(() => expect(requests).toBe(1));
    expect(cachedJobs(queryClient)).toEqual([ready]);

    gate.resolve();
    await expect(failure).resolves.toMatchObject({
      status: 409,
      message: 'Cannot hold a job that is ready.',
    });
    expect(cachedJobs(queryClient)).toEqual([ready]);
  });

  it('still sends the request for a job the cache does not have', async () => {
    seed([other]);
    const fromServer = makeJob({ id: 'unseen', state: 'held', placeInLine: null });
    server.use(http.post(`${BASE_URL}/api/jobs/:id/hold`, () => HttpResponse.json(fromServer)));
    await actionObserver('hold').mutate('unseen');
    // The answer is inserted: the page learns about the job from it.
    expect(
      cachedJobs(queryClient)
        ?.map((j) => j.id)
        .sort(),
    ).toEqual(['other', 'unseen']);
  });

  it('does not invent a list when none is loaded', async () => {
    server.use(http.post(`${BASE_URL}/api/jobs/:id/hold`, () => HttpResponse.json(other)));
    await actionObserver('hold').mutate(other.id);
    expect(cachedJobs(queryClient)).toBeUndefined();
  });
});

describe('after the action, success or not', () => {
  it('reloads the list so the cache ends up as the server has it', async () => {
    const serverList = [
      makeJob({
        ...held,
        state: 'editing',
        step: 1,
        placeInLine: null,
        updatedAt: '2026-10-20T14:05:00.000Z',
      }),
      other,
    ];
    let listCalls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => {
        listCalls += 1;
        return HttpResponse.json(listCalls === 1 ? [held, other] : serverList);
      }),
      // The answer says "queued"; by the time the list is reloaded the worker has picked it up.
      http.post(`${BASE_URL}/api/jobs/:id/release`, () =>
        HttpResponse.json({ ...held, state: 'queued', placeInLine: 1 }),
      ),
    );
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([held, other]));

    await actionObserver('release').mutate(held.id);

    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual(serverList));
    expect(listCalls).toBe(2);
  });

  it('repairs a stale cache after a refusal', async () => {
    // The cache thinks the job is ready; the server knows it is already held.
    const stale = makeJob({ id: 'x', state: 'ready', placeInLine: null, step: 7 });
    const truth = makeJob({ id: 'x', state: 'held', placeInLine: null });
    let loaded = false;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json(loaded ? [truth] : [stale])),
      http.post(`${BASE_URL}/api/jobs/:id/hold`, () => {
        loaded = true;
        return HttpResponse.json({ error: 'Cannot hold a job that is held.' }, { status: 409 });
      }),
    );
    watchJobs(queryClient, api);
    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([stale]));

    await expect(actionObserver('hold').mutate('x')).rejects.toMatchObject({ status: 409 });

    await vi.waitFor(() => expect(cachedJobs(queryClient)).toEqual([truth]));
  });
});

/** The order the cache keeps: newest updatedAt first. */
function byUpdatedDesc(a: Job, b: Job): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

describe('Send notes and the cached notes (W5)', () => {
  const review = makeJob({
    id: 'review-one',
    state: 'review',
    step: 7,
    placeInLine: null,
    preview: { durationSec: 28.4, width: 1080, height: 1920 },
    updatedAt: '2026-10-20T13:30:00.000Z',
  });
  const note = makeReviewNote({ id: 'n1', jobId: review.id });
  const queuedByTheServer: Job = {
    ...review,
    state: 'queued',
    step: null,
    runKind: 'revise',
    round: 1,
    placeInLine: 1,
    updatedAt: '2026-10-20T13:45:00.000Z',
  };
  const notes = () => queryClient.getQueryData<ReviewNote[]>(notesKey(review.id));

  it('empties the cached notes once the Send went through', async () => {
    seed([review, other]);
    queryClient.setQueryData(notesKey(review.id), [note]);
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/send-notes`, () => HttpResponse.json(queuedByTheServer)),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([queuedByTheServer, other])),
    );

    await actionObserver('send_notes').mutate(review.id);

    expect(notes()).toEqual([]);
    expect(stateOf(review.id)).toBe('queued');
  });

  it('keeps the notes when the Send is refused (the voice notes are still being transcribed)', async () => {
    seed([review, other]);
    queryClient.setQueryData(notesKey(review.id), [note]);
    const gate = deferred();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/send-notes`, async () => {
        await gate.promise;
        return HttpResponse.json(
          { error: 'Wait for the voice notes to be transcribed.' },
          { status: 409 },
        );
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([review, other])),
    );

    const done = actionObserver('send_notes')
      .mutate(review.id)
      .catch((e: unknown) => e);
    // Not emptied while the request is on its way either.
    await vi.waitFor(() => expect(stateOf(review.id)).toBe('queued'));
    expect(notes()).toEqual([note]);
    gate.resolve();
    const error = await done;

    expect(error).toMatchObject({
      status: 409,
      message: 'Wait for the voice notes to be transcribed.',
    });
    expect(notes()).toEqual([note]);
    expect(stateOf(review.id)).toBe('review');
  });

  it('does not create a notes list that was not cached', async () => {
    seed([review, other]);
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/send-notes`, () => HttpResponse.json(queuedByTheServer)),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([queuedByTheServer, other])),
    );

    await actionObserver('send_notes').mutate(review.id);

    expect(notes()).toBeUndefined();
  });

  it('leaves the notes alone for every other action', async () => {
    seed([review, other]);
    queryClient.setQueryData(notesKey(review.id), [note]);
    const approved: Job = { ...queuedByTheServer, runKind: 'render', round: 0 };
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/approve`, () => HttpResponse.json(approved)),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([approved, other])),
    );

    await actionObserver('approve').mutate(review.id);

    expect(notes()).toEqual([note]);
  });
});
