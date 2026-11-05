import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import { deferred } from '@/data/test-utils';
import { createReviewDialogStore } from './review-dialog';
import { submitReview } from './review-submit';

const counts = { notes: 2, styled: 1 };

function setup(run: (jobId: string) => Promise<unknown>) {
  const store = createReviewDialogStore({ jobId: 'r1', session: 1 });
  const notify = vi.fn();
  const runSpy = vi.fn(run);
  return { store, notify, run: runSpy, deps: { store, run: runSpy, notify } };
}

describe('submitReview', () => {
  it('Send: runs the action for the job, closes the dialog and says what was sent', async () => {
    const { store, notify, run, deps } = setup(async () => ({}));
    await submitReview('send_notes', 'r1', counts, deps);
    expect(run).toHaveBeenCalledWith('r1');
    expect(store.getState()).toMatchObject({ jobId: null, submitting: null, submitError: null });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      'Sent 2 notes (1 saved to the client style). The job comes back to Review when the changes are done.',
    );
  });

  it('Approve: closes the dialog and says the final video is rendering', async () => {
    const { store, notify, deps } = setup(async () => ({}));
    await submitReview('approve', 'r1', { notes: 0, styled: 0 }, deps);
    expect(store.getState().jobId).toBeNull();
    expect(notify).toHaveBeenCalledWith(
      'Approved. The final video is rendering; the job shows Ready when it is done.',
    );
  });

  it('stayOpen: leaves the dialog open, tells onSubmitted first and shows no toast', async () => {
    const { store, notify, run } = setup(async () => ({}));
    const order: string[] = [];
    const onSubmitted = vi.fn(() => order.push(`submitted, ${store.getState().jobId} open`));
    await submitReview('send_notes', 'r1', counts, {
      store,
      run,
      onSubmitted,
      stayOpen: true,
    });
    expect(onSubmitted).toHaveBeenCalledOnce();
    expect(order).toEqual(['submitted, r1 open']);
    expect(store.getState()).toMatchObject({ jobId: 'r1', submitting: null, submitError: null });
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps the dialog open while the request is on its way', async () => {
    const answer = deferred();
    const { store, notify, deps } = setup(() => answer.promise);
    const done = submitReview('send_notes', 'r1', counts, deps);
    expect(store.getState()).toMatchObject({ jobId: 'r1', submitting: 'send_notes' });
    expect(notify).not.toHaveBeenCalled();
    answer.resolve();
    await done;
    expect(store.getState()).toMatchObject({ jobId: null, submitting: null });
  });

  it('keeps the dialog open with the server’s reason when the request is refused', async () => {
    const { store, notify, deps } = setup(() =>
      Promise.reject(new ApiError(409, 'Send or delete your notes first.')),
    );
    await submitReview('approve', 'r1', { notes: 0, styled: 0 }, deps);
    expect(store.getState()).toMatchObject({
      jobId: 'r1',
      submitting: null,
      submitError: 'Send or delete your notes first.',
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('uses the text of anything else that was thrown', async () => {
    const { store, deps } = setup(() => Promise.reject('plain text'));
    await submitReview('approve', 'r1', { notes: 0, styled: 0 }, deps);
    expect(store.getState().submitError).toBe('plain text');
  });

  it('does not run a second request while the first is in flight', async () => {
    const answer = deferred();
    const { run, deps } = setup(() => answer.promise);
    const first = submitReview('send_notes', 'r1', counts, deps);
    await submitReview('approve', 'r1', counts, deps);
    await submitReview('send_notes', 'r1', counts, deps);
    expect(run).toHaveBeenCalledOnce();
    answer.resolve();
    await first;
  });

  it('does nothing when the dialog is closed', async () => {
    const run = vi.fn(async () => ({}));
    const notify = vi.fn();
    const store = createReviewDialogStore();
    await submitReview('send_notes', 'r1', counts, { store, run, notify });
    expect(run).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('can be tried again after a refusal, and the error goes when it starts', async () => {
    let attempts = 0;
    const { store, notify, deps } = setup(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(409, 'Wait for the voice notes to be transcribed.');
    });
    await submitReview('send_notes', 'r1', counts, deps);
    expect(store.getState().submitError).toBe('Wait for the voice notes to be transcribed.');
    await submitReview('send_notes', 'r1', counts, deps);
    expect(store.getState()).toMatchObject({ jobId: null, submitError: null });
    expect(notify).toHaveBeenCalledOnce();
  });
});
