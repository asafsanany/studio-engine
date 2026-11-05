import { JOB_ACTIONS, jobActionPath } from '@studio/shared';
import { isCancelledError, QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  CANCEL_TIMEOUT_MS,
  createApi,
  createJsonClient,
  downloadUrl,
  formatDownloadUrl,
  noteAudioUrl,
  previewFixRev,
  previewPosterUrl,
  previewUrl,
  previewVideoUrl,
  REQUEST_TIMEOUT_MS,
  reviewExportFileUrl,
  reviewExportUrl,
  sendReviewTimeLast,
  TIMEOUT_MESSAGE,
  UNREACHABLE_MESSAGE,
  UNREADABLE_MESSAGE,
  UPLOAD_TIMEOUT_MS,
} from './api';
import { BASE_URL, makeJob, makeReviewNote } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const job = makeJob();

describe('listJobs', () => {
  it('returns the parsed list from GET /api/jobs', async () => {
    const jobs = [job, makeJob({ id: 'second', state: 'held', placeInLine: null })];
    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json(jobs)));
    await expect(api.listJobs()).resolves.toEqual(jobs);
  });

  it('rejects with an ApiError when the body is not a list of jobs', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([{ id: 'x' }])));
    const error = await api.listJobs().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, message: UNREADABLE_MESSAGE });
    expect((error as ApiError).cause).toBeDefined();
  });

  it('rejects with an ApiError when a good status carries a body that is not JSON', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs`, () => new HttpResponse('<html></html>')));
    await expect(api.listJobs()).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('takes the text of a 500 from its { error } body', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () =>
        HttpResponse.json({ error: 'Internal server error' }, { status: 500 }),
      ),
    );
    await expect(api.listJobs()).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'Internal server error',
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.error()));
    const error = await api.listJobs().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, message: UNREACHABLE_MESSAGE });
  });

  it('lets an abort through as an abort, not as an ApiError', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json([]);
      }),
    );
    const controller = new AbortController();
    const request = api.listJobs(controller.signal);
    controller.abort();
    const error = await request.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('createJsonClient', () => {
  it('answers null for a 204, which has no body to read', async () => {
    server.use(http.delete(`${BASE_URL}/x`, () => new HttpResponse(null, { status: 204 })));
    const { request } = createJsonClient({ baseUrl: BASE_URL });
    await expect(request('/x', { method: 'DELETE' })).resolves.toBeNull();
  });
});

describe('getMe', () => {
  it('returns the parsed answer of GET /api/me', async () => {
    const me = { email: 'yael@example.com', name: 'Yael', role: 'editor' };
    server.use(http.get(`${BASE_URL}/api/me`, () => HttpResponse.json(me)));
    await expect(api.getMe()).resolves.toEqual(me);
  });

  it('rejects when the role is not one the engine knows (an engine from the future)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/me`, () =>
        HttpResponse.json({ email: 'x', name: 'X', role: 'owner' }),
      ),
    );
    await expect(api.getMe()).rejects.toMatchObject({
      name: 'ApiError',
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.get(`${BASE_URL}/api/me`, () => HttpResponse.error()));
    await expect(api.getMe()).rejects.toMatchObject({ status: 0, message: UNREACHABLE_MESSAGE });
  });
});

describe('getHealth', () => {
  const health = {
    ok: true,
    version: '0.1.6',
    settleMs: 5000,
    series: false,
    jobSheet: false,
    analytics: false,
    phone: false,
    graphics: false,
    graphicsInEdits: false,
    music: false,
    luts: false,
    lutsInEdits: false,
    fonts: false,
    fontsInNotes: false,
    quickFixes: false,
  };

  it('returns the parsed answer of GET /api/health', async () => {
    server.use(http.get(`${BASE_URL}/api/health`, () => HttpResponse.json(health)));
    await expect(api.getHealth()).resolves.toEqual(health);
  });

  it('rejects with an ApiError when the answer has no settle delay (an older engine)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/health`, () => HttpResponse.json({ ok: true, version: '0.1.6' })),
    );
    await expect(api.getHealth()).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.get(`${BASE_URL}/api/health`, () => HttpResponse.error()));
    await expect(api.getHealth()).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});

