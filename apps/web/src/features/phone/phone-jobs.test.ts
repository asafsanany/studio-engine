import type { Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import {
  groupByClient,
  isFailedDetail,
  phoneArchivedLine,
  phoneArchivedLineLead,
  phoneArchivedLineText,
  phoneDetail,
  treeContinues,
  treeFlags,
  treePosition,
} from './phone-jobs';

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

const archived = (id: string, clientId: string, minutes: number, overrides: Partial<Job> = {}) =>
  job(id, clientId, minutes, { archivedAt: NOW, ...overrides });

describe('groupByClient', () => {
  it('puts the clients in order of their latest activity, newest first', () => {
    const jobs = [
      job('a1', 'a', 50),
      job('b1', 'b', 5),
      job('c1', 'c', 20),
      job('a2', 'a', 60),
      job('c2', 'c', 30),
    ];
    expect(groupByClient(jobs).map((group) => group.clientId)).toEqual(['b', 'c', 'a']);
  });

  it('orders by the newest job of the client, wherever it sits in the given order', () => {
    // A is first in the list, but its newest job is the oldest of the three clients' newest.
    const jobs = [job('a1', 'a', 90), job('b1', 'b', 10), job('a2', 'a', 40), job('c1', 'c', 30)];
    expect(groupByClient(jobs).map((group) => group.clientId)).toEqual(['b', 'c', 'a']);
  });

  it('keeps the first-seen order of clients with the same latest activity', () => {
    const jobs = [job('b1', 'b', 10), job('a1', 'a', 10), job('c1', 'c', 10)];
    expect(groupByClient(jobs).map((group) => group.clientId)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the jobs of a client in the order they were given', () => {
    const jobs = [job('a1', 'a', 5), job('b1', 'b', 6), job('a2', 'a', 7), job('a3', 'a', 8)];
    const [first] = groupByClient(jobs);
    expect(first?.clientId).toBe('a');
    expect(first?.jobs.map((each) => each.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('carries the client’s id and name, and nothing for no jobs', () => {
    expect(groupByClient([job('a1', 'a', 5)])).toEqual([
      expect.objectContaining({ clientId: 'a', client: 'Client a' }),
    ]);
    expect(groupByClient([])).toEqual([]);
  });

  it('does not change the list it is given', () => {
    const jobs = [job('a1', 'a', 50), job('b1', 'b', 5)];
    const before = jobs.map((each) => each.id);
    groupByClient(jobs);
    expect(jobs.map((each) => each.id)).toEqual(before);
  });
});

describe('the tree flags', () => {
  it('mark the first, the middle and the last job of a client', () => {
    expect(treeFlags(0, 3)).toEqual({ first: true, middle: false, last: false });
    expect(treeFlags(1, 3)).toEqual({ first: false, middle: true, last: false });
    expect(treeFlags(2, 3)).toEqual({ first: false, middle: false, last: true });
  });

  it('make a client’s only job both first and last, and never middle', () => {
    expect(treeFlags(0, 1)).toEqual({ first: true, middle: false, last: true });
  });

  it('with two jobs have no middle', () => {
    expect(treeFlags(0, 2)).toEqual({ first: true, middle: false, last: false });
    expect(treeFlags(1, 2)).toEqual({ first: false, middle: false, last: true });
  });

  it('carry the line on below the elbow for every row but the last', () => {
    expect([0, 1, 2].map((index) => treeContinues(treeFlags(index, 3)))).toEqual([
      true,
      true,
      false,
    ]);
    expect(treeContinues(treeFlags(0, 1))).toBe(false);
  });

  it('read as one word', () => {
    expect(treePosition(treeFlags(0, 1))).toBe('only');
    expect([0, 1, 2].map((index) => treePosition(treeFlags(index, 3)))).toEqual([
      'first',
      'middle',
      'last',
    ]);
  });
});

describe('phoneArchivedLine', () => {
  const jobs = [
    job('a1', 'a', 5, { name: 'Spring promo' }),
    archived('a2', 'a', 6, { name: 'Spring teaser' }),
    archived('a3', 'a', 7, { name: 'Winter cut', state: 'failed', failedAt: 8 }),
    archived('b1', 'b', 8, { name: 'Other', client: 'Other client' }),
  ];
  const all = { tab: 'all', search: '', showArchived: false } as const;

  it('offers the archived jobs at the end of the list even with no search: "3 archived · Show"', () => {
    const line = phoneArchivedLine(jobs, all, 1);
    expect(line).toEqual({ count: 3, more: false });
    expect(line && phoneArchivedLineText(line)).toBe('3 archived · Show');
    expect(line && phoneArchivedLineLead(line)).toBe('3 archived ·');
  });

  it('says "more" under a search that found rows: "1 more archived · Show"', () => {
    const line = phoneArchivedLine(jobs, { ...all, search: 'spring' }, 1);
    expect(line).toEqual({ count: 1, more: true });
    expect(line && phoneArchivedLineText(line)).toBe('1 more archived · Show');
    expect(line && phoneArchivedLineLead(line)).toBe('1 more archived ·');
  });

  it('does not say "more" when the search found nothing else', () => {
    const line = phoneArchivedLine(jobs, { ...all, search: 'winter' }, 0);
    expect(line && phoneArchivedLineText(line)).toBe('1 archived · Show');
  });

  it('counts only the archived jobs of the tab', () => {
    const line = phoneArchivedLine(jobs, { ...all, tab: 'attention' }, 0);
    expect(line && phoneArchivedLineText(line)).toBe('1 archived · Show');
  });

  it('matches the search the way the Mac does: every word, in the name or the client', () => {
    expect(phoneArchivedLine(jobs, { ...all, search: 'other client' }, 0)?.count).toBe(1);
    expect(phoneArchivedLine(jobs, { ...all, search: 'spring winter' }, 0)).toBeNull();
  });

  it('is gone once Show archived is on', () => {
    expect(phoneArchivedLine(jobs, { ...all, showArchived: true }, 1)).toBeNull();
  });

  it('is gone when no archived job fits', () => {
    expect(phoneArchivedLine([job('a1', 'a', 5)], all, 1)).toBeNull();
    expect(phoneArchivedLine(jobs, { ...all, tab: 'review' }, 0)).toBeNull();
    expect(phoneArchivedLine(jobs, { ...all, search: 'zzz' }, 0)).toBeNull();
  });
});

describe('phoneDetail', () => {
  it('is the Mac’s list detail', () => {
    expect(phoneDetail(makeJob({ state: 'failed', failedAt: 8 }), NOW)).toBe('Failed at Render');
    expect(phoneDetail(makeJob({ state: 'held' }), NOW)).toBe('Held');
  });

  it('says a note is being fixed, or how many were fixed here, as the Mac does (C57)', () => {
    const preview = { durationSec: 39, width: 1080, height: 1920 };
    const review = makeJob({ state: 'review', placeInLine: null, preview });
    expect(phoneDetail(review, NOW)).toBe('Ready to review · 0:39');
    expect(phoneDetail({ ...review, fixing: { atSec: 12 } }, NOW)).toBe(
      'Review · fixing a note at 0:12…',
    );
    expect(phoneDetail({ ...review, round: 1, fixedCount: 1 }, NOW)).toBe(
      'Review · cut 2 · 1 fixed here',
    );
  });

  it('says what a delivered or paid job is owed, or was paid', () => {
    const delivered = makeJob({
      state: 'ready',
      delivery: makeJobDelivery({ deliveredAt: '2026-10-21T09:00:00.000Z' }),
    });
    expect(phoneDetail(delivered, NOW)).toBe('Delivered 21 Oct · ₪40 not paid');
    const paid = makeJob({
      state: 'ready',
      delivery: makeJobDelivery({ paidOn: '2026-10-22' }),
    });
    expect(phoneDetail(paid, NOW)).toBe('Paid 22 Oct · ₪40');
  });

  it('says when the reel of an uploaded job was posted and its plays, as the Mac row does', () => {
    const uploaded = makeJob({
      state: 'ready',
      delivery: makeJobDelivery({
        deliveredAt: '2026-10-21T09:00:00.000Z',
        uploadedAt: '2026-10-20T09:30:00.000Z',
        reelPlays: 27_500,
      }),
    });
    expect(phoneDetail(uploaded, NOW)).toMatch(/^Posted [A-Z][a-z]{2} \d{1,2} Oct · 27\.5K plays$/);
    // Plays that are not known are not written, and the money is not put in their place.
    const unknown = makeJob({
      ...uploaded,
      delivery: makeJobDelivery({ ...uploaded.delivery, reelPlays: undefined }),
    });
    expect(phoneDetail(unknown, NOW)).toMatch(/^Posted [A-Z][a-z]{2} \d{1,2} Oct$/);
  });

  it('is red only for a failed job', () => {
    expect(isFailedDetail({ state: 'failed' })).toBe(true);
    expect(isFailedDetail({ state: 'ready' })).toBe(false);
  });
});
