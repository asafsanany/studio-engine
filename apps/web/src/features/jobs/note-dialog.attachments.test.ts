import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/api';
import { deferred, makeJob } from '@/data/test-utils';
import type { NoteAttachmentsSession } from './note-attachments';
import {
  createNoteDialogStore,
  dismissNoteDialog,
  type NoteDialogDeps,
  saveNoteDialog,
  startNoteDialog,
} from './note-dialog';

// The note dialog's Save and Cancel with pictures (Songs, SG5): Save waits for the uploads, a
// picture that did not attach stops it, the pictures are kept once the note is in, and Cancel
// throws away what the opening added. The pictures' own rules are in note-attachments.test.ts.

/** Records the order of everything the dialog asks, pictures included. */
function fakeDeps(
  attachments: Partial<NoteAttachmentsSession> | null,
  overrides: Partial<NoteDialogDeps> = {},
) {
  const calls: string[] = [];
  const session: NoteAttachmentsSession = {
    settle: vi.fn(async () => {
      calls.push('settle');
      return null;
    }),
    keep: vi.fn(() => void calls.push('keep')),
    discard: vi.fn(async () => void calls.push('discard')),
    ...attachments,
  };
  const deps: NoteDialogDeps = {
    hold: vi.fn(async (id: string) => void calls.push(`hold ${id}`)),
    release: vi.fn(async (id: string) => void calls.push(`release ${id}`)),
    save: vi.fn(async (id: string, note: string) => void calls.push(`save ${id} ${note}`)),
    refused: vi.fn(),
    ...(attachments === null ? {} : { attachments: session }),
    ...overrides,
  };
  return { deps, calls, session };
}

const queued = makeJob({ id: 'q', state: 'queued', name: 'Class schedule', client: 'Arc Fitness' });
const failed = makeJob({ id: 'f', state: 'failed' });

let store: ReturnType<typeof createNoteDialogStore>;
beforeEach(() => {
  store = createNoteDialogStore();
});

const state = () => store.getState();

describe('Save with pictures', () => {
  it('waits for the pictures, then sends the note, puts the job back in line, then keeps them', async () => {
    const { deps, calls } = fakeDeps({});
    await startNoteDialog(queued, deps, store);
    state().setText('Use her song.');

    await saveNoteDialog(deps, store);

    expect(calls).toEqual(['hold q', 'settle', 'save q Use her song.', 'release q', 'keep']);
    expect(state().phase).toBe('closed');
  });

  it('does not send the note while a picture is still on its way', async () => {
    const landing = deferred<string | null>();
    const { deps, calls } = fakeDeps({ settle: vi.fn(() => landing.promise) });
    await startNoteDialog(failed, deps, store);
    state().setText('Use her song.');

    const saving = saveNoteDialog(deps, store);
    await Promise.resolve();
    expect(state().phase).toBe('saving');
    expect(deps.save).not.toHaveBeenCalled();

    landing.resolve(null);
    await saving;
    expect(calls).toEqual(['save f Use her song.', 'keep']);
    expect(state().phase).toBe('closed');
  });

  it('cannot be closed while it waits', async () => {
    const landing = deferred<string | null>();
    const { deps, session } = fakeDeps({ settle: vi.fn(() => landing.promise) });
    await startNoteDialog(failed, deps, store);
    const saving = saveNoteDialog(deps, store);

    await dismissNoteDialog(deps, store);
    expect(state().phase).toBe('saving');
    expect(session.discard).not.toHaveBeenCalled();

    landing.resolve(null);
    await saving;
  });

  it('stops, with the reason, when a picture did not attach: the note is not sent and the pictures stay', async () => {
    const { deps, session } = fakeDeps({
      settle: vi.fn(async () => 'A picture didn’t attach. Take it off to save the note.'),
    });
    await startNoteDialog(failed, deps, store);
    state().setText('Use her song.');

    await saveNoteDialog(deps, store);

    expect(deps.save).not.toHaveBeenCalled();
    expect(session.keep).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      phase: 'writing',
      text: 'Use her song.',
      error: 'A picture didn’t attach. Take it off to save the note.',
    });

    // Fixed: Save goes through.
    vi.mocked(session.settle).mockResolvedValueOnce(null);
    await saveNoteDialog(deps, store);
    expect(deps.save).toHaveBeenCalledWith('f', 'Use her song.');
    expect(state().phase).toBe('closed');
  });

  it('says the words of a settle that breaks', async () => {
    const { deps } = fakeDeps({
      settle: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await startNoteDialog(failed, deps, store);
    await saveNoteDialog(deps, store);
    expect(state()).toMatchObject({ phase: 'writing', error: 'boom' });
  });

  it('keeps the dialog open, and the pictures un-kept, when the note is refused', async () => {
    const { deps, session } = fakeDeps(
      {},
      {
        save: vi.fn(async () => {
          throw new ApiError(409, 'Cannot edit the note of a job that is editing.');
        }),
      },
    );
    await startNoteDialog(failed, deps, store);

    await saveNoteDialog(deps, store);

    expect(state()).toMatchObject({
      phase: 'writing',
      error: 'Cannot edit the note of a job that is editing.',
    });
    expect(session.keep).not.toHaveBeenCalled();

    // Cancel then throws away what this opening added.
    await dismissNoteDialog(deps, store);
    expect(session.discard).toHaveBeenCalledTimes(1);
  });

  it('keeps the pictures even when the Release after the note is refused', async () => {
    const { deps, session } = fakeDeps(
      {},
      {
        release: vi.fn(async () => {
          throw new ApiError(500, 'down');
        }),
      },
    );
    await startNoteDialog(queued, deps, store);
    await saveNoteDialog(deps, store);
    expect(session.keep).toHaveBeenCalledTimes(1);
    expect(state().phase).toBe('closed');
  });
});