describe('runJobAction', () => {
  it.each(JOB_ACTIONS)('POSTs the path of %s and returns the job', async (action) => {
    const after = makeJob({ state: 'held', placeInLine: null, settledAt: null });
    const seen: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/${jobActionPath(action)}`, ({ request, params }) => {
        seen.push(`${request.method} ${params.id}`);
        return HttpResponse.json(after);
      }),
    );
    await expect(api.runJobAction(job.id, action)).resolves.toEqual(after);
    expect(seen).toEqual([`POST ${job.id}`]);
  });

  it('POSTs send_notes to /send-notes, with a hyphen', async () => {
    const after = makeJob({ state: 'queued', runKind: 'revise', round: 1 });
    const seen: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/send-notes`, ({ request }) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return HttpResponse.json(after);
      }),
    );
    await expect(api.runJobAction(job.id, 'send_notes')).resolves.toEqual(after);
    expect(seen).toEqual([`POST /api/jobs/${job.id}/send-notes`]);
  });

  it('keeps the explanation the server gives for a 409', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/hold`, () =>
        HttpResponse.json({ error: 'Cannot hold a job that is ready.' }, { status: 409 }),
      ),
    );
    const error = await api.runJobAction(job.id, 'hold').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'Cannot hold a job that is ready.' });
  });

  it('reports an unknown job as a 404 with the server text', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/cancel`, () =>
        HttpResponse.json({ error: 'Job not found.' }, { status: 404 }),
      ),
    );
    await expect(api.runJobAction('gone', 'cancel')).rejects.toMatchObject({
      status: 404,
      message: 'Job not found.',
    });
  });

  it('falls back to a generic line when an error has no readable body (a dev proxy page)', async () => {
    server.use(
      http.post(
        `${BASE_URL}/api/jobs/:id/retry`,
        () =>
          new HttpResponse('<html>Bad Gateway</html>', {
            status: 502,
            statusText: 'Bad Gateway',
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    await expect(api.runJobAction(job.id, 'retry')).rejects.toMatchObject({
      status: 502,
      message: 'The server answered 502 Bad Gateway.',
    });
  });

  it('asks for ?restore=1 on a release with restorePlace, and on nothing else', async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/:action`, ({ request }) => {
        const url = new URL(request.url);
        seen.push(url.pathname + url.search);
        return HttpResponse.json(job);
      }),
    );

    await api.runJobAction('j', 'release');
    await api.runJobAction('j', 'release', undefined, {});
    await api.runJobAction('j', 'release', undefined, { restorePlace: false });
    await api.runJobAction('j', 'release', undefined, { restorePlace: true });
    await api.runJobAction('j', 'hold', undefined, { restorePlace: true });

    expect(seen).toEqual([
      '/api/jobs/j/release',
      '/api/jobs/j/release',
      '/api/jobs/j/release',
      '/api/jobs/j/release?restore=1',
      '/api/jobs/j/hold',
    ]);
  });

  it('puts the id in the path safely', async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/resume`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(job);
      }),
    );
    await api.runJobAction('a/b c', 'resume');
    expect(seen).toEqual(['/api/jobs/a%2Fb%20c/resume']);
  });
});

describe('saveNote', () => {
  const noted = makeJob({ note: 'Keep it under 30 seconds.' });

  it('PUTs { note } as JSON to /api/jobs/:id/note and returns the job', async () => {
    const seen: { method: string; path: string; type: string | null; body: unknown }[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          type: request.headers.get('content-type'),
          body: await request.json(),
        });
        return HttpResponse.json(noted);
      }),
    );

    await expect(api.saveNote(job.id, 'Keep it under 30 seconds.')).resolves.toEqual(noted);

    expect(seen).toEqual([
      {
        method: 'PUT',
        path: `/api/jobs/${job.id}/note`,
        type: 'application/json',
        body: { note: 'Keep it under 30 seconds.' },
      },
    ]);
  });

  it('sends the text as it is (the server trims it), Hebrew and line breaks included', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(job);
      }),
    );
    const text = '  תשאיר את זה קצר\nKeep it short \n';

    await api.saveNote(job.id, text);
    await api.saveNote(job.id, '');

    expect(bodies).toEqual([{ note: text }, { note: '' }]);
  });

  it('puts the id in the path safely', async () => {
    const seen: string[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(job);
      }),
    );
    await api.saveNote('a/b c', 'x');
    expect(seen).toEqual(['/api/jobs/a%2Fb%20c/note']);
  });

  it.each([
    [409, 'Cannot edit the note of a job that is editing.'],
    [400, 'The note can be at most 4000 characters.'],
    [404, 'Job gone not found'],
  ])('keeps the explanation the server gives for a %s', async (status, message) => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, () =>
        HttpResponse.json({ error: message }, { status }),
      ),
    );
    const error = await api.saveNote(job.id, 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message });
  });

  it('rejects with an ApiError when the answer is not a job', async () => {
    server.use(http.put(`${BASE_URL}/api/jobs/:id/note`, () => HttpResponse.json({ ok: true })));
    await expect(api.saveNote(job.id, 'x')).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('rejects with an ApiError when the answer has no note field (an older engine)', async () => {
    const { note: _omitted, ...older } = job;
    server.use(http.put(`${BASE_URL}/api/jobs/:id/note`, () => HttpResponse.json(older)));
    await expect(api.saveNote(job.id, 'x')).rejects.toMatchObject({
      name: 'ApiError',
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.put(`${BASE_URL}/api/jobs/:id/note`, () => HttpResponse.error()));
    await expect(api.saveNote(job.id, 'x')).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });

  it('lets an abort through as an abort, not as an ApiError', async () => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json(job);
      }),
    );
    const controller = new AbortController();
    const request = api.saveNote(job.id, 'x', controller.signal);
    controller.abort();
    const error = await request.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('addReviewTime', () => {
  it('POSTs { sec } as JSON to /api/jobs/:id/review-time and returns the new total', async () => {
    const seen: { method: string; path: string; type: string | null; body: unknown }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/review-time`, async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          type: request.headers.get('content-type'),
          body: await request.json(),
        });
        return HttpResponse.json({ reviewSec: 45 });
      }),
    );

    await expect(api.addReviewTime(job.id, 15)).resolves.toBe(45);

    expect(seen).toEqual([
      {
        method: 'POST',
        path: `/api/jobs/${job.id}/review-time`,
        type: 'application/json',
        body: { sec: 15 },
      },
    ]);
  });

  it('puts the id in the path safely', async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/review-time`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ reviewSec: 1 });
      }),
    );
    await api.addReviewTime('a/b c', 1);
    expect(seen).toEqual(['/api/jobs/a%2Fb%20c/review-time']);
  });

  it.each([
    [409, 'Review time can only be counted while the job is in Review, and this job is queued.'],
    [404, 'Job gone not found'],
    [400, 'Send the time as JSON: { "sec": 15 }, a whole number of seconds from 1 to 60.'],
  ])('keeps the explanation the server gives for a %s', async (status, message) => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/review-time`, () =>
        HttpResponse.json({ error: message }, { status }),
      ),
    );
    const error = await api.addReviewTime(job.id, 15).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message });
  });

  it('rejects with an ApiError when the answer has no total', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/review-time`, () => HttpResponse.json({ ok: true })),
    );
    await expect(api.addReviewTime(job.id, 15)).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.post(`${BASE_URL}/api/jobs/:id/review-time`, () => HttpResponse.error()));
    await expect(api.addReviewTime(job.id, 15)).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});

