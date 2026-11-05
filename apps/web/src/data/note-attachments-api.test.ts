import { NOTE_ATTACHMENTS } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, UNREADABLE_MESSAGE } from './api';
import { createNoteAttachmentsApi, noteAttachmentUrl } from './note-attachments-api';
import { BASE_URL } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createNoteAttachmentsApi({ baseUrl: BASE_URL });
const KEPT = { name: 'IMG_4412.PNG', bytes: 3, addedAt: '2026-10-25T14:03:00.000Z' };

describe('noteAttachmentUrl', () => {
  it('names the picture inside the job’s note, encoded', () => {
    expect(noteAttachmentUrl('a/b c', 'צילום מסך.png')).toBe(
      `/api/jobs/a%2Fb%20c/note/attachments/${encodeURIComponent('צילום מסך.png')}`,
    );
    expect(noteAttachmentUrl('j1', 'x.png', 'http://h')).toBe(
      'http://h/api/jobs/j1/note/attachments/x.png',
    );
  });
});

describe('getNoteView', () => {
  it('reads the note and its pictures', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/j1/note`, () =>
        HttpResponse.json({ note: 'Use her song.', attachments: [KEPT] }),
      ),
    );
    await expect(api.getNoteView('j1')).resolves.toEqual({
      note: 'Use her song.',
      attachments: [KEPT],
    });
  });

  it('says so when the answer is not a note view', async () => {
    server.use(http.get(`${BASE_URL}/api/jobs/j1/note`, () => HttpResponse.json({ nope: 1 })));
    const error = await api.getNoteView('j1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(UNREADABLE_MESSAGE);
  });

  it('carries the server’s words for a refusal: no such job', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/j1/note`, () =>
        HttpResponse.json({ error: 'There is no job j1.' }, { status: 404 }),
      ),
    );
    await expect(api.getNoteView('j1')).rejects.toMatchObject({
      status: 404,
      message: 'There is no job j1.',
    });
  });
});

describe('addNoteAttachment', () => {
  it('posts the picture as multipart form data in the field "file", with its name', async () => {
    let seen: { name: string; type: string; size: number; contentType: string } | null = null;
    server.use(
      http.post(`${BASE_URL}/api/jobs/j%201/note/attachments`, async ({ request }) => {
        const form = await request.formData();
        const file = form.get('file') as File;
        seen = {
          name: file.name,
          type: file.type,
          size: file.size,
          contentType: request.headers.get('content-type') ?? '',
        };
        return HttpResponse.json(KEPT, { status: 201 });
      }),
    );

    const kept = await api.addNoteAttachment(
      'j 1',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      'IMG_4412.PNG',
    );

    expect(kept).toEqual(KEPT);
    expect(seen).toMatchObject({ name: 'IMG_4412.PNG', type: 'image/png', size: 3 });
    expect((seen as unknown as { contentType: string }).contentType).toMatch(
      /^multipart\/form-data; boundary=/,
    );
  });

  it('carries the server’s words for a picture it refuses', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/j1/note/attachments`, () =>
        HttpResponse.json({ error: 'That picture is over 15 MB.' }, { status: 400 }),
      ),
    );
    await expect(api.addNoteAttachment('j1', new Blob(['x']), 'big.png')).rejects.toMatchObject({
      status: 400,
      message: 'That picture is over 15 MB.',
    });
  });

  it('knows the limits the dialog checks before it asks', () => {
    expect(NOTE_ATTACHMENTS.maxFiles).toBe(6);
  });
});

describe('deleteNoteAttachment', () => {
  it('deletes by the picture’s encoded name', async () => {
    let path = '';
    server.use(
      http.delete(`${BASE_URL}/api/jobs/j1/note/attachments/:name`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ ok: true });
      }),
    );
    await api.deleteNoteAttachment('j1', 'צילום מסך.png');
    expect(decodeURIComponent(path)).toBe('/api/jobs/j1/note/attachments/צילום מסך.png');
  });

  it('carries the 409 once the job is editing', async () => {
    server.use(
      http.delete(`${BASE_URL}/api/jobs/j1/note/attachments/:name`, () =>
        HttpResponse.json(
          { error: 'Cannot edit the note of a job that is editing.' },
          { status: 409 },
        ),
      ),
    );
    await expect(api.deleteNoteAttachment('j1', 'a.png')).rejects.toMatchObject({
      status: 409,
      message: 'Cannot edit the note of a job that is editing.',
    });
  });
});