describe('Cancel with pictures', () => {
  it('throws away the pictures of the opening and puts the job back in line', async () => {
    const { deps, calls } = fakeDeps({});
    await startNoteDialog(queued, deps, store);

    await dismissNoteDialog(deps, store);

    expect(calls).toContain('discard');
    expect(calls).toContain('release q');
    expect(calls).not.toContain('keep');
    expect(state().phase).toBe('closed');
  });

  it('does so for a job the dialog did not hold too', async () => {
    const { deps, session } = fakeDeps({});
    await startNoteDialog(failed, deps, store);
    await dismissNoteDialog(deps, store);
    expect(session.discard).toHaveBeenCalledTimes(1);
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('does not wait for the deletes: the dialog is closed at once', async () => {
    const deleting = deferred<void>();
    const { deps } = fakeDeps({ discard: vi.fn(() => deleting.promise) });
    await startNoteDialog(failed, deps, store);

    await dismissNoteDialog(deps, store);

    expect(state().phase).toBe('closed');
    deleting.resolve();
  });

  it('is not troubled by a discard that breaks', async () => {
    const { deps } = fakeDeps({
      discard: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await startNoteDialog(failed, deps, store);
    await expect(dismissNoteDialog(deps, store)).resolves.toBeUndefined();
    expect(state().phase).toBe('closed');
  });

  it('has nothing to throw away before the dialog opens (the Hold is still on its way)', async () => {
    const holding = deferred<unknown>();
    const { deps, session } = fakeDeps({}, { hold: vi.fn(() => holding.promise) });
    const starting = startNoteDialog(queued, deps, store);
    expect(state().phase).toBe('holding');

    await dismissNoteDialog(deps, store);
    expect(session.discard).not.toHaveBeenCalled();

    holding.resolve(undefined);
    await starting;
  });
});

describe('without pictures (the switch is off, or the phone)', () => {
  it('is today’s Save and Cancel: nothing about pictures happens', async () => {
    const { deps, calls } = fakeDeps(null);
    await startNoteDialog(queued, deps, store);
    state().setText('A note');
    await saveNoteDialog(deps, store);
    expect(calls).toEqual(['hold q', 'save q A note', 'release q']);

    const second = fakeDeps(null);
    await startNoteDialog(queued, second.deps, store);
    await dismissNoteDialog(second.deps, store);
    expect(second.calls).toEqual(['hold q', 'release q']);
  });
});