describe('sendReviewTimeLast', () => {
  it('hands the seconds to navigator.sendBeacon as a text/plain JSON blob, and sends nothing else', async () => {
    const blobs: Blob[] = [];
    const sendBeacon = vi.fn((_url: string, data: Blob) => {
      blobs.push(data);
      return true;
    });
    const fetch = vi.fn<typeof globalThis.fetch>();

    sendReviewTimeLast(job.id, 7, { baseUrl: BASE_URL, sendBeacon, fetch });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0]?.[0]).toBe(`${BASE_URL}/api/jobs/${job.id}/review-time`);
    expect(blobs[0]?.type).toBe('text/plain;charset=utf-8');
    expect(await blobs[0]?.text()).toBe('{"sec":7}');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to a keepalive fetch when the browser has no beacon', () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'));

    sendReviewTimeLast(job.id, 7, { baseUrl: BASE_URL, sendBeacon: null, fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${BASE_URL}/api/jobs/${job.id}/review-time`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"sec":7}',
      keepalive: true,
    });
  });

  it('falls back to the fetch when the beacon refuses (its queue is full)', () => {
    const sendBeacon = vi.fn(() => false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'));

    sendReviewTimeLast(job.id, 7, { sendBeacon, fetch });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never throws and never rejects, whatever fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() =>
        sendReviewTimeLast(job.id, 7, {
          sendBeacon: () => {
            throw new Error('no beacon');
          },
        }),
      ).not.toThrow();
      expect(() =>
        sendReviewTimeLast(job.id, 7, {
          sendBeacon: null,
          fetch: vi.fn<typeof globalThis.fetch>(async () => {
            throw new TypeError('Failed to fetch');
          }),
        }),
      ).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('revealClient', () => {
  it('POSTs to /api/clients/:clientId/reveal, with the id escaped', async () => {
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/clients/:clientId/reveal`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json({ ok: true });
      }),
    );

    await expect(api.revealClient('4d337086919d')).resolves.toBeUndefined();
    await api.revealClient('a/b c');

    expect(seen).toEqual([
      { method: 'POST', path: '/api/clients/4d337086919d/reveal' },
      { method: 'POST', path: '/api/clients/a%2Fb%20c/reveal' },
    ]);
  });

  it('keeps the explanation of a 404 for a client the engine does not know', async () => {
    server.use(
      http.post(`${BASE_URL}/api/clients/:clientId/reveal`, () =>
        HttpResponse.json({ error: 'Client gone not found' }, { status: 404 }),
      ),
    );
    const error = await api.revealClient('gone').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: 'Client gone not found' });
  });

  it('rejects with an ApiError when the answer is not { ok: true }', async () => {
    server.use(
      http.post(`${BASE_URL}/api/clients/:clientId/reveal`, () => HttpResponse.json({ ok: false })),
    );
    await expect(api.revealClient('x')).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });
});

describe('deleteClient', () => {
  it('sends DELETE to /api/clients/:clientId, with the id escaped, and answers what went', async () => {
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.delete(`${BASE_URL}/api/clients/:clientId`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json({ clientId: '4d337086919d', client: 'Pinewood', trashed: true });
      }),
    );

    await expect(api.deleteClient('4d337086919d')).resolves.toEqual({
      clientId: '4d337086919d',
      client: 'Pinewood',
      trashed: true,
    });
    await api.deleteClient('a/b c');

    expect(seen).toEqual([
      { method: 'DELETE', path: '/api/clients/4d337086919d' },
      { method: 'DELETE', path: '/api/clients/a%2Fb%20c' },
    ]);
  });

  it('keeps the explanation of a 409 for a client the engine is busy with', async () => {
    const error = 'Wait until “Ad 6” is edited to delete this client.';
    server.use(
      http.delete(`${BASE_URL}/api/clients/:clientId`, () =>
        HttpResponse.json({ error }, { status: 409 }),
      ),
    );
    await expect(api.deleteClient('4d337086919d')).rejects.toMatchObject({
      status: 409,
      message: error,
    });
  });
});

describe('downloadUrl', () => {
  it('is the plain download link of the job', () => {
    expect(downloadUrl('a1b2c3d4e5f6')).toBe('/api/jobs/a1b2c3d4e5f6/download');
  });

  it('encodes the id and accepts a base for tests', () => {
    expect(downloadUrl('a/b c', BASE_URL)).toBe(`${BASE_URL}/api/jobs/a%2Fb%20c/download`);
  });
});

