import { type ClientStyle, noClientStyle } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiError,
  createApi,
  stillUrl,
  TIMEOUT_MESSAGE,
  UNREACHABLE_MESSAGE,
  UNREADABLE_MESSAGE,
} from './api';
import { BASE_URL } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const CLIENT_ID = '27ad66831f94';
const JOB_ID = '0c5072f499ad';

const analysing: ClientStyle = {
  ...noClientStyle(CLIENT_ID, 'Arc Fitness'),
  state: 'analysing',
  version: 2,
  updatedAt: '2026-10-21T13:54:37.904Z',
  sourceJobId: '8cc31fc9036d',
  pass: { kind: 'learn', mode: 'replace', fileCount: 0, jobId: JOB_ID, job: 'Studio tour' },
};

describe('stillUrl', () => {
  it('is the job’s still, a plain image address', () => {
    expect(stillUrl(JOB_ID)).toBe(`/api/jobs/${JOB_ID}/still`);
    expect(stillUrl(JOB_ID, BASE_URL)).toBe(`${BASE_URL}/api/jobs/${JOB_ID}/still`);
  });

  it('escapes the id', () => {
    expect(stillUrl('a b/c')).toBe('/api/jobs/a%20b%2Fc/still');
  });
});

describe('applyLook', () => {
  it('POSTs to /api/jobs/:id/use-look and returns the client’s style, now analysing', async () => {
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:jobId/use-look`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json(analysing);
      }),
    );
    await expect(api.applyLook(JOB_ID)).resolves.toEqual(analysing);
    expect(seen).toEqual([{ method: 'POST', path: `/api/jobs/${JOB_ID}/use-look` }]);
  });

  it('escapes the id', async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:jobId/use-look`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(analysing);
      }),
    );
    await api.applyLook('a b');
    expect(seen).toEqual(['/api/jobs/a%20b/use-look']);
  });

  it('rejects with the server’s explanation on a 409', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB_ID}/use-look`, () =>
        HttpResponse.json(
          { error: 'The style is being analysed. Try again once it is done.' },
          { status: 409 },
        ),
      ),
    );
    const error = await api.applyLook(JOB_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      message: 'The style is being analysed. Try again once it is done.',
    });
  });

  it('rejects with an ApiError when the answer is not a style', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB_ID}/use-look`, () => HttpResponse.json({ ok: 1 })),
    );
    await expect(api.applyLook(JOB_ID)).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.post(`${BASE_URL}/api/jobs/${JOB_ID}/use-look`, () => HttpResponse.error()));
    await expect(api.applyLook(JOB_ID)).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });

  it('ends a request that never gets an answer', async () => {
    const hung = createApi({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      timeoutMs: 20,
    });
    await expect(hung.applyLook(JOB_ID)).rejects.toMatchObject({
      status: 0,
      message: TIMEOUT_MESSAGE,
    });
  });
});

describe('undoClientStyle', () => {
  it('POSTs to /api/clients/:clientId/style/undo and returns the restored style', async () => {
    const restored: ClientStyle = { ...analysing, state: 'ready', version: 3, pass: null };
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/clients/:clientId/style/undo`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json(restored);
      }),
    );
    await expect(api.undoClientStyle(CLIENT_ID)).resolves.toEqual(restored);
    expect(seen).toEqual([{ method: 'POST', path: `/api/clients/${CLIENT_ID}/style/undo` }]);
  });

  it('rejects with the server’s explanation on a 409', async () => {
    server.use(
      http.post(`${BASE_URL}/api/clients/${CLIENT_ID}/style/undo`, () =>
        HttpResponse.json({ error: 'There is no earlier style to go back to.' }, { status: 409 }),
      ),
    );
    await expect(api.undoClientStyle(CLIENT_ID)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'There is no earlier style to go back to.',
    });
  });
});
