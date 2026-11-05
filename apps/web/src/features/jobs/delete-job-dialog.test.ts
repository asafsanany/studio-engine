import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { createDeleteDialogStore } from './delete-job-dialog';
import { rowMenuEntries, withDeleteEntry } from './row-menu';

describe('Delete… in the row menu', () => {
  it('ends the menu, after a line, in red', () => {
    const job = makeJob();
    const base = rowMenuEntries(job, { run: () => {}, busy: false });
    const entries = withDeleteEntry(job, base);
    expect(entries.slice(0, base.length)).toEqual(base);
    expect(entries.slice(-2).map((entry) => entry.id)).toEqual(['delete-separator', 'delete']);
    const last = entries.at(-1);
    expect(last).toMatchObject({ label: 'Delete…', destructive: true });
  });

  it('asks, shows a failure, and closes', () => {
    const store = createDeleteDialogStore();
    const job = makeJob();
    store.getState().ask(job);
    expect(store.getState().job?.id).toBe(job.id);
    store.getState().setPending(true);
    store.getState().fail('nope');
    expect(store.getState()).toMatchObject({ pending: false, error: 'nope' });
    store.getState().dismiss();
    expect(store.getState().job).toBeNull();
  });
});
