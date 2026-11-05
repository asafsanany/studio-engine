import type { Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { byClientOrder } from './by-client';
import { matchingJobs } from './use-jobs-list';

const NOW = '2026-10-22T12:00:00.000Z';

/** A job of a client, last updated `minutes` before NOW. */
function job(id: string, clientId: string, minutes: number, overrides: Partial<Job> = {}): Job {
  return makeJob({
    id,
    clientId,
    client: `Client ${clientId}`,
    name: `Job ${id}`,
    state: 'ready',
    updatedAt: new Date(Date.parse(NOW) - minutes * 60_000).toISOString(),
    ...overrides,
  });
}

// In the order the list gives them: last updated first.
const JOBS = [
  job('b1', 'b', 5),
  job('a1', 'a', 20),
  job('b2', 'b', 30),
  job('c1', 'c', 40),
  job('a2', 'a', 50),
];

describe('byClientOrder', () => {
  it('lists the jobs client by client, the clients by their latest activity', () => {
    expect(byClientOrder(JOBS).map((j) => j.id)).toEqual(['b1', 'b2', 'a1', 'a2', 'c1']);
  });

  it('keeps the order the jobs came in inside a client', () => {
    const jobs = [job('a2', 'a', 5), job('b1', 'b', 10), job('a1', 'a', 20)];
    expect(byClientOrder(jobs).map((j) => j.id)).toEqual(['a2', 'a1', 'b1']);
  });

  it('is the same order again when it is applied twice', () => {
    const once = byClientOrder(JOBS);
    expect(byClientOrder(once)).toEqual(once);
  });

  it('is empty for no jobs', () => {
    expect(byClientOrder([])).toEqual([]);
  });
});

describe('matchingJobs: By client', () => {
  const base = { tab: 'all', search: '', showArchived: false } as const;

  it('is the list as it is while By client is off', () => {
    expect(matchingJobs(JOBS, base).map((j) => j.id)).toEqual(['b1', 'a1', 'b2', 'c1', 'a2']);
  });

  it('puts the jobs client by client while it is on', () => {
    expect(matchingJobs(JOBS, { ...base, byClient: true }).map((j) => j.id)).toEqual([
      'b1',
      'b2',
      'a1',
      'a2',
      'c1',
    ]);
  });

  it('groups only the jobs the search leaves, and orders the clients by those', () => {
    // Client A's newest job is "a1", which the search leaves out: "a2" puts A last.
    const jobs = JOBS.map((j) => (j.id === 'a1' ? { ...j, name: 'Teaser' } : j));
    const found = matchingJobs(jobs, { ...base, search: 'Job', byClient: true });
    expect(found.map((j) => j.id)).toEqual(['b1', 'b2', 'c1', 'a2']);
  });

  it("leaves a client's own page in the order it has: By client does not apply", () => {
    const found = matchingJobs(JOBS, { ...base, clientId: 'b', byClient: true });
    expect(found.map((j) => j.id)).toEqual(['b1', 'b2']);
    const mixed = matchingJobs(JOBS, { ...base, clientId: 'a', byClient: true });
    expect(mixed.map((j) => j.id)).toEqual(['a1', 'a2']);
  });
});
