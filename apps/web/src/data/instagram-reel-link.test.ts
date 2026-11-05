import type { ClientInstagram, InstagramRange } from '@studio/shared';
import { MutationObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstagramApi } from './instagram-api';
import { clientInstagramKey } from './instagram-cache';
import { linkReelMutationOptions, unlinkReelMutationOptions } from './instagram-mutations';
import { clientInstagramQueryOptions } from './instagram-query';
import { makeClientInstagram, makeInstagramReel } from './instagram-test-utils';
import { BASE_URL, createTestQueryClient } from './test-utils';

// Link and unlink are the one optimistic change of the Instagram data: the reel's row (and its bar
// and band in the charts, and the Link to job list) changes before the server has answered, a
// refusal puts the page back, and the server's own page replaces it in the end.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createInstagramApi({ baseUrl: BASE_URL });
const CLIENT = '1c9823704bf5';
const OTHER = 'b2c3d4e5f6a1';
const THEIRS = 'C8aaBB11CcD';
const OURS = 'C9xYz12AbCd';
const WINTER = 'b2c3d4e5f6a1';

let queryClient: QueryClient;
let unsubscribers: Array<() => void>;
beforeEach(() => {
  queryClient = createTestQueryClient();
  unsubscribers = [];
});
afterEach(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
});

const params = () => ({ queryClient, api });

/** The server's page: what the GET answers, and how many times it was asked. */
function serverPage(answer: ClientInstagram = makeClientInstagram()) {
  const state = { answer, calls: 0 };
  server.use(
    http.get(`${BASE_URL}/api/clients/:clientId/instagram`, () => {
      state.calls += 1;
      return HttpResponse.json(state.answer);
    }),
  );
  return state;
}

/** A page on screen: an observer on the client's Instagram in a range, loaded. */
async function show(clientId: string, range: InstagramRange = 'since') {
  const observer = new QueryObserver(
    queryClient,
    clientInstagramQueryOptions(api, clientId, range),
  );
  unsubscribers.push(observer.subscribe(() => {}));
  await vi.waitFor(() =>
    expect(queryClient.getQueryData(clientInstagramKey(clientId, range))).toBeDefined(),
  );
}

const cached = (clientId = CLIENT, range: InstagramRange = 'since') =>
  queryClient.getQueryData<ClientInstagram>(clientInstagramKey(clientId, range));

const jobOf = (shortcode: string, data = cached()) =>
  data?.reels.find((reel) => reel.shortcode === shortcode)?.job ?? null;

/** A route that waits to be let go: the page is looked at while the request is on its way. */
function held() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
}

