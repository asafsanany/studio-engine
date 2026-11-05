// Another song and Pick a trending one: what each posts to the job's notes, word for word, and what
// the hook says about the notes already there. The route is answered by MSW. There is no DOM, so the
// hook is rendered once to take its actions, which are then called.

import type { AddNoteRequest, ReviewNote } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOBS_KEY } from '@/data/jobs-cache';
import { notesKey } from '@/data/notes-cache';
import { BASE_URL, createTestQueryClient, makeJob, makeReviewNote } from '@/data/test-utils';
import { SONG_NOTE_AT_SEC, type SongNotes, useSongNotes } from './use-song-notes';

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
const NOTES_URL = `${BASE_URL}/api/jobs/${JOB}/notes`;

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The hook's answer for a job whose unsent notes are `notes` (not in the cache for `undefined`). */
function songNotes(notes?: string[]): SongNotes {
  if (notes !== undefined) {
    queryClient.setQueryData(
      notesKey(JOB),
      notes.map((text, index) => makeReviewNote({ id: `n${index}`, jobId: JOB, text })),
    );
  }
  let result: SongNotes | undefined;
  function Capture() {
    result = useSongNotes(JOB, notes !== undefined);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Capture />
    </QueryClientProvider>,
  );
  if (result === undefined) throw new Error('the hook did not run');
  return result;
}

/** Answers the add-note route with the note as it was asked for, and records the bodies. */
function answerAdd(bodies: AddNoteRequest[] = []) {
  server.use(
    http.post(NOTES_URL, async ({ request }) => {
      const body = (await request.json()) as AddNoteRequest;
      bodies.push(body);
      return HttpResponse.json(makeReviewNote({ id: 'new', jobId: JOB, ...body }), { status: 201 });
    }),
  );
  return bodies;
}

const cachedTexts = () =>
  queryClient.getQueryData<ReviewNote[]>(notesKey(JOB))?.map((note) => note.text);

describe('Another song', () => {
  it('posts "Use [name] instead." for a name, trimmed, at the start of the video', async () => {
    const bodies = answerAdd();
    queryClient.setQueryData(notesKey(JOB), []);
    songNotes([]).addSong('  נתתי לך בית ');
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ atSec: SONG_NOTE_AT_SEC, text: 'Use נתתי לך בית instead.' });
    expect(SONG_NOTE_AT_SEC).toBe(0);
  });

  it('posts "Use the song from [link] instead." for a link', async () => {
    const bodies = answerAdd();
    songNotes([]).addSong('https://www.instagram.com/reel/DQx7mK2kF9a/');
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.text).toBe(
      'Use the song from https://www.instagram.com/reel/DQx7mK2kF9a/ instead.',
    );
  });

  it('puts the note in the job’s notes and tells the list it was added', async () => {
    answerAdd();
    const onAdded = vi.fn();
    songNotes([]).addSong('Mr. Brightside', onAdded);
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(cachedTexts()).toEqual(['Use Mr. Brightside instead.']);
  });

  it('posts nothing for a blank', async () => {
    const bodies = answerAdd();
    const onAdded = vi.fn();
    songNotes([]).addSong('   ', onAdded);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toEqual([]);
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe('Pick a trending one', () => {
  it('posts exactly "Use a trending song that fits the cut."', async () => {
    const bodies = answerAdd();
    songNotes([]).addTrending();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ atSec: 0, text: 'Use a trending song that fits the cut.' });
  });

  it('adds nothing more when the note is already among the unsent ones', async () => {
    const bodies = answerAdd();
    songNotes(['Use a trending song that fits the cut.']).addTrending();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toEqual([]);
  });
});

describe('what it says about the notes', () => {
  it('knows the trending note by its words, and says it was added', () => {
    const notes = songNotes(['Use cooler colours.', 'Use a trending song that fits the cut.']);
    expect(notes.trendingAdded).toBe(true);
    expect(notes.noted).toEqual({
      kind: 'trending',
      text: 'Use a trending song that fits the cut.',
    });
  });

  it('says nothing for other notes, even ones that look alike', () => {
    const notes = songNotes(['Use cooler colours.', 'Use something else instead.']);
    expect(notes.trendingAdded).toBe(false);
    expect(notes.noted).toBeNull();
  });

  it('says nothing before the notes are known', () => {
    const notes = songNotes();
    expect(notes).toMatchObject({ trendingAdded: false, noted: null, pending: false, error: null });
  });

  it('knows the client’s name, for the trending line', () => {
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: JOB, client: 'Falcon FPV' })]);
    expect(songNotes([]).client).toBe('Falcon FPV');
    expect(songNotes([]).client).not.toBeNull();
    queryClient.setQueryData(JOBS_KEY, []);
    expect(songNotes([]).client).toBeNull();
  });
});
