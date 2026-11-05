import { FIX_MESSAGES, type Job, type QuickFix } from '@studio/shared';
import { type QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeOpenFix, makeQuickFix } from '@/features/review/fix-test-helpers';
import { ApiError, createApi } from './api';
import {
  applyFix,
  applyJobFixEvent,
  fixesRev,
  JOB_FIXES_KEY,
  type JobFixes,
  jobFixesKey,
  jobFixesQueryOptions,
  newestFixByNote,
  UNDO_FIX_FAILED_TEXT,
  undoFixMutationOptions,
  upsertFix,
  useJobFixes,
} from './job-fixes';
import { JOBS_KEY } from './jobs-cache';
import { BASE_URL, createTestQueryClient, makeJob } from './test-utils';

// A job's quick fixes as the page holds them (Quick fixes, QF6): the two calls, the pure rules
// (the newest fix of a note, `rev`), the cache, the switch that keeps the hook from asking
// anything, and Undo.

const JOB = 'a1b2c3d4e5f6';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

describe('the fixes calls', () => {
  it('GETs /api/jobs/:id/fixes, with the id escaped, and unwraps the list', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/fixes`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ fixes: [makeQuickFix()] });
      }),
    );
    await expect(api.getJobFixes(JOB)).resolves.toEqual([makeQuickFix()]);
    await api.getJobFixes('a/b c');
    expect(seen).toEqual([`/api/jobs/${JOB}/fixes`, '/api/jobs/a%2Fb%20c/fixes']);
  });

  it('POSTs the undo of a fix and reads the fix and the job it answers with', async () => {
    const seen: string[] = [];
    const job = makeJob({ id: JOB, state: 'review', placeInLine: null });
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/fixes/:fixId/undo`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ fix: makeQuickFix({ status: 'undone', said: null }), job });
      }),
    );
    const answer = await api.undoFix(JOB, 'f/1');
    expect(answer.fix.status).toBe('undone');
    expect(answer.job.id).toBe(JOB);
    expect(seen).toEqual([`/api/jobs/${JOB}/fixes/f%2F1/undo`]);
  });

  it('keeps the server’s words of a refusal: not the newest fix, off', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/fixes/:fixId/undo`, () =>
        HttpResponse.json({ error: FIX_MESSAGES.notNewest }, { status: 409 }),
      ),
      http.get(`${BASE_URL}/api/jobs/:id/fixes`, () =>
        HttpResponse.json({ error: FIX_MESSAGES.off }, { status: 404 }),
      ),
    );
    await expect(api.undoFix(JOB, 'f1')).rejects.toMatchObject({
      status: 409,
      message: FIX_MESSAGES.notNewest,
    });
    await expect(api.getJobFixes(JOB)).rejects.toMatchObject({
      status: 404,
      message: FIX_MESSAGES.off,
    });
  });

  it('rejects an answer that is not a list of fixes', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/fixes`, () => HttpResponse.json({ fixes: [{ id: 'x' }] })),
    );
    await expect(api.getJobFixes(JOB)).rejects.toMatchObject({ name: 'ApiError', status: 200 });
  });
});

