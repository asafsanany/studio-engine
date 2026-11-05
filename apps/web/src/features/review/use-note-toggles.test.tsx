// The toggles' actions: what PATCH carries, what the card shows, and the toast of a refusal. The
// route is answered by MSW; sonner's toast is mocked. There is no DOM, so the hook is rendered once
// to take its actions, which are then called.

import type { PatchNoteRequest, ReviewNote } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { notesKey } from '@/data/notes-cache';
import { BASE_URL, createTestQueryClient, makeReviewNote } from '@/data/test-utils';

const sonner = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('sonner', () => sonner);

const { useNoteToggles } = await import('./use-note-toggles');
type Toggles = ReturnType<typeof useNoteToggles>;

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  // The data layer's `api` asks for relative addresses; MSW answers absolute ones.
  const interceptedFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    interceptedFetch(
      typeof input === 'string' && input.startsWith('/') ? `${BASE_URL}${input}` : input,
      init,
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  vi.unstubAllGlobals();
  server.close();
});

const JOB = 'a1b2c3d4e5f6';
const NOTE_URL = `${BASE_URL}/api/jobs/${JOB}/notes/n1`;

let queryClient: QueryClient;
beforeEach(() => {
  sonner.toast.error.mockClear();
  queryClient = createTestQueryClient();
  queryClient.setQueryData(notesKey(JOB), [makeReviewNote()]);
});

/** The toggles of `note`, as a note card makes them. */
function togglesOf(note: ReviewNote, inSeries = true): Toggles {
  let toggles: Toggles | undefined;
  function Capture() {
    toggles = useNoteToggles(JOB, note, inSeries);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Capture />
    </QueryClientProvider>,
  );
  if (toggles === undefined) throw new Error('the hook did not run');
  return toggles;
}

/** Answers PATCH with the note changed as the request says, and records the bodies. */
function answerPatch(bodies: PatchNoteRequest[] = []) {
  server.use(
    http.patch(NOTE_URL, async ({ request }) => {
      const body = (await request.json()) as PatchNoteRequest;
      bodies.push(body);
      return HttpResponse.json(makeReviewNote(body));
    }),
  );
  return bodies;
}

const cachedNote = () => queryClient.getQueryData<ReviewNote[]>(notesKey(JOB))?.[0];

describe('useNoteToggles', () => {
  it('shows the note’s two marks', () => {
    expect(togglesOf(makeReviewNote())).toMatchObject({ style: false, series: false });
    expect(togglesOf(makeReviewNote({ addToStyle: true }))).toMatchObject({
      style: true,
      series: false,
    });
    expect(togglesOf(makeReviewNote({ addToSeries: true }))).toMatchObject({
      style: false,
      series: true,
    });
  });

  it('shows Series off on a card that has no Series toggle, whatever the note carries', () => {
    expect(togglesOf(makeReviewNote({ addToSeries: true }), false).series).toBe(false);
  });

  it('PATCHes addToSeries, alone, when Series is toggled, and keeps the note the server answers with', async () => {
    const bodies = answerPatch();
    togglesOf(makeReviewNote()).toggleSeries();
    await vi.waitFor(() => expect(cachedNote()?.addToSeries).toBe(true));
    expect(bodies).toEqual([{ addToSeries: true }]);
  });

  it('PATCHes addToSeries false when a Series that is on is toggled', async () => {
    const bodies = answerPatch();
    queryClient.setQueryData(notesKey(JOB), [makeReviewNote({ addToSeries: true })]);
    togglesOf(makeReviewNote({ addToSeries: true })).toggleSeries();
    await vi.waitFor(() => expect(cachedNote()?.addToSeries).toBe(false));
    expect(bodies).toEqual([{ addToSeries: false }]);
  });

  it('PATCHes addToStyle, alone, when Style is toggled', async () => {
    const bodies = answerPatch();
    togglesOf(makeReviewNote()).toggleStyle();
    await vi.waitFor(() => expect(cachedNote()?.addToStyle).toBe(true));
    expect(bodies).toEqual([{ addToStyle: true }]);
  });

  it('says what the server refused, with its reason, and leaves the note as it was', async () => {
    server.use(
      http.patch(NOTE_URL, () => HttpResponse.json({ error: 'Series are off.' }, { status: 422 })),
    );
    togglesOf(makeReviewNote()).toggleSeries();
    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledTimes(1));
    expect(sonner.toast.error).toHaveBeenCalledWith("Couldn't change Add to series", {
      description: 'Series are off.',
    });
    expect(cachedNote()?.addToSeries).toBe(false);
  });

  it('says it was Add to style that failed when Style is refused', async () => {
    server.use(http.patch(NOTE_URL, () => HttpResponse.json({ error: 'No.' }, { status: 409 })));
    togglesOf(makeReviewNote()).toggleStyle();
    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledTimes(1));
    expect(sonner.toast.error).toHaveBeenCalledWith("Couldn't change Add to style", {
      description: 'No.',
    });
  });
});
