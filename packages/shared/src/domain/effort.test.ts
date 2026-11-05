import { describe, expect, it } from 'vitest';
import { saveEffortRequestSchema } from './api.ts';
import {
  canEditEffort,
  DEFAULT_EFFORT,
  EFFORT_EDITABLE_STATES,
  EFFORT_LABELS,
  EFFORT_LEVELS,
  effortLabel,
  effortSchema,
  runEffort,
} from './effort.ts';
import { jobSchema } from './job.ts';
import { canEditNote } from './note.ts';
import { JOB_STATES } from './status.ts';
import { makeJob } from './test-fixtures.ts';

describe('the effort levels', () => {
  it('are Medium, High and Extra high, lowest first (Low and Max are not offered)', () => {
    expect(EFFORT_LEVELS).toEqual(['medium', 'high', 'xhigh']);
  });

  it('parse, and nothing else does, Low and Max included', () => {
    for (const level of EFFORT_LEVELS) expect(effortSchema.parse(level)).toBe(level);
    for (const bad of ['', 'default', 'low', 'max', 'Max', 'ultra', 3, null, undefined]) {
      expect(effortSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('have a label each, and Default is no level', () => {
    expect(EFFORT_LABELS).toEqual({ medium: 'Medium', high: 'High', xhigh: 'Extra high' });
    expect(effortLabel(null)).toBe('Default');
    expect(effortLabel('xhigh')).toBe('Extra high');
  });
});

describe('the default effort', () => {
  it('is Extra high, one of the levels', () => {
    expect(DEFAULT_EFFORT).toBe('xhigh');
    expect(EFFORT_LEVELS).toContain(DEFAULT_EFFORT);
  });

  it('is what a job with no level runs at, and a job’s own level is kept', () => {
    expect(runEffort(null)).toBe('xhigh');
    expect(runEffort('medium')).toBe('medium');
    expect(runEffort('high')).toBe('high');
    expect(runEffort('xhigh')).toBe('xhigh');
  });
});

describe('canEditEffort', () => {
  it('is true while the next run has not started: the note’s states, and review', () => {
    for (const state of JOB_STATES) {
      expect(canEditEffort({ state }), state).toBe(canEditNote({ state }) || state === 'review');
    }
    expect([...EFFORT_EDITABLE_STATES]).toEqual([
      'arriving',
      'queued',
      'held',
      'review',
      'failed',
      'cancelled',
    ]);
  });

  it('is true in review, so the fixes can be asked for at another level', () => {
    expect(canEditEffort({ state: 'review' })).toBe(true);
    // The note is not: the review dialog takes notes instead.
    expect(canEditNote({ state: 'review' })).toBe(false);
  });

  it.each(['editing', 'ready'] as const)('is false for a %s job', (state) => {
    expect(canEditEffort({ state })).toBe(false);
  });
});

describe('a job’s effort', () => {
  it('is null (Default) or a level', () => {
    expect(jobSchema.parse(makeJob()).effort).toBeNull();
    expect(jobSchema.parse(makeJob({ effort: 'high' })).effort).toBe('high');
    expect(jobSchema.safeParse(makeJob({ effort: 'ultra' as never })).success).toBe(false);
    const { effort: _effort, ...without } = makeJob();
    expect(jobSchema.safeParse(without).success).toBe(false);
  });

  it('is saved with { effort: level | null }', () => {
    expect(saveEffortRequestSchema.parse({ effort: 'xhigh' })).toEqual({ effort: 'xhigh' });
    expect(saveEffortRequestSchema.parse({ effort: null })).toEqual({ effort: null });
    expect(saveEffortRequestSchema.safeParse({}).success).toBe(false);
    expect(saveEffortRequestSchema.safeParse({ effort: 'default' }).success).toBe(false);
    expect(saveEffortRequestSchema.safeParse({ effort: 'max' }).success).toBe(false);
    expect(saveEffortRequestSchema.safeParse({ effort: 'low' }).success).toBe(false);
  });
});
