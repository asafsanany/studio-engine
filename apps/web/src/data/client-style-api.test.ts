import { type ClientStyle, noClientStyle } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, UNREACHABLE_MESSAGE, UNREADABLE_MESSAGE } from './api';
import { BASE_URL } from './test-utils';
import { FakeXhr } from './test-xhr';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CLIENT_ID = '4d337086919d';
const analysing: ClientStyle = {
  ...noClientStyle(CLIENT_ID, 'Kova Coffee'),
  state: 'analysing',
  version: 1,
  updatedAt: '2026-10-21T10:00:00.000Z',
  pass: { kind: 'read', mode: 'add', fileCount: 2, jobId: null, job: null },
};

function uploadApi() {
  const requests: FakeXhr[] = [];
  const api = createApi({
    baseUrl: BASE_URL,
    createXhr: () => {
      const xhr = new FakeXhr();
      requests.push(xhr);
      return xhr;
    },
  });
  return { api, requests, xhr: () => requests[0] as FakeXhr };
}

const file = (name: string, content = 'x') => new File([content], name);

describe('getClientStyle', () => {
  it('GETs /api/clients/:clientId/style, with the id escaped, and parses the answer', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/clients/:clientId/style`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ ...analysing, markdown: '# Style: Kova Coffee\n' });
      }),
    );
    const api = createApi({ baseUrl: BASE_URL });

    await expect(api.getClientStyle(CLIENT_ID)).resolves.toEqual({
      ...analysing,
      markdown: '# Style: Kova Coffee\n',
    });
    await api.getClientStyle('a/b c');
    expect(seen).toEqual([`/api/clients/${CLIENT_ID}/style`, '/api/clients/a%2Fb%20c/style']);
  });

  it('reads a style with no style.md: markdown is null', async () => {
    server.use(
      http.get(`${BASE_URL}/api/clients/:clientId/style`, () =>
        HttpResponse.json({ ...noClientStyle(CLIENT_ID, 'Kova Coffee'), markdown: null }),
      ),
    );
    const style = await createApi({ baseUrl: BASE_URL }).getClientStyle(CLIENT_ID);
    expect(style).toMatchObject({ state: 'none', markdown: null });
  });

  it('keeps the explanation of a 404 for a client the engine does not know', async () => {
    server.use(
      http.get(`${BASE_URL}/api/clients/:clientId/style`, () =>
        HttpResponse.json({ error: 'Client gone not found' }, { status: 404 }),
      ),
    );
    const error = await createApi({ baseUrl: BASE_URL })
      .getClientStyle('gone')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: 'Client gone not found' });
  });

  it('rejects with an ApiError when the answer is not a style', async () => {
    server.use(
      http.get(`${BASE_URL}/api/clients/:clientId/style`, () =>
        HttpResponse.json({ state: 'ready' }),
      ),
    );
    await expect(createApi({ baseUrl: BASE_URL }).getClientStyle(CLIENT_ID)).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });
});

describe('retryClientStyle', () => {
  it('POSTs to /api/clients/:clientId/style/retry and returns the style, now analysing', async () => {
    const seen: { method: string; path: string }[] = [];
    server.use(
      http.post(`${BASE_URL}/api/clients/:clientId/style/retry`, ({ request }) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname });
        return HttpResponse.json(analysing);
      }),
    );
    const api = createApi({ baseUrl: BASE_URL });

    await expect(api.retryClientStyle(CLIENT_ID)).resolves.toEqual(analysing);
    expect(seen).toEqual([{ method: 'POST', path: `/api/clients/${CLIENT_ID}/style/retry` }]);
  });

  it('keeps the explanation of a 409 (the style did not fail)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/clients/:clientId/style/retry`, () =>
        HttpResponse.json({ error: 'Nothing to retry.' }, { status: 409 }),
      ),
    );
    await expect(
      createApi({ baseUrl: BASE_URL }).retryClientStyle(CLIENT_ID),
    ).rejects.toMatchObject({ status: 409, message: 'Nothing to retry.' });
  });
});

