import type { Job } from '@studio/shared';
import type { JobRepository } from '../db/index.js';
import type { EventBus } from './bus.js';

export interface QueuePlacesOptions {
  bus: EventBus;
  /** Only `getAll` is used, to read the queue as it is after a change. */
  jobs: Pick<JobRepository, 'getAll'>;
}

/**
 * Keeps `placeInLine` on screen true (A2).
 *
 * `placeInLine` is derived when a job is read, so when a job joins the queue ahead of others,
 * starts, is held, cancelled or removed, the jobs behind it move up without being written: no
 * write means no publish, and their rows on screen would still show the old place. This listens to
 * the bus and, whenever a job enters, leaves or moves in the queue, republishes (`job.upsert`) every
 * queued job whose place differs from what was last announced. The jobs are re-read, so the
 * upserts carry the current `placeInLine`, `etaSec` and the rest, with the same `updatedAt` (a
 * place in line is not an update).
 *
 * It sees every publisher at once (routes, worker, watcher, reconcile), so none of them has to
 * remember. An event about a job that is neither queued nor was in the queue costs nothing, which
 * keeps chatty progress events and ETA ticks cheap. Returns the function that stops it.
 *
 * What it relies on: a job that joins the queue is published (every writer does that anyway), so
 * the job is known as queued by the time it leaves. The jobs already queued when it is created are
 * read from the database.
 */
export function followQueuePlaces({ bus, jobs }: QueuePlacesOptions): () => void {
  // What the bus last said about each queued job's place. Seeded from the database; whatever the
  // boot changes after this (reconcile) is published, so it reaches the map as events.
  let announced = placesOf(jobs.getAll());

  function sync(changedJob: Job | null): void {
    const queued = jobs.getAll().filter((job) => job.state === 'queued');
    const before = announced;
    announced = placesOf(queued);

    const stale = queued
      .filter((job) => {
        // The event's own job was just announced with the place it carried.
        const told = job.id === changedJob?.id ? changedJob.placeInLine : before.get(job.id);
        return told !== job.placeInLine;
      })
      // Front of the queue first, whatever order `getAll` lists them in.
      .sort((a, b) => (a.placeInLine ?? 0) - (b.placeInLine ?? 0));
    // `announced` is already current, so these upserts coming back to this listener do nothing.
    for (const job of stale) bus.publish({ type: 'job.upsert', job });
  }

  return bus.subscribe((event) => {
    if (event.type === 'job.upsert') {
      const { job } = event;
      if (job.state === 'queued') {
        if (announced.get(job.id) !== job.placeInLine) sync(job);
      } else if (announced.has(job.id)) {
        sync(null);
      }
    } else if (event.type === 'job.remove' && announced.has(event.id)) {
      sync(null);
    }
  });
}

function placesOf(jobs: readonly Job[]): Map<string, number | null> {
  const places = new Map<string, number | null>();
  for (const job of jobs) {
    if (job.state === 'queued') places.set(job.id, job.placeInLine);
  }
  return places;
}
