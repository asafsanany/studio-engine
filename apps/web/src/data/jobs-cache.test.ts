import { describe, expect, it } from 'vitest';
import { findJob, JOBS_KEY, removeJob, upsertJob, withQueuePlaces } from './jobs-cache';
import { makeJob } from './test-utils';

const newest = makeJob({ id: 'c', updatedAt: '2026-10-20T15:00:00.000Z' });
const middle = makeJob({ id: 'b', updatedAt: '2026-10-20T14:00:00.000Z' });
const oldest = makeJob({ id: 'a', updatedAt: '2026-10-20T13:00:00.000Z' });
const list = [newest, middle, oldest];

describe('upsertJob', () => {
  it('uses the key the server list is cached under', () => {
    expect(JOBS_KEY).toEqual(['jobs']);
  });

  it('replaces a job in place when its updatedAt did not change (an ETA or place-in-line tick)', () => {
    const tick = { ...middle, etaSec: 90 };
    expect(upsertJob(list, tick)).toEqual([newest, tick, oldest]);
  });

  it('moves a job to where its new updatedAt puts it', () => {
    const touched = { ...oldest, state: 'held' as const, updatedAt: '2026-10-20T16:00:00.000Z' };
    expect(upsertJob(list, touched).map((j) => j.id)).toEqual(['a', 'c', 'b']);
  });

  it('inserts a new job by updatedAt, newest first', () => {
    const fresh = makeJob({ id: 'd', updatedAt: '2026-10-20T14:30:00.000Z' });
    expect(upsertJob(list, fresh).map((j) => j.id)).toEqual(['c', 'd', 'b', 'a']);
    const newer = makeJob({ id: 'e', updatedAt: '2026-10-20T17:00:00.000Z' });
    expect(upsertJob(list, newer).map((j) => j.id)).toEqual(['e', 'c', 'b', 'a']);
    const older = makeJob({ id: 'f', updatedAt: '2026-10-20T12:00:00.000Z' });
    expect(upsertJob(list, older).map((j) => j.id)).toEqual(['c', 'b', 'a', 'f']);
  });

  it('puts a newcomer with the same updatedAt after the jobs that were there', () => {
    const same = makeJob({ id: 'g', updatedAt: middle.updatedAt });
    expect(upsertJob(list, same).map((j) => j.id)).toEqual(['c', 'b', 'g', 'a']);
  });

  it('inserts into an empty list', () => {
    expect(upsertJob([], oldest)).toEqual([oldest]);
  });

  it('compares times, not strings (a timestamp without milliseconds)', () => {
    const plain = makeJob({ id: 'h', updatedAt: '2026-10-20T14:00:01Z' });
    expect(upsertJob(list, plain).map((j) => j.id)).toEqual(['c', 'h', 'b', 'a']);
  });

  it('never modifies the list it is given', () => {
    const frozen = Object.freeze([...list]);
    expect(() => upsertJob(frozen, { ...middle, etaSec: 1 })).not.toThrow();
    expect(() => upsertJob(frozen, makeJob({ id: 'z' }))).not.toThrow();
    expect(frozen).toEqual(list);
  });
});

describe('removeJob', () => {
  it('drops the job by id', () => {
    expect(removeJob(list, 'b')).toEqual([newest, oldest]);
  });

  it('returns an equal list when the id is not there', () => {
    expect(removeJob(list, 'nope')).toEqual(list);
  });
});

describe('findJob', () => {
  it('finds a job by id and tolerates no list', () => {
    expect(findJob(list, 'b')).toBe(middle);
    expect(findJob(list, 'nope')).toBeUndefined();
    expect(findJob(undefined, 'b')).toBeUndefined();
  });
});

describe('withQueuePlaces', () => {
  const queued = (id: string, settledAt: string | null, overrides = {}) =>
    makeJob({ id, state: 'queued', settledAt, placeInLine: null, ...overrides });

  it('numbers the queued jobs in the order they joined the queue', () => {
    const jobs = [
      queued('c', '2026-10-20T13:33:00.000Z'),
      queued('a', '2026-10-20T13:31:00.000Z'),
      queued('b', '2026-10-20T13:32:00.000Z'),
    ];
    expect(withQueuePlaces(jobs).map((j) => [j.id, j.placeInLine])).toEqual([
      ['c', 3],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('corrects stale places', () => {
    const jobs = [
      queued('a', '2026-10-20T13:31:00.000Z', { placeInLine: 2 }),
      queued('b', '2026-10-20T13:32:00.000Z', { placeInLine: 1 }),
    ];
    expect(withQueuePlaces(jobs).map((j) => j.placeInLine)).toEqual([1, 2]);
  });

  it('breaks a tie by addedAt, then by id, like the server', () => {
    const same = '2026-10-20T13:31:00.000Z';
    const jobs = [
      queued('b', same, { addedAt: '2026-10-20T11:00:00.000Z' }),
      queued('c', same, { addedAt: '2026-10-20T10:00:00.000Z' }),
      queued('a', same, { addedAt: '2026-10-20T11:00:00.000Z' }),
    ];
    expect(withQueuePlaces(jobs).map((j) => [j.id, j.placeInLine])).toEqual([
      ['b', 3],
      ['c', 1],
      ['a', 2],
    ]);
  });

  it('leaves jobs that are not queued alone, and keeps their objects', () => {
    const editing = makeJob({ id: 'e', state: 'editing', placeInLine: null });
    const held = makeJob({ id: 'h', state: 'held', placeInLine: null, settledAt: null });
    const waiting = queued('q', '2026-10-20T13:31:00.000Z');
    const result = withQueuePlaces([editing, held, waiting]);
    expect(result[0]).toBe(editing);
    expect(result[1]).toBe(held);
    expect(result[2]).toMatchObject({ id: 'q', placeInLine: 1 });
  });

  it('keeps the object of a queued job whose place is already right', () => {
    const first = queued('a', '2026-10-20T13:31:00.000Z', { placeInLine: 1 });
    expect(withQueuePlaces([first])[0]).toBe(first);
  });

  it('never modifies the list it is given', () => {
    const jobs = Object.freeze([
      queued('b', '2026-10-20T13:32:00.000Z'),
      queued('a', '2026-10-20T13:31:00.000Z'),
    ]);
    expect(() => withQueuePlaces(jobs)).not.toThrow();
    expect(jobs.map((j) => j.placeInLine)).toEqual([null, null]);
  });
});