describe('Link to job', () => {
  it('turns the row ours, and takes the job off the list, before the server has answered', async () => {
    const state = serverPage();
    await show(CLIENT);
    const gate = held();
    server.use(
      http.post(`${BASE_URL}/api/instagram/reels/:shortcode/link`, async () => {
        await gate.released;
        return HttpResponse.json(
          makeInstagramReel({ shortcode: THEIRS, job: { id: WINTER, name: 'Winter reel' } }),
        );
      }),
    );
    expect(jobOf(THEIRS)).toBeNull();

    const linking = new MutationObserver(queryClient, linkReelMutationOptions(params())).mutate({
      shortcode: THEIRS,
      jobId: WINTER,
    });

    await vi.waitFor(() => expect(jobOf(THEIRS)).toEqual({ id: WINTER, name: 'Winter reel' }));
    expect(cached()?.linkableJobs).toEqual([]);
    expect(state.calls).toBe(1);

    // The server's own page replaces the change a moment after it answers.
    state.answer = makeClientInstagram({
      reels: [
        makeInstagramReel(),
        makeInstagramReel({
          shortcode: THEIRS,
          postedAt: '2026-10-14T09:00:00.000Z',
          job: { id: WINTER, name: 'Winter reel' },
        }),
      ],
      linkableJobs: [],
    });
    gate.release();
    await linking;
    await vi.waitFor(() => expect(state.calls).toBe(2));
    expect(cached()).toEqual(state.answer);
  });

  it('changes every range of the client that is loaded, and no other client’s page', async () => {
    serverPage();
    await show(CLIENT, 'since');
    await show(CLIENT, '30');
    // Another client's page with a reel of its own: the engine's shortcodes are unique, so it is not touched.
    const other = makeClientInstagram({
      reels: [makeInstagramReel({ shortcode: 'Other1', job: null })],
      linkableJobs: [],
    });
    queryClient.setQueryData(clientInstagramKey(OTHER, 'since'), other);
    const gate = held();
    server.use(
      http.post(`${BASE_URL}/api/instagram/reels/:shortcode/link`, async () => {
        await gate.released;
        return HttpResponse.json(makeInstagramReel({ shortcode: THEIRS }));
      }),
    );

    const linking = new MutationObserver(queryClient, linkReelMutationOptions(params())).mutate({
      shortcode: THEIRS,
      jobId: WINTER,
    });

    await vi.waitFor(() => expect(jobOf(THEIRS, cached(CLIENT, '30'))).not.toBeNull());
    expect(jobOf(THEIRS, cached(CLIENT, 'since'))).not.toBeNull();
    expect(cached(OTHER, 'since')).toBe(other);
    gate.release();
    await linking;
  });

  it('puts the row back when the server refuses, and says why in the server’s words', async () => {
    const original = makeClientInstagram();
    const state = serverPage(original);
    await show(CLIENT);
    const gate = held();
    server.use(
      http.post(`${BASE_URL}/api/instagram/reels/:shortcode/link`, async () => {
        await gate.released;
        return HttpResponse.json(
          {
            error: 'That video is linked to a reel already. Unlink it first.',
            reason: 'job-linked',
          },
          { status: 409 },
        );
      }),
    );

    const linking = new MutationObserver(queryClient, linkReelMutationOptions(params())).mutate({
      shortcode: THEIRS,
      jobId: WINTER,
    });
    const refused = expect(linking).rejects.toThrow(
      'That video is linked to a reel already. Unlink it first.',
    );
    await vi.waitFor(() => expect(jobOf(THEIRS)).not.toBeNull());

    gate.release();
    await refused;
    expect(cached()).toEqual(original);
    expect(jobOf(THEIRS)).toBeNull();
    expect(cached()?.linkableJobs).toEqual(original.linkableJobs);
    // The page is asked again, so what the refusal found out (the job is linked) comes in.
    await vi.waitFor(() => expect(state.calls).toBe(2));
  });

  it('puts the row back when the server cannot be reached', async () => {
    const original = makeClientInstagram();
    serverPage(original);
    await show(CLIENT);
    server.use(
      http.post(`${BASE_URL}/api/instagram/reels/:shortcode/link`, () => HttpResponse.error()),
    );

    await expect(
      new MutationObserver(queryClient, linkReelMutationOptions(params())).mutate({
        shortcode: THEIRS,
        jobId: WINTER,
      }),
    ).rejects.toThrow();
    expect(cached()).toEqual(original);
  });

  it('changes nothing it cannot show (an unknown job), and still asks the server', async () => {
    const original = makeClientInstagram();
    serverPage(original);
    await show(CLIENT);
    const gate = held();
    server.use(
      http.post(`${BASE_URL}/api/instagram/reels/:shortcode/link`, async () => {
        await gate.released;
        return HttpResponse.json({ error: 'Job nope not found' }, { status: 404 });
      }),
    );

    const linking = new MutationObserver(queryClient, linkReelMutationOptions(params())).mutate({
      shortcode: THEIRS,
      jobId: 'nope',
    });
    const refused = expect(linking).rejects.toThrow('Job nope not found');
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(1));
    expect(cached()).toEqual(original);
    gate.release();
    await refused;
  });
});

describe('Unlink', () => {
  it('turns the row theirs before the server has answered', async () => {
    serverPage();
    await show(CLIENT);
    const gate = held();
    server.use(
      http.delete(`${BASE_URL}/api/instagram/reels/:shortcode/link`, async () => {
        await gate.released;
        return HttpResponse.json(makeInstagramReel({ job: null }));
      }),
    );
    expect(jobOf(OURS)).not.toBeNull();

    const unlinking = new MutationObserver(queryClient, unlinkReelMutationOptions(params())).mutate(
      OURS,
    );

    await vi.waitFor(() => expect(jobOf(OURS)).toBeNull());
    gate.release();
    await expect(unlinking).resolves.toMatchObject({ job: null });
  });

  it('puts the row back when the server refuses', async () => {
    const original = makeClientInstagram();
    serverPage(original);
    await show(CLIENT);
    const gate = held();
    server.use(
      http.delete(`${BASE_URL}/api/instagram/reels/:shortcode/link`, async () => {
        await gate.released;
        return HttpResponse.json({ error: 'That reel is not linked to a video.' }, { status: 404 });
      }),
    );

    const unlinking = new MutationObserver(queryClient, unlinkReelMutationOptions(params())).mutate(
      OURS,
    );
    const refused = expect(unlinking).rejects.toThrow('That reel is not linked to a video.');
    await vi.waitFor(() => expect(jobOf(OURS)).toBeNull());

    gate.release();
    await refused;
    expect(cached()).toEqual(original);
    expect(jobOf(OURS)).toEqual({ id: 'a1b2c3d4e5f6', name: 'Autumn run' });
  });
});