describe('the rules', () => {
  it('upsertFix replaces a fix where it stands, or joins the end', () => {
    const a = makeQuickFix({ id: 'a', noteId: 'na' });
    const b = makeOpenFix('queued', { id: 'b', noteId: 'nb' });
    expect(upsertFix([a], b)).toEqual([a, b]);
    const running = makeOpenFix('running', { id: 'b', noteId: 'nb' });
    expect(upsertFix([a, b], running)).toEqual([a, running]);
    const later = makeQuickFix({ id: 'c', noteId: 'nc' });
    expect(upsertFix([a, b], later)).toEqual([a, b, later]);
  });

  it('upsertFix drops the fixes of a round that is over', () => {
    const old = makeQuickFix({ id: 'old', round: 1 });
    const next = makeOpenFix('queued', { id: 'new', round: 2 });
    expect(upsertFix([old], next)).toEqual([next]);
  });

  it('newestFixByNote gives each note its last fix, in whatever state', () => {
    const first = makeQuickFix({
      id: 'a',
      noteId: 'n1',
      status: 'escalated',
      why: 'x',
      said: null,
    });
    const second = makeOpenFix('queued', { id: 'b', noteId: 'n1' });
    const other = makeQuickFix({ id: 'c', noteId: 'n2' });
    const byNote = newestFixByNote([first, second, other]);
    expect(byNote.get('n1')?.id).toBe('b');
    expect(byNote.get('n2')?.id).toBe('c');
    expect(byNote.size).toBe(2);
  });

  it('fixesRev is the newest end of a fixed or an undone fix, in ms; null for none', () => {
    expect(fixesRev([])).toBeNull();
    expect(fixesRev([makeOpenFix('running'), makeOpenFix('queued')])).toBeNull();
    const escalated = makeQuickFix({
      status: 'escalated',
      endedAt: '2026-10-25T10:00:00.000Z',
      why: 'x',
      said: null,
    });
    expect(fixesRev([escalated, makeQuickFix({ status: 'cancelled' })])).toBeNull();
    const fixed = makeQuickFix({ id: 'a', endedAt: '2026-10-25T09:00:48.000Z' });
    const undone = makeQuickFix({
      id: 'b',
      status: 'undone',
      endedAt: '2026-10-25T09:05:00.000Z',
      said: null,
    });
    expect(fixesRev([fixed])).toBe(Date.parse('2026-10-25T09:00:48.000Z'));
    // An undo moves it on: the preview changed again.
    expect(fixesRev([fixed, undone])).toBe(Date.parse('2026-10-25T09:05:00.000Z'));
    expect(fixesRev([undone, fixed])).toBe(Date.parse('2026-10-25T09:05:00.000Z'));
  });
});

