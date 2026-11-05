import { describe, expect, it } from 'vitest';
import { sheetState } from './job-sheet-state';
import { jobSheetJobs, jobSheetList } from './test-fixtures';

const failed = jobSheetJobs.failed;

describe('sheetState', () => {
  it('is closed with no job in the address', () => {
    expect(
      sheetState({ openId: null, jobs: jobSheetList, listComplete: true, seenId: null }),
    ).toEqual({ kind: 'closed' });
  });

  it('opens the job when the list holds it', () => {
    expect(
      sheetState({ openId: failed.id, jobs: jobSheetList, listComplete: true, seenId: null }),
    ).toEqual({ kind: 'open', job: failed });
  });

  it('opens a job the list’s tab or search leaves out: it is looked up in every job', () => {
    expect(
      sheetState({ openId: failed.id, jobs: [failed], listComplete: false, seenId: null }).kind,
    ).toBe('open');
  });

  it('waits for the list when it has not arrived (a reload)', () => {
    expect(
      sheetState({ openId: failed.id, jobs: undefined, listComplete: false, seenId: null }),
    ).toEqual({ kind: 'waiting' });
    // Even for a job the host showed: no list is not "gone".
    expect(
      sheetState({ openId: failed.id, jobs: undefined, listComplete: false, seenId: failed.id }),
    ).toEqual({ kind: 'waiting' });
  });

  it('is unknown for an id the list never held, once the list is whole', () => {
    expect(
      sheetState({ openId: 'nope', jobs: jobSheetList, listComplete: true, seenId: null }),
    ).toEqual({ kind: 'unknown' });
    expect(
      sheetState({ openId: 'nope', jobs: jobSheetList, listComplete: true, seenId: failed.id }),
    ).toEqual({ kind: 'unknown' });
  });

  it('does not call an id unknown while the list is still coming in (the videos without a folder)', () => {
    expect(
      sheetState({ openId: 'nope', jobs: jobSheetList, listComplete: false, seenId: null }),
    ).toEqual({ kind: 'waiting' });
  });

  it('is gone for a job the host had open that left the list', () => {
    const without = jobSheetList.filter((job) => job.id !== failed.id);
    expect(
      sheetState({ openId: failed.id, jobs: without, listComplete: true, seenId: failed.id }),
    ).toEqual({ kind: 'gone' });
    // Gone does not wait for the rest of the list.
    expect(
      sheetState({ openId: failed.id, jobs: without, listComplete: false, seenId: failed.id }),
    ).toEqual({ kind: 'gone' });
  });
});
