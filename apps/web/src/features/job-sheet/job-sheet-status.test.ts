import { describe, expect, it } from 'vitest';
import { clockTime, isDoneWith, sheetStatus } from './job-sheet-status';
import { jobSheetJobs } from './test-fixtures';

describe('sheetStatus', () => {
  it('says each state in a word, with the status colour', () => {
    const word = (state: keyof typeof jobSheetJobs) => sheetStatus(jobSheetJobs[state]);
    expect(word('arriving')).toMatchObject({ label: 'Arriving', dot: 'bg-status-neutral' });
    expect(word('queued')).toMatchObject({ label: 'Queued', dot: 'bg-status-neutral' });
    expect(word('held')).toMatchObject({ label: 'Held', dot: 'bg-status-held' });
    expect(word('editing')).toMatchObject({ label: 'Editing', dot: 'bg-status-editing' });
    expect(word('review')).toMatchObject({ label: 'Ready to review', dot: 'bg-status-review' });
    expect(word('failed')).toMatchObject({ label: 'Failed', dot: 'bg-status-failed' });
    expect(word('cancelled')).toMatchObject({ label: 'Cancelled', dot: 'bg-status-cancelled' });
  });

  it('says Uploaded, in violet, once a reel is linked to the delivered job', () => {
    const uploaded = {
      ...jobSheetJobs.delivered,
      delivery: { ...jobSheetJobs.delivered.delivery, uploadedAt: '2026-10-20T09:30:00.000Z' },
    } as typeof jobSheetJobs.delivered;
    expect(sheetStatus(uploaded)).toMatchObject({
      label: 'Uploaded',
      dot: 'bg-status-uploaded',
    });
    // A paid job stays Paid when a reel is linked to it.
    const paid = {
      ...jobSheetJobs.paid,
      delivery: { ...jobSheetJobs.paid.delivery, uploadedAt: '2026-10-20T09:30:00.000Z' },
    } as typeof jobSheetJobs.paid;
    expect(sheetStatus(paid).label).toBe('Paid');
  });

  it('says a ready job’s stage: Approved, Delivered, Paid', () => {
    expect(sheetStatus(jobSheetJobs.approved)).toMatchObject({
      label: 'Approved',
      dot: 'bg-status-ready',
    });
    expect(sheetStatus(jobSheetJobs.delivered)).toMatchObject({
      label: 'Delivered',
      dot: 'bg-status-delivered',
    });
    expect(sheetStatus(jobSheetJobs.paid)).toMatchObject({ label: 'Paid', dot: 'bg-status-paid' });
    // An archived job is still what it was.
    expect(sheetStatus(jobSheetJobs.archived).label).toBe('Paid');
  });

  it('says Rendering for an editing job on a render run, in the editing blue', () => {
    expect(sheetStatus(jobSheetJobs.rendering)).toEqual({
      label: 'Rendering',
      dot: 'bg-status-editing',
      round: null,
    });
    // A revise run is an edit.
    expect(sheetStatus({ ...jobSheetJobs.editing, runKind: 'revise', round: 1 }).label).toBe(
      'Editing',
    );
  });

  it('numbers the cut as the boards do: one round of notes sent is round 2, shown from there', () => {
    expect(sheetStatus(jobSheetJobs.review).round).toBeNull();
    expect(jobSheetJobs.reviewRound2.round).toBe(1);
    expect(sheetStatus(jobSheetJobs.reviewRound2)).toMatchObject({
      label: 'Ready to review',
      round: 'round 2',
    });
    expect(sheetStatus({ ...jobSheetJobs.review, round: 2 }).round).toBe('round 3');
  });

  it('shows no round outside review', () => {
    expect(sheetStatus({ ...jobSheetJobs.approved, round: 1 }).round).toBeNull();
    expect(sheetStatus({ ...jobSheetJobs.editing, round: 1 }).round).toBeNull();
  });
});

describe('isDoneWith', () => {
  it('is true for a paid job, whose name the sheet draws muted', () => {
    expect(isDoneWith(jobSheetJobs.paid)).toBe(true);
    expect(isDoneWith(jobSheetJobs.archived)).toBe(true);
  });

  it('is false for the rest, a delivered job included (it still has money to come)', () => {
    for (const state of ['arriving', 'review', 'failed', 'approved', 'delivered'] as const) {
      expect(isDoneWith(jobSheetJobs[state]), state).toBe(false);
    }
  });

  it('is false for an uploaded job: it still has money to come', () => {
    const uploaded = {
      ...jobSheetJobs.delivered,
      delivery: { ...jobSheetJobs.delivered.delivery, uploadedAt: '2026-10-20T09:30:00.000Z' },
    } as typeof jobSheetJobs.delivered;
    expect(isDoneWith(uploaded)).toBe(false);
  });

  it('is true for a video whose folder was deleted, as in the list', () => {
    expect(isDoneWith({ ...jobSheetJobs.delivered, folderDeleted: true } as never)).toBe(true);
  });
});

describe('clockTime', () => {
  it('is the hour and minute on a 24-hour clock, with two digits each', () => {
    expect(clockTime(new Date(2026, 9, 22, 14, 43, 59))).toBe('14:43');
    expect(clockTime(new Date(2026, 9, 22, 9, 5))).toBe('09:05');
    expect(clockTime(new Date(2026, 9, 22, 0, 0))).toBe('00:00');
  });
});
