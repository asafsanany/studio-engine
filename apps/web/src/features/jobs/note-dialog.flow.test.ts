import { eventForAction, type Job, type JobAction, transition } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '@/data/api';
import { jobActionMutationOptions } from '@/data/job-action';
import { BASE_URL, cachedJobs, createTestQueryClient, makeJob, watchJobs } from '@/data/test-utils';
import {
  createNoteDialogStore,
  dismissNoteDialog,
  type NoteDialogDeps,
  saveNoteDialog,
  startNoteDialog,
} from './note-dialog';

// CVP-140: the whole Add note… flow with the real actions against a small stand-in server that
// runs the shared state machine, as the real one does. Writing a note must not cost a queued job
// its turn; a manual Hold then Release still sends it to the back of the line.

const api = createApi({ baseUrl: BASE_URL });

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const FIRST = makeJob({
  id: 'testimonial',
  name: 'Patient testimonial',
  state: 'queued',
  settledAt: '2026-10-20T13:31:00.000Z',
  lastChangeAt: '2026-10-20T13:20:00.000Z',
  updatedAt: '2026-10-20T13:31:00.000Z',
});
const SECOND = makeJob({
  id: 'schedule',
  name: 'Class schedule',
  state: 'queued',
  settledAt: '2026-10-20T13:35:00.000Z',
  lastChangeAt: '2026-10-20T13:25:00.000Z',
  updatedAt: '2026-10-20T13:35:00.000Z',
});

/** The engine: the stored jobs, the clock, and the routes the page calls. */
function standInServer(initial: Job[]) {
  const jobs = new Map(initial.map((job) => [job.id, job]));
  let now = Date.parse('2026-10-20T14:00:00.000Z');
  const calls: string[] = [];

  /** The jobs as the API lists them: places in line worked out from the queue order. */
  function listed(): Job[] {
    const queue = [...jobs.values()]
      .filter((job) => job.state === 'queued')
      .sort((a, b) => Date.parse(a.settledAt ?? '') - Date.parse(b.settledAt ?? ''));
    return [...jobs.values()].map((job) => ({
      ...job,
      placeInLine: job.state === 'queued' ? queue.indexOf(job) + 1 : null,
    }));
  }
  const get = (id: string) => listed().find((job) => job.id === id) as Job;

  server.use(
    http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json(listed())),
    http.put(`${BASE_URL}/api/jobs/:id/note`, async ({ params, request }) => {
      const { note } = (await request.json()) as { note: string };
      calls.push(`note ${params.id}`);
      const job = { ...(jobs.get(String(params.id)) as Job), note };
      jobs.set(job.id, job);
      return HttpResponse.json(get(job.id));
    }),
    http.post(`${BASE_URL}/api/jobs/:id/:action`, ({ params, request }) => {
      const url = new URL(request.url);
      const action = String(params.action) as JobAction;
      calls.push(`${action}${url.search} ${params.id}`);
      const job = jobs.get(String(params.id)) as Job;
      const event = eventForAction(action, {
        restorePlace: url.searchParams.get('restore') === '1',
      });
      jobs.set(job.id, transition(job, event, new Date(now)));
      return HttpResponse.json(get(job.id));
    }),
  );

  return {
    calls,
    get,
    /** Time passes on the server. */
    advance: (ms: number) => {
      now += ms;
    },
  };
}

let queryClient: QueryClient;
let store: ReturnType<typeof createNoteDialogStore>;
beforeEach(() => {
  queryClient = createTestQueryClient();
  store = createNoteDialogStore();
});

/** The dialog's requests, sent the way `NoteDialogHost` sends them (its Release restores the place). */
function dialogDeps(): NoteDialogDeps {
  const run = (action: JobAction, restorePlace = false) => {
    const observer = new MutationObserver(
      queryClient,
      jobActionMutationOptions({ queryClient, api, action, restorePlace }),
    );
    return (id: string) => observer.mutate(id);
  };
  return {
    hold: run('hold'),
    release: run('release', true),
    save: (id, note) => api.saveNote(id, note),
    refused: vi.fn(),
  };
}