describe('formatDownloadUrl', () => {
  it('is the download link of one format’s file (GN7), with the id encoded', () => {
    expect(formatDownloadUrl('a1b2c3d4e5f6', '1x1')).toBe(
      '/api/jobs/a1b2c3d4e5f6/download?format=1x1',
    );
    expect(formatDownloadUrl('a/b c', '9x16', BASE_URL)).toBe(
      `${BASE_URL}/api/jobs/a%2Fb%20c/download?format=9x16`,
    );
  });
});

describe('previewPosterUrl', () => {
  it('is the preview’s first frame, tagged with the round, with the id encoded', () => {
    expect(previewPosterUrl('a1b2c3d4e5f6', 0)).toBe('/api/jobs/a1b2c3d4e5f6/preview-poster?r=0');
    expect(previewPosterUrl('a/b c', 2, BASE_URL)).toBe(
      `${BASE_URL}/api/jobs/a%2Fb%20c/preview-poster?r=2`,
    );
  });
});

describe('the Export MP4 addresses (Formats, C65)', () => {
  it('are what they always were for the main format, with no format or null', () => {
    expect(reviewExportUrl('a1b2c3d4e5f6')).toBe('/api/jobs/a1b2c3d4e5f6/review-export');
    expect(reviewExportUrl('a1b2c3d4e5f6', BASE_URL, null)).toBe(
      `${BASE_URL}/api/jobs/a1b2c3d4e5f6/review-export`,
    );
    expect(reviewExportFileUrl('a1b2c3d4e5f6', 3)).toBe(
      '/api/jobs/a1b2c3d4e5f6/review-export.mp4?r=3',
    );
    expect(reviewExportFileUrl('a1b2c3d4e5f6', 3, BASE_URL, null)).toBe(
      `${BASE_URL}/api/jobs/a1b2c3d4e5f6/review-export.mp4?r=3`,
    );
  });

  it('name the extra format in the query', () => {
    expect(reviewExportUrl('a1b2c3d4e5f6', BASE_URL, '1x1')).toBe(
      `${BASE_URL}/api/jobs/a1b2c3d4e5f6/review-export?format=1x1`,
    );
    expect(reviewExportFileUrl('a1b2c3d4e5f6', 3, BASE_URL, '1x1')).toBe(
      `${BASE_URL}/api/jobs/a1b2c3d4e5f6/review-export.mp4?r=3&format=1x1`,
    );
  });
});

describe('previewUrl for a format (Generated videos)', () => {
  it('is the main address for no format and for null', () => {
    expect(previewUrl('a1b2c3d4e5f6', 1, 3, '', null, 2, null)).toBe(
      previewUrl('a1b2c3d4e5f6', 1, 3, '', null, 2),
    );
  });

  it('points at the extra format’s composition, with the same query', () => {
    expect(previewUrl('a1b2c3d4e5f6', 1, 3, BASE_URL, null, 2, '1x1')).toBe(
      `${BASE_URL}/api/jobs/a1b2c3d4e5f6/preview/1x1/index.html?r=1&m=3&f=2`,
    );
  });
});

describe('previewUrl', () => {
  it('is the root composition of the job, tagged with the round', () => {
    expect(previewUrl('a1b2c3d4e5f6', 0)).toBe('/api/jobs/a1b2c3d4e5f6/preview/index.html?r=0');
  });

  it('encodes the id and accepts a base for tests', () => {
    expect(previewUrl('a/b c', 2, undefined, BASE_URL)).toBe(
      `${BASE_URL}/api/jobs/a%2Fb%20c/preview/index.html?r=2`,
    );
  });

  it('changes with the round, so the player loads the new one', () => {
    expect(previewUrl('a1b2c3d4e5f6', 1)).not.toBe(previewUrl('a1b2c3d4e5f6', 2));
  });

  it('adds the music’s rev only when it is given, so the player loads new music', () => {
    expect(previewUrl('a1b2c3d4e5f6', 1, 1792705695440)).toBe(
      '/api/jobs/a1b2c3d4e5f6/preview/index.html?r=1&m=1792705695440',
    );
    expect(previewUrl('a1b2c3d4e5f6', 1, 0)).toBe(
      '/api/jobs/a1b2c3d4e5f6/preview/index.html?r=1&m=0',
    );
    expect(previewUrl('a1b2c3d4e5f6', 1, null)).toBe(previewUrl('a1b2c3d4e5f6', 1));
    expect(previewUrl('a1b2c3d4e5f6', 1, undefined)).toBe(previewUrl('a1b2c3d4e5f6', 1));
    expect(previewUrl('a1b2c3d4e5f6', 1, 1)).not.toBe(previewUrl('a1b2c3d4e5f6', 1, 2));
  });

  it('adds the quick fixes’ rev only when it is given, after the music’s, so the player loads a fix that landed', () => {
    expect(previewUrl('a1b2c3d4e5f6', 1, undefined, '', null, 1792705695440)).toBe(
      '/api/jobs/a1b2c3d4e5f6/preview/index.html?r=1&f=1792705695440',
    );
    expect(previewUrl('a1b2c3d4e5f6', 1, 7, '', null, 9)).toBe(
      '/api/jobs/a1b2c3d4e5f6/preview/index.html?r=1&m=7&f=9',
    );
    expect(previewUrl('a1b2c3d4e5f6', 1, undefined, BASE_URL, undefined, 0)).toBe(
      `${BASE_URL}/api/jobs/a1b2c3d4e5f6/preview/index.html?r=1&f=0`,
    );
    // Without a rev (nothing fixed, the switch off, or `null`) the address is what it always was.
    expect(previewUrl('a1b2c3d4e5f6', 1, undefined, '', null, null)).toBe(
      previewUrl('a1b2c3d4e5f6', 1),
    );
    expect(previewUrl('a1b2c3d4e5f6', 1, 7, '', undefined, undefined)).toBe(
      previewUrl('a1b2c3d4e5f6', 1, 7),
    );
    expect(previewUrl('a1b2c3d4e5f6', 1, undefined, '', null, 1)).not.toBe(
      previewUrl('a1b2c3d4e5f6', 1, undefined, '', null, 2),
    );
  });

  it('carries no fix rev for a preview version: its files do not change', () => {
    expect(previewUrl('a1b2c3d4e5f6', 2, 5, '', 3, 9)).toBe(
      '/api/jobs/a1b2c3d4e5f6/versions/3/preview/index.html',
    );
  });

  it('is a preview version’s root composition when a version is given', () => {
    expect(previewUrl('a1b2c3d4e5f6', 2, undefined, '', 3)).toBe(
      '/api/jobs/a1b2c3d4e5f6/versions/3/preview/index.html',
    );
    expect(previewUrl('a/b c', 2, 1792705695440, BASE_URL, 1)).toBe(
      `${BASE_URL}/api/jobs/a%2Fb%20c/versions/1/preview/index.html`,
    );
    expect(previewUrl('a1b2c3d4e5f6', 2, undefined, '', null)).toBe(previewUrl('a1b2c3d4e5f6', 2));
  });
});

