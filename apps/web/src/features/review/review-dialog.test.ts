import { afterEach, describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import {
  createReviewDialogStore,
  openReview,
  reviewDialogStore,
  reviewDraftOf,
} from './review-dialog';

const reviewJob = (id = 'r1') => makeJob({ id, state: 'review', step: 7, placeInLine: null });

afterEach(() => {
  reviewDialogStore.getState().reset();
  reviewDialogStore.setState({ session: 0, drafts: {} });
});

describe('createReviewDialogStore: opening and closing', () => {
  it('starts closed, with no drafts, no submission and session 0', () => {
    const state = createReviewDialogStore().getState();
    expect(state).toMatchObject({
      jobId: null,
      session: 0,
      drafts: {},
      submitting: null,
      submitError: null,
    });
  });

  it('opens for a job and counts the opening', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    expect(store.getState()).toMatchObject({ jobId: 'r1', session: 1 });
  });

  it('counts an opening of the same job again as a new session', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().open('r1');
    expect(store.getState().session).toBe(2);
    store.getState().open('r2');
    expect(store.getState()).toMatchObject({ jobId: 'r2', session: 3 });
  });

  it('keeps the session when it closes', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().close();
    expect(store.getState()).toMatchObject({ jobId: null, session: 1 });
  });

  it('clears the last refusal when it opens or closes', () => {
    const store = createReviewDialogStore({ jobId: 'r1', submitError: 'Nope' });
    store.getState().close();
    expect(store.getState().submitError).toBeNull();
    store.setState({ submitError: 'Nope again' });
    store.getState().open('r1');
    expect(store.getState().submitError).toBeNull();
  });

  it('starts where it is told to (for a server render)', () => {
    const store = createReviewDialogStore({ jobId: 'r1', session: 4, drafts: { r1: 'Hi' } });
    expect(store.getState()).toMatchObject({ jobId: 'r1', session: 4, drafts: { r1: 'Hi' } });
  });
});

describe('createReviewDialogStore: drafts', () => {
  it('keeps the text of each job on its own', () => {
    const store = createReviewDialogStore();
    store.getState().setDraft('r1', 'Cut the intro');
    store.getState().setDraft('r2', 'Louder music');
    expect(reviewDraftOf(store.getState(), 'r1')).toBe('Cut the intro');
    expect(reviewDraftOf(store.getState(), 'r2')).toBe('Louder music');
    expect(reviewDraftOf(store.getState(), 'r3')).toBe('');
  });

  it('removes the key when the text is emptied', () => {
    const store = createReviewDialogStore();
    store.getState().setDraft('r1', 'Cut the intro');
    store.getState().setDraft('r2', 'Louder music');
    store.getState().setDraft('r1', '');
    expect(store.getState().drafts).toEqual({ r2: 'Louder music' });
  });

  it('survives closing and resetting', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().setDraft('r1', 'Cut the intro');
    store.getState().close();
    expect(reviewDraftOf(store.getState(), 'r1')).toBe('Cut the intro');
    store.getState().reset();
    expect(reviewDraftOf(store.getState(), 'r1')).toBe('Cut the intro');
  });
});

