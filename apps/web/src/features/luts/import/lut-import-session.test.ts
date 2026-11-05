import type { LutImportResponse, LutStageFile, LutStageResponse } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type LutStageSend } from '@/data';
import { makeLutSummary } from '@/data/test-utils';
import { createLutImportSession, importErrorText } from './lut-import-session';
import { LUT_IMPORT_TEXT } from './lut-import-text';

const cube = (name: string, bytes = 10) => new File(['x'.repeat(bytes)], name);

const good = (id: string, name: string, overrides: Partial<LutStageFile> = {}): LutStageFile => ({
  id,
  name,
  ok: true,
  error: null,
  size: 33,
  bytes: 1_468_006,
  kindGuess: 'look',
  ...overrides,
});

const bad = (id: string, name: string, error: string): LutStageFile => ({
  id,
  name,
  ok: false,
  error,
  size: null,
  bytes: 90,
  kindGuess: 'look',
});

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
  stage = async (): Promise<LutStageResponse> => ({ stageId: 's1', files: [] }),
  importStaged = async (): Promise<LutImportResponse> => ({ imported: [], failed: [] }),
}: {
  stage?: (send: LutStageSend) => Promise<LutStageResponse>;
  importStaged?: () => Promise<LutImportResponse>;
} = {}) {
  const deps = {
    stage: vi.fn(stage),
    cancelStage: vi.fn(async () => undefined),
    importStaged: vi.fn(importStaged),
    onResult: vi.fn(),
    onClose: vi.fn(),
  };
  const session = createLutImportSession(deps);
  return { session, deps };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const twoFiles: LutStageResponse = {
  stageId: 's1',
  files: [
    good('a', 'Golden Hour.cube'),
    good('b', 'S-Log3 to Rec709.cube', { kindGuess: 'camera' }),
  ],
};

describe('choosing files', () => {
  it('uploads them under one stage and lists a verdict per file, kinds from the guess', async () => {
    const { session, deps } = setup({ stage: async () => twoFiles });
    const files = [cube('Golden Hour.cube'), cube('S-Log3 to Rec709.cube')];
    session.take(files);
    expect(session.getState().step).toBe('sending');
    expect(session.getState().rows.map((row) => row.name)).toEqual([
      'Golden Hour.cube',
      'S-Log3 to Rec709.cube',
    ]);
    await flush();
    expect(deps.stage).toHaveBeenCalledTimes(1);
    expect(deps.stage.mock.calls[0]?.[0].files).toEqual(files);
    const state = session.getState();
    expect(state.step).toBe('listed');
    expect(state.stageId).toBe('s1');
    expect(state.rows.map((row) => [row.id, row.ok, row.kind, row.size])).toEqual([
      ['a', true, 'look', 33],
      ['b', true, 'camera', 33],
    ]);
  });

  it('reports the upload progress', async () => {
    const gate = deferred<LutStageResponse>();
    const { session, deps } = setup({ stage: () => gate.promise });
    session.take([cube('a.cube')]);
    deps.stage.mock.calls[0]?.[0].onProgress?.(40);
    expect(session.getState().percent).toBe(40);
    gate.resolve(twoFiles);
    await flush();
    expect(session.getState().step).toBe('listed');
  });

  it('says so when a folder had no LUTs in it, and stays at step 1', () => {
    const { session, deps } = setup();
    session.take([]);
    expect(session.getState()).toMatchObject({
      step: 'pick',
      notice: LUT_IMPORT_TEXT.emptyFolder,
    });
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('refuses more files than one import takes without sending them', () => {
    const { session, deps } = setup();
    session.take(Array.from({ length: 61 }, (_, i) => cube(`lut-${i}.cube`)));
    expect(session.getState().notice).toBe(LUT_IMPORT_TEXT.tooMany);
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('ignores a second pick while the first is being checked or listed', async () => {
    const { session, deps } = setup({ stage: async () => twoFiles });
    session.take([cube('a.cube')]);
    session.take([cube('b.cube')]);
    await flush();
    session.take([cube('c.cube')]);
    expect(deps.stage).toHaveBeenCalledTimes(1);
  });
});

describe('the kinds', () => {
  it('start at the guess and change per file', async () => {
    const { session } = setup({ stage: async () => twoFiles });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    session.setKind('a', 'fix');
    expect(session.getState().rows.map((row) => row.kind)).toEqual(['fix', 'camera']);
  });
});

describe('a file that is not a LUT', () => {
  const stage = async (): Promise<LutStageResponse> => ({
    stageId: 's1',
    files: [
      good('a', 'Golden Hour.cube'),
      bad('b', 'notes.cube', 'Not a LUT: there is no LUT_3D_SIZE line.'),
    ],
  });

  it('keeps its reason and has no kind', async () => {
    const { session } = setup({ stage });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    const row = session.getState().rows[1];
    expect(row).toMatchObject({
      ok: false,
      error: 'Not a LUT: there is no LUT_3D_SIZE line.',
      kind: null,
    });
    session.setKind('b', 'fix');
    expect(session.getState().rows[1]?.kind).toBeNull();
  });

  it('is left out of the import', async () => {
    const { session, deps } = setup({
      stage,
      importStaged: async () => ({ imported: [makeLutSummary()], failed: [] }),
    });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    session.importNow();
    expect(deps.importStaged).toHaveBeenCalledWith({
      stageId: 's1',
      items: [{ id: 'a', kind: 'look' }],
    });
  });

  it('can be removed, and so can a good one; the last removal goes back to step 1', async () => {
    const { session, deps } = setup({ stage });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    session.remove('b');
    expect(session.getState().rows.map((row) => row.id)).toEqual(['a']);
    session.remove('a');
    expect(session.getState()).toMatchObject({ step: 'pick', rows: [], stageId: null });
    expect(deps.cancelStage).toHaveBeenCalledWith('s1');
  });
});

describe('importing', () => {
  it('copies the marked files, then tells the page and closes', async () => {
    const imported = [makeLutSummary({ slug: 'golden-hour' }), makeLutSummary({ slug: 'logs' })];
    const gate = deferred<LutImportResponse>();
    const { session, deps } = setup({
      stage: async () => twoFiles,
      importStaged: () => gate.promise,
    });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    session.setKind('a', 'fix');
    session.importNow();
    expect(session.getState().step).toBe('importing');
    expect(deps.importStaged).toHaveBeenCalledWith({
      stageId: 's1',
      items: [
        { id: 'a', kind: 'fix' },
        { id: 'b', kind: 'camera' },
      ],
    });
    gate.resolve({ imported, failed: [] });
    await flush();
    expect(deps.onResult).toHaveBeenCalledWith(imported, 0);
    expect(deps.onClose).toHaveBeenCalledTimes(1);
    expect(session.getState().step).toBe('pick');
    // The engine used the stage up: nothing is thrown away.
    expect(deps.cancelStage).not.toHaveBeenCalled();
  });

  it('cannot be cancelled while the files are being copied, and takes no clicks on the rows', async () => {
    const gate = deferred<LutImportResponse>();
    const { session, deps } = setup({
      stage: async () => twoFiles,
      importStaged: () => gate.promise,
    });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    session.importNow();
    expect(session.cancel()).toBe(false);
    session.setKind('a', 'fix');
    session.remove('a');
    expect(session.getState().step).toBe('importing');
    expect(session.getState().rows).toHaveLength(2);
    expect(deps.cancelStage).not.toHaveBeenCalled();
  });

  it('keeps the dialog open when a file could not be added, with the reason in the list', async () => {
    const imported = [makeLutSummary({ slug: 'golden-hour' })];
    const { session, deps } = setup({
      stage: async () => twoFiles,
      importStaged: async () => ({
        imported,
        failed: [{ id: 'b', error: 'The video tools could not read this LUT.' }],
      }),
    });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    session.importNow();
    await flush();
    expect(deps.onResult).toHaveBeenCalledWith(imported, 1);
    expect(deps.onClose).not.toHaveBeenCalled();
    const state = session.getState();
    expect(state.step).toBe('listed');
    expect(state.rows).toEqual([
      expect.objectContaining({
        id: 'b',
        ok: false,
        error: 'The video tools could not read this LUT.',
        kind: null,
      }),
    ]);
  });

  it('stays at step 2 with the reason when the request itself fails', async () => {
    const { session, deps } = setup({
      stage: async () => twoFiles,
      importStaged: async () => {
        throw new ApiError(404, 'That upload is gone. Choose the files again.');
      },
    });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    session.importNow();
    await flush();
    expect(session.getState()).toMatchObject({
      step: 'listed',
      error: 'That upload is gone. Choose the files again.',
    });
    expect(session.getState().rows).toHaveLength(2);
    expect(deps.onResult).not.toHaveBeenCalled();
  });

  it('does nothing when no file is good', async () => {
    const { session, deps } = setup({
      stage: async () => ({ stageId: 's1', files: [bad('a', 'x.txt', 'Not a LUT.')] }),
    });
    session.take([cube('x.txt')]);
    await flush();
    session.importNow();
    expect(deps.importStaged).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('throws the stage away and starts over', async () => {
    const { session, deps } = setup({ stage: async () => twoFiles });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    expect(session.cancel()).toBe(true);
    expect(deps.cancelStage).toHaveBeenCalledWith('s1');
    expect(session.getState()).toMatchObject({ step: 'pick', rows: [], stageId: null });
  });

  it('has nothing to throw away at step 1', () => {
    const { session, deps } = setup();
    expect(session.cancel()).toBe(true);
    expect(deps.cancelStage).not.toHaveBeenCalled();
  });

  it('aborts an upload in flight, and throws the stage away if the answer still arrives', async () => {
    const gate = deferred<LutStageResponse>();
    const { session, deps } = setup({ stage: () => gate.promise });
    session.take([cube('a.cube')]);
    const signal = deps.stage.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    expect(session.cancel()).toBe(true);
    expect(signal?.aborted).toBe(true);
    gate.resolve({ stageId: 'late', files: [good('a', 'a.cube')] });
    await flush();
    expect(deps.cancelStage).toHaveBeenCalledWith('late');
    expect(session.getState().step).toBe('pick');
  });

  it('ignores the abort error of the upload it cancelled', async () => {
    const gate = deferred<LutStageResponse>();
    const { session } = setup({ stage: () => gate.promise });
    session.take([cube('a.cube')]);
    session.cancel();
    gate.reject(new DOMException('The upload was cancelled.', 'AbortError'));
    await flush();
    expect(session.getState()).toMatchObject({ step: 'pick', error: null });
  });
});

describe('an upload that fails', () => {
  const unreachable = async (): Promise<LutStageResponse> => {
    throw new ApiError(0, 'Cannot reach the Studio Engine server.');
  };

  it('says the engine could not be reached and keeps the picked files', async () => {
    const { session } = setup({ stage: unreachable });
    session.take([cube('a.cube', 2048), cube('b.cube')]);
    await flush();
    const state = session.getState();
    expect(state.step).toBe('failed');
    expect(state.error).toBe("Couldn't reach the engine. Nothing was added.");
    expect(state.rows.map((row) => [row.name, row.bytes, row.kind])).toEqual([
      ['a.cube', 2048, null],
      ['b.cube', 10, null],
    ]);
  });

  it('sends the same files again on Try again', async () => {
    let calls = 0;
    const { session, deps } = setup({
      stage: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(0, 'down');
        return twoFiles;
      },
    });
    const files = [cube('a.cube'), cube('b.cube')];
    session.take(files);
    await flush();
    session.retry();
    expect(session.getState().step).toBe('sending');
    await flush();
    expect(deps.stage.mock.calls[1]?.[0].files).toEqual(files);
    expect(session.getState().step).toBe('listed');
    expect(session.getState().error).toBeNull();
  });

  it('lets a picked file be removed before trying again', async () => {
    const { session, deps } = setup({ stage: unreachable });
    session.take([cube('a.cube'), cube('b.cube')]);
    await flush();
    session.remove('file-0');
    expect(session.getState().rows.map((row) => row.name)).toEqual(['b.cube']);
    session.remove('file-1');
    expect(session.getState()).toMatchObject({ step: 'pick', error: null });
    expect(deps.cancelStage).not.toHaveBeenCalled();
  });

  it("shows the engine's own sentence when it answered with a refusal", async () => {
    const { session } = setup({
      stage: async () => {
        throw new ApiError(413, 'Import at most 60 LUTs at once.');
      },
    });
    session.take([cube('a.cube')]);
    await flush();
    expect(session.getState().error).toBe('Import at most 60 LUTs at once.');
  });
});

describe('importErrorText', () => {
  it('is the engine\'s sentence for an answer and "couldn\'t reach" for anything else', () => {
    expect(importErrorText(new ApiError(422, 'Another LUT already has this name.'))).toBe(
      'Another LUT already has this name.',
    );
    expect(importErrorText(new ApiError(0, 'x'))).toBe(LUT_IMPORT_TEXT.unreachable);
    // A proxy in front of a stopped engine answers 502.
    expect(importErrorText(new ApiError(502, 'The server answered 502 Bad Gateway.'))).toBe(
      LUT_IMPORT_TEXT.unreachable,
    );
    expect(importErrorText(new Error('boom'))).toBe(LUT_IMPORT_TEXT.unreachable);
  });
});

describe('subscribers', () => {
  it('hear every change and stop hearing after they unsubscribe', async () => {
    const { session } = setup({ stage: async () => twoFiles });
    const listener = vi.fn();
    const off = session.subscribe(listener);
    session.take([cube('a.cube')]);
    await flush();
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    off();
    listener.mockClear();
    session.cancel();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('opened for a job that waits for a camera LUT (LU10)', () => {
  const stagedTwo = async (): Promise<LutStageResponse> => twoFiles;

  it('starts every checked file at Camera, whatever its name suggests', async () => {
    const deps = {
      stage: vi.fn(stagedTwo),
      cancelStage: vi.fn(async () => undefined),
      importStaged: vi.fn(async (): Promise<LutImportResponse> => ({ imported: [], failed: [] })),
      onResult: vi.fn(),
      onClose: vi.fn(),
      defaultKind: () => 'camera' as const,
    };
    const session = createLutImportSession(deps);
    session.take([cube('Golden Hour.cube'), cube('S-Log3 to Rec709.cube')]);
    await flush();

    expect(session.getState().rows.map((row) => row.kind)).toEqual(['camera', 'camera']);
    session.setKind('a', 'look');
    expect(session.getState().rows.map((row) => row.kind)).toEqual(['look', 'camera']);
  });

  it('a file that did not pass has no kind, and no default either', async () => {
    const files: LutStageResponse = {
      stageId: 's1',
      files: [good('a', 'ok.cube'), bad('b', 'notes.cube', 'Not a LUT.')],
    };
    const session = createLutImportSession({
      stage: async () => files,
      cancelStage: async () => undefined,
      importStaged: async () => ({ imported: [], failed: [] }),
      onResult: () => {},
      onClose: () => {},
      defaultKind: () => 'camera',
    });
    session.take([cube('ok.cube'), cube('notes.cube')]);
    await flush();
    expect(session.getState().rows.map((row) => row.kind)).toEqual(['camera', null]);
  });

  it('with no default (or null) the guess stands, as before', async () => {
    for (const defaultKind of [undefined, () => null]) {
      const session = createLutImportSession({
        stage: stagedTwo,
        cancelStage: async () => undefined,
        importStaged: async () => ({ imported: [], failed: [] }),
        onResult: () => {},
        onClose: () => {},
        ...(defaultKind === undefined ? {} : { defaultKind }),
      });
      session.take([cube('a.cube'), cube('b.cube')]);
      await flush();
      expect(session.getState().rows.map((row) => row.kind)).toEqual(['look', 'camera']);
    }
  });
});
