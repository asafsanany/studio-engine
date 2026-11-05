import {
  FONT_MESSAGES,
  type FontImportResponse,
  type FontStageResponse,
  fontAddsMessage,
  fontConflictMessage,
  fontNewMessage,
  fontSameMessage,
} from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type FontStageSend } from '@/data';
import { makeFontFamilySummary, makeFontStageItem } from '@/data/test-utils';
import {
  createFontImportSession,
  importableCount,
  importErrorText,
  isImportable,
} from './font-import-session';
import { FONT_IMPORT_TEXT } from './font-import-text';

const ttf = (name: string, bytes = 10) => new File(['x'.repeat(bytes)], name);

// The four kinds of item the check answers with (board FOStates 4), plus a conflict.
const karantina = makeFontStageItem();
const bebas = makeFontStageItem({
  id: 'bebas-neue',
  name: 'Bebas Neue',
  files: 1,
  he: false,
  weights: [400],
  bytes: 100_000,
  info: fontNewMessage(1, false, 100_000),
});
const rubik = makeFontStageItem({
  id: 'rubik',
  name: 'Rubik',
  files: 2,
  weights: [800, 900],
  status: 'adds',
  info: fontAddsMessage(2, 'Rubik'),
});
const heebo = makeFontStageItem({
  id: 'heebo',
  name: 'Heebo',
  files: 9,
  weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
  bytes: 420_000,
  status: 'same',
  info: fontSameMessage(9),
});
const outfit = makeFontStageItem({
  id: 'outfit',
  name: 'Outfit',
  files: 1,
  he: false,
  weights: [700],
  status: 'conflict',
  info: fontConflictMessage('Outfit Bold'),
});
const broken = makeFontStageItem({
  id: 'broken-export-ttf',
  name: 'Broken export.ttf',
  files: 1,
  he: false,
  weights: [],
  bytes: 2_048,
  status: 'bad',
  info: FONT_MESSAGES.cutShort,
});

