import type { ReviewNote } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi, UNREACHABLE_MESSAGE, UNREADABLE_MESSAGE } from './api';
import { BASE_URL, makeReviewNote } from './test-utils';

// The job sheet's third route (Job sheet plan §4, added by JS1): the review notes a job's rounds
// were sent with.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const JOB = 'a1b2c3d4e5f6';

const sent: ReviewNote = makeReviewNote({
  id: 's1',
  jobId: JOB,
  round: 1,
  sentAt: '2026-10-20T15:00:00.000Z',
});

describe('getSentNotes', () => {
  it('GETs /api/jobs/:id/sent-notes, with the id escaped, and parses { jobId, notes }', async () => {
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/sent-notes`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json({ jobId: JOB, notes: [sent] });
      }),
    );

    await expect(api.getSentNotes(JOB)).resolves.toEqual({ jobId: JOB, notes: [sent] });
    await api.getSentNotes('a/b c');

    expect(seen).toEqual([
      { method: 'GET', path: `/api/jobs/${JOB}/sent-notes` },
      { method: 'GET', path: '/api/jobs/a%2Fb%20c/sent-notes' },
    ]);
  });

  it('answers no notes for a job that has sent none', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/sent-notes`, () =>
        HttpResponse.json({ jobId: JOB, notes: [] }),
      ),
    );
    await expect(api.getSentNotes(JOB)).resolves.toEqual({ jobId: JOB, notes: [] });
  });

  it('keeps the words of the 404 for a job the engine does not know', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/sent-notes`, () =>
        HttpResponse.json({ error: 'Job gone not found' }, { status: 404 }),
      ),
    );
    const error = await api.getSentNotes('gone').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: 'Job gone not found' });
  });

  it('rejects with an ApiError when a note does not fit', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/sent-notes`, () =>
        HttpResponse.json({ jobId: JOB, notes: [{ ...sent, kind: 'sms' }] }),
      ),
    );
    await expect(api.getSentNotes(JOB)).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('rejects with an ApiError when the answer is the plain notes list (the other route)', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs/${JOB}/sent-notes`, () => HttpResponse.json([sent])));
    await expect(api.getSentNotes(JOB)).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs/${JOB}/sent-notes`, () => HttpResponse.error()));
    await expect(api.getSentNotes(JOB)).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});
