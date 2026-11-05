import { type Job, SETTLE_MS, type ServerEvent } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { createEventBus } from './bus.js';
import { followQueuePlaces } from './queue-places.js';

// The real repository (so `placeInLine` is the real derived value) and a real bus. The test plays
// the part of the publishers: after each write it publishes the result, as the routes, the worker
// and the watcher do.

function setup() {
  const clock = fakeClock();
  const repo = new JobRepository(memoryDb(), { clock });
  const bus = createEventBus();
  const getAll = vi.fn(() => repo.getAll());
  const stop = followQueuePlaces({ bus, jobs: { getAll } });
  const seen: ServerEvent[] = [];
  bus.subscribe((event) => seen.push(event));

  const upsert = (job: Job): Job => {
    bus.publish({ type: 'job.upsert', job });
    return job;
  };
  const queue = (name: string): Job => {
    clock.tick();
    const { job } = repo.upsertFromScan(makeScan('Northwind Bakery', name));
    return upsert(repo.applyTransition(job.id, { type: 'SETTLED' }));
  };
  const apply = (job: Job, event: Parameters<JobRepository['applyTransition']>[1]): Job => {
    clock.tick();
    return upsert(repo.applyTransition(job.id, event));
  };
  /** The events seen since the last call, as `name:state:place`. */
  const drain = (): string[] => {
    const lines = seen.map((event) =>
      event.type === 'job.upsert'
        ? `${event.job.name}:${event.job.state}:${event.job.placeInLine ?? '-'}`
        : event.type === 'job.remove'
          ? `remove:${event.id}`
          : 'hello',
    );
    seen.length = 0;
    return lines;
  };
  return { clock, repo, bus, getAll, stop, queue, apply, drain, upsert, seen };
}