describe('createReviewDialogStore: sending notes or approving', () => {
  it('cannot begin while closed or already submitting', () => {
    const store = createReviewDialogStore();
    expect(store.getState().beginSubmit('send_notes')).toBe(false);
    expect(store.getState().submitting).toBeNull();
    store.getState().open('r1');
    expect(store.getState().beginSubmit('send_notes')).toBe(true);
    expect(store.getState().beginSubmit('approve')).toBe(false);
    expect(store.getState().submitting).toBe('send_notes');
  });

  it('ignores open, close and checkJob while it is submitting', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().beginSubmit('approve');

    store.getState().open('r2');
    store.getState().close();
    const closed = store.getState().checkJob('r1', makeJob({ id: 'r1', state: 'queued' }));

    expect(closed).toBe(false);
    expect(store.getState()).toMatchObject({ jobId: 'r1', session: 1, submitting: 'approve' });
  });

  it('closes when the server accepted it', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().beginSubmit('send_notes');
    store.getState().endSubmit({ ok: true });
    expect(store.getState()).toMatchObject({ jobId: null, submitting: null, submitError: null });
  });

  it('stays open after an answer that asked to (the phone’s done footer), until closed', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().beginSubmit('approve');
    store.getState().endSubmit({ ok: true, stayOpen: true });
    expect(store.getState()).toMatchObject({ jobId: 'r1', submitting: null, submitError: null });
    // Nothing is submitting any more, so Close works.
    store.getState().close();
    expect(store.getState().jobId).toBeNull();
  });

  it('stays open with the server’s words when it refused', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().beginSubmit('approve');
    store.getState().endSubmit({ ok: false, error: 'This job is not in review.' });
    expect(store.getState()).toMatchObject({
      jobId: 'r1',
      submitting: null,
      submitError: 'This job is not in review.',
    });
  });

  it('clears the refusal when it begins again', () => {
    const store = createReviewDialogStore({ jobId: 'r1', submitError: 'Nope' });
    expect(store.getState().beginSubmit('approve')).toBe(true);
    expect(store.getState().submitError).toBeNull();
  });

  it('ignores an answer when nothing is submitting', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().endSubmit({ ok: true });
    expect(store.getState().jobId).toBe('r1');
    store.getState().endSubmit({ ok: false, error: 'Stray' });
    expect(store.getState().submitError).toBeNull();
  });
});

describe('createReviewDialogStore: following the job', () => {
  it.each([
    ['queued', makeJob({ id: 'r1', state: 'queued' })],
    ['failed', makeJob({ id: 'r1', state: 'failed', failedAt: 8, error: 'boom' })],
    ['gone from the list', undefined],
  ] as const)('closes and says so when the job is %s', (_label, job) => {
    const store = createReviewDialogStore({ jobId: 'r1', session: 1 });
    expect(store.getState().checkJob('r1', job)).toBe(true);
    expect(store.getState().jobId).toBeNull();
  });

  it('keeps the dialog while the job is in review', () => {
    const store = createReviewDialogStore({ jobId: 'r1', session: 1 });
    expect(store.getState().checkJob('r1', reviewJob())).toBe(false);
    expect(store.getState().jobId).toBe('r1');
  });

  it('keeps the job’s chat open while the job waits or runs, and closes it when it fails (Draft & chat)', () => {
    const store = createReviewDialogStore({ jobId: 'r1', session: 1 });
    expect(store.getState().checkJob('r1', makeJob({ id: 'r1', state: 'queued' }), true)).toBe(
      false,
    );
    expect(store.getState().checkJob('r1', makeJob({ id: 'r1', state: 'editing' }), true)).toBe(
      false,
    );
    expect(store.getState().jobId).toBe('r1');
    const failed = makeJob({ id: 'r1', state: 'failed', failedAt: 8, error: 'boom' });
    expect(store.getState().checkJob('r1', failed, true)).toBe(true);
    expect(store.getState().jobId).toBeNull();
  });

  it('ignores a job that is not the open one', () => {
    const store = createReviewDialogStore({ jobId: 'r1', session: 1 });
    expect(store.getState().checkJob('r2', undefined)).toBe(false);
    expect(store.getState().jobId).toBe('r1');
  });

  it('has nothing to follow while closed', () => {
    const store = createReviewDialogStore();
    expect(store.getState().checkJob('r1', undefined)).toBe(false);
  });
});

describe('createReviewDialogStore: reset', () => {
  it('closes and forgets the submission, and keeps the drafts and the session', () => {
    const store = createReviewDialogStore();
    store.getState().open('r1');
    store.getState().setDraft('r1', 'Cut the intro');
    store.getState().beginSubmit('send_notes');

    store.getState().reset();

    expect(store.getState()).toMatchObject({
      jobId: null,
      session: 1,
      submitting: null,
      submitError: null,
      drafts: { r1: 'Cut the intro' },
    });
  });
});

describe('openReview', () => {
  it('opens the app-wide dialog for a job', () => {
    openReview('r1');
    expect(reviewDialogStore.getState()).toMatchObject({ jobId: 'r1', session: 1 });
  });

  it('opens a store it is given', () => {
    const store = createReviewDialogStore();
    openReview('r9', store);
    expect(store.getState().jobId).toBe('r9');
    expect(reviewDialogStore.getState().jobId).toBeNull();
  });
});