describe('previewFixRev', () => {
  it('reads the fix rev an address was made with, from the live preview and from the MP4', () => {
    expect(previewFixRev(previewUrl('a1', 1, 7, '', null, 1792705695440))).toBe(1792705695440);
    expect(previewFixRev(previewVideoUrl('a1', 1, { musicRev: 7, fixRev: 9 }))).toBe(9);
    expect(previewFixRev(previewUrl('a1', 1, undefined, '', null, 0))).toBe(0);
  });

  it('is null for an address without one', () => {
    expect(previewFixRev(previewUrl('a1', 1))).toBeNull();
    expect(previewFixRev(previewUrl('a1', 1, 7))).toBeNull();
    expect(previewFixRev('/sample/index.html')).toBeNull();
    // Only the parameter `f`: not one that ends in f.
    expect(previewFixRev('/api/jobs/a1/preview/index.html?r=1&xf=5')).toBeNull();
  });
});

describe('previewVideoUrl', () => {
  it('is the MP4 of the round, with the music’s and the quick fixes’ revs only when given', () => {
    expect(previewVideoUrl('a1', 2)).toBe('/api/jobs/a1/preview-video.mp4?r=2');
    expect(previewVideoUrl('a1', 2, { musicRev: 7 })).toBe(
      '/api/jobs/a1/preview-video.mp4?r=2&m=7',
    );
    expect(previewVideoUrl('a1', 2, { musicRev: 7, fixRev: 9 })).toBe(
      '/api/jobs/a1/preview-video.mp4?r=2&m=7&f=9',
    );
    expect(previewVideoUrl('a1', 2, { fixRev: 9, download: true })).toBe(
      '/api/jobs/a1/preview-video.mp4?r=2&f=9&download=1',
    );
  });
});

