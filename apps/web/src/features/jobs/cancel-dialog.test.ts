import type { Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  askToCancel,
  CANCEL_NOTES,
  cancelDialogStore,
  confirmCancel,
  createCancelDialogStore,
  noteForJob,
} from './cancel-dialog';
import { canvasJob } from './cells/test-helpers';

/** j5 is the editing job of the canvas; j6 is ready; j8 is cancelled. */
const editing: Job = canvasJob('j5');
const ready: Job = canvasJob('j6');
const cancelled: Job = canvasJob('j8');

/** A promise settled by hand, to hold a request in flight. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const view = (store: ReturnType<typeof createCancelDialogStore>) => {
  const { jobId, phase, note } = store.getState();
  return { jobId, phase, note };
};

describe('the cancel dialog store', () => {
  it('starts with no dialog', () => {
    expect(view(createCancelDialogStore())).toEqual({ jobId: null, phase: 'asking', note: null });
  });

  it('opens the question for the job that was asked about', () => {
    const store = createCancelDialogStore();
    store.getState().ask('j5');
    expect(view(store)).toEqual({ jobId: 'j5', phase: 'asking', note: null });
  });

  it('keeps the question while its job changes, which is what lets it outlive its row', () => {
    // The store knows jobs only by id: where the row is (which page, or none) never reaches it.
    const store = createCancelDialogStore();
    store.getState().ask('j5');
    for (let i = 0; i < 3; i++) store.getState().checkJob('j5', { ...editing, updatedAt: `${i}` });
    expect(view(store)).toEqual({ jobId: 'j5', phase: 'asking', note: null });
  });

  it('moves the question to another job when asked again, and a note gives way to a new question', () => {
    const store = createCancelDialogStore();
    store.getState().ask('j5');
    store.getState().checkJob('j5', ready);
    expect(store.getState().phase).toBe('note');
    store.getState().ask('j9');
    expect(view(store)).toEqual({ jobId: 'j9', phase: 'asking', note: null });
  });

  it('does not let a new question replace a stop that is in flight', () => {
    const store = createCancelDialogStore();
    store.getState().ask('j5');
    store.getState().confirm('j5');
    store.getState().ask('j9');
    expect(view(store)).toMatchObject({ jobId: 'j5', phase: 'stopping' });
  });

  describe('confirm', () => {
    it('turns the question into a running stop', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      expect(store.getState().confirm('j5')).toBe(true);
      expect(view(store)).toMatchObject({ jobId: 'j5', phase: 'stopping' });
    });

    it('refuses when nothing was asked, another job was asked, or the stop already runs', () => {
      const store = createCancelDialogStore();
      expect(store.getState().confirm('j5')).toBe(false);
      store.getState().ask('j5');
      expect(store.getState().confirm('j9')).toBe(false);
      expect(store.getState().confirm('j5')).toBe(true);
      expect(store.getState().confirm('j5')).toBe(false);
    });
  });

  describe('settle', () => {
    it('closes the dialog when the stop succeeded', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().confirm('j5');
      store.getState().settle('j5');
      expect(view(store)).toEqual({ jobId: null, phase: 'asking', note: null });
    });

    it("turns the dialog into a note with the server's words when the stop was refused", () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().confirm('j5');
      store.getState().settle('j5', 'Only an editing job can be cancelled.');
      expect(view(store)).toEqual({
        jobId: 'j5',
        phase: 'note',
        note: {
          title: CANCEL_NOTES.refusedTitle,
          description: 'Only an editing job can be cancelled.',
        },
      });
    });

    it('ignores an answer for a job that is not the one stopping, or when nothing is stopping', () => {
      const store = createCancelDialogStore();
      store.getState().settle('j5');
      store.getState().ask('j5');
      store.getState().settle('j5', 'late');
      expect(view(store)).toMatchObject({ jobId: 'j5', phase: 'asking' });
      store.getState().confirm('j5');
      store.getState().settle('j9');
      expect(view(store)).toMatchObject({ jobId: 'j5', phase: 'stopping' });
    });
  });

  describe('checkJob: the question follows its job', () => {
    it('leaves the question while the job can still be cancelled', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().checkJob('j5', editing);
      expect(view(store)).toMatchObject({ phase: 'asking', note: null });
    });

    it('turns it into a note when the edit ended by itself', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().checkJob('j5', ready);
      expect(view(store)).toEqual({ jobId: 'j5', phase: 'note', note: CANCEL_NOTES.ended });
    });

    it('turns it into a note when the job is gone from the list', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().checkJob('j5', undefined);
      expect(view(store)).toEqual({ jobId: 'j5', phase: 'note', note: CANCEL_NOTES.gone });
    });

    it('does not touch a stop in flight, although the optimistic update has left editing', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().confirm('j5');
      store.getState().checkJob('j5', cancelled);
      store.getState().checkJob('j5', undefined);
      expect(view(store)).toMatchObject({ phase: 'stopping', note: null });
    });

    it('ignores a check for another job, and one when nothing is open', () => {
      const store = createCancelDialogStore();
      store.getState().checkJob('j5', ready);
      expect(view(store).jobId).toBeNull();
      store.getState().ask('j5');
      store.getState().checkJob('j9', ready);
      expect(view(store)).toMatchObject({ phase: 'asking', note: null });
    });
  });

  describe('dismiss and reset', () => {
    it('closes the question and the note', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().dismiss();
      expect(view(store).jobId).toBeNull();
      store.getState().ask('j5');
      store.getState().checkJob('j5', ready);
      store.getState().dismiss();
      expect(view(store)).toEqual({ jobId: null, phase: 'asking', note: null });
    });

    it('never closes a stop that is in flight', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().confirm('j5');
      store.getState().dismiss();
      expect(view(store)).toMatchObject({ jobId: 'j5', phase: 'stopping' });
    });

    it('reset (the page was left) closes everything, a stop in flight included', () => {
      const store = createCancelDialogStore();
      store.getState().ask('j5');
      store.getState().confirm('j5');
      store.getState().reset();
      expect(view(store)).toEqual({ jobId: null, phase: 'asking', note: null });
    });
  });
});

describe('noteForJob', () => {
  it('is null for a job that can be cancelled', () => {
    expect(noteForJob(editing)).toBeNull();
  });

  it('says the job is gone when there is no job', () => {
    expect(noteForJob(undefined)).toBe(CANCEL_NOTES.gone);
  });

  it('says the edit is no longer running for a job in any other state', () => {
    expect(noteForJob(ready)).toBe(CANCEL_NOTES.ended);
    expect(noteForJob(cancelled)).toBe(CANCEL_NOTES.ended);
    expect(noteForJob(canvasJob('j7'))).toBe(CANCEL_NOTES.ended);
  });

  it('keeps its notes short: a title and one sentence', () => {
    for (const note of [CANCEL_NOTES.ended, CANCEL_NOTES.gone]) {
      expect(note.title).toBe('Nothing to stop');
      expect(note.description.split('.').filter(Boolean)).toHaveLength(1);
    }
  });
});

describe('askToCancel', () => {
  it('asks on the store it is given', () => {
    const store = createCancelDialogStore();
    askToCancel('j5', store);
    expect(view(store).jobId).toBe('j5');
  });

  it('asks on the shared app-wide store by default (the rows use it)', () => {
    askToCancel('j5');
    expect(cancelDialogStore.getState().jobId).toBe('j5');
    cancelDialogStore.getState().reset();
  });
});

describe('confirmCancel', () => {
  it('sends one cancel for the job, keeps the dialog stopping until the answer, then closes it', async () => {
    const store = createCancelDialogStore();
    const request = deferred();
    const cancel = vi.fn(() => request.promise);
    store.getState().ask('j5');

    const done = confirmCancel('j5', cancel, store);
    expect(cancel).toHaveBeenCalledExactlyOnceWith('j5');
    expect(view(store)).toMatchObject({ jobId: 'j5', phase: 'stopping' });

    request.resolve({});
    await done;
    expect(view(store)).toEqual({ jobId: null, phase: 'asking', note: null });
  });

  it('shows the refusal as a note when the request fails', async () => {
    const store = createCancelDialogStore();
    store.getState().ask('j5');
    await confirmCancel('j5', () => Promise.reject(new Error('Job j5 is not running.')), store);
    expect(view(store)).toMatchObject({
      jobId: 'j5',
      phase: 'note',
      note: { title: CANCEL_NOTES.refusedTitle, description: 'Job j5 is not running.' },
    });
  });

  it('copes with a failure that is not an Error', async () => {
    const store = createCancelDialogStore();
    store.getState().ask('j5');
    await confirmCancel('j5', () => Promise.reject('offline'), store);
    expect(view(store).note?.description).toBe('offline');
  });

  it('sends nothing when the job was not asked about, or a stop already runs', async () => {
    const store = createCancelDialogStore();
    const cancel = vi.fn(() => Promise.resolve({}));
    await confirmCancel('j5', cancel, store);
    store.getState().ask('j5');
    await confirmCancel('j9', cancel, store);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('lets the answer land on the store with no component around (the row and the host may be gone)', async () => {
    const store = createCancelDialogStore();
    const request = deferred();
    store.getState().ask('j5');
    const done = confirmCancel('j5', () => request.promise, store);
    request.reject(new Error('refused'));
    await done;
    expect(view(store).phase).toBe('note');
  });

  it('drops an answer that arrives after the page was left', async () => {
    const store = createCancelDialogStore();
    const request = deferred();
    store.getState().ask('j5');
    const done = confirmCancel('j5', () => request.promise, store);
    store.getState().reset();
    request.reject(new Error('too late'));
    await done;
    expect(view(store)).toEqual({ jobId: null, phase: 'asking', note: null });
  });
});