describe('followQueuePlaces', () => {
  it('republishes the jobs behind the one that started, with their new places', () => {
    const { queue, apply, drain } = setup();
    const a = queue('A');
    queue('B');
    queue('C');
    drain();

    apply(a, { type: 'START' });

    expect(drain()).toEqual(['A:editing:-', 'B:queued:1', 'C:queued:2']);
  });

  it('republishes the jobs behind a queued job that is held', () => {
    const { queue, apply, drain } = setup();
    queue('A');
    const b = queue('B');
    queue('C');
    drain();

    apply(b, { type: 'HOLD' });

    // A keeps place 1 and is not republished.
    expect(drain()).toEqual(['B:held:-', 'C:queued:2']);
  });

  it('republishes the jobs behind a queued job whose files changed, which sends it back to arriving', () => {
    const { queue, apply, drain } = setup();
    const a = queue('A');
    queue('B');
    drain();

    apply(a, { type: 'FILES_CHANGED' });

    expect(drain()).toEqual(['A:arriving:-', 'B:queued:1']);
  });

  it('puts a released job at the end of the queue and leaves the others as they are', () => {
    const { clock, queue, apply, drain } = setup();
    queue('A');
    const b = queue('B');
    const held = apply(b, { type: 'HOLD' });
    drain();

    // Release queues the job at once when its folder has been quiet for the settle time.
    clock.tick(SETTLE_MS);
    apply(held, { type: 'RELEASE' });

    expect(drain()).toEqual(['B:queued:2']);
  });

  it('republishes the jobs behind a queued job whose folder was removed', () => {
    const { repo, bus, queue, drain } = setup();
    const a = queue('A');
    queue('B');
    queue('C');
    drain();

    repo.remove(a.id);
    bus.publish({ type: 'job.remove', id: a.id });

    expect(drain()).toEqual([`remove:${a.id}`, 'B:queued:1', 'C:queued:2']);
  });

  it('sends the republished jobs as the repository has them now, without an update', () => {
    const { repo, queue, apply, seen } = setup();
    const a = queue('A');
    const b = queue('B');
    const updatedBefore = repo.get(b.id)?.updatedAt;
    seen.length = 0;

    apply(a, { type: 'START' });

    const republished = seen.find((event) => event.type === 'job.upsert' && event.job.id === b.id);
    expect(republished).toEqual({ type: 'job.upsert', job: repo.get(b.id) });
    // A place in line is not an update: `updatedAt` is the one the job had.
    expect(repo.get(b.id)?.placeInLine).toBe(1);
    expect(repo.get(b.id)?.updatedAt).toBe(updatedBefore);
  });

  it('says nothing more when a job joins the end of the queue', () => {
    const { queue, drain } = setup();
    queue('A');
    drain();

    queue('B');

    expect(drain()).toEqual(['B:queued:2']);
  });

  it('says nothing about jobs that never were in the queue', () => {
    const { queue, apply, repo, drain } = setup();
    queue('A');
    const { job } = repo.upsertFromScan(makeScan('Northwind Bakery', 'Arriving'));
    drain();

    apply(job, { type: 'FILES_CHANGED' });

    expect(drain()).toEqual(['Arriving:arriving:-']);
  });

  it('does not touch the database for events that cannot move the queue', () => {
    const { queue, apply, getAll, drain } = setup();
    const a = queue('A');
    queue('B');
    const started = apply(a, { type: 'START' });
    drain();
    getAll.mockClear();

    // Chatty progress of the running job, and an ETA tick that repeats the same place for a queued one.
    for (let i = 1; i <= 20; i += 1) {
      apply(started, { type: 'PROGRESS', step: 4, sub: `${i}/20` });
    }
    const b = [...new Set(drain())].filter((line) => line.startsWith('B'));
    expect(b).toEqual([]);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('does not republish when an ETA tick repeats a queued job with the place it has', () => {
    const { repo, bus, queue, getAll, drain } = setup();
    queue('A');
    const b = queue('B');
    drain();
    getAll.mockClear();

    const tick = repo.get(b.id) as Job;
    bus.publish({ type: 'job.upsert', job: { ...tick, etaSec: 120 } });

    expect(drain()).toEqual(['B:queued:2']);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('corrects a job published with a place that is out of date', () => {
    const { repo, bus, queue, apply, drain } = setup();
    const a = queue('A');
    const b = queue('B');
    const staleB = repo.get(b.id) as Job; // place 2
    apply(a, { type: 'START' });
    drain();

    // A late publisher still holds B as it was.
    bus.publish({ type: 'job.upsert', job: staleB });

    expect(drain()).toEqual(['B:queued:2', 'B:queued:1']);
  });

  it('starts from the queue the database already has', () => {
    const clock = fakeClock();
    const repo = new JobRepository(memoryDb(), { clock });
    const queued: Job[] = [];
    for (const name of ['A', 'B', 'C']) {
      clock.tick();
      const { job } = repo.upsertFromScan(makeScan('Northwind Bakery', name));
      queued.push(repo.applyTransition(job.id, { type: 'SETTLED' }));
    }
    const bus = createEventBus();
    followQueuePlaces({ bus, jobs: repo });
    const seen: Job[] = [];
    bus.subscribe((event) => {
      if (event.type === 'job.upsert') seen.push(event.job);
    });

    clock.tick();
    const [first] = queued;
    bus.publish({
      type: 'job.upsert',
      job: repo.applyTransition((first as Job).id, { type: 'START' }),
    });

    expect(seen.map((job) => `${job.name}:${job.placeInLine ?? '-'}`)).toEqual([
      'A:-',
      'B:1',
      'C:2',
    ]);
  });

  it('settles: the republished jobs do not start another round', () => {
    const { queue, apply, getAll, drain } = setup();
    const a = queue('A');
    queue('B');
    queue('C');
    drain();
    getAll.mockClear();

    apply(a, { type: 'START' });

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(drain()).toHaveLength(3);
  });

  it('stops when told to', () => {
    const { queue, apply, stop, drain, bus } = setup();
    const a = queue('A');
    queue('B');
    drain();

    stop();
    apply(a, { type: 'START' });

    expect(drain()).toEqual(['A:editing:-']);
    expect(bus.listenerCount()).toBe(1); // the test's own
  });
});
