import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import {
  JOB_SHEET_STATES,
  type JobSheetState,
  jobSheetJobs,
  jobSheetList,
  jobSheetNow,
} from '@/features/job-sheet/test-fixtures';
import {
  type PhonePill,
  phoneMeta,
  phoneNextStep,
  phonePill,
  phoneSteps,
  segmentClasses,
} from './phone-sheet';

const UTC = 'UTC';
const MINUTE = 60_000;

describe('phonePill', () => {
  const EXPECTED: Record<JobSheetState, Pick<PhonePill, 'label' | 'tone'>> = {
    arriving: { label: 'Arriving', tone: 'default' },
    queued: { label: 'Queued · #1 in line', tone: 'default' },
    held: { label: 'Held', tone: 'amber' },
    editing: { label: 'Editing', tone: 'default' },
    failed: { label: 'Failed at Render', tone: 'red' },
    cancelled: { label: 'Cancelled at Cut', tone: 'default' },
    review: { label: 'Ready to review', tone: 'default' },
    reviewRound2: { label: 'Ready to review', tone: 'default' },
    rendering: { label: 'Rendering', tone: 'default' },
    approved: { label: 'Approved', tone: 'default' },
    delivered: { label: 'Delivered', tone: 'default' },
    paid: { label: 'Paid', tone: 'muted' },
    archived: { label: 'Paid', tone: 'muted' },
  };

  for (const state of JOB_SHEET_STATES) {
    it(`${state}: ${EXPECTED[state].label}`, () => {
      expect(phonePill(jobSheetJobs[state])).toMatchObject(EXPECTED[state]);
    });
  }

  it('says Uploaded, in the violet dot and the normal tone, once a reel is linked to the job', () => {
    const job = jobSheetJobs.delivered;
    const uploaded = {
      ...job,
      delivery: job.delivery && { ...job.delivery, uploadedAt: '2026-10-20T09:30:00.000Z' },
    };
    expect(phonePill(uploaded)).toMatchObject({
      label: 'Uploaded',
      dot: 'bg-status-uploaded',
      tone: 'default',
    });
  });

  it('uses the Mac header’s dot colours', () => {
    expect(phonePill(jobSheetJobs.failed).dot).toBe('bg-status-failed');
    expect(phonePill(jobSheetJobs.held).dot).toBe('bg-status-held');
    expect(phonePill(jobSheetJobs.editing).dot).toBe('bg-status-editing');
  });

  it('keeps the bare word when a queued, failed or stopped job names no place or step', () => {
    expect(phonePill(makeJob({ state: 'queued', placeInLine: null })).label).toBe('Queued');
    expect(phonePill(makeJob({ state: 'failed', failedAt: null })).label).toBe('Failed');
    expect(phonePill(makeJob({ state: 'cancelled', stoppedAt: null })).label).toBe('Cancelled');
  });
});

describe('phoneMeta', () => {
  const meta = (state: JobSheetState) =>
    phoneMeta(jobSheetJobs[state], jobSheetList, jobSheetNow[state], UTC);

  it('counts down an arriving job’s settle timer', () => {
    expect(meta('arriving')).toBe('settles in 0:42');
  });

  it('names the job a queued job waits for', () => {
    expect(meta('queued')).toBe('Starts after חנוכה 2026');
    const alone = jobSheetJobs.queued;
    expect(phoneMeta(alone, [alone], jobSheetNow.queued, UTC)).toBe('Starts next');
  });

  it('says how long ago a held, failed or stopped job last changed', () => {
    for (const state of ['held', 'failed', 'cancelled'] as const) {
      const job = jobSheetJobs[state];
      const now = Date.parse(job.updatedAt) + 3 * MINUTE;
      expect(phoneMeta(job, jobSheetList, now, UTC), state).toBe('3 min ago');
    }
  });

  it('says the time left of an edit, and of the render after Approve', () => {
    expect(meta('editing')).toBe('~4 min left');
    expect(meta('rendering')).toBe('approved · ~1 min left');
  });

  it('gives a cut in review its length and frame size, and its round once notes were sent', () => {
    expect(meta('review')).toBe('0:44 · 1080×1920');
    expect(meta('reviewRound2')).toBe('0:41 · 1080×1920 · round 2');
  });

  it('gives an approved job its length, frame size and file size', () => {
    expect(meta('approved')).toBe('0:30 · 1080×1920 · 27 MB');
  });

  it('gives a delivered job its delivery line, and a paid one its payment', () => {
    expect(meta('delivered')).toBe('Delivered 21 Oct · ₪40 not paid');
    expect(meta('paid')).toBe('Paid 21 Oct · ₪40');
  });

  it('says when the reel was posted, in place of Delivered, for an uploaded job', () => {
    const job = jobSheetJobs.delivered;
    const uploaded = {
      ...job,
      delivery: job.delivery && { ...job.delivery, uploadedAt: '2026-10-20T09:30:00.000Z' },
    };
    expect(phoneMeta(uploaded, jobSheetList, jobSheetNow.delivered, UTC)).toBe(
      'Posted Tue 20 Oct · ₪40 not paid',
    );
  });

  it('says "Today" for a video delivered today and not paid yet, as the Delivered board has it', () => {
    const job = jobSheetJobs.delivered;
    const delivery = job.delivery;
    if (delivery === null) throw new Error('the delivered fixture has a delivery');
    const now = Date.parse(delivery.deliveredAt) + 3 * 60 * MINUTE;
    expect(phoneMeta(job, jobSheetList, now, UTC)).toBe('Today · ₪40 not paid');
    // The next day it is a date again; and a paid video keeps its payment day, never "Today".
    expect(phoneMeta(job, jobSheetList, now + 24 * 60 * MINUTE, UTC)).toBe(
      'Delivered 21 Oct · ₪40 not paid',
    );
    const paid = { ...job, delivery: { ...delivery, paidOn: '2026-10-21' } };
    expect(phoneMeta(paid, jobSheetList, now, UTC)).toBe('Paid 21 Oct · ₪40');
  });

  it('adds when an archived job was archived', () => {
    expect(meta('archived')).toBe('Paid 28 Sep · ₪40 · Archived 30 Sep');
  });
});