describe('uploadStyleFiles', () => {
  it('POSTs a multipart form with the mode and every file as files[] to the style folder', async () => {
    const { api, xhr } = uploadApi();
    const sent = api.uploadStyleFiles(CLIENT_ID, {
      files: [file('logo.png'), file('notes.txt', 'Warm colours')],
      mode: 'replace',
    });

    expect(xhr()).toMatchObject({
      method: 'POST',
      url: `${BASE_URL}/api/clients/${CLIENT_ID}/style/files`,
    });
    const form = xhr().body;
    expect(form?.get('mode')).toBe('replace');
    const files = form?.getAll('files[]') as File[];
    expect(files.map((f) => f.name)).toEqual(['logo.png', 'notes.txt']);
    expect(await files[1]?.text()).toBe('Warm colours');

    xhr().answer(200, analysing);
    await expect(sent).resolves.toEqual(analysing);
  });

  it('escapes the id', () => {
    const { api, xhr } = uploadApi();
    void api.uploadStyleFiles('a/b c', { files: [file('a.txt')], mode: 'add' }).catch(() => {});
    expect(xhr().url).toBe(`${BASE_URL}/api/clients/a%2Fb%20c/style/files`);
  });

  it('reports the share of the bytes sent, as a whole percent', async () => {
    const { api, xhr } = uploadApi();
    const onProgress = vi.fn();
    const sent = api.uploadStyleFiles(CLIENT_ID, {
      files: [file('a.txt')],
      mode: 'add',
      onProgress,
    });

    xhr().progress(0, 2000);
    xhr().progress(333, 2000);
    xhr().progress(2000, 2000);
    expect(onProgress.mock.calls.map(([percent]) => percent)).toEqual([0, 17, 100]);

    xhr().answer(200, analysing);
    await sent;
  });

  it('says nothing when the size is not known, and never goes above 100', async () => {
    const { api, xhr } = uploadApi();
    const onProgress = vi.fn();
    const sent = api.uploadStyleFiles(CLIENT_ID, {
      files: [file('a.txt')],
      mode: 'add',
      onProgress,
    });

    xhr().progress(10, 0, false);
    xhr().progress(2100, 2000);
    expect(onProgress.mock.calls.map(([percent]) => percent)).toEqual([100]);

    xhr().answer(200, analysing);
    await sent;
  });

  it('takes the text of a 409 from its { error } body (the last files are still being analysed)', async () => {
    const { api, xhr } = uploadApi();
    const sent = api.uploadStyleFiles(CLIENT_ID, { files: [file('a.txt')], mode: 'add' });
    xhr().answer(409, { error: 'The style is being analysed.' });

    const error = await sent.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'The style is being analysed.' });
  });

  it('takes the text of a 413 (more than 2 GB) from its { error } body', async () => {
    const { api, xhr } = uploadApi();
    const sent = api.uploadStyleFiles(CLIENT_ID, { files: [file('a.txt')], mode: 'add' });
    xhr().answer(413, { error: 'The files are larger than 2 GB together. Send fewer at a time.' });
    await expect(sent).rejects.toMatchObject({
      status: 413,
      message: 'The files are larger than 2 GB together. Send fewer at a time.',
    });
  });

  it('describes an error that has no { error } body by its status', async () => {
    const { api, xhr } = uploadApi();
    const sent = api.uploadStyleFiles(CLIENT_ID, { files: [file('a.txt')], mode: 'add' });
    xhr().answer(502, '<html>Bad gateway</html>', 'Bad Gateway');
    await expect(sent).rejects.toMatchObject({
      status: 502,
      message: 'The server answered 502 Bad Gateway.',
    });
  });

  it('says so when the server cannot be reached', async () => {
    const { api, xhr } = uploadApi();
    const sent = api.uploadStyleFiles(CLIENT_ID, { files: [file('a.txt')], mode: 'add' });
    xhr().fail();
    const error = await sent.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, message: UNREACHABLE_MESSAGE });
  });

  it('rejects with an ApiError when the answer is not a style', async () => {
    const { api, xhr } = uploadApi();
    const sent = api.uploadStyleFiles(CLIENT_ID, { files: [file('a.txt')], mode: 'add' });
    xhr().answer(200, { ok: true });
    await expect(sent).rejects.toMatchObject({ status: 200, message: UNREADABLE_MESSAGE });
  });

  it('rejects with an ApiError when a good status carries a body that is not JSON', async () => {
    const { api, xhr } = uploadApi();
    const sent = api.uploadStyleFiles(CLIENT_ID, { files: [file('a.txt')], mode: 'add' });
    xhr().answer(200, '<html></html>');
    await expect(sent).rejects.toMatchObject({ status: 200, message: UNREADABLE_MESSAGE });
  });

  it('has no time limit: an upload that takes minutes is not cut off', async () => {
    vi.useFakeTimers();
    try {
      const { api, xhr } = uploadApi();
      const sent = api.uploadStyleFiles(CLIENT_ID, { files: [file('a.txt')], mode: 'add' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      xhr().answer(200, analysing);
      await expect(sent).resolves.toEqual(analysing);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is cancelled by the caller as an abort, not as an ApiError', async () => {
    const { api, xhr } = uploadApi();
    const controller = new AbortController();
    const sent = api.uploadStyleFiles(CLIENT_ID, {
      files: [file('a.txt')],
      mode: 'add',
      signal: controller.signal,
    });
    controller.abort();

    expect(xhr().aborted).toBe(true);
    const error = await sent.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('does not start when the caller has cancelled already', async () => {
    const { api, requests } = uploadApi();
    const controller = new AbortController();
    controller.abort();
    const sent = api.uploadStyleFiles(CLIENT_ID, {
      files: [file('a.txt')],
      mode: 'add',
      signal: controller.signal,
    });
    await expect(sent).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests[0]?.body ?? null).toBeNull();
  });
});
