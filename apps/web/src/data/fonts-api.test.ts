import { FONT_MESSAGES, FONT_STAGE_FIELD } from '@studio/shared';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, UNREADABLE_MESSAGE } from './api';
import { createFontsApi, fontFileUrl, fontStageForm } from './fonts-api';
import {
  BASE_URL,
  makeFontFace,
  makeFontFamilyDetail,
  makeFontFamilySummary,
  makeFontRequest,
  makeFontStageItem,
} from './test-utils';
import { FakeXhr } from './test-xhr';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const xhrs: FakeXhr[] = [];
afterEach(() => {
  xhrs.length = 0;
});
const api = createFontsApi({
  baseUrl: BASE_URL,
  createXhr: () => {
    const xhr = new FakeXhr();
    xhrs.push(xhr);
    return xhr;
  },
});

/** Records each request's method, path and body, and answers `body` with `status`. */
function record(method: 'get' | 'post' | 'delete', path: string, body: JsonBodyType, status = 200) {
  const seen: { method: string; path: string; body: string; contentType: string | null }[] = [];
  server.use(
    http[method](`${BASE_URL}${path}`, async ({ request }) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.text(),
        contentType: request.headers.get('content-type'),
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

describe('the Fonts API, one call per route', () => {
  it('GET /api/fonts lists the families, the catalog and the open requests', async () => {
    const body = {
      families: [makeFontFamilySummary()],
      catalog: [makeFontFace()],
      requests: [makeFontRequest()],
    };
    const seen = record('get', '/api/fonts', body);
    await expect(api.listFonts()).resolves.toEqual(body);
    expect(seen.map((r) => [r.method, r.path])).toEqual([['GET', '/api/fonts']]);
  });

  it('GET /api/fonts/:slug answers the family with its faces, the slug escaped', async () => {
    const body = makeFontFamilyDetail();
    const seen = record('get', '/api/fonts/:slug', body);
    await expect(api.getFont('heebo')).resolves.toEqual(body);
    expect(seen[0]?.path).toBe('/api/fonts/heebo');
    await api.getFont('a b');
    expect(seen[1]?.path).toBe('/api/fonts/a%20b');
  });

  it('DELETE /api/fonts/:slug answers where the files went', async () => {
    const seen = record('delete', '/api/fonts/:slug', { ok: true, where: '/Trash' });
    await expect(api.deleteFont('heebo')).resolves.toEqual({ ok: true, where: '/Trash' });
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/api/fonts/heebo' });
  });

  it('POST /api/fonts/:slug/reveal resolves with nothing', async () => {
    const seen = record('post', '/api/fonts/:slug/reveal', { ok: true });
    await expect(api.revealFont('heebo')).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/fonts/heebo/reveal' });
  });

  it('DELETE /api/fonts/requests/:id dismisses a request ("Not a font") and resolves with nothing', async () => {
    const seen = record('delete', '/api/fonts/requests/:id', { ok: true });
    await expect(api.dismissRequest('a3c19e0b7d44')).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/api/fonts/requests/a3c19e0b7d44' });
  });

  it('rejects a dismissal the server refuses with its words', async () => {
    record('delete', '/api/fonts/requests/:id', { error: FONT_MESSAGES.requestNotFound }, 404);
    await expect(api.dismissRequest('0123456789ab')).rejects.toMatchObject({
      status: 404,
      message: FONT_MESSAGES.requestNotFound,
    });
  });

  it('POST /api/fonts/import sends the stage and the chosen items as JSON', async () => {
    const answer = {
      imported: [makeFontFamilySummary({ slug: 'karantina', name: 'Karantina', isNew: true })],
      failed: [{ id: 'rubik', error: FONT_MESSAGES.importFailed }],
    };
    const seen = record('post', '/api/fonts/import', answer, 201);
    const request = { stageId: 's1', items: ['karantina', 'rubik'] };
    await expect(api.importStaged(request)).resolves.toEqual(answer);
    expect(seen[0]?.contentType).toBe('application/json');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(request);
  });

  it('DELETE /api/fonts/stage/:stageId throws an upload away', async () => {
    const seen = record('delete', '/api/fonts/stage/:stageId', { ok: true });
    await expect(api.cancelStage('s 1')).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/api/fonts/stage/s%201' });
  });
});

describe('POST /api/fonts/stage', () => {
  it('sends the files as multipart under files[], reporting progress', async () => {
    const a = new File(['a'], 'Karantina-Light.ttf');
    const b = new File(['b'], 'Karantina-Bold.ttf');
    const progress: number[] = [];
    const answer = {
      stageId: 's1',
      items: [
        makeFontStageItem(),
        makeFontStageItem({
          id: 'broken-export-ttf',
          name: 'Broken export.ttf',
          files: 1,
          he: false,
          weights: [],
          bytes: 1_024,
          status: 'bad',
          info: FONT_MESSAGES.cutShort,
        }),
      ],
    };

    const staged = api.stageFonts({
      files: [a, b],
      onProgress: (percent) => progress.push(percent),
    });
    const xhr = lastXhr();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(`${BASE_URL}/api/fonts/stage`);
    const sent = (xhr.body?.getAll(FONT_STAGE_FIELD) ?? []) as File[];
    expect(sent.map((file) => file.name)).toEqual(['Karantina-Light.ttf', 'Karantina-Bold.ttf']);
    xhr.progress(50, 100);
    xhr.answer(200, answer);

    await expect(staged).resolves.toEqual(answer);
    expect(progress).toEqual([50]);
  });

  it('rejects with the server’s words', async () => {
    const staged = api.stageFonts({ files: [new File(['x'], 'A.ttf')] });
    lastXhr().answer(413, { error: FONT_MESSAGES.stageTooLarge });
    await expect(staged).rejects.toMatchObject({
      status: 413,
      message: FONT_MESSAGES.stageTooLarge,
    });
  });

  it('rejects an answer it cannot read', async () => {
    const staged = api.stageFonts({ files: [new File(['x'], 'A.ttf')] });
    lastXhr().answer(200, { stageId: 's1' });
    await expect(staged).rejects.toBeInstanceOf(ApiError);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    const staged = api.stageFonts({ files: [new File(['x'], 'A.ttf')], signal: controller.signal });
    controller.abort();
    await expect(staged).rejects.toBeDefined();
  });
});

describe('fontStageForm', () => {
  it('has one files[] part per file, under the file’s own name', () => {
    const form = fontStageForm([new File(['1'], 'A.ttf'), new File(['2'], 'B.otf')]);
    expect(Array.from(form.keys())).toEqual(['files[]', 'files[]']);
    expect((form.getAll('files[]') as File[]).map((file) => file.name)).toEqual(['A.ttf', 'B.otf']);
  });

  it('sends a file picked from a folder under its path inside the folder', () => {
    const inFolder = new File(['1'], 'Heebo-Bold.ttf');
    Object.defineProperty(inFolder, 'webkitRelativePath', { value: 'Fonts/Heebo/Heebo-Bold.ttf' });
    const form = fontStageForm([inFolder, new File(['2'], 'Rubik.ttf')]);
    expect((form.getAll('files[]') as File[]).map((file) => file.name)).toEqual([
      'Fonts/Heebo/Heebo-Bold.ttf',
      'Rubik.ttf',
    ]);
  });
});

describe('failures', () => {
  it('carry the server’s words and status', async () => {
    record('get', '/api/fonts', { error: FONT_MESSAGES.off }, 404);
    await expect(api.listFonts()).rejects.toMatchObject({ status: 404, message: 'Fonts are off.' });
  });

  it('refuse an answer that does not fit the shared schema', async () => {
    record('get', '/api/fonts', { families: [] });
    await expect(api.listFonts()).rejects.toThrow(UNREADABLE_MESSAGE);
  });
});

describe('fontFileUrl', () => {
  it('is the address of the font file, the id escaped', () => {
    expect(fontFileUrl('3f9a1c7e5b20')).toBe('/api/fonts/file/3f9a1c7e5b20');
    expect(fontFileUrl('a b')).toBe('/api/fonts/file/a%20b');
  });

  it('carries the file’s version as ?v= so the server lets the file be cached for good', () => {
    expect(fontFileUrl('3f9a1c7e5b20', 1761300000000)).toBe(
      '/api/fonts/file/3f9a1c7e5b20?v=1761300000000',
    );
    expect(fontFileUrl('3f9a1c7e5b20', null)).toBe('/api/fonts/file/3f9a1c7e5b20');
    expect(fontFileUrl('3f9a1c7e5b20', '')).toBe('/api/fonts/file/3f9a1c7e5b20?v=');
  });
});