describe('request timeout', () => {
  /** A fetch to a server that took the connection and never answers; it only ends when aborted. */
  const hungFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason));
    });

  it('is 10 s, and the text reads like the engine not answering', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(TIMEOUT_MESSAGE).toBe("The engine didn't answer.");
  });

  it('turns a request that never gets an answer into an ApiError', async () => {
    const hung = createApi({ fetch: hungFetch, timeoutMs: 20 });
    const error = await hung.listJobs().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, message: TIMEOUT_MESSAGE });
    expect((error as ApiError).cause).toMatchObject({ name: 'TimeoutError' });
  });

  it('does it with the real fetch too: a handler that answers too late', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return HttpResponse.json([job]);
      }),
    );
    const slow = createApi({ baseUrl: BASE_URL, timeoutMs: 30 });
    await expect(slow.listJobs()).rejects.toMatchObject({ status: 0, message: TIMEOUT_MESSAGE });
  });

  it('covers every call: actions and health end the same way', async () => {
    const hung = createApi({ fetch: hungFetch, timeoutMs: 20 });
    await expect(hung.runJobAction('a', 'hold')).rejects.toMatchObject({
      status: 0,
      message: TIMEOUT_MESSAGE,
    });
    await expect(hung.getHealth()).rejects.toMatchObject({ status: 0, message: TIMEOUT_MESSAGE });
  });

  it('gives Cancel longer, since it answers only once the edit has stopped', async () => {
    expect(CANCEL_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    server.use(
      http.post(`${BASE_URL}/api/jobs/a/:action`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return HttpResponse.json(job);
      }),
    );
    const slow = createApi({ baseUrl: BASE_URL, timeoutMs: 20, cancelTimeoutMs: 1_000 });
    await expect(slow.runJobAction('a', 'cancel')).resolves.toMatchObject({ id: job.id });
    await expect(slow.runJobAction('a', 'hold')).rejects.toMatchObject({
      message: TIMEOUT_MESSAGE,
    });
  });

  it('also covers an answer that starts and then stalls while its body is read', async () => {
    const stalled: typeof fetch = (_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      } as unknown as Response);
    const error = await createApi({ fetch: stalled, timeoutMs: 20 })
      .listJobs()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ApiError', status: 0, message: TIMEOUT_MESSAGE });
  });

  it('leaves an answer that comes in time alone', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([job])));
    const api = createApi({ baseUrl: BASE_URL, timeoutMs: 5_000 });
    await expect(api.listJobs()).resolves.toEqual([job]);
  });

  it('does not touch a failure that is not a timeout: unreachable stays unreachable', async () => {
    const broken: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(createApi({ fetch: broken }).listJobs()).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });

  it('gives fetch one signal that the caller can still abort, and the abort comes out as an abort', async () => {
    const seen: AbortSignal[] = [];
    const recording: typeof fetch = (url, init) => {
      if (init?.signal) seen.push(init.signal);
      return hungFetch(url, init);
    };
    const controller = new AbortController();
    const request = createApi({ fetch: recording }).listJobs(controller.signal);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(false);

    controller.abort();

    const error = await request.catch((e: unknown) => e);
    expect(seen[0]?.aborted).toBe(true);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('a request that was aborted before it started still aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await createApi({ fetch: hungFetch })
      .listJobs(controller.signal)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('an abort that comes first beats the timeout, and one that comes later is just a timeout', async () => {
    const early = new AbortController();
    const request = createApi({ fetch: hungFetch, timeoutMs: 40 }).listJobs(early.signal);
    early.abort();
    expect(await request.catch((e: unknown) => e)).toMatchObject({ name: 'AbortError' });

    const late = new AbortController(); // never aborted: the timeout ends the request
    const timedOut = await createApi({ fetch: hungFetch, timeoutMs: 20 })
      .listJobs(late.signal)
      .catch((e: unknown) => e);
    expect(timedOut).toMatchObject({ name: 'ApiError', message: TIMEOUT_MESSAGE });
  });

  it('is cancelled by a query being cancelled, as TanStack does it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sawAbort = vi.fn();
    const hung = createApi({
      timeoutMs: 5_000,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            sawAbort();
            reject(init.signal?.reason);
          });
        }),
    });
    const fetching = client.fetchQuery({
      queryKey: ['jobs'],
      queryFn: ({ signal }) => hung.listJobs(signal),
    });
    const settled = fetching.catch((e: unknown) => e);
    await vi.waitFor(() => expect(client.isFetching()).toBe(1));

    await client.cancelQueries({ queryKey: ['jobs'] });

    expect(isCancelledError(await settled)).toBe(true);
    await vi.waitFor(() => expect(sawAbort).toHaveBeenCalledTimes(1));
  });
});

