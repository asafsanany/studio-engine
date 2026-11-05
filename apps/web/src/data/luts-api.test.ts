import { LUT_MESSAGES } from '@studio/shared';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, UNREADABLE_MESSAGE } from './api';
import { createLutsApi, lutPreviewUrl, lutStageForm, reviewFrameUrl } from './luts-api';
import { BASE_URL, makeLutDetail, makeLutSummary } from './test-utils';
import { FakeXhr } from './test-xhr';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const xhrs: FakeXhr[] = [];
afterEach(() => {
  xhrs.length = 0;
});
const api = createLutsApi({
  baseUrl: BASE_URL,
  createXhr: () => {
    const xhr = new FakeXhr();
    xhrs.push(xhr);
    return xhr;
  },
});

/** Records each request's method, path and body, and answers `body` with `status`. */
function record(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body: JsonBodyType,
  status = 200,
) {
  const seen: { method: string; path: string; body: string }[] = [];
  server.use(
    http[method](`${BASE_URL}${path}`, async ({ request }) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.text(),
      });
      return HttpResponse.json(body, { status });
    }),
  );
  return seen;
}

function lastXhr(): FakeXhr {
  const xhr = xhrs.at(-1);
  if (xhr === undefined) throw new Error('no request was sent');
  return xhr;
}

describe('the LUTs API, one call per route', () => {
  it('GET /api/luts lists Yours and Built in', async () => {
    const body = { yours: [makeLutSummary()], builtIn: [], builtInAvailable: false };
    const seen = record('get', '/api/luts', body);
    await expect(api.listLuts()).resolves.toEqual(body);
    expect(seen.map((r) => [r.method, r.path])).toEqual([['GET', '/api/luts']]);
  });

  it('GET /api/luts/:slug answers the LUT with its pane’s facts, the slug escaped', async () => {
    const body = makeLutDetail();
    const seen = record('get', '/api/luts/:slug', body);
    await expect(api.getLut('golden-hour-warm')).resolves.toEqual(body);
    expect(seen[0]?.path).toBe('/api/luts/golden-hour-warm');
  });

  it('PATCH /api/luts/:slug sends the change as JSON', async () => {
    const answer = makeLutDetail({ name: 'Sunset Amber', slug: 'sunset-amber' });
    const seen = record('patch', '/api/luts/:slug', answer);
    await expect(api.updateLut('golden-hour-warm', { name: 'Sunset Amber' })).resolves.toEqual(
      answer,
    );
    expect(seen[0]).toMatchObject({ method: 'PATCH', path: '/api/luts/golden-hour-warm' });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ name: 'Sunset Amber' });
  });

  it('DELETE /api/luts/:slug answers where the file went', async () => {
    const seen = record('delete', '/api/luts/:slug', { ok: true, where: '/Trash' });
    await expect(api.deleteLut('golden-hour-warm')).resolves.toEqual({ ok: true, where: '/Trash' });
    expect(seen[0]?.method).toBe('DELETE');
  });

  it('POST /api/luts/:slug/duplicate answers the copy', async () => {
    const copy = makeLutDetail({ slug: 'film-contrast-2', name: 'Film contrast (2)' });
    const seen = record('post', '/api/luts/:slug/duplicate', copy, 201);
    await expect(api.duplicateLut('film-contrast')).resolves.toEqual(copy);
    expect(seen[0]?.path).toBe('/api/luts/film-contrast/duplicate');
  });

  it('POST /api/luts/:slug/reveal resolves with nothing', async () => {
    const seen = record('post', '/api/luts/:slug/reveal', { ok: true });
    await expect(api.revealLut('golden-hour-warm')).resolves.toBeUndefined();
    expect(seen[0]?.path).toBe('/api/luts/golden-hour-warm/reveal');
  });

  it('POST /api/luts/import sends the stage and the kinds as JSON', async () => {
    const answer = { imported: [makeLutSummary({ isNew: true })], failed: [] };
    const seen = record('post', '/api/luts/import', answer, 201);
    const request = { stageId: 's1', items: [{ id: 'f1', kind: 'camera' as const }] };
    await expect(api.importStaged(request)).resolves.toEqual(answer);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(request);
  });

  it('DELETE /api/luts/stage/:stageId throws an upload away', async () => {
    const seen = record('delete', '/api/luts/stage/:stageId', { ok: true });
    await expect(api.cancelStage('s 1')).resolves.toBeUndefined();
    expect(seen[0]?.path).toBe('/api/luts/stage/s%201');
  });
});