describe('phoneSteps', () => {
  it('has the editing job on its step: the segments before it solid, its own lighter', () => {
    const steps = phoneSteps(jobSheetJobs.editing);
    expect(steps).toEqual({
      done: 4,
      mark: 'running',
      text: 'Cut · graphics 2/5 · step 5 of 8',
    });
    expect(
      segmentClasses(steps ?? { done: 0, mark: null, text: '' }).map((s) => s.className),
    ).toEqual([
      'bg-status-editing',
      'bg-status-editing',
      'bg-status-editing',
      'bg-status-editing',
      'bg-status-editing/45',
      'bg-muted',
      'bg-muted',
      'bg-muted',
    ]);
  });

  it('has the render run on the last step', () => {
    expect(phoneSteps(jobSheetJobs.rendering)).toEqual({
      done: 7,
      mark: 'running',
      text: 'Render · step 8 of 8',
    });
  });

  it('says how far a failed job got, and shows where it stopped in red', () => {
    const steps = phoneSteps(jobSheetJobs.failed);
    expect(steps).toEqual({ done: 7, mark: 'failed', text: '7 of 8 done, stopped at Render' });
    const classes = segmentClasses(steps ?? { done: 0, mark: null, text: '' }).map(
      (s) => s.className,
    );
    expect(classes.slice(0, 7)).toEqual(Array(7).fill('bg-status-editing'));
    expect(classes[7]).toBe('bg-status-failed');
  });

  it('says where a stopped job stopped, in grey', () => {
    const steps = phoneSteps(jobSheetJobs.cancelled);
    expect(steps).toEqual({ done: 4, mark: 'stopped', text: '4 of 8 done, stopped at Cut' });
    expect(segmentClasses(steps ?? { done: 0, mark: null, text: '' })[4]?.className).toBe(
      'bg-zinc-500',
    );
  });

  it('starts an editing job that has no step yet at the first segment', () => {
    expect(phoneSteps(makeJob({ state: 'editing', step: null }))).toEqual({
      done: 0,
      mark: 'running',
      text: 'Starting the edit',
    });
  });

  it('has none for a job that is in no run, or that stopped without naming a step', () => {
    for (const state of [
      'arriving',
      'queued',
      'held',
      'review',
      'reviewRound2',
      'approved',
      'delivered',
      'paid',
      'archived',
    ] as const) {
      expect(phoneSteps(jobSheetJobs[state]), state).toBeNull();
    }
    expect(phoneSteps(makeJob({ state: 'failed', failedAt: null }))).toBeNull();
    expect(phoneSteps(makeJob({ state: 'cancelled', stoppedAt: null }))).toBeNull();
  });
});

describe('phoneNextStep', () => {
  const label = (state: JobSheetState) => phoneNextStep(jobSheetJobs[state])?.label ?? null;

  it('is the Mac’s next step, with its label', () => {
    expect(label('arriving')).toBe('Start now');
    expect(label('held')).toBe('Release');
    expect(label('failed')).toBe('Retry from Render');
    expect(label('cancelled')).toBe('Resume');
  });

  it('is Share video for an approved job (Mobile 4), and Mark paid… for a delivered one', () => {
    expect(phoneNextStep(jobSheetJobs.approved)).toEqual({ kind: 'share', label: 'Share video' });
    expect(label('delivered')).toBe('Mark paid…');
  });

  it('is Mark paid… for an uploaded job too', () => {
    const job = jobSheetJobs.delivered;
    const uploaded = {
      ...job,
      delivery: job.delivery && { ...job.delivery, uploadedAt: '2026-10-20T09:30:00.000Z' },
    };
    expect(phoneNextStep(uploaded)?.label).toBe('Mark paid…');
  });

  it('is Review for a job in review (it opens the phone Review), in every round', () => {
    expect(label('review')).toBe('Review');
    expect(label('reviewRound2')).toBe('Review');
  });

  it('is Share video for an archived approved job too, as the Mac’s is Mark delivered', () => {
    const archived = { ...jobSheetJobs.approved, archivedAt: '2026-10-20T09:00:00.000Z' };
    expect(phoneNextStep(archived)?.kind).toBe('share');
  });

  it('is none for a job that moves by itself or is paid', () => {
    for (const state of ['queued', 'editing', 'rendering', 'paid', 'archived'] as const) {
      expect(label(state), state).toBeNull();
    }
  });
});
