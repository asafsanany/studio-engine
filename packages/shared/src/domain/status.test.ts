import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  JOB_STATES,
  type JobState,
  type JobStatusGroup,
  jobStateSchema,
  STATUS_GROUPS,
  type StatusGroup,
  statusGroupSchema,
} from './status.ts';

describe('JobState', () => {
  it('lists the eight states in lifecycle order', () => {
    expect(JOB_STATES).toEqual([
      'arriving',
      'queued',
      'held',
      'editing',
      'review',
      'ready',
      'failed',
      'cancelled',
    ]);
  });

  it('accepts every state', () => {
    for (const state of JOB_STATES) expect(jobStateSchema.parse(state)).toBe(state);
  });

  it.each(['Queued', 'paused', 'done', '', null, undefined, 7])('rejects %j', (value) => {
    expect(jobStateSchema.safeParse(value).success).toBe(false);
  });

  it('infers a string-literal union', () => {
    expectTypeOf<JobState>().toEqualTypeOf<
      'arriving' | 'queued' | 'held' | 'editing' | 'review' | 'ready' | 'failed' | 'cancelled'
    >();
  });
});

describe('StatusGroup', () => {
  it('lists all, progress, review, approved, delivered, uploaded, paid, attention (in that order)', () => {
    expect(STATUS_GROUPS).toEqual([
      'all',
      'progress',
      'review',
      'approved',
      'delivered',
      'uploaded',
      'paid',
      'attention',
    ]);
  });

  it('accepts every group and rejects anything else', () => {
    for (const group of STATUS_GROUPS) expect(statusGroupSchema.parse(group)).toBe(group);
    for (const bad of ['In progress', 'needs-attention', '', 1, null]) {
      expect(statusGroupSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('infers the union, and a job group never includes all', () => {
    expectTypeOf<StatusGroup>().toEqualTypeOf<
      'all' | 'progress' | 'review' | 'approved' | 'delivered' | 'uploaded' | 'paid' | 'attention'
    >();
    expectTypeOf<JobStatusGroup>().toEqualTypeOf<
      'progress' | 'review' | 'approved' | 'delivered' | 'uploaded' | 'paid' | 'attention'
    >();
  });
});