describe('POST /api/luts/stage', () => {
  it('sends the files as multipart under files[], reporting progress', async () => {
    const a = new File(['LUT_3D_SIZE 2'], 'A.cube');
    const b = new File(['x'], 'B.3dl');
    const progress: number[] = [];
    const answer = {
      stageId: 's1',
      files: [
        { id: 'f1', name: 'A.cube', ok: true, error: null, size: 33, bytes: 13, kindGuess: 'look' },
        {
          id: 'f2',
          name: 'B.3dl',
          ok: false,
          error: LUT_MESSAGES.bad3dl,
          size: null,
          bytes: 1,
          kindGuess: 'look',
        },
      ],
    };

    const staged = api.stageLuts({
      files: [a, b],
      onProgress: (percent) => progress.push(percent),
    });
    const xhr = lastXhr();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(`${BASE_URL}/api/luts/stage`);
    const sent = (xhr.body?.getAll('files[]') ?? []) as File[];
    expect(sent.map((file) => file.name)).toEqual(['A.cube', 'B.3dl']);
    xhr.progress(50, 100);
    xhr.answer(200, answer);

    await expect(staged).resolves.toEqual(answer);
    expect(progress).toEqual([50]);
  });

  it('rejects with the server’s words', async () => {
    const staged = api.stageLuts({ files: [new File(['x'], 'A.cube')] });
    lastXhr().answer(413, { error: LUT_MESSAGES.tooManyFiles });
    await expect(staged).rejects.toMatchObject({ status: 413, message: LUT_MESSAGES.tooManyFiles });
  });

  it('rejects an answer it cannot read', async () => {
    const staged = api.stageLuts({ files: [new File(['x'], 'A.cube')] });
    lastXhr().answer(200, { stageId: 's1' });
    await expect(staged).rejects.toBeInstanceOf(ApiError);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    const staged = api.stageLuts({ files: [new File(['x'], 'A.cube')], signal: controller.signal });
    controller.abort();
    await expect(staged).rejects.toBeDefined();
  });

  it('builds the form with one part per file', () => {
    const form = lutStageForm([new File(['1'], 'A.cube'), new File(['2'], 'B.cube')]);
    expect(Array.from(form.keys())).toEqual(['files[]', 'files[]']);
  });
});

describe('failures', () => {
  it('carry the server’s words and status', async () => {
    record('get', '/api/luts', { error: LUT_MESSAGES.off }, 404);
    await expect(api.listLuts()).rejects.toMatchObject({ status: 404, message: 'LUTs are off.' });
  });

  it('refuse an answer that does not fit the shared schema', async () => {
    record('get', '/api/luts', { yours: [] });
    await expect(api.listLuts()).rejects.toThrow(UNREADABLE_MESSAGE);
  });
});

describe('lutPreviewUrl', () => {
  it('is the address of the still, the slug escaped', () => {
    expect(lutPreviewUrl('golden-hour-warm', 'person', 'after')).toBe(
      '/api/luts/golden-hour-warm/preview/person/after.jpg',
    );
    expect(lutPreviewUrl('a b', 'interior', 'before')).toBe(
      '/api/luts/a%20b/preview/interior/before.jpg',
    );
  });

  it('carries the LUT’s previewKey as ?v= so the server lets the still be cached for good', () => {
    expect(lutPreviewUrl('golden-hour-warm', 'person', 'after', '1a2b3c4d')).toBe(
      '/api/luts/golden-hour-warm/preview/person/after.jpg?v=1a2b3c4d',
    );
    expect(lutPreviewUrl('golden-hour-warm', 'person', 'after', null)).toBe(
      '/api/luts/golden-hour-warm/preview/person/after.jpg',
    );
    expect(lutPreviewUrl('golden-hour-warm', 'person', 'after', undefined)).toBe(
      '/api/luts/golden-hour-warm/preview/person/after.jpg',
    );
  });
});

describe('reviewFrameUrl', () => {
  it('is the plain frame at the nearest tenth of a second', () => {
    expect(reviewFrameUrl('abc123', 12.34)).toBe('/api/jobs/abc123/review/frame?t=12.3');
    expect(reviewFrameUrl('abc123', 0.05)).toBe('/api/jobs/abc123/review/frame?t=0.1');
    expect(reviewFrameUrl('abc123', -2)).toBe('/api/jobs/abc123/review/frame?t=0');
  });

  it('names the LUT (its slug escaped) and carries the round and the music, which change the preview', () => {
    expect(reviewFrameUrl('abc123', 3, 'golden-warm', { round: 2, musicRev: 5 })).toBe(
      '/api/jobs/abc123/review/frame?t=3&lut=golden-warm&r=2&m=5',
    );
    expect(reviewFrameUrl('a b', 3, 'a b', { musicRev: null })).toBe(
      '/api/jobs/a%20b/review/frame?t=3&lut=a%20b',
    );
  });

  it('takes a base address for tests', () => {
    expect(reviewFrameUrl('x', 1, null, {}, 'http://host')).toBe(
      'http://host/api/jobs/x/review/frame?t=1',
    );
  });
});
