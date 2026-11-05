import { JOB_STATES } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { deferred, makeJob } from '@/data/test-utils';
import {
  askToUseLook,
  confirmUseLook,
  createUseLookDialogStore,
  type UseLookDeps,
  type UseLookTarget,
} from './use-look-dialog';

const READY = makeJob({
  id: 'job-ready',
  name: 'Studio tour',
  client: 'Arc Fitness',
  clientId: 'client-1',
  state: 'ready',
});

/** What the dialog remembers about READY. */
const TARGET: UseLookTarget = {
  jobId: 'job-ready',
  jobName: 'Studio tour',
  clientId: 'client-1',
  client: 'Arc Fitness',
};

function deps(overrides: Partial<UseLookDeps> = {}) {
  const calls = {
    applyLook: vi.fn<UseLookDeps['applyLook']>(() => Promise.resolve()),
    done: vi.fn<UseLookDeps['done']>(),
    refused: vi.fn<UseLookDeps['refused']>(),
  };
  return { calls, deps: { ...calls, ...overrides } satisfies UseLookDeps };
}

/** A store with the question on screen for READY. */
function asking() {
  const store = createUseLookDialogStore();
  askToUseLook(READY, store);
  return store;
}

describe('the Use this look dialog store', () => {
  it('starts closed, with nothing to show', () => {
    const { phase, target } = createUseLookDialogStore().getState();
    expect(phase).toBe('closed');
    expect(target).toBeNull();
  });

  it('opens the question for a ready job, remembering its name and its client', () => {
    const store = createUseLookDialogStore();
    askToUseLook(READY, store);
    expect(store.getState()).toMatchObject({ phase: 'asking', target: TARGET });
  });

  it.each(JOB_STATES.filter((state) => state !== 'ready'))(
    'does not open for a job that is %s: only a finished job has a look to use',
    (state) => {
      const store = createUseLookDialogStore();
      askToUseLook(makeJob({ state }), store);
      expect(store.getState().phase).toBe('closed');
    },
  );

  it('asked again for another job, shows the other job', () => {
    const store = asking();
    askToUseLook(makeJob({ ...READY, id: 'job-2', name: 'Coach intro reel' }), store);
    expect(store.getState().target).toMatchObject({ jobId: 'job-2', jobName: 'Coach intro reel' });
  });

  it('cancel, Escape or a click outside close it, and the job stays for the fade-out', () => {
    const store = asking();
    store.getState().dismiss();
    expect(store.getState()).toMatchObject({ phase: 'closed', target: TARGET });
  });

  it('confirms only a question that was asked, for that job', () => {
    const store = createUseLookDialogStore();
    expect(store.getState().confirm('job-ready')).toBe(false);
    askToUseLook(READY, store);
    expect(store.getState().confirm('another-job')).toBe(false);
    expect(store.getState().phase).toBe('asking');
    expect(store.getState().confirm('job-ready')).toBe(true);
    expect(store.getState().phase).toBe('saving');
    // Pressing it twice sends one request.
    expect(store.getState().confirm('job-ready')).toBe(false);
  });

  it('cannot be closed or replaced while the request is in flight', () => {
    const store = asking();
    store.getState().confirm('job-ready');
    store.getState().dismiss();
    askToUseLook(makeJob({ ...READY, id: 'job-2' }), store);
    expect(store.getState()).toMatchObject({ phase: 'saving', target: TARGET });
  });

  it('closes when the request is answered, and ignores an answer for another job', () => {
    const store = asking();
    store.getState().confirm('job-ready');
    store.getState().settle('another-job');
    expect(store.getState().phase).toBe('saving');
    store.getState().settle('job-ready');
    expect(store.getState().phase).toBe('closed');
  });

  it('reset (the page was left) closes it even in flight, and forgets the job', () => {
    const store = asking();
    store.getState().confirm('job-ready');
    store.getState().reset();
    expect(store.getState()).toMatchObject({ phase: 'closed', target: null });
    // The answer of the request that was running finds nothing to settle.
    store.getState().settle('job-ready');
    expect(store.getState().phase).toBe('closed');
  });
});

describe('confirmUseLook', () => {
  it('sends the request for the job on screen, closes the dialog and says the look is the client’s', async () => {
    const store = asking();
    const { calls, deps: d } = deps();
    await confirmUseLook(d, store);
    expect(calls.applyLook).toHaveBeenCalledExactlyOnceWith('job-ready');
    expect(store.getState().phase).toBe('closed');
    expect(calls.done).toHaveBeenCalledExactlyOnceWith(TARGET);
    expect(calls.refused).not.toHaveBeenCalled();
  });

  it('keeps the dialog (not closable) until the answer is in', async () => {
    const store = asking();
    const answer = deferred();
    const { calls, deps: d } = deps({ applyLook: () => answer.promise });
    const sent = confirmUseLook(d, store);
    expect(store.getState().phase).toBe('saving');
    expect(calls.done).not.toHaveBeenCalled();
    answer.resolve();
    await sent;
    expect(store.getState().phase).toBe('closed');
    expect(calls.done).toHaveBeenCalledOnce();
  });

  it('closes the dialog and shows the server’s words when it refuses (409)', async () => {
    const store = asking();
    const { calls, deps: d } = deps({
      applyLook: () =>
        Promise.reject(new Error('The style is being analysed. Try again once it is done.')),
    });
    await confirmUseLook(d, store);
    expect(store.getState().phase).toBe('closed');
    expect(calls.refused).toHaveBeenCalledExactlyOnceWith(
      TARGET,
      'The style is being analysed. Try again once it is done.',
    );
    expect(calls.done).not.toHaveBeenCalled();
  });

  it('says something even when what failed was not an Error', async () => {
    const store = asking();
    const { calls, deps: d } = deps({ applyLook: () => Promise.reject('offline') });
    await confirmUseLook(d, store);
    expect(calls.refused).toHaveBeenCalledWith(TARGET, 'offline');
  });

  it('sends nothing when no question was asked, and nothing twice', async () => {
    const closed = createUseLookDialogStore();
    const first = deps();
    await confirmUseLook(first.deps, closed);
    expect(first.calls.applyLook).not.toHaveBeenCalled();

    const store = asking();
    const answer = deferred();
    const second = deps({ applyLook: () => answer.promise });
    const sent = confirmUseLook(second.deps, store);
    await confirmUseLook(second.deps, store);
    answer.resolve();
    await sent;
    expect(second.calls.done).toHaveBeenCalledOnce();
  });

  it('still tells the person when the page was left while it was running (the request went through)', async () => {
    const store = asking();
    const answer = deferred();
    const { calls, deps: d } = deps({ applyLook: () => answer.promise });
    const sent = confirmUseLook(d, store);
    store.getState().reset();
    answer.resolve();
    await sent;
    expect(store.getState().phase).toBe('closed');
    expect(calls.done).toHaveBeenCalledExactlyOnceWith(TARGET);
  });
});