describe('review notes', () => {
  const note = makeReviewNote({ jobId: job.id });
  const voice = makeReviewNote({
    id: 'n2',
    jobId: job.id,
    kind: 'voice',
    text: null,
    audioFile: 'edit/review/voice/n2.webm',
    audioSec: 7.5,
    transcriptStatus: 'pending',
  });

  it('listNotes GETs /api/jobs/:id/notes and returns the parsed list', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/notes`, ({ request }) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return HttpResponse.json([note, voice]);
      }),
    );

    await expect(api.listNotes(job.id)).resolves.toEqual([note, voice]);

    expect(seen).toEqual([`GET /api/jobs/${job.id}/notes`]);
  });

  it('puts the ids in the path safely, a Hebrew id included', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/notes`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json([]);
      }),
      http.patch(`${BASE_URL}/api/jobs/:id/notes/:noteId`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(note);
      }),
      http.delete(`${BASE_URL}/api/jobs/:id/notes/:noteId`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ ok: true });
      }),
    );

    await api.listNotes('a/b c');
    await api.patchNote('a/b c', 'הערה 1', { addToStyle: true });
    await api.deleteNote('a/b c', 'n/1');

    expect(seen).toEqual([
      '/api/jobs/a%2Fb%20c/notes',
      `/api/jobs/a%2Fb%20c/notes/${encodeURIComponent('הערה 1')}`,
      '/api/jobs/a%2Fb%20c/notes/n%2F1',
    ]);
  });

  it('addNote POSTs { atSec, text } as JSON and returns the note', async () => {
    const seen: { method: string; path: string; type: string | null; body: unknown }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/notes`, async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          type: request.headers.get('content-type'),
          body: await request.json(),
        });
        return HttpResponse.json(note, { status: 201 });
      }),
    );

    await expect(api.addNote(job.id, { atSec: 2.4, text: '  הכותרת  ' })).resolves.toEqual(note);

    expect(seen).toEqual([
      {
        method: 'POST',
        path: `/api/jobs/${job.id}/notes`,
        type: 'application/json',
        body: { atSec: 2.4, text: '  הכותרת  ' },
      },
    ]);
  });

  it('patchNote PATCHes the change as JSON and returns the note', async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    server.use(
      http.patch(`${BASE_URL}/api/jobs/:id/notes/:noteId`, async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: await request.json(),
        });
        return HttpResponse.json({ ...note, addToStyle: true });
      }),
    );

    await expect(api.patchNote(job.id, 'n1', { addToStyle: true })).resolves.toEqual({
      ...note,
      addToStyle: true,
    });

    expect(seen).toEqual([
      { method: 'PATCH', path: `/api/jobs/${job.id}/notes/n1`, body: { addToStyle: true } },
    ]);
  });

  it('deleteNote DELETEs the note and resolves with nothing', async () => {
    const seen: string[] = [];
    server.use(
      http.delete(`${BASE_URL}/api/jobs/:id/notes/:noteId`, ({ request }) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return HttpResponse.json({ ok: true });
      }),
    );

    await expect(api.deleteNote(job.id, 'n1')).resolves.toBeUndefined();

    expect(seen).toEqual([`DELETE /api/jobs/${job.id}/notes/n1`]);
  });

  describe('addVoiceNote', () => {
    interface Upload {
      method: string;
      path: string;
      type: string | null;
      audioName: string | null;
      audioType: string | null;
      audioBytes: number[];
      atSec: unknown;
      audioSec: unknown;
    }

    function captureUploads(uploads: Upload[]) {
      server.use(
        http.post(`${BASE_URL}/api/jobs/:id/notes/voice`, async ({ request }) => {
          const form = await request.formData();
          const audio = form.get('audio');
          uploads.push({
            method: request.method,
            path: new URL(request.url).pathname,
            type: request.headers.get('content-type'),
            audioName: audio instanceof File ? audio.name : null,
            audioType: audio instanceof File ? audio.type : null,
            audioBytes: audio instanceof File ? [...new Uint8Array(await audio.arrayBuffer())] : [],
            atSec: form.get('atSec'),
            audioSec: form.get('audioSec'),
          });
          return HttpResponse.json(voice, { status: 201 });
        }),
      );
    }

    it('sends multipart with the audio as voice.webm, atSec and audioSec as strings', async () => {
      const uploads: Upload[] = [];
      captureUploads(uploads);
      const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm;codecs=opus' });

      await expect(api.addVoiceNote(job.id, { audio, atSec: 7.8, audioSec: 12 })).resolves.toEqual(
        voice,
      );

      expect(uploads).toEqual([
        {
          method: 'POST',
          path: `/api/jobs/${job.id}/notes/voice`,
          // fetch adds the boundary itself; nothing was set by hand.
          type: expect.stringMatching(/^multipart\/form-data; boundary=/),
          audioName: 'voice.webm',
          audioType: 'audio/webm;codecs=opus',
          audioBytes: [1, 2, 3],
          atSec: '7.8',
          audioSec: '12',
        },
      ]);
    });

    it('names a Safari recording voice.m4a', async () => {
      const uploads: Upload[] = [];
      captureUploads(uploads);

      await api.addVoiceNote(job.id, {
        audio: new Blob([new Uint8Array([9])], { type: 'audio/mp4' }),
        atSec: 0,
        audioSec: 1.5,
      });

      expect(uploads[0]).toMatchObject({
        audioName: 'voice.m4a',
        audioType: 'audio/mp4',
        atSec: '0',
        audioSec: '1.5',
      });
    });

    it('sends the format of an extra format, and nothing for the main one (Generated videos)', async () => {
      const formats: Array<FormDataEntryValue | null> = [];
      server.use(
        http.post(`${BASE_URL}/api/jobs/:id/notes/voice`, async ({ request }) => {
          formats.push((await request.formData()).get('format'));
          return HttpResponse.json(voice, { status: 201 });
        }),
      );
      const audio = new Blob([new Uint8Array([1])], { type: 'audio/webm' });

      await api.addVoiceNote(job.id, { audio, atSec: 1, audioSec: 1, format: '1x1' });
      await api.addVoiceNote(job.id, { audio, atSec: 1, audioSec: 1, format: null });
      await api.addVoiceNote(job.id, { audio, atSec: 1, audioSec: 1 });

      expect(formats).toEqual(['1x1', null, null]);
    });

    it('does not set the content-type by hand', async () => {
      const seen: Array<string | null> = [];
      const fetchSpy: typeof fetch = async (_url, init) => {
        seen.push(new Headers(init?.headers).get('content-type'));
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify(voice), { status: 201 });
      };

      await createApi({ fetch: fetchSpy }).addVoiceNote(job.id, {
        audio: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
        atSec: 1,
        audioSec: 1,
      });

      expect(seen).toEqual([null]);
    });

    it('gives an upload 60 s, not 10', () => {
      expect(UPLOAD_TIMEOUT_MS).toBe(60_000);
      expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    });

    it('times out an upload with uploadTimeoutMs while a plain request with a longer limit does not', async () => {
      const slow = async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return HttpResponse.json(voice, { status: 201 });
      };
      server.use(
        http.post(`${BASE_URL}/api/jobs/:id/notes/voice`, slow),
        http.post(`${BASE_URL}/api/jobs/:id/notes`, slow),
      );
      const upload = {
        audio: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
        atSec: 1,
        audioSec: 1,
      };

      const tight = createApi({ baseUrl: BASE_URL, uploadTimeoutMs: 50, timeoutMs: 5_000 });
      await expect(tight.addVoiceNote(job.id, upload)).rejects.toMatchObject({
        status: 0,
        message: TIMEOUT_MESSAGE,
      });
      await expect(tight.addNote(job.id, { atSec: 1, text: 'x' })).resolves.toEqual(voice);

      // The other way round: a short plain limit does not cut an upload that has more time.
      const patient = createApi({ baseUrl: BASE_URL, uploadTimeoutMs: 5_000, timeoutMs: 50 });
      await expect(patient.addVoiceNote(job.id, upload)).resolves.toEqual(voice);
      await expect(patient.addNote(job.id, { atSec: 1, text: 'x' })).rejects.toMatchObject({
        message: TIMEOUT_MESSAGE,
      });
    });
  });

  it.each([
    ['listNotes', () => api.listNotes(job.id), 'get', '/notes'],
    ['addNote', () => api.addNote(job.id, { atSec: 1, text: 'x' }), 'post', '/notes'],
    ['patchNote', () => api.patchNote(job.id, 'n1', { text: 'x' }), 'patch', '/notes/n1'],
    ['deleteNote', () => api.deleteNote(job.id, 'n1'), 'delete', '/notes/n1'],
  ] as const)('%s keeps the explanation of a 409', async (_name, call, method, path) => {
    server.use(
      http[method](`${BASE_URL}/api/jobs/${job.id}${path}`, () =>
        HttpResponse.json(
          { error: 'Notes can only be changed while the job is in Review.' },
          { status: 409 },
        ),
      ),
    );

    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      message: 'Notes can only be changed while the job is in Review.',
    });
  });

  it('keeps the explanation of a 409 and a 413 for an upload', async () => {
    const upload = {
      audio: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
      atSec: 1,
      audioSec: 1,
    };
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/notes/voice`, () =>
        HttpResponse.json({ error: 'A voice note can be at most 25 MB.' }, { status: 413 }),
      ),
    );

    await expect(api.addVoiceNote(job.id, upload)).rejects.toMatchObject({
      status: 413,
      message: 'A voice note can be at most 25 MB.',
    });
  });

  it('rejects with an ApiError when the answer is not what the schema says', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/notes`, () => HttpResponse.json([{ id: 'x' }])),
      http.delete(`${BASE_URL}/api/jobs/:id/notes/:noteId`, () => HttpResponse.json({ ok: false })),
      http.post(`${BASE_URL}/api/jobs/:id/notes`, () => HttpResponse.json({ ...note, round: 0 })),
    );

    for (const call of [
      () => api.listNotes(job.id),
      () => api.deleteNote(job.id, 'n1'),
      () => api.addNote(job.id, { atSec: 1, text: 'x' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 200, message: UNREADABLE_MESSAGE });
    }
  });

  it('noteAudioUrl is a plain URL for an <audio src>', () => {
    expect(noteAudioUrl('a1b2c3d4e5f6', 'n1')).toBe('/api/jobs/a1b2c3d4e5f6/notes/n1/audio');
    expect(noteAudioUrl('a/b', 'הערה', 'http://studio.test')).toBe(
      `http://studio.test/api/jobs/a%2Fb/notes/${encodeURIComponent('הערה')}/audio`,
    );
  });
});

