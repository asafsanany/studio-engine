import { GRAPHIC_MESSAGES } from '@studio/shared';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, UNREADABLE_MESSAGE } from './api';
import { createGraphicsApi, GRAPHIC_VOICE_TIMEOUT_MS, graphicMessageForm } from './graphics-api';
import { BASE_URL, GRAPHIC_ID, makeGraphicDetail, makeGraphicSummary } from './test-utils';
import { FakeXhr } from './test-xhr';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const xhrs: FakeXhr[] = [];
afterEach(() => {
  xhrs.length = 0;
});
const api = createGraphicsApi({
  baseUrl: BASE_URL,
  createXhr: () => {
    const xhr = new FakeXhr();
    xhrs.push(xhr);
    return xhr;
  },
});

/** Records each request's method and path, and answers `body` with `status`. */
function record(
  method: 'get' | 'post' | 'put' | 'delete',
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

describe('the graphics API, one call per route', () => {
  it('GET /api/graphics lists the graphics', async () => {
    const body = [makeGraphicSummary()];
    const seen = record('get', '/api/graphics', body);
    await expect(api.listGraphics()).resolves.toEqual(body);
    expect(seen.map((r) => [r.method, r.path])).toEqual([['GET', '/api/graphics']]);
  });

  it('GET /api/graphics/:id answers the graphic with its chat', async () => {
    const body = makeGraphicDetail();
    const seen = record('get', '/api/graphics/:id', body);
    await expect(api.getGraphic(GRAPHIC_ID)).resolves.toEqual(body);
    expect(seen[0]?.path).toBe(`/api/graphics/${GRAPHIC_ID}`);
  });

  it('POST /api/graphics sends the first message as multipart, reporting progress', async () => {
    const file = new File(['png'], 'pill.png', { type: 'image/png' });
    const progress: number[] = [];
    const answer = makeGraphicDetail({ status: 'making', makingVersion: 1 });

    const created = api.createGraphic({
      text: 'A lower third.',
      effort: 'high',
      files: [file],
      onProgress: (percent) => progress.push(percent),
    });
    const xhr = lastXhr();
    expect([xhr.method, xhr.url]).toEqual(['POST', `${BASE_URL}/api/graphics`]);
    expect(xhr.body?.get('text')).toBe('A lower third.');
    expect(xhr.body?.get('effort')).toBe('high');
    const sentFiles = (xhr.body?.getAll('files[]') ?? []) as File[];
    expect(sentFiles.map((f) => f.name)).toEqual(['pill.png']);
    xhr.progress(50, 100);
    xhr.answer(201, answer);

    await expect(created).resolves.toEqual(answer);
    expect(progress).toEqual([50]);
  });

  it('POST /api/graphics/:id/messages sends a change, without an effort when none was picked', async () => {
    const sent = api.sendMessage(GRAPHIC_ID, { text: 'Slower.', effort: null, files: [] });
    const xhr = lastXhr();
    expect(xhr.url).toBe(`${BASE_URL}/api/graphics/${GRAPHIC_ID}/messages`);
    expect(xhr.body?.has('effort')).toBe(false);
    expect(xhr.body?.getAll('files[]')).toEqual([]);
    xhr.answer(202, makeGraphicDetail());
    await expect(sent).resolves.toMatchObject({ id: GRAPHIC_ID });
  });

  it('turns a refusal of a send into an ApiError with the server’s words', async () => {
    const sent = api.sendMessage(GRAPHIC_ID, { text: 'Slower.', effort: null, files: [] });
    lastXhr().answer(409, { error: 'Wait until v3 is made, then send your next message.' });
    await expect(sent).rejects.toEqual(
      new ApiError(409, 'Wait until v3 is made, then send your next message.'),
    );
  });

  it('POSTs Stop, Retry, Use vN again and Duplicate, each answering the graphic', async () => {
    const body = makeGraphicDetail();
    const stop = record('post', '/api/graphics/:id/messages/:mid/stop', body);
    const retry = record('post', '/api/graphics/:id/messages/:mid/retry', body, 202);
    const restore = record('post', '/api/graphics/:id/versions/:n/restore', body);
    const duplicate = record('post', '/api/graphics/:id/duplicate', body, 201);

    await expect(api.stopMessage(GRAPHIC_ID, 'm 2')).resolves.toEqual(body);
    await expect(api.retryMessage(GRAPHIC_ID, 'm2')).resolves.toEqual(body);
    await expect(api.restoreVersion(GRAPHIC_ID, 1)).resolves.toEqual(body);
    await expect(api.duplicateGraphic(GRAPHIC_ID)).resolves.toEqual(body);

    expect(stop[0]?.path).toBe(`/api/graphics/${GRAPHIC_ID}/messages/m%202/stop`);
    expect(retry[0]?.path).toBe(`/api/graphics/${GRAPHIC_ID}/messages/m2/retry`);
    expect(restore[0]?.path).toBe(`/api/graphics/${GRAPHIC_ID}/versions/1/restore`);
    expect(duplicate[0]?.path).toBe(`/api/graphics/${GRAPHIC_ID}/duplicate`);
  });

  it('PUT /api/graphics/:id sends the patch as JSON', async () => {
    const seen = record('put', '/api/graphics/:id', makeGraphicDetail({ uses: false }));
    await expect(api.updateGraphic(GRAPHIC_ID, { uses: false })).resolves.toMatchObject({
      uses: false,
    });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ uses: false });
  });

  it('POST /api/graphics/:id/reveal and DELETE /api/graphics/:id', async () => {
    record('post', '/api/graphics/:id/reveal', { ok: true });
    const deleted = { ok: true, where: '/Users/owner/.Trash/Name on a white pill' } as const;
    const seen = record('delete', '/api/graphics/:id', deleted);
    await expect(api.revealGraphic(GRAPHIC_ID)).resolves.toBeUndefined();
    await expect(api.deleteGraphic(GRAPHIC_ID)).resolves.toEqual(deleted);
    expect(seen[0]?.method).toBe('DELETE');
  });

  it('POST /api/graphics/voice sends the recording and answers its text', async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/graphics/voice`, async ({ request }) => {
        const form = await request.formData();
        const audio = form.get('audio') as File;
        seen.push(`${audio.name} ${audio.type}`);
        return HttpResponse.json({ text: 'Make it slower.' });
      }),
    );
    await expect(
      api.transcribeVoice(new Blob(['x'], { type: 'audio/webm;codecs=opus' })),
    ).resolves.toBe('Make it slower.');
    await expect(api.transcribeVoice(new Blob(['x'], { type: 'audio/mp4' }))).resolves.toBe(
      'Make it slower.',
    );
    expect(seen).toEqual(['voice.webm audio/webm;codecs=opus', 'voice.m4a audio/mp4']);
    expect(GRAPHIC_VOICE_TIMEOUT_MS).toBeGreaterThan(120_000);
  });
});

describe('the graphics API, answers it cannot use', () => {
  it('says the graphics are off with the server’s words', async () => {
    record('get', '/api/graphics', { error: GRAPHIC_MESSAGES.off }, 404);
    await expect(api.listGraphics()).rejects.toEqual(new ApiError(404, 'Graphics are off.'));
  });

  it('refuses a body that does not fit the shared schema', async () => {
    record('get', '/api/graphics/:id', { ...makeGraphicDetail(), status: 'learning' });
    await expect(api.getGraphic(GRAPHIC_ID)).rejects.toEqual(new ApiError(200, UNREADABLE_MESSAGE));
    record('get', '/api/graphics', [{ ...makeGraphicSummary(), id: 'not-hex' }]);
    await expect(api.listGraphics()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('graphicMessageForm', () => {
  it('holds the text, the effort when picked and every file', () => {
    const files = [new File(['a'], 'a.png'), new File(['b'], 'b.mov')];
    const form = graphicMessageForm({ text: 'A title.', effort: 'medium', files });
    expect(form.get('text')).toBe('A title.');
    expect(form.get('effort')).toBe('medium');
    expect((form.getAll('files[]') as File[]).map((f) => f.name)).toEqual(['a.png', 'b.mov']);
    expect(graphicMessageForm({ text: 'x', effort: null, files: [] }).has('effort')).toBe(false);
  });
});
