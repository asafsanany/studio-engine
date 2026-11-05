import { JOB_STATES } from '@studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/api';
import { deferred, makeJob } from '@/data/test-utils';
import {
  askForNote,
  createNoteDialogStore,
  dismissNoteDialog,
  holdsWhileWriting,
  isNoteDialogOpen,
  isWritingNote,
  type NoteDialogDeps,
  noteDialogStore,
  saveNoteDialog,
  startNoteDialog,
} from './note-dialog';

/** Fake server: records the order of the calls, and each answer can be held back or refused. */
function fakeDeps(overrides: Partial<NoteDialogDeps> = {}) {
  const calls: string[] = [];
  const deps: NoteDialogDeps = {
    hold: vi.fn(async (id: string) => void calls.push(`hold ${id}`)),
    release: vi.fn(async (id: string) => void calls.push(`release ${id}`)),
    save: vi.fn(async (id: string, note: string) => void calls.push(`save ${id} ${note}`)),
    refused: vi.fn((action, id, message) => void calls.push(`refused ${action} ${id} ${message}`)),
    ...overrides,
  };
  return { deps, calls };
}

const arriving = makeJob({
  id: 'a',
  state: 'arriving',
  name: 'פרומו לסוף השבוע',
  client: 'מאפיית הצפון',
});
const queued = makeJob({ id: 'q', state: 'queued', name: 'Class schedule', client: 'Arc Fitness' });
const held = makeJob({ id: 'h', state: 'held', note: 'Old note' });

let store: ReturnType<typeof createNoteDialogStore>;
beforeEach(() => {
  store = createNoteDialogStore();
});

const state = () => store.getState();

describe('holdsWhileWriting', () => {
  it('is true for arriving and queued jobs only', () => {
    expect(JOB_STATES.filter((s) => holdsWhileWriting({ state: s }))).toEqual([
      'arriving',
      'queued',
    ]);
  });
});

describe('asking', () => {
  it('remembers the job once, until the host takes it', () => {
    state().ask(queued);
    expect(state().asked).toEqual(queued);
    expect(state().takeAsked()).toEqual(queued);
    expect(state().asked).toBeNull();
    expect(state().takeAsked()).toBeNull();
  });

  it('ignores a job that cannot take a note (editing, ready)', () => {
    state().ask(makeJob({ state: 'editing' }));
    state().ask(makeJob({ state: 'ready' }));
    expect(state().asked).toBeNull();
  });

  it('ignores a request while a dialog is already in progress', async () => {
    const { deps } = fakeDeps();
    await startNoteDialog(held, deps, store);
    state().ask(queued);
    expect(state().asked).toBeNull();
  });

  it('is what the row menu calls: askForNote asks the shared store, or the one it is given', () => {
    askForNote(queued, store);
    expect(state().asked).toEqual(queued);
    askForNote(queued);
    expect(noteDialogStore.getState().asked).toEqual(queued);
    noteDialogStore.getState().reset();
  });
});