describe('saveEffort', () => {
  const withEffort = makeJob({ effort: 'xhigh' });

  it('PUTs { effort } as JSON to /api/jobs/:id/effort and returns the job', async () => {
    const seen: { method: string; path: string; type: string | null; body: unknown }[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          type: request.headers.get('content-type'),
          body: await request.json(),
        });
        return HttpResponse.json(withEffort);
      }),
    );

    await expect(api.saveEffort(job.id, 'xhigh')).resolves.toEqual(withEffort);

    expect(seen).toEqual([
      {
        method: 'PUT',
        path: `/api/jobs/${job.id}/effort`,
        type: 'application/json',
        body: { effort: 'xhigh' },
      },
    ]);
  });

  it('sends null for Default', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(job);
      }),
    );
    await api.saveEffort(job.id, null);
    expect(bodies).toEqual([{ effort: null }]);
  });

  it('puts the id in the path safely', async () => {
    const seen: string[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(job);
      }),
    );
    await api.saveEffort('a/b c', 'medium');
    expect(seen).toEqual(['/api/jobs/a%2Fb%20c/effort']);
  });

  it.each([
    [409, 'Cannot change the effort of a job that is editing.'],
    [400, 'Send the effort as JSON.'],
    [404, 'Job gone not found'],
  ])('keeps the explanation the server gives for a %s', async (status, message) => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, () =>
        HttpResponse.json({ error: message }, { status }),
      ),
    );
    const error = await api.saveEffort(job.id, 'high').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message });
  });

  it('rejects with an ApiError when the answer has no effort field (an older engine)', async () => {
    const { effort: _omitted, ...older } = job;
    server.use(http.put(`${BASE_URL}/api/jobs/:id/effort`, () => HttpResponse.json(older)));
    await expect(api.saveEffort(job.id, 'high')).rejects.toMatchObject({
      name: 'ApiError',
      message: UNREADABLE_MESSAGE,
    });
  });

  it('says so when the server cannot be reached', async () => {
    server.use(http.put(`${BASE_URL}/api/jobs/:id/effort`, () => HttpResponse.error()));
    await expect(api.saveEffort(job.id, 'high')).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});
