import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi, UNREACHABLE_MESSAGE, UNREADABLE_MESSAGE } from './api';
import { BASE_URL, makeJob } from './test-utils';

// CVP-196: `archiveJobs` and `unarchiveJobs` over `POST /api/jobs/archive` and `/unarchive`.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const archivedAt = '2026-10-21T10:00:00.000Z';
const first = makeJob({ id: 'first', state: 'ready', placeInLine: null });
const second = makeJob({ id: 'second', state: 'failed', placeInLine: null });

interface Seen {
  method: string;
  path: string;
  contentType: string | null;
  body: unknown;
}

async function seenOf(request: Request): Promise<Seen> {
  return {
    method: request.method,
    path: new URL(request.url).pathname,
    contentType: request.headers.get('content-type'),
    body: await request.json(),
  };
}

describe.each([
  ['archiveJobs', 'archive', (ids: readonly string[]) => api.archiveJobs(ids)],
  ['unarchiveJobs', 'unarchive', (ids: readonly string[]) => api.unarchiveJobs(ids)],
] as const)('%s', (_name, verb, call) => {
  const url = `${BASE_URL}/api/jobs/${verb}`;
  const answer = [
    { ...first, archivedAt: verb === 'archive' ? archivedAt : null },
    { ...second, archivedAt: verb === 'archive' ? archivedAt : null },
  ];

  it(`POSTs { ids } as JSON to /api/jobs/${verb} and returns the jobs, in the order asked`, async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(url, async ({ request }) => {
        seen.push(await seenOf(request));
        return HttpResponse.json({ jobs: answer });
      }),
    );

    await expect(call(['first', 'second'])).resolves.toEqual(answer);

    expect(seen).toEqual([
      {
        method: 'POST',
        path: `/api/jobs/${verb}`,
        contentType: 'application/json',
        body: { ids: ['first', 'second'] },
      },
    ]);
  });

  it('takes a read-only list of ids and does not change it', async () => {
    const ids: readonly string[] = Object.freeze(['a', 'b']);
    server.use(http.post(url, () => HttpResponse.json({ jobs: [] })));

    await expect(call(ids)).resolves.toEqual([]);

    expect(ids).toEqual(['a', 'b']);
  });

  it('sends the ids as they are, whatever they hold', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(url, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ jobs: [] });
      }),
    );

    await call(['a/b c', 'מאפיית']);

    expect(bodies).toEqual([{ ids: ['a/b c', 'מאפיית'] }]);
  });

  it.each([
    [400, 'Send the jobs as JSON.'],
    [404, 'Job gone not found'],
    [409, 'Can\'t archive "Spring menu" while it is editing.'],
  ])('keeps the explanation the server gives for a %s', async (status, message) => {
    server.use(http.post(url, () => HttpResponse.json({ error: message }, { status })));

    const error = await call(['first']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message });
  });

  it('rejects with an ApiError when the answer is not { jobs }', async () => {
    server.use(http.post(url, () => HttpResponse.json([first])));

    const error = await call(['first']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, message: UNREADABLE_MESSAGE });
  });

  it('rejects with an ApiError when a job is not valid (an older engine has no archivedAt)', async () => {
    const { archivedAt: _omitted, ...older } = first;
    server.use(http.post(url, () => HttpResponse.json({ jobs: [older] })));

    await expect(call(['first'])).rejects.toMatchObject({
      name: 'ApiError',
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.post(url, () => HttpResponse.error()));

    await expect(call(['first'])).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});