const allKinds: FontStageResponse = {
  stageId: 's1',
  items: [karantina, bebas, rubik, heebo, outfit, broken],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A session over a mocked data layer; `stage` and `importStaged` answer what the test gives them. */
function setup({
  stage = async (): Promise<FontStageResponse> => ({ stageId: 's1', items: [] }),
  importStaged = async (): Promise<FontImportResponse> => ({ imported: [], failed: [] }),
}: {
  stage?: (send: FontStageSend) => Promise<FontStageResponse>;
  importStaged?: () => Promise<FontImportResponse>;
} = {}) {
  const deps = {
    stage: vi.fn(stage),
    cancelStage: vi.fn(async () => undefined),
    importStaged: vi.fn(importStaged),
    onResult: vi.fn(),
    onClose: vi.fn(),
  };
  const session = createFontImportSession(deps);
  return { session, deps };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A session that has staged `allKinds` and is waiting at step 2. */
async function listed(importStaged?: () => Promise<FontImportResponse>) {
  const made = setup({ stage: async () => allKinds, importStaged });
  made.session.take([ttf('a.ttf')]);
  await flush();
  return made;
}

describe('choosing files', () => {
  it('uploads them under one stage and lists a verdict per item, as the engine put it', async () => {
    const { session, deps } = setup({ stage: async () => allKinds });
    const files = [ttf('Karantina-Bold.ttf'), ttf('Bebas.ttf')];
    session.take(files);
    expect(session.getState()).toMatchObject({ step: 'sending', picked: 2, items: [] });
    await flush();
    expect(deps.stage).toHaveBeenCalledTimes(1);
    expect(deps.stage.mock.calls[0]?.[0].files).toEqual(files);
    const state = session.getState();
    expect(state.step).toBe('listed');
    expect(state.stageId).toBe('s1');
    expect(state.items.map((item) => [item.id, item.status])).toEqual([
      ['karantina', 'new'],
      ['bebas-neue', 'new'],
      ['rubik', 'adds'],
      ['heebo', 'same'],
      ['outfit', 'conflict'],
      ['broken-export-ttf', 'bad'],
    ]);
  });

  it('reports the upload progress', async () => {
    const gate = deferred<FontStageResponse>();
    const { session, deps } = setup({ stage: () => gate.promise });
    session.take([ttf('a.ttf')]);
    deps.stage.mock.calls[0]?.[0].onProgress?.(40);
    expect(session.getState().percent).toBe(40);
    gate.resolve(allKinds);
    await flush();
    expect(session.getState().step).toBe('listed');
  });

  it('says so when a folder had no fonts in it, and stays at step 1', () => {
    const { session, deps } = setup();
    session.take([]);
    expect(session.getState()).toMatchObject({
      step: 'pick',
      notice: FONT_IMPORT_TEXT.emptyFolder,
    });
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('refuses more files than one import takes without sending them', () => {
    const { session, deps } = setup();
    session.take(Array.from({ length: 401 }, (_, i) => ttf(`f-${i}.ttf`)));
    expect(session.getState().notice).toBe(FONT_MESSAGES.tooManyFiles);
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('takes exactly the most an import allows', async () => {
    const { session, deps } = setup({ stage: async () => allKinds });
    session.take(Array.from({ length: 400 }, (_, i) => ttf(`f-${i}.ttf`)));
    await flush();
    expect(deps.stage).toHaveBeenCalledTimes(1);
  });

  it('ignores a second pick while the first is being checked or listed', async () => {
    const { session, deps } = setup({ stage: async () => allKinds });
    session.take([ttf('a.ttf')]);
    session.take([ttf('b.ttf')]);
    await flush();
    session.take([ttf('c.ttf')]);
    expect(deps.stage).toHaveBeenCalledTimes(1);
  });

  it('goes back to step 1 with a note when nothing in the upload was a font', async () => {
    const { session, deps } = setup({ stage: async () => ({ stageId: 's9', items: [] }) });
    session.take([ttf('notes.txt')]);
    await flush();
    expect(session.getState()).toMatchObject({
      step: 'pick',
      items: [],
      stageId: null,
      notice: FONT_IMPORT_TEXT.emptyFolder,
    });
    expect(deps.cancelStage).toHaveBeenCalledWith('s9');
  });
});

describe('the four kinds of item', () => {
  it('counts only the new and the adds items for the Import button', async () => {
    const { session } = await listed();
    const { items } = session.getState();
    expect(items.filter(isImportable).map((item) => item.id)).toEqual([
      'karantina',
      'bebas-neue',
      'rubik',
    ]);
    expect(importableCount(items)).toBe(3);
  });

  it('counts none when everything is already here or cannot be imported', () => {
    expect(importableCount([heebo, outfit, broken])).toBe(0);
    expect(importableCount([])).toBe(0);
  });
});

describe('a failed upload', () => {
  it('shows the server’s sentence and keeps the files for "Try again"', async () => {
    let calls = 0;
    const { session, deps } = setup({
      stage: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(413, FONT_MESSAGES.stageTooLarge);
        return allKinds;
      },
    });
    const files = [ttf('a.ttf'), ttf('b.ttf')];
    session.take(files);
    await flush();
    expect(session.getState()).toMatchObject({
      step: 'failed',
      error: FONT_MESSAGES.stageTooLarge,
      picked: 2,
    });
    session.retry();
    expect(session.getState()).toMatchObject({ step: 'sending', error: null });
    await flush();
    expect(deps.stage.mock.calls[1]?.[0].files).toEqual(files);
    expect(session.getState().step).toBe('listed');
  });

  it('says the engine did not answer when there was no answer', async () => {
    const { session } = setup({
      stage: async () => {
        throw new ApiError(0, 'Failed to fetch');
      },
    });
    session.take([ttf('a.ttf')]);
    await flush();
    expect(session.getState().error).toBe(FONT_IMPORT_TEXT.unreachable);
  });

  it('takes a new pick after a failure, without "Try again"', async () => {
    let calls = 0;
    const { session, deps } = setup({
      stage: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(400, FONT_MESSAGES.badImport);
        return allKinds;
      },
    });
    session.take([ttf('a.ttf')]);
    await flush();
    session.take([ttf('b.ttf')]);
    await flush();
    expect(deps.stage).toHaveBeenCalledTimes(2);
    expect(session.getState().step).toBe('listed');
  });

  it('ignores "Try again" when nothing failed', async () => {
    const { session, deps } = await listed();
    session.retry();
    expect(deps.stage).toHaveBeenCalledTimes(1);
  });
});

describe('importErrorText', () => {
  it('is the engine’s own sentence, except when the engine did not answer', () => {
    expect(importErrorText(new ApiError(400, FONT_MESSAGES.badImportItem))).toBe(
      FONT_MESSAGES.badImportItem,
    );
    expect(importErrorText(new ApiError(404, FONT_MESSAGES.stageNotFound))).toBe(
      FONT_MESSAGES.stageNotFound,
    );
    for (const status of [0, 502, 503, 504]) {
      expect(importErrorText(new ApiError(status, 'Bad Gateway'))).toBe(
        FONT_IMPORT_TEXT.unreachable,
      );
    }
    expect(importErrorText(new TypeError('boom'))).toBe(FONT_IMPORT_TEXT.unreachable);
  });
});

describe('removing an item', () => {
  it('takes that item out of the list and out of the count', async () => {
    const { session } = await listed();
    session.remove('bebas-neue');
    const { items } = session.getState();
    expect(items.map((item) => item.id)).not.toContain('bebas-neue');
    expect(items).toHaveLength(5);
    expect(importableCount(items)).toBe(2);
  });

  it('does not send a removed item to the import', async () => {
    const { session, deps } = await listed(async () => ({ imported: [], failed: [] }));
    session.remove('karantina');
    session.importNow();
    await flush();
    expect(deps.importStaged).toHaveBeenCalledWith({
      stageId: 's1',
      items: ['bebas-neue', 'rubik'],
    });
  });

  it('throws the stage away and returns to step 1 when the last item goes', async () => {
    const { session, deps } = setup({
      stage: async () => ({ stageId: 's2', items: [heebo, broken] }),
    });
    session.take([ttf('a.ttf')]);
    await flush();
    session.remove('heebo');
    expect(session.getState().step).toBe('listed');
    expect(deps.cancelStage).not.toHaveBeenCalled();
    session.remove('broken-export-ttf');
    expect(deps.cancelStage).toHaveBeenCalledWith('s2');
    expect(session.getState()).toMatchObject({ step: 'pick', items: [], stageId: null });
  });

  it('does nothing outside the list', () => {
    const { session } = setup();
    session.remove('karantina');
    expect(session.getState().step).toBe('pick');
  });
});

describe('importing', () => {
  it('sends the new and adds items of the stage, and only those', async () => {
    const { session, deps } = await listed();
    session.importNow();
    expect(session.getState().step).toBe('importing');
    expect(deps.importStaged).toHaveBeenCalledWith({
      stageId: 's1',
      items: ['karantina', 'bebas-neue', 'rubik'],
    });
    await flush();
  });

  it('does nothing when no item can be imported', async () => {
    const { session, deps } = setup({
      stage: async () => ({ stageId: 's3', items: [heebo, outfit, broken] }),
    });
    session.take([ttf('a.ttf')]);
    await flush();
    session.importNow();
    expect(deps.importStaged).not.toHaveBeenCalled();
    expect(session.getState().step).toBe('listed');
  });

  it('does nothing before the check is back', () => {
    const { session, deps } = setup({ stage: () => new Promise(() => {}) });
    session.take([ttf('a.ttf')]);
    session.importNow();
    expect(deps.importStaged).not.toHaveBeenCalled();
  });

  it('closes the dialog and hands over the new families when everything went in', async () => {
    const imported = [
      makeFontFamilySummary({ slug: 'karantina', name: 'Karantina', weights: [300, 400, 700] }),
      makeFontFamilySummary({ slug: 'bebas-neue', name: 'Bebas Neue', weights: [400] }),
    ];
    const { session, deps } = await listed(async () => ({ imported, failed: [] }));
    session.importNow();
    await flush();
    expect(deps.onResult).toHaveBeenCalledWith(imported, 0);
    expect(deps.onClose).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ step: 'pick', items: [], stageId: null });
  });

  it('keeps the dialog open with the reason in red when an item could not be added', async () => {
    const imported = [makeFontFamilySummary({ slug: 'karantina', name: 'Karantina' })];
    const { session, deps } = await listed(async () => ({
      imported,
      failed: [{ id: 'rubik', error: FONT_MESSAGES.importFailed }],
    }));
    session.importNow();
    await flush();
    expect(deps.onClose).not.toHaveBeenCalled();
    expect(deps.onResult).toHaveBeenCalledWith(imported, 1);
    const state = session.getState();
    expect(state.step).toBe('listed');
    const rubikRow = state.items.find((item) => item.id === 'rubik');
    expect(rubikRow).toMatchObject({ status: 'bad', info: FONT_MESSAGES.importFailed });
    // The ones that went in are gone from the list; the others were never going to.
    expect(state.items.map((item) => item.id)).toEqual([
      'rubik',
      'heebo',
      'outfit',
      'broken-export-ttf',
    ]);
  });

  it('stays on the list with the engine’s sentence when the import itself is refused, and can be tried again', async () => {
    let calls = 0;
    const { session, deps } = await listed(async () => {
      calls += 1;
      if (calls === 1) throw new ApiError(404, FONT_MESSAGES.stageNotFound);
      return { imported: [makeFontFamilySummary()], failed: [] };
    });
    session.importNow();
    await flush();
    expect(session.getState()).toMatchObject({
      step: 'listed',
      error: FONT_MESSAGES.stageNotFound,
    });
    expect(session.getState().items).toHaveLength(6);
    expect(deps.onClose).not.toHaveBeenCalled();
    session.importNow();
    await flush();
    expect(deps.onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot be cancelled while the fonts are being copied', async () => {
    const gate = deferred<FontImportResponse>();
    const { session, deps } = await listed(() => gate.promise);
    session.importNow();
    expect(session.cancel()).toBe(false);
    expect(session.getState().step).toBe('importing');
    expect(deps.cancelStage).not.toHaveBeenCalled();
    session.remove('karantina');
    expect(session.getState().items).toHaveLength(6);
    gate.resolve({ imported: [], failed: [] });
    await flush();
    expect(deps.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('cancel', () => {
  it('deletes the stage on the engine and starts over', async () => {
    const { session, deps } = await listed();
    expect(session.cancel()).toBe(true);
    expect(deps.cancelStage).toHaveBeenCalledWith('s1');
    expect(session.getState()).toMatchObject({ step: 'pick', items: [], stageId: null });
  });

  it('has no stage to delete before a pick', () => {
    const { session, deps } = setup();
    expect(session.cancel()).toBe(true);
    expect(deps.cancelStage).not.toHaveBeenCalled();
  });

  it('aborts an upload in flight, and deletes the stage if the answer comes anyway', async () => {
    const gate = deferred<FontStageResponse>();
    const { session, deps } = setup({ stage: () => gate.promise });
    session.take([ttf('a.ttf')]);
    const signal = deps.stage.mock.calls[0]?.[0].signal;
    expect(session.cancel()).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(session.getState().step).toBe('pick');
    gate.resolve({ stageId: 'late', items: [karantina] });
    await flush();
    expect(deps.cancelStage).toHaveBeenCalledWith('late');
    expect(session.getState().step).toBe('pick');
  });

  it('does not mind a stage that is already gone', async () => {
    const { session, deps } = await listed();
    deps.cancelStage.mockRejectedValueOnce(new ApiError(404, FONT_MESSAGES.stageNotFound));
    expect(session.cancel()).toBe(true);
    await flush();
    expect(session.getState().step).toBe('pick');
  });

  it('throws away the stage after a failed upload’s files too, with nothing to delete', async () => {
    const { session, deps } = setup({
      stage: async () => {
        throw new ApiError(500, FONT_MESSAGES.badImport);
      },
    });
    session.take([ttf('a.ttf')]);
    await flush();
    expect(session.cancel()).toBe(true);
    expect(deps.cancelStage).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ step: 'pick', error: null });
  });
});

describe('subscribe', () => {
  it('tells listeners about each change, until they leave', async () => {
    const { session } = setup({ stage: async () => allKinds });
    const listener = vi.fn();
    const stop = session.subscribe(listener);
    session.take([ttf('a.ttf')]);
    await flush();
    const told = listener.mock.calls.length;
    expect(told).toBeGreaterThanOrEqual(2);
    stop();
    session.cancel();
    expect(listener.mock.calls.length).toBe(told);
  });
});
