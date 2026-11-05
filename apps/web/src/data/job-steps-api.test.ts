import { JOB_REVEAL_MESSAGES, type JobStepRun } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi, UNREACHABLE_MESSAGE, UNREADABLE_MESSAGE } from './api';
import { BASE_URL } from './test-utils';

// The job sheet's two routes (Job sheet plan §4): a job's step runs, and Show in Finder.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const JOB = 'a1b2c3d4e5f6';

const run: JobStepRun = {
  step: 5,
  runKind: 'edit',
  round: 0,
  startedAt: '2026-10-22T14:41:00.000Z',
  endedAt: null,
};

describe('getJobSteps', () => {
  it('GETs /api/jobs/:id/steps, with the id escaped, and parses { jobId, runs }', async () => {
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/steps`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json({ jobId: JOB, runs: [run] });
      }),
    );

    await expect(api.getJobSteps(JOB)).resolves.toEqual({ jobId: JOB, runs: [run] });
    await api.getJobSteps('a/b c');

    expect(seen).toEqual([
      { method: 'GET', path: `/api/jobs/${JOB}/steps` },
      { method: 'GET', path: '/api/jobs/a%2Fb%20c/steps' },
    ]);
  });

  it('answers no runs for a job that has not started', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/steps`, () =>
        HttpResponse.json({ jobId: JOB, runs: [] }),
      ),
    );
    await expect(api.getJobSteps(JOB)).resolves.toEqual({ jobId: JOB, runs: [] });
  });

  it('keeps the words of the 404 for a job the engine does not know', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/steps`, () =>
        HttpResponse.json({ error: 'Job gone not found' }, { status: 404 }),
      ),
    );
    const error = await api.getJobSteps('gone').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: 'Job gone not found' });
  });

  it('rejects with an ApiError when a run does not fit (a step that does not exist)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/steps`, () =>
        HttpResponse.json({ jobId: JOB, runs: [{ ...run, step: 9 }] }),
      ),
    );
    await expect(api.getJobSteps(JOB)).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('rejects with an ApiError when the answer has no runs', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/steps`, () => HttpResponse.json({ jobId: JOB })),
    );
    await expect(api.getJobSteps(JOB)).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs/${JOB}/steps`, () => HttpResponse.error()));
    await expect(api.getJobSteps(JOB)).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});

describe('revealJob', () => {
  it('POSTs to /api/jobs/:id/reveal, with the id escaped, and says what Finder was asked for', async () => {
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/reveal`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        const revealed = seen.length === 1 ? 'file' : 'folder';
        return HttpResponse.json({ ok: true, revealed });
      }),
    );

    await expect(api.revealJob(JOB)).resolves.toEqual({ ok: true, revealed: 'file' });
    await expect(api.revealJob('a/b c')).resolves.toEqual({ ok: true, revealed: 'folder' });

    expect(seen).toEqual([
      { method: 'POST', path: `/api/jobs/${JOB}/reveal` },
      { method: 'POST', path: '/api/jobs/a%2Fb%20c/reveal' },
    ]);
  });

  it.each([
    [404, 'Job gone not found'],
    [404, JOB_REVEAL_MESSAGES.folderMissing],
    [500, JOB_REVEAL_MESSAGES.couldNotOpen],
  ])('keeps the server’s words for a %s: %s', async (status, message) => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/reveal`, () =>
        HttpResponse.json({ error: message }, { status }),
      ),
    );
    const error = await api.revealJob(JOB).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message });
  });

  it('rejects with an ApiError when the answer does not say what was revealed', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB}/reveal`, () => HttpResponse.json({ ok: true })),
    );
    await expect(api.revealJob(JOB)).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.post(`${BASE_URL}/api/jobs/${JOB}/reveal`, () => HttpResponse.error()));
    await expect(api.revealJob(JOB)).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});