describe('the cache', () => {
  it('is its own root, keyed by job', () => {
    expect(jobFixesKey(JOB)).toEqual(['job-fixes', JOB]);
    expect(jobFixesKey(JOB).slice(0, 1)).toEqual([...JOB_FIXES_KEY]);
    expect(jobFixesQueryOptions(api, JOB).queryKey).toEqual(jobFixesKey(JOB));
  });

  it('does not retry a 4xx, and retries when the engine could not be reached', () => {
    const retry = jobFixesQueryOptions(api, JOB).retry as (c: number, e: ApiError) => boolean;
    expect(retry(0, new ApiError(404, FIX_MESSAGES.off))).toBe(false);
    expect(retry(0, new ApiError(0, 'down'))).toBe(true);
  });

  it('applyFix writes into a list that is cached, and leaves an unasked job alone', () => {
    queryClient.setQueryData(jobFixesKey(JOB), [makeOpenFix('queued')]);
    applyFix(queryClient, makeOpenFix('running'));
    expect(queryClient.getQueryData<QuickFix[]>(jobFixesKey(JOB))?.[0]?.status).toBe('running');
    applyFix(queryClient, makeQuickFix({ jobId: 'other' }));
    expect(queryClient.getQueryData(jobFixesKey('other'))).toBeUndefined();
  });

  it('applyJobFixEvent writes the fix into the list', () => {
    queryClient.setQueryData(jobFixesKey(JOB), [makeOpenFix('queued')]);
    applyJobFixEvent(queryClient, { type: 'job.fix', jobId: JOB, fix: makeOpenFix('running') });
    expect(queryClient.getQueryData<QuickFix[]>(jobFixesKey(JOB))?.[0]?.status).toBe('running');
    expect(queryClient.getQueryState(jobFixesKey(JOB))?.isInvalidated).toBe(false);
  });

  it('applyJobFixEvent asks again when a fetch of the list is in flight: it may predate the event', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/fixes`, async () => {
        asked += 1;
        if (asked === 1) await gate;
        return HttpResponse.json({ fixes: [makeQuickFix()] });
      }),
    );
    // A page that shows the fixes is watching the query.
    const watcher = new QueryObserver(queryClient, jobFixesQueryOptions(api, JOB));
    const unsubscribe = watcher.subscribe(() => {});
    await vi.waitFor(() => expect(asked).toBe(1));
    applyJobFixEvent(queryClient, { type: 'job.fix', jobId: JOB, fix: makeQuickFix() });
    release();
    await vi.waitFor(() => expect(asked).toBe(2));
    unsubscribe();
  });
});

describe('useJobFixes', () => {
  let seen: JobFixes | undefined;
  function Probe({ enabled }: { enabled: boolean }) {
    seen = useJobFixes(JOB, enabled);
    return <p>{`${seen.fixes.length} ${seen.rev ?? 'none'} ${seen.loaded}`}</p>;
  }
  const render = (enabled: boolean) =>
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Probe enabled={enabled} />
      </QueryClientProvider>,
    );

  it('answers with nothing while it is off, even with a cached list', () => {
    queryClient.setQueryData(jobFixesKey(JOB), [makeQuickFix()]);
    expect(render(false)).toBe('<p>0 none false</p>');
    expect(seen?.fixes).toEqual([]);
    expect(seen?.byNote.size).toBe(0);
  });

  it('gives the cached fixes, the newest fix of each note and rev while it is on', () => {
    const first = makeQuickFix({ id: 'a', noteId: 'n1', status: 'undone', said: null });
    const second = makeQuickFix({ id: 'b', noteId: 'n1', endedAt: '2026-10-25T09:10:00.000Z' });
    queryClient.setQueryData(jobFixesKey(JOB), [first, second]);
    expect(render(true)).toBe(`<p>2 ${Date.parse('2026-10-25T09:10:00.000Z')} true</p>`);
    expect(seen?.byNote.get('n1')?.id).toBe('b');
    expect(seen?.fixes).toEqual([first, second]);
  });

  it('is not loaded before the first answer, and has no rev', () => {
    expect(render(true)).toBe('<p>0 none false</p>');
  });
});

describe('Undo', () => {
  const job = (overrides: Partial<Job> = {}) =>
    makeJob({ id: JOB, state: 'review', placeInLine: null, ...overrides });

  it('puts the undone fix in the list and the job in the jobs cache', async () => {
    queryClient.setQueryData(jobFixesKey(JOB), [makeQuickFix()]);
    queryClient.setQueryData(JOBS_KEY, [job({ round: 1 })]);
    const undone = makeQuickFix({ status: 'undone', said: null });
    const notify = vi.fn();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/fixes/:fixId/undo`, () =>
        HttpResponse.json({ fix: undone, job: job({ round: 1, name: 'After the undo' }) }),
      ),
    );
    const options = undoFixMutationOptions({ queryClient, api, jobId: JOB, notify });
    await options.mutationFn?.('f1', {} as never);
    // The mutation's success handler is what the hook runs after the call.
    options.onSuccess?.(
      { fix: undone, job: job({ name: 'After the undo' }) },
      'f1',
      undefined,
      {} as never,
    );
    expect(queryClient.getQueryData<QuickFix[]>(jobFixesKey(JOB))?.[0]?.status).toBe('undone');
    expect(queryClient.getQueryData<Job[]>(JOBS_KEY)?.[0]?.name).toBe('After the undo');
    expect(notify).not.toHaveBeenCalled();
  });

  it('says why in a toast, in the server’s words, when it is refused', async () => {
    const notify = vi.fn();
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/fixes/:fixId/undo`, () =>
        HttpResponse.json({ error: FIX_MESSAGES.busy }, { status: 409 }),
      ),
    );
    const options = undoFixMutationOptions({ queryClient, api, jobId: JOB, notify });
    const error = await (options.mutationFn?.('f1', {} as never) ?? Promise.resolve()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    options.onError?.(error as ApiError, 'f1', undefined, {} as never);
    expect(notify).toHaveBeenCalledWith(UNDO_FIX_FAILED_TEXT, { description: FIX_MESSAGES.busy });
    expect(UNDO_FIX_FAILED_TEXT).toBe("Couldn't undo the fix");
  });

  it('is keyed by job, so a job’s Undo is told apart', () => {
    const options = undoFixMutationOptions({ queryClient, api, jobId: JOB, notify: vi.fn() });
    expect(options.mutationKey).toEqual(['undo-fix', JOB]);
  });
});
