import {
  FONT_MESSAGES,
  FONT_STAGE_FIELD,
  fontAddsMessage,
  fontNewMessage,
  fontSameMessage,
} from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFontsApi } from '@/data/fonts-api';
import { BASE_URL, makeFontFamilySummary, makeFontStageItem } from '@/data/test-utils';
import { FakeXhr } from '@/data/test-xhr';
import { type EntryLike, readDroppedFiles } from './font-files';
import { createFontImportSession } from './font-import-session';
import { fontImportToast } from './font-import-toasts';

// The whole import over the real Fonts client (typed answers, the multipart upload, the JSON
// import, the DELETE of a stage) with the network mocked at the edge: FakeXhr for the upload, MSW
// for the rest. The engine's side (FN4) does not exist yet; the answers have the shapes of FN0.

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function sessionOverApi() {
  const onResult = vi.fn();
  const onClose = vi.fn();
  const session = createFontImportSession({
    stage: (send) => api.stageFonts(send),
    cancelStage: (stageId) => api.cancelStage(stageId),
    importStaged: (request) => api.importStaged(request),
    onResult,
    onClose,
  });
  return { session, onResult, onClose };
}

const stageAnswer = {
  stageId: 's1',
  items: [
    makeFontStageItem({ info: fontNewMessage(3, true, 210_000) }),
    makeFontStageItem({
      id: 'rubik',
      name: 'Rubik',
      files: 2,
      weights: [800, 900],
      status: 'adds',
      info: fontAddsMessage(2, 'Rubik'),
    }),
    makeFontStageItem({
      id: 'heebo',
      name: 'Heebo',
      files: 9,
      weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
      status: 'same',
      info: fontSameMessage(9),
    }),
    makeFontStageItem({
      id: 'broken-export-ttf',
      name: 'Broken export.ttf',
      files: 1,
      he: false,
      weights: [],
      bytes: 2_048,
      status: 'bad',
      info: FONT_MESSAGES.cutShort,
    }),
  ],
};

/** A dropped folder `Fonts` holding two families, as the browser's entries show it. */
function droppedFolder() {
  const file = (name: string): EntryLike => ({
    isFile: true,
    isDirectory: false,
    name,
    file: (success) => success(new File([name], name)),
  });
  const folder = (name: string, children: EntryLike[]): EntryLike => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      const queue = [children];
      return { readEntries: (success) => success(queue.shift() ?? []) };
    },
  });
  const root = folder('Fonts', [
    folder('Karantina', [file('Karantina-Light.ttf'), file('Karantina-Bold.ttf'), file('OFL.txt')]),
    folder('Rubik', [file('Rubik-ExtraBold.ttf'), file('.DS_Store')]),
  ]);
  return {
    types: ['Files'],
    files: [new File([''], 'Fonts')],
    items: [{ webkitGetAsEntry: () => root }],
  };
}

