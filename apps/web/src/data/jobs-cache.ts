// The pure rules for the cached job list (query key ['jobs']). Nothing here touches React, the
// network or the query client, so the rules are tested on plain arrays.
//
// Order: the cache keeps the server's order, newest `updatedAt` first, which is what
// `GET /api/jobs` returns. A job that changes `updatedAt` moves to where the new time puts it;
// a job whose `updatedAt` stays (an ETA or place-in-line tick) is replaced in place. Jobs with the
// same `updatedAt` keep their relative order, and a newcomer goes after them. The table sorts by
// its own state anyway; this order only matters to code that reads the list as it is.

import type { Job } from '@studio/shared';

/** The TanStack Query key of the full job list. */
export const JOBS_KEY = ['jobs'] as const;

function time(job: Pick<Job, 'updatedAt'>): number {
  return Date.parse(job.updatedAt);
}

/** `job` replaces the job with the same id, or is inserted when the list has none. */
export function upsertJob(list: readonly Job[], job: Job): Job[] {
  const index = list.findIndex((existing) => existing.id === job.id);
  const existing = index === -1 ? undefined : list[index];

  if (existing !== undefined && time(existing) === time(job)) {
    // Same position in the order: swap it where it stands.
    const next = list.slice();
    next[index] = job;
    return next;
  }

  const others = existing === undefined ? list.slice() : list.filter((j) => j.id !== job.id);
  const at = others.findIndex((other) => time(other) < time(job));
  others.splice(at === -1 ? others.length : at, 0, job);
  return others;
}

/** The list without the job `id`. A new array even when `id` is not in it. */
export function removeJob(list: readonly Job[], id: string): Job[] {
  return list.filter((job) => job.id !== id);
}

/** The job `id` in `list`, if any. */
export function findJob(list: readonly Job[] | undefined, id: string): Job | undefined {
  return list?.find((job) => job.id === id);
}

function compare<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The queue's order: the job that joined it first runs first; `addedAt` and `id` break ties. */
function queueOrder(a: Job, b: Job): number {
  const joined = (job: Job) => (job.settledAt === null ? Infinity : Date.parse(job.settledAt));
  return (
    compare(joined(a), joined(b)) ||
    compare(Date.parse(a.addedAt), Date.parse(b.addedAt)) ||
    compare(a.id, b.id)
  );
}

/**
 * The list with every queued job's `placeInLine` worked out again from the queue order (the
 * server's: `settledAt`, then `addedAt`, then id). For an optimistic change that puts a job
 * somewhere in the middle of the queue, where the cached places of the others would be stale.
 * Jobs that are not queued, and queued jobs whose place does not change, are the same objects.
 */
export function withQueuePlaces(list: readonly Job[]): Job[] {
  const queued = list.filter((job) => job.state === 'queued').sort(queueOrder);
  const place = new Map(queued.map((job, index) => [job.id, index + 1]));
  return list.map((job) => {
    const next = place.get(job.id);
    return next === undefined || job.placeInLine === next ? job : { ...job, placeInLine: next };
  });
}