describe('opening: auto-hold', () => {
  it.each([
    ['arriving', arriving],
    ['queued', queued],
  ])('holds an %s job first and waits for the answer before opening', async (_state, job) => {
    const gate = deferred();
    const { deps, calls } = fakeDeps({
      hold: vi.fn(async (id: string) => {
        calls.push(`hold ${id}`);
        await gate.promise;
      }),
    });

    const starting = startNoteDialog(job, deps, store);

    expect(calls).toEqual([`hold ${job.id}`]);
    expect(state().phase).toBe('holding');
    expect(isNoteDialogOpen(state())).toBe(false);

    gate.resolve();
    await starting;

    expect(state().phase).toBe('writing');
    expect(isNoteDialogOpen(state())).toBe(true);
    expect(state().held).toBe(true);
    expect(calls).toEqual([`hold ${job.id}`]);
  });

  it('shows the job as it was asked for, with the note it has so far', async () => {
    const { deps } = fakeDeps();
    await startNoteDialog({ ...queued, note: 'Use the second take.' }, deps, store);
    expect(state().job).toEqual({ id: 'q', name: 'Class schedule', client: 'Arc Fitness' });
    expect(state().text).toBe('Use the second take.');
    expect(state().error).toBeNull();
  });

  it('starts with an empty box when the job has no note', async () => {
    const { deps } = fakeDeps();
    await startNoteDialog(arriving, deps, store);
    expect(state().text).toBe('');
  });

  it.each(['held', 'failed', 'cancelled'] as const)(
    'opens a %s job at once and does not hold it (it keeps its state)',
    async (jobState) => {
      const { deps, calls } = fakeDeps();
      const job = makeJob({ id: 'x', state: jobState, note: 'Old note' });

      const starting = startNoteDialog(job, deps, store);
      // Open before anything is awaited: nothing to wait for.
      expect(state().phase).toBe('writing');
      await starting;

      expect(state().held).toBe(false);
      expect(state().text).toBe('Old note');
      expect(calls).toEqual([]);
    },
  );

  it.each(['editing', 'ready'] as const)('does nothing for a %s job', async (jobState) => {
    const { deps, calls } = fakeDeps();
    await startNoteDialog(makeJob({ state: jobState }), deps, store);
    expect(state().phase).toBe('closed');
    expect(calls).toEqual([]);
  });

  it('does not open, and says why, when the Hold is refused (the job just started editing)', async () => {
    const { deps } = fakeDeps({
      hold: vi.fn(async () => {
        throw new Error('Only an arriving or queued job can be held.');
      }),
    });

    await startNoteDialog(queued, deps, store);

    expect(state().phase).toBe('closed');
    expect(isNoteDialogOpen(state())).toBe(false);
    expect(state().held).toBe(false);
    expect(deps.refused).toHaveBeenCalledWith(
      'hold',
      'q',
      'Only an arriving or queued job can be held.',
    );
    // Nothing was held, so there is nothing to put back.
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('turns a refusal that is not an Error into text', async () => {
    const { deps } = fakeDeps({ hold: vi.fn(() => Promise.reject('offline')) });
    await startNoteDialog(queued, deps, store);
    expect(deps.refused).toHaveBeenCalledWith('hold', 'q', 'offline');
  });

  it('holds only once when it is asked again while the Hold is on its way', async () => {
    const gate = deferred();
    const { deps } = fakeDeps({ hold: vi.fn(() => gate.promise) });

    const first = startNoteDialog(queued, deps, store);
    await startNoteDialog(queued, deps, store);
    gate.resolve();
    await first;

    expect(deps.hold).toHaveBeenCalledTimes(1);
  });

  it('puts the job back if the dialog was closed while it was being held (the page was left)', async () => {
    const gate = deferred();
    const { deps, calls } = fakeDeps({
      hold: vi.fn(async (id: string) => {
        calls.push(`hold ${id}`);
        await gate.promise;
      }),
    });

    const starting = startNoteDialog(queued, deps, store);
    await dismissNoteDialog(deps, store);
    // Nothing to release yet: the Hold has not been answered.
    expect(calls).toEqual(['hold q']);
    gate.resolve();
    await starting;

    expect(state().phase).toBe('closed');
    expect(calls).toEqual(['hold q', 'release q']);
  });
});

describe('Save', () => {
  it('saves the text, then releases the job the dialog held, then closes', async () => {
    const { deps, calls } = fakeDeps();
    await startNoteDialog(queued, deps, store);
    state().setText('Keep it under 30 seconds.');

    await saveNoteDialog(deps, store);

    expect(calls).toEqual(['hold q', 'save q Keep it under 30 seconds.', 'release q']);
    expect(state().phase).toBe('closed');
    expect(isNoteDialogOpen(state())).toBe(false);
  });

  it('does not release a job it did not hold (held, failed, cancelled)', async () => {
    const { deps, calls } = fakeDeps();
    await startNoteDialog(held, deps, store);
    state().setText('New note');

    await saveNoteDialog(deps, store);

    expect(calls).toEqual(['save h New note']);
    expect(deps.release).not.toHaveBeenCalled();
    expect(state().phase).toBe('closed');
  });

  it('sends an empty text as it is (the server clears the note)', async () => {
    const { deps, calls } = fakeDeps();
    await startNoteDialog(held, deps, store);
    state().setText('');
    await saveNoteDialog(deps, store);
    expect(calls).toEqual(['save h ']);
  });

  it('is saving, and cannot be saved twice or closed, until the answer is in', async () => {
    const gate = deferred();
    const { deps, calls } = fakeDeps({
      save: vi.fn(async (id: string, note: string) => {
        calls.push(`save ${id} ${note}`);
        await gate.promise;
      }),
    });
    await startNoteDialog(queued, deps, store);
    state().setText('Note');

    const saving = saveNoteDialog(deps, store);
    expect(state().phase).toBe('saving');
    expect(isNoteDialogOpen(state())).toBe(true);

    await saveNoteDialog(deps, store);
    await dismissNoteDialog(deps, store);
    expect(state().phase).toBe('saving');
    expect(calls).toEqual(['hold q', 'save q Note']);

    gate.resolve();
    await saving;
    expect(state().phase).toBe('closed');
    expect(calls).toEqual(['hold q', 'save q Note', 'release q']);
  });

  it('stays open with the text and the reason when the job started editing meanwhile (409)', async () => {
    const { deps, calls } = fakeDeps({
      save: vi.fn(async () => {
        throw new Error('Cannot edit the note of a job that is editing.');
      }),
    });
    await startNoteDialog(queued, deps, store);
    state().setText('My long note');

    await saveNoteDialog(deps, store);

    expect(state().phase).toBe('writing');
    expect(isNoteDialogOpen(state())).toBe(true);
    expect(state().error).toBe('Cannot edit the note of a job that is editing.');
    expect(state().text).toBe('My long note');
    // The job stays held by the dialog: Save did not put it back, and Cancel still can.
    expect(state().held).toBe(true);
    expect(calls).toEqual(['hold q']);
    expect(deps.refused).not.toHaveBeenCalled();
  });

  it('clears the reason when it is tried again, and finishes when it works', async () => {
    let attempt = 0;
    const { deps, calls } = fakeDeps({
      save: vi.fn(async (id: string, note: string) => {
        attempt += 1;
        if (attempt === 1) throw new Error('Cannot reach the Studio Engine server.');
        calls.push(`save ${id} ${note}`);
      }),
    });
    await startNoteDialog(queued, deps, store);
    state().setText('Note');
    await saveNoteDialog(deps, store);
    expect(state().error).toBe('Cannot reach the Studio Engine server.');

    const again = saveNoteDialog(deps, store);
    expect(state().error).toBeNull();
    await again;

    expect(state().phase).toBe('closed');
    expect(calls).toEqual(['hold q', 'save q Note', 'release q']);
  });

  it('closes anyway when the Release is refused after the note was saved, and says so', async () => {
    const { deps } = fakeDeps({
      release: vi.fn(async () => {
        throw new Error('Cannot reach the Studio Engine server.');
      }),
    });
    await startNoteDialog(queued, deps, store);
    state().setText('Note');

    await saveNoteDialog(deps, store);

    expect(state().phase).toBe('closed');
    expect(state().error).toBeNull();
    expect(deps.refused).toHaveBeenCalledWith(
      'release',
      'q',
      'Cannot reach the Studio Engine server.',
    );
  });

  it('closes quietly when the job is no longer held by the time of the Release (409): nothing is left to undo', async () => {
    const { deps } = fakeDeps({
      release: vi.fn(async () => {
        throw new ApiError(409, 'Cannot release a job that is queued.');
      }),
    });
    await startNoteDialog(queued, deps, store);
    state().setText('Note');

    await saveNoteDialog(deps, store);

    expect(state().phase).toBe('closed');
    expect(deps.save).toHaveBeenCalledWith('q', 'Note');
    expect(deps.refused).not.toHaveBeenCalled();
  });

  it('does nothing when no dialog is open', async () => {
    const { deps } = fakeDeps();
    await saveNoteDialog(deps, store);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it('does not close a newer dialog when an older save finishes after the page was left', async () => {
    const gate = deferred();
    const { deps } = fakeDeps({ save: vi.fn(() => gate.promise) });
    await startNoteDialog(held, deps, store);
    const saving = saveNoteDialog(deps, store);

    // The page is left (the store is reset) and a dialog for another job opens.
    state().reset();
    await startNoteDialog(makeJob({ id: 'other', state: 'failed' }), fakeDeps().deps, store);
    gate.resolve();
    await saving;

    expect(state().phase).toBe('writing');
    expect(state().job?.id).toBe('other');
  });
});

describe('Cancel, Escape or a click outside', () => {
  it('releases a job the dialog held, without saving, and closes', async () => {
    const { deps, calls } = fakeDeps();
    await startNoteDialog(arriving, deps, store);
    state().setText('Typed but not saved');

    await dismissNoteDialog(deps, store);

    expect(calls).toEqual(['hold a', 'release a']);
    expect(deps.save).not.toHaveBeenCalled();
    expect(state().phase).toBe('closed');
  });

  it('leaves a job it did not hold exactly as it was (held, failed, cancelled)', async () => {
    const { deps, calls } = fakeDeps();
    await startNoteDialog(held, deps, store);

    await dismissNoteDialog(deps, store);

    expect(calls).toEqual([]);
    expect(state().phase).toBe('closed');
  });

  it('closes at once, without waiting for the Release', async () => {
    const gate = deferred();
    const { deps } = fakeDeps({ release: vi.fn(() => gate.promise) });
    await startNoteDialog(queued, deps, store);

    const dismissing = dismissNoteDialog(deps, store);
    expect(state().phase).toBe('closed');
    gate.resolve();
    await dismissing;
  });

  it('says so when the Release is refused (the dialog is gone, so it is a toast)', async () => {
    const { deps } = fakeDeps({
      release: vi.fn(async () => {
        throw new Error('Only a held job can be released.');
      }),
    });
    await startNoteDialog(queued, deps, store);

    await dismissNoteDialog(deps, store);

    expect(deps.refused).toHaveBeenCalledWith('release', 'q', 'Only a held job can be released.');
  });

  it('says nothing when the job was already released by something else (409: not held)', async () => {
    const { deps } = fakeDeps({
      release: vi.fn(async () => {
        throw new ApiError(409, 'Cannot release a job that is queued.');
      }),
    });
    await startNoteDialog(queued, deps, store);

    await dismissNoteDialog(deps, store);

    expect(state().phase).toBe('closed');
    expect(deps.release).toHaveBeenCalledTimes(1);
    expect(deps.refused).not.toHaveBeenCalled();
  });

  it('says so when the server cannot be reached for the Release (the job stays held)', async () => {
    const { deps } = fakeDeps({
      release: vi.fn(async () => {
        throw new ApiError(0, 'Cannot reach the Studio Engine server.');
      }),
    });
    await startNoteDialog(queued, deps, store);

    await dismissNoteDialog(deps, store);

    expect(deps.refused).toHaveBeenCalledWith(
      'release',
      'q',
      'Cannot reach the Studio Engine server.',
    );
  });

  it('keeps the last job, text and words in the state, so the dialog can fade out with them', async () => {
    const { deps } = fakeDeps();
    await startNoteDialog({ ...queued, note: 'Old' }, deps, store);
    state().setText('Edited');
    await dismissNoteDialog(deps, store);
    expect(state()).toMatchObject({
      phase: 'closed',
      job: { id: 'q', name: 'Class schedule', client: 'Arc Fitness' },
      text: 'Edited',
    });
  });

  it('does nothing when no dialog is open', async () => {
    const { deps } = fakeDeps();
    await dismissNoteDialog(deps, store);
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('can be reopened afterwards with the note the job has then', async () => {
    const { deps } = fakeDeps();
    await startNoteDialog(queued, deps, store);
    state().setText('Typed but not saved');
    await dismissNoteDialog(deps, store);

    await startNoteDialog({ ...queued, note: 'Saved elsewhere' }, deps, store);

    expect(state().text).toBe('Saved elsewhere');
    expect(state().phase).toBe('writing');
  });
});

describe('isWritingNote: the row of a job the dialog is holding', () => {
  it('is true for that job while the dialog is open, and for no other', async () => {
    const { deps } = fakeDeps();
    await startNoteDialog(queued, deps, store);
    expect(isWritingNote(state(), 'q')).toBe(true);
    expect(isWritingNote(state(), 'other')).toBe(false);
  });

  it('is false while the Hold is on its way, for a job that was not held, and once closed', async () => {
    const gate = deferred();
    const { deps } = fakeDeps({ hold: vi.fn(() => gate.promise) });
    const starting = startNoteDialog(queued, deps, store);
    expect(isWritingNote(state(), 'q')).toBe(false);
    gate.resolve();
    await starting;
    await dismissNoteDialog(deps, store);
    expect(isWritingNote(state(), 'q')).toBe(false);

    await startNoteDialog(held, deps, store);
    expect(isWritingNote(state(), 'h')).toBe(false);
  });
});

describe('reset', () => {
  it('forgets the request and closes the dialog (the page was left)', async () => {
    const { deps } = fakeDeps();
    await startNoteDialog(held, deps, store);
    state().ask(queued);
    state().reset();
    expect(state()).toMatchObject({
      asked: null,
      phase: 'closed',
      job: null,
      text: '',
      held: false,
    });
  });
});
