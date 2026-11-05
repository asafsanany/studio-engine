import { groupOf, JOB_STATES, type JobState } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { attentionLabel, countEngine, SUMMARY_ITEMS } from './engine-summary';

const jobs = (...states: JobState[]) => states.map((state) => ({ state, delivery: null }));

describe('countEngine', () => {
  it('is all zeros for no jobs', () => {
    expect(countEngine([])).toEqual({ editing: 0, queued: 0, review: 0, attention: 0 });
  });

  it('counts editing and queued jobs by exact state', () => {
    expect(countEngine(jobs('editing', 'queued', 'queued', 'ready'))).toEqual({
      editing: 1,
      queued: 2,
      review: 0,
      attention: 0,
    });
  });

  it('counts a review job only under review', () => {
    expect(countEngine(jobs('review', 'review', 'editing'))).toEqual({
      editing: 1,
      queued: 0,
      review: 2,
      attention: 0,
    });
  });

  it('counts held, failed and cancelled jobs as needing attention', () => {
    expect(countEngine(jobs('held', 'failed', 'cancelled', 'ready'))).toEqual({
      editing: 0,
      queued: 0,
      review: 0,
      attention: 3,
    });
  });

  it('does not count arriving or ready jobs in any counter', () => {
    expect(countEngine(jobs('arriving', 'ready', 'ready'))).toEqual({
      editing: 0,
      queued: 0,
      review: 0,
      attention: 0,
    });
  });

  it('does not count a ready job at any stage (approved, delivered or paid) in any counter', () => {
    const delivery = { deliveredAt: '2026-10-21T09:00:00.000Z', price: 40, currency: 'ILS' };
    const stages = [
      { state: 'ready' as const, delivery: null },
      { state: 'ready' as const, delivery: { ...delivery, paidOn: null } },
      { state: 'ready' as const, delivery: { ...delivery, paidOn: '2026-10-23' } },
    ];
    expect(countEngine(stages)).toEqual({ editing: 0, queued: 0, review: 0, attention: 0 });
  });

  it('matches the canvas example: 1 editing, 2 queued, 3 need attention', () => {
    const board = jobs(
      'arriving',
      'queued',
      'held',
      'queued',
      'editing',
      'ready',
      'failed',
      'cancelled',
      'ready',
    );
    expect(countEngine(board)).toEqual({ editing: 1, queued: 2, review: 0, attention: 3 });
  });

  it('attention always equals the size of the Needs attention group', () => {
    const everyState = jobs(...JOB_STATES, ...JOB_STATES);
    const inGroup = everyState.filter((job) => groupOf(job) === 'attention').length;
    expect(countEngine(everyState).attention).toBe(inGroup);
  });
});

describe('attentionLabel', () => {
  it('says "needs attention" for exactly one job', () => {
    expect(attentionLabel(1)).toBe('needs attention');
  });

  it('says "need attention" for none and for several', () => {
    expect(attentionLabel(0)).toBe('need attention');
    expect(attentionLabel(2)).toBe('need attention');
    expect(attentionLabel(3)).toBe('need attention');
    expect(attentionLabel(12)).toBe('need attention');
  });
});

describe('SUMMARY_ITEMS', () => {
  it('lists editing, queued, review and attention in that order', () => {
    expect(SUMMARY_ITEMS.map((item) => item.key)).toEqual([
      'editing',
      'queued',
      'review',
      'attention',
    ]);
  });

  it('switches editing and queued to In progress, review to Review, attention to Needs attention', () => {
    expect(SUMMARY_ITEMS.map((item) => item.tab)).toEqual([
      'progress',
      'progress',
      'review',
      'attention',
    ]);
  });

  it('uses the status colours: blue, grey, violet, red', () => {
    expect(SUMMARY_ITEMS.map((item) => item.dot)).toEqual([
      'bg-status-editing',
      'bg-status-neutral',
      'bg-status-review',
      'bg-status-failed',
    ]);
  });

  it('says "in review" whatever the count', () => {
    const review = SUMMARY_ITEMS.find((item) => item.key === 'review');
    expect([0, 1, 2].map((count) => review?.label(count))).toEqual([
      'in review',
      'in review',
      'in review',
    ]);
  });
});
