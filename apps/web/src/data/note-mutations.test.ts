import type { ReviewNote } from '@studio/shared';
import { MutationObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import {
  addNoteMutationOptions,
  addVoiceNoteMutationOptions,
  deleteNoteMutationOptions,
  isNoteDeletePending,
  NOTE_MUTATION_KEY,
  patchNoteMutationOptions,
} from './note-mutations';
import { notesKey } from './notes-cache';
import { notesQueryOptions } from './notes-query';
import { BASE_URL, createTestQueryClient, deferred, makeReviewNote } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const JOB = 'a1b2c3d4e5f6';

const first = makeReviewNote({ id: 'n1', atSec: 1, text: 'First' });
const second = makeReviewNote({ id: 'n2', atSec: 5, text: 'Second' });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
  queryClient.setQueryData(notesKey(JOB), [first, second]);
});

const cached = (): ReviewNote[] | undefined =>
  queryClient.getQueryData<ReviewNote[]>(notesKey(JOB));
const ids = (): string[] | undefined => cached()?.map((note) => note.id);

const params = () => ({ queryClient, api, jobId: JOB });

describe('addNoteMutationOptions', () => {
  it('puts the note the server answers with in the cache, in order', async () => {
    const answer = makeReviewNote({ id: 'n3', atSec: 3, text: 'Trimmed by the server' });
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB}/notes`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(answer, { status: 201 });
      }),
    );

    const note = await new MutationObserver(queryClient, addNoteMutationOptions(params())).mutate({
      atSec: 3,
      text: '  Trimmed by the server  ',
    });

    expect(note).toEqual(answer);
    expect(bodies).toEqual([{ atSec: 3, text: '  Trimmed by the server  ' }]);
    expect(ids()).toEqual(['n1', 'n3', 'n2']);
  });

  it('leaves the cache alone when the server refuses, and the error carries its text', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB}/notes`, () =>
        HttpResponse.json(
          { error: 'Notes can only be changed while the job is in Review.' },
          { status: 409 },
        ),
      ),
    );

    const error = await new MutationObserver(queryClient, addNoteMutationOptions(params()))
      .mutate({ atSec: 3, text: 'x' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      message: 'Notes can only be changed while the job is in Review.',
    });
    expect(ids()).toEqual(['n1', 'n2']);
  });

  it('does not create a list that was not cached', async () => {
    const other = 'another-job';
    const answer = makeReviewNote({ id: 'n9', jobId: other });
    server.use(
      http.post(`${BASE_URL}/api/jobs/${other}/notes`, () =>
        HttpResponse.json(answer, { status: 201 }),
      ),
    );

    await new MutationObserver(
      queryClient,
      addNoteMutationOptions({ queryClient, api, jobId: other }),
    ).mutate({ atSec: 1, text: 'x' });

    expect(queryClient.getQueryData(notesKey(other))).toBeUndefined();
  });
});

describe('addVoiceNoteMutationOptions', () => {
  it('uploads the recording and puts the pending note in the cache', async () => {
    const pending = makeReviewNote({
      id: 'v1',
      atSec: 2,
      kind: 'voice',
      text: null,
      audioFile: 'edit/review/voice/v1.webm',
      audioSec: 6,
      transcriptStatus: 'pending',
    });
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB}/notes/voice`, () =>
        HttpResponse.json(pending, { status: 201 }),
      ),
    );

    const note = await new MutationObserver(
      queryClient,
      addVoiceNoteMutationOptions(params()),
    ).mutate({
      audio: new Blob([new Uint8Array([1, 2])], { type: 'audio/webm' }),
      atSec: 2,
      audioSec: 6,
    });

    expect(note).toEqual(pending);
    expect(ids()).toEqual(['n1', 'v1', 'n2']);
  });
});

describe('patchNoteMutationOptions', () => {
  it('puts the changed note in the cache where it stands', async () => {
    const bodies: unknown[] = [];
    const answer = { ...second, addToStyle: true };
    server.use(
      http.patch(`${BASE_URL}/api/jobs/${JOB}/notes/n2`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(answer);
      }),
    );

    const note = await new MutationObserver(queryClient, patchNoteMutationOptions(params())).mutate(
      {
        noteId: 'n2',
        patch: { addToStyle: true },
      },
    );

    expect(note).toEqual(answer);
    expect(bodies).toEqual([{ addToStyle: true }]);
    expect(cached()).toEqual([first, answer]);
  });
});

describe('deleteNoteMutationOptions', () => {
  const observer = () => new MutationObserver(queryClient, deleteNoteMutationOptions(params()));

  it('removes the note at once, before the server has answered', async () => {
    const gate = deferred();
    server.use(
      http.delete(`${BASE_URL}/api/jobs/${JOB}/notes/n1`, async () => {
        await gate.promise;
        return HttpResponse.json({ ok: true });
      }),
    );

    const done = observer().mutate('n1');

    await vi.waitFor(() => expect(ids()).toEqual(['n2']));
    expect(isNoteDeletePending(queryClient, 'n1')).toBe(true);
    expect(isNoteDeletePending(queryClient, 'n2')).toBe(false);
    gate.resolve();
    await done;
    expect(ids()).toEqual(['n2']);
    expect(isNoteDeletePending(queryClient, 'n1')).toBe(false);
  });

  it('puts the note back, in its place, when the server refuses', async () => {
    server.use(
      http.delete(`${BASE_URL}/api/jobs/${JOB}/notes/n1`, () =>
        HttpResponse.json(
          { error: 'Notes can only be changed while the job is in Review.' },
          { status: 409 },
        ),
      ),
    );

    const error = await observer()
      .mutate('n1')
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 409 });
    expect(cached()).toEqual([first, second]);
  });

  it('does not put back a note the server says is gone (404)', async () => {
    server.use(
      http.delete(`${BASE_URL}/api/jobs/${JOB}/notes/n1`, () =>
        HttpResponse.json({ error: 'Note n1 not found' }, { status: 404 }),
      ),
    );

    await observer()
      .mutate('n1')
      .catch(() => {});

    expect(ids()).toEqual(['n2']);
  });

  it('deletes a note that is not in the cache without trouble', async () => {
    server.use(
      http.delete(`${BASE_URL}/api/jobs/${JOB}/notes/ghost`, () => HttpResponse.json({ ok: true })),
    );

    await observer().mutate('ghost');

    expect(ids()).toEqual(['n1', 'n2']);
  });

  it('cancels a list fetch that is under way, so it cannot bring the note back', async () => {
    const gate = deferred();
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/notes`, async () => {
        await gate.promise;
        return HttpResponse.json([first, second]);
      }),
      http.delete(`${BASE_URL}/api/jobs/${JOB}/notes/n1`, () => HttpResponse.json({ ok: true })),
    );
    const watching = new QueryObserver(queryClient, notesQueryOptions(api, JOB));
    const stop = watching.subscribe(() => {});
    await queryClient.invalidateQueries({ queryKey: notesKey(JOB), refetchType: 'none' });
    void queryClient.refetchQueries({ queryKey: notesKey(JOB) });
    await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: notesKey(JOB) })).toBe(1));

    await observer().mutate('n1');
    gate.resolve();

    expect(ids()).toEqual(['n2']);
    stop();
  });
});

describe('isNoteDeletePending', () => {
  it('uses the note mutation key', () => {
    expect(NOTE_MUTATION_KEY).toBe('note');
    expect(isNoteDeletePending(queryClient, 'n1')).toBe(false);
  });
});