describe('dropping a folder, then importing it', () => {
  it('stages the font files under their paths, imports the new and adds families, and reports them', async () => {
    const { session, onResult, onClose } = sessionOverApi();
    const importBodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/fonts/import`, async ({ request }) => {
        importBodies.push(await request.json());
        return HttpResponse.json({
          imported: [
            makeFontFamilySummary({
              slug: 'karantina',
              name: 'Karantina',
              weights: [300, 400, 700],
            }),
            makeFontFamilySummary({ slug: 'rubik', name: 'Rubik', weights: [300, 800, 900] }),
          ],
          failed: [],
        });
      }),
    );

    // Step 1 → 2: the drop is read, the files go up as multipart under files[].
    const dropped = await readDroppedFiles(droppedFolder());
    expect(dropped.sawFolder).toBe(true);
    session.take(dropped.files);
    expect(session.getState().step).toBe('sending');
    const xhr = xhrs.at(-1);
    expect(xhr?.method).toBe('POST');
    expect(xhr?.url).toBe(`${BASE_URL}/api/fonts/stage`);
    const sent = (xhr?.body?.getAll(FONT_STAGE_FIELD) ?? []) as File[];
    expect(sent.map((one) => one.name)).toEqual([
      'Fonts/Karantina/Karantina-Light.ttf',
      'Fonts/Karantina/Karantina-Bold.ttf',
      'Fonts/Rubik/Rubik-ExtraBold.ttf',
    ]);
    xhr?.progress(50, 100);
    expect(session.getState().percent).toBe(50);
    xhr?.answer(200, stageAnswer);
    await flush();
    expect(session.getState().step).toBe('listed');
    expect(session.getState().items.map((item) => item.status)).toEqual([
      'new',
      'adds',
      'same',
      'bad',
    ]);

    // Step 2: remove the one that is already here, then import.
    session.remove('heebo');
    session.importNow();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(importBodies).toEqual([{ stageId: 's1', items: ['karantina', 'rubik'] }]);

    // The result carries the families the toast and the page need.
    const [imported, failedCount] = onResult.mock.calls[0] ?? [];
    expect(failedCount).toBe(0);
    expect(imported.map((one: { slug: string }) => one.slug)).toEqual(['karantina', 'rubik']);
    expect(fontImportToast(imported, failedCount, true)).toEqual({
      tone: 'success',
      title: 'Imported 2 fonts',
      description: 'Write @Karantina Bold in a note to use one.',
    });
    expect(session.getState().step).toBe('pick');
  });
});

describe('cancelling', () => {
  it('sends DELETE /api/fonts/stage/:stageId', async () => {
    const { session } = sessionOverApi();
    const deleted: string[] = [];
    server.use(
      http.delete(`${BASE_URL}/api/fonts/stage/:stageId`, ({ params }) => {
        deleted.push(String(params.stageId));
        return HttpResponse.json({ ok: true });
      }),
    );
    session.take([new File(['x'], 'Karantina-Bold.ttf')]);
    xhrs.at(-1)?.answer(200, stageAnswer);
    await flush();
    expect(session.cancel()).toBe(true);
    await vi.waitFor(() => expect(deleted).toEqual(['s1']));
    expect(session.getState().step).toBe('pick');
  });

  it('does not mind that the engine has already dropped the stage', async () => {
    const { session } = sessionOverApi();
    server.use(
      http.delete(`${BASE_URL}/api/fonts/stage/:stageId`, () =>
        HttpResponse.json({ error: FONT_MESSAGES.stageNotFound }, { status: 404 }),
      ),
    );
    session.take([new File(['x'], 'Karantina-Bold.ttf')]);
    xhrs.at(-1)?.answer(200, stageAnswer);
    await flush();
    expect(session.cancel()).toBe(true);
    await flush();
    expect(session.getState().step).toBe('pick');
  });
});

describe('the engine’s sentences reach the dialog', () => {
  it('shows a refused upload’s sentence', async () => {
    const { session } = sessionOverApi();
    session.take([new File(['x'], 'Karantina-Bold.ttf')]);
    xhrs.at(-1)?.answer(413, { error: FONT_MESSAGES.stageTooLarge });
    await flush();
    expect(session.getState()).toMatchObject({
      step: 'failed',
      error: 'The upload is too large: at most 400 MB at once.',
    });
  });

  it('shows a refused import’s sentence and keeps the list', async () => {
    const { session, onClose } = sessionOverApi();
    server.use(
      http.post(`${BASE_URL}/api/fonts/import`, () =>
        HttpResponse.json({ error: FONT_MESSAGES.stageNotFound }, { status: 404 }),
      ),
    );
    session.take([new File(['x'], 'Karantina-Bold.ttf')]);
    xhrs.at(-1)?.answer(200, stageAnswer);
    await flush();
    session.importNow();
    await vi.waitFor(() => expect(session.getState().step).toBe('listed'));
    expect(session.getState().error).toBe('That upload is gone. Choose the files again.');
    expect(session.getState().items).toHaveLength(4);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows an import’s per-item failure beside the others', async () => {
    const { session, onResult, onClose } = sessionOverApi();
    server.use(
      http.post(`${BASE_URL}/api/fonts/import`, () =>
        HttpResponse.json({
          imported: [makeFontFamilySummary({ slug: 'karantina', name: 'Karantina' })],
          failed: [{ id: 'rubik', error: FONT_MESSAGES.importFailed }],
        }),
      ),
    );
    session.take([new File(['x'], 'Karantina-Bold.ttf')]);
    xhrs.at(-1)?.answer(200, stageAnswer);
    await flush();
    session.importNow();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    const rubik = session.getState().items.find((item) => item.id === 'rubik');
    expect(rubik).toMatchObject({
      status: 'bad',
      info: 'The font could not be copied into _Fonts.',
    });
    expect(fontImportToast(onResult.mock.calls[0]?.[0], 1, true).title).toBe(
      'Imported 1 font. 1 could not be added.',
    );
  });
});