/** The page: the cache holds what the server listed, kept live like `useJobs()`. */
async function openPage(engine: ReturnType<typeof standInServer>) {
  queryClient.setQueryData(['jobs'], [engine.get(FIRST.id), engine.get(SECOND.id)]);
  watchJobs(queryClient, api);
}

const placeOf = (id: string) => cachedJobs(queryClient)?.find((job) => job.id === id)?.placeInLine;
const stateOf = (id: string) => cachedJobs(queryClient)?.find((job) => job.id === id)?.state;

describe('Add note… on the job that is first in line', () => {
  it('Cancel puts it back first, and the job behind it stays second', async () => {
    const engine = standInServer([FIRST, SECOND]);
    await openPage(engine);
    const deps = dialogDeps();
    expect(placeOf(FIRST.id)).toBe(1);

    await startNoteDialog(cachedJobs(queryClient)?.[0] as Job, deps, store);
    expect(engine.get(FIRST.id).state).toBe('held');
    // The dialog is open for a while: the other job moves up and time passes.
    engine.advance(5 * 60_000);
    await vi.waitFor(() => expect(placeOf(SECOND.id)).toBe(1));

    await dismissNoteDialog(deps, store);

    expect(engine.calls).toEqual([`hold ${FIRST.id}`, `release?restore=1 ${FIRST.id}`]);
    expect(engine.get(FIRST.id)).toMatchObject({ state: 'queued', placeInLine: 1 });
    expect(engine.get(FIRST.id).settledAt).toBe(FIRST.settledAt);
    expect(engine.get(SECOND.id).placeInLine).toBe(2);
    await vi.waitFor(() => expect(placeOf(FIRST.id)).toBe(1));
    await vi.waitFor(() => expect(placeOf(SECOND.id)).toBe(2));
    expect(stateOf(FIRST.id)).toBe('queued');
    expect(deps.refused).not.toHaveBeenCalled();
  });

  it('Save keeps its turn too, and the note is in', async () => {
    const engine = standInServer([FIRST, SECOND]);
    await openPage(engine);
    const deps = dialogDeps();

    await startNoteDialog(cachedJobs(queryClient)?.[0] as Job, deps, store);
    store.getState().setText('Keep it under 30 seconds.');
    engine.advance(5 * 60_000);
    await saveNoteDialog(deps, store);

    expect(engine.calls).toEqual([
      `hold ${FIRST.id}`,
      `note ${FIRST.id}`,
      `release?restore=1 ${FIRST.id}`,
    ]);
    expect(engine.get(FIRST.id)).toMatchObject({
      state: 'queued',
      placeInLine: 1,
      note: 'Keep it under 30 seconds.',
    });
    expect(engine.get(SECOND.id).placeInLine).toBe(2);
    await vi.waitFor(() => expect(placeOf(FIRST.id)).toBe(1));
    await vi.waitFor(() => expect(placeOf(SECOND.id)).toBe(2));
  });

  it('a manual Hold and Release from the row still sends it to the back of the line', async () => {
    const engine = standInServer([FIRST, SECOND]);
    await openPage(engine);
    const observer = (action: JobAction) =>
      new MutationObserver(queryClient, jobActionMutationOptions({ queryClient, api, action }));

    await observer('hold').mutate(FIRST.id);
    engine.advance(5 * 60_000);
    await observer('release').mutate(FIRST.id);

    expect(engine.calls).toEqual([`hold ${FIRST.id}`, `release ${FIRST.id}`]);
    expect(engine.get(FIRST.id)).toMatchObject({ state: 'queued', placeInLine: 2 });
    expect(engine.get(SECOND.id).placeInLine).toBe(1);
    await vi.waitFor(() => expect(placeOf(FIRST.id)).toBe(2));
    await vi.waitFor(() => expect(placeOf(SECOND.id)).toBe(1));
  });
});
