import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { matchingJobs } from './use-jobs-list';

const ids = (jobs: readonly { id: string }[]) => jobs.map((job) => job.id);

// Last updated first, as `lastUpdatedOrder` leaves them: a queued job, one in Review, a delivered
// one and an archived one, then another client's job in Review.
const ORDERED = [
  makeJob({ id: 'queued', state: 'queued' }),
  makeJob({ id: 'review', state: 'review', placeInLine: null }),
  makeJob({ id: 'ready', state: 'ready', name: 'Winter menu', placeInLine: null }),
  makeJob({
    id: 'archived',
    state: 'ready',
    placeInLine: null,
    archivedAt: '2026-10-19T10:00:00.000Z',
  }),
  makeJob({
    id: 'other',
    state: 'review',
    clientId: 'ffffffffffff',
    client: 'Other client',
    placeInLine: null,
  }),
];

const ALL = { tab: 'all', search: '', showArchived: false } as const;

describe('matchingJobs: the open job', () => {
  it('changes nothing when no job is open, or the open one is shown anyway', () => {
    expect(ids(matchingJobs(ORDERED, { ...ALL, tab: 'review' }))).toEqual(['review', 'other']);
    expect(ids(matchingJobs(ORDERED, { ...ALL, tab: 'review', openId: 'review' }))).toEqual([
      'review',
      'other',
    ]);
  });

  it('keeps the open job at its place when the tab leaves it out (approved from Review)', () => {
    expect(ids(matchingJobs(ORDERED, { ...ALL, tab: 'review', openId: 'ready' }))).toEqual([
      'review',
      'ready',
      'other',
    ]);
  });

  it('keeps it when the search leaves it out, and when it is archived with Show archived off', () => {
    expect(ids(matchingJobs(ORDERED, { ...ALL, search: 'winter', openId: 'queued' }))).toEqual([
      'queued',
      'ready',
    ]);
    expect(ids(matchingJobs(ORDERED, { ...ALL, openId: 'archived' }))).toEqual([
      'queued',
      'review',
      'ready',
      'archived',
      'other',
    ]);
  });

  it('keeps it on a client’s page, but never adds another client’s job there', () => {
    const page = { ...ALL, clientId: '1c9823704bf5' };
    expect(ids(matchingJobs(ORDERED, { ...page, openId: 'archived' }))).toEqual([
      'queued',
      'review',
      'ready',
      'archived',
    ]);
    expect(ids(matchingJobs(ORDERED, { ...page, openId: 'other' }))).toEqual([
      'queued',
      'review',
      'ready',
    ]);
  });

  it('adds nothing for an id that is no job', () => {
    expect(ids(matchingJobs(ORDERED, { ...ALL, tab: 'review', openId: 'gone' }))).toEqual([
      'review',
      'other',
    ]);
  });
});
