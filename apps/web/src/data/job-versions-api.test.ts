import { VERSION_MESSAGES } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi, UNREADABLE_MESSAGE } from './api';
import { BASE_URL, makeJob, makeJobVersion } from './test-utils';

// The job sheet's versions routes: a job's preview versions, and going back to one.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const JOB = 'a1b2c3d4e5f6';

describe('getJobVersions', () => {
  it('GETs /api/jobs/:id/versions, with the id escaped, and parses { versions }', async () => {
    const versions = [makeJobVersion(2, { current: true }), makeJobVersion(1)];
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/versions`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json({ versions });
      }),
    );

    await expect(api.getJobVersions(JOB)).resolves.toEqual({ versions });
    await api.getJobVersions('a/b c');

    expect(seen).toEqual([
      { method: 'GET', path: `/api/jobs/${JOB}/versions` },
      { method: 'GET', path: '/api/jobs/a%2Fb%20c/versions' },
    ]);
  });

  it('answers no versions for a job from before versions', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/versions`, () => HttpResponse.json({ versions: [] })),
    );
    await expect(api.getJobVersions(JOB)).resolves.toEqual({ versions: [] });
  });

  it('keeps the words of the 404 for a job the engine does not know', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/versions`, () =>
        HttpResponse.json({ error: 'Job gone not found' }, { status: 404 }),
      ),
    );
    const error = await api.getJobVersions('gone').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: 'Job gone not found' });
  });

  it('refuses an answer that is not a list of versions', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/versions`, () =>
        HttpResponse.json({ versions: [{ n: 'one' }] }),
      ),
    );
    await expect(api.getJobVersions(JOB)).rejects.toMatchObject({ message: UNREADABLE_MESSAGE });
  });
});

describe('restoreJobVersion', () => {
  it('POSTs /api/jobs/:id/versions/:n/restore and parses the job', async () => {
    const job = makeJob({ id: JOB, state: 'review', round: 1 });
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/versions/:n/restore`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json(job);
      }),
    );

    await expect(api.restoreJobVersion(JOB, 2)).resolves.toEqual(job);

    expect(seen).toEqual([{ method: 'POST', path: `/api/jobs/${JOB}/versions/2/restore` }]);
  });

  it('keeps the words of a 409 (not in Review) and of a 404 (no such version)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/versions/:n/restore`, ({ params }) =>
        params.n === '9'
          ? HttpResponse.json({ error: VERSION_MESSAGES.notFound }, { status: 404 })
          : HttpResponse.json({ error: VERSION_MESSAGES.notInReview }, { status: 409 }),
      ),
    );

    await expect(api.restoreJobVersion(JOB, 1)).rejects.toMatchObject({
      status: 409,
      message: VERSION_MESSAGES.notInReview,
    });
    await expect(api.restoreJobVersion(JOB, 9)).rejects.toMatchObject({
      status: 404,
      message: VERSION_MESSAGES.notFound,
    });
  });
});
