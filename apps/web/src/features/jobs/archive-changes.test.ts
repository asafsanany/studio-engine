// CVP-197: the messages after Archive, Archive all paid and Unarchive, and what their Undo calls.
// The routes are answered by MSW; the messages are sonner's, mocked.

import type { Job } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '@/data/api';
import { JOBS_KEY } from '@/data/jobs-cache';
import {
  BASE_URL,
  cachedJobs,
  createTestQueryClient,
  makeJob,
  makeJobDelivery,
} from '@/data/test-utils';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { afterArchived, afterArchivedAllPaid, afterLeftArchive, afterUnarchived } = await import(
  './archive-changes'
);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const ARCHIVED_AT = '2026-10-21T10:00:00.000Z';
const paid = (id: string, name: string, archivedAt: string | null = null): Job =>
  makeJob({
    id,
    name,
    state: 'ready',
    placeInLine: null,
    delivery: makeJobDelivery({ paidOn: '2026-10-22' }),
    archivedAt,
  });

const one = paid('one', 'מיתוס או אמת 2');
const two = paid('two', 'פתיחת הסניף');
const three = paid('three', 'סרטון תדמית');
const archive = (job: Job): Job => ({ ...job, archivedAt: ARCHIVED_AT });

let queryClient: QueryClient;
let deps: { api: typeof api; queryClient: QueryClient };
beforeEach(() => {
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [archive(one), archive(two), archive(three)]);
  deps = { api, queryClient };
});

/** The Undo button of the last message. */
function undoOfLast(): () => void {
  const options = sonner.toast.mock.calls.at(-1)?.[1] as {
    action: { label: string; onClick: () => void };
  };
  expect(options.action.label).toBe('Undo');
  return options.action.onClick;
}

/** Answers a route with the given jobs and records the body it was sent. */
function answer(route: 'archive' | 'unarchive', jobs: Job[], bodies: unknown[] = []) {
  server.use(
    http.post(`${BASE_URL}/api/jobs/${route}`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ jobs });
    }),
    http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json(cachedJobs(queryClient))),
  );
  return bodies;
}

describe('afterArchived: Undo is Unarchive', () => {
  it('calls POST /api/jobs/unarchive with the job’s id and puts the answer in the list', async () => {
    const bodies = answer('unarchive', [one]);
    afterArchived(deps, archive(one));
    undoOfLast()();

    await vi.waitFor(() => expect(bodies).toEqual([{ ids: ['one'] }]));
    await vi.waitFor(() =>
      expect(cachedJobs(queryClient)?.find((job) => job.id === 'one')?.archivedAt).toBeNull(),
    );
    // The other jobs stay as they were.
    expect(cachedJobs(queryClient)?.find((job) => job.id === 'two')?.archivedAt).toBe(ARCHIVED_AT);
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it('tells a refusal (409: the job started editing meanwhile) as a message of its own', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/unarchive`, () =>
        HttpResponse.json({ error: 'Job one is not archived.' }, { status: 409 }),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json(cachedJobs(queryClient))),
    );
    afterArchived(deps, archive(one));
    undoOfLast()();

    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    const [, options] = sonner.toast.error.mock.calls[0] as [unknown, { description: string }];
    expect(options.description).toBe('Job one is not archived.');
  });
});

describe('afterArchivedAllPaid: Undo unarchives exactly those videos', () => {
  it('says how many, and Undo sends all of their ids in one request', async () => {
    const bodies = answer('unarchive', [one, two, three]);
    afterArchivedAllPaid(deps, [archive(one), archive(two), archive(three)]);

    const [message] = sonner.toast.mock.calls.at(-1) as [string];
    expect(message).toBe('Archived 3 paid videos · they still count on Money');

    undoOfLast()();
    await vi.waitFor(() => expect(bodies).toEqual([{ ids: ['one', 'two', 'three'] }]));
    await vi.waitFor(() =>
      expect(cachedJobs(queryClient)?.map((job) => job.archivedAt)).toEqual([null, null, null]),
    );
  });

  it('does not touch a paid video that was archived before: it is not in the list it was given', async () => {
    const bodies = answer('unarchive', [one, two]);
    afterArchivedAllPaid(deps, [archive(one), archive(two)]);
    undoOfLast()();
    await vi.waitFor(() => expect(bodies).toEqual([{ ids: ['one', 'two'] }]));
    expect(cachedJobs(queryClient)?.find((job) => job.id === 'three')?.archivedAt).toBe(
      ARCHIVED_AT,
    );
  });

  it('tells a refusal for several videos by their number', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/unarchive`, () =>
        HttpResponse.json({ error: 'Job two not found' }, { status: 404 }),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json(cachedJobs(queryClient))),
    );
    afterArchivedAllPaid(deps, [archive(one), archive(two)]);
    undoOfLast()();
    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    expect(sonner.toast.error.mock.calls[0]?.[0]).toBe("Couldn't undo for 2 videos");
  });
});

describe('afterUnarchived: Undo is Archive', () => {
  it('says which tab the job is back in, and Undo calls POST /api/jobs/archive with its id', async () => {
    queryClient.setQueryData(JOBS_KEY, [one, archive(two)]);
    const bodies = answer('archive', [archive(one)]);
    afterUnarchived(deps, one);

    undoOfLast()();
    await vi.waitFor(() => expect(bodies).toEqual([{ ids: ['one'] }]));
    await vi.waitFor(() =>
      expect(cachedJobs(queryClient)?.find((job) => job.id === 'one')?.archivedAt).toBe(
        ARCHIVED_AT,
      ),
    );
  });

  it('tells a refusal (409: the job is editing now) with the server’s words', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/archive`, () =>
        HttpResponse.json({ error: 'Cannot archive “X” while it is editing.' }, { status: 409 }),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json(cachedJobs(queryClient))),
    );
    afterUnarchived(deps, one);
    undoOfLast()();
    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    const [, options] = sonner.toast.error.mock.calls[0] as [unknown, { description: string }];
    expect(options.description).toBe('Cannot archive “X” while it is editing.');
  });
});

describe('afterLeftArchive', () => {
  it('says the job left the archive, with nothing to undo, and sends nothing', () => {
    afterLeftArchive(makeJob({ id: 'x', name: 'טיוטה ישנה', state: 'editing', archivedAt: null }));
    expect(sonner.toast).toHaveBeenCalledOnce();
    const options = sonner.toast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.action).toBeUndefined();
  });
});
