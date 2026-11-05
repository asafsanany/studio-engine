// CVP-197: the archive group at the end of a job's right-click menu. Archive wherever the server
// would agree, "Archive all paid · N" on a Paid row, Unarchive on an archived one.

import { JOB_STATES, type Job } from '@studio/shared';
import { Archive, ArchiveRestore } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { NO_SERIES_MENU } from '@/features/series/series-menu';
import type { RunnableRowAction } from './cells/use-row-actions';
import type { JobMenuEntry, RowMenuItem } from './row-menu';
import { archiveMenuEntries, NO_ARCHIVE_MENU, rowMenuEntries } from './row-menu';
import { ARCHIVE_JOBS } from './test-archive-jobs';

const run = vi.fn<(action: RunnableRowAction) => void>();
const archive = vi.fn<() => void>();
const unarchive = vi.fn<() => void>();
const archiveAllPaid = vi.fn<(ids: readonly string[]) => void>();
const actions = { run, busy: false, archive, unarchive, archiveAllPaid };

beforeEach(() => {
  for (const mock of [run, archive, unarchive, archiveAllPaid]) mock.mockClear();
});

const board = (id: string): Job => {
  const job = ARCHIVE_JOBS.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`no job ${id}`);
  return job;
};

const entries = (job: Job, context = NO_ARCHIVE_MENU, a: typeof actions = actions) =>
  rowMenuEntries(job, a, null, NO_SERIES_MENU, context);

const labels = (list: readonly JobMenuEntry[]) =>
  list.flatMap((entry) => (entry.type === 'item' ? [entry.label] : []));

/** The items after the last line: the archive group, which is the last group of every menu that has it. */
function archiveGroup(list: readonly JobMenuEntry[]): RowMenuItem[] {
  const lastLine = list.map((entry) => entry.type).lastIndexOf('separator');
  return list.slice(lastLine + 1).filter((entry): entry is RowMenuItem => entry.type === 'item');
}

const PAID_IDS = ['paid-1', 'paid-2'];

describe('the archive group: Archive', () => {
  it.each([
    ['review-1', 'review'],
    ['failed-1', 'failed'],
    ['approved-1', 'ready (approved)'],
    ['delivered-1', 'ready (delivered)'],
    ['paid-1', 'ready (paid)'],
  ])('puts Archive last in the menu of %s (%s)', (id) => {
    const list = entries(board(id), { paidIds: PAID_IDS });
    expect(archiveGroup(list)[0]?.label).toBe('Archive');
    expect(list.at(-1)?.type).toBe('item');
  });

  it.each(['held', 'failed', 'cancelled', 'review', 'ready'] as const)(
    'offers Archive for a %s job',
    (state) => {
      const job = makeJob({ state, placeInLine: null, failedAt: 8, error: 'boom' });
      expect(labels(entries(job))).toContain('Archive');
    },
  );

  it.each(['arriving', 'queued', 'editing'] as const)(
    'offers no archive group for a %s job: the engine is working on it, or will',
    (state) => {
      const job = makeJob({ state, placeInLine: state === 'queued' ? 1 : null });
      const list = entries(job);
      expect(labels(list)).not.toContain('Archive');
      expect(labels(list)).not.toContain('Unarchive');
      expect(list.some((entry) => entry.id === 'archive-separator')).toBe(false);
    },
  );

  it('follows the shared rule for every state', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({ state, placeInLine: null, failedAt: 8, error: 'boom' });
      const blocked = state === 'arriving' || state === 'queued' || state === 'editing';
      expect(labels(entries(job)).includes('Archive'), state).toBe(!blocked);
    }
  });

  it('puts a line before it and nothing after it', () => {
    for (const id of ['failed-1', 'approved-1', 'delivered-1', 'archived-cancelled']) {
      const list = entries(board(id));
      expect(list.at(-1)?.type, id).toBe('item');
      expect(list.at(-2)?.type, id).toBe('separator');
      expect(list.at(-2)?.id, id).toBe('archive-separator');
    }
  });

  it('never puts two lines in a row: a review job’s note line and the archive line are one', () => {
    const list = entries(board('review-1'));
    list.forEach((entry, i) => {
      if (entry.type === 'separator') expect(list[i - 1]?.type).not.toBe('separator');
    });
    // Review…, a line, the (disabled) note, one line, Archive.
    expect(list.map((entry) => entry.id)).toEqual([
      'review',
      'review-separator',
      'note',
      'rename',
      'note-separator',
      'archive',
    ]);
  });

  it('draws Archive with the box icon, and not in the destructive style', () => {
    const item = archiveGroup(entries(board('failed-1')))[0];
    expect(item?.id).toBe('archive');
    expect(item?.icon).toBe(Archive);
    expect(item?.destructive).toBeFalsy();
  });

  it('archives the row’s job when it is chosen, and nothing else', () => {
    archiveGroup(entries(board('failed-1')))[0]?.onSelect();
    expect(archive).toHaveBeenCalledOnce();
    expect(unarchive).not.toHaveBeenCalled();
    expect(archiveAllPaid).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('waits for the answer to the row’s other request, like the other items', () => {
    const busy = { ...actions, busy: true };
    for (const item of archiveGroup(entries(board('paid-1'), { paidIds: PAID_IDS }, busy))) {
      expect(item.disabled, item.label).toBe(true);
    }
    for (const item of archiveGroup(entries(board('paid-1'), { paidIds: PAID_IDS }))) {
      expect(item.disabled, item.label).toBe(false);
    }
  });

  it('is left out for a caller that cannot archive (the items need the row’s actions)', () => {
    const list = rowMenuEntries(board('failed-1'), { run, busy: false });
    expect(labels(list)).not.toContain('Archive');
    expect(list.some((entry) => entry.id === 'archive-separator')).toBe(false);
    expect(list.at(-1)?.type).toBe('item');
  });
});

describe('the archive group: Archive all paid · N', () => {
  it('follows Archive on a Paid row when two paid videos are on the list', () => {
    const group = archiveGroup(entries(board('paid-1'), { paidIds: PAID_IDS }));
    expect(group.map((item) => item.label)).toEqual(['Archive', 'Archive all paid · 2']);
    expect(group[1]?.id).toBe('archive-all-paid');
    expect(group[1]?.icon).toBe(Archive);
  });

  it('counts the paid videos that are not archived, as many as there are', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const group = archiveGroup(entries(board('paid-1'), { paidIds: ids }));
    expect(group[1]?.label).toBe('Archive all paid · 5');
  });

  it('hands exactly those videos to the row when it is chosen', () => {
    const ids = ['paid-1', 'paid-2', 'x-3'];
    archiveGroup(entries(board('paid-1'), { paidIds: ids }))[1]?.onSelect();
    expect(archiveAllPaid).toHaveBeenCalledWith(ids);
    expect(archive).not.toHaveBeenCalled();
  });

  it('shows only from 2: for a lone paid video, Archive is all there is', () => {
    expect(
      archiveGroup(entries(board('paid-1'), { paidIds: ['paid-1'] })).map((i) => i.label),
    ).toEqual(['Archive']);
    expect(archiveGroup(entries(board('paid-1'), NO_ARCHIVE_MENU)).map((i) => i.label)).toEqual([
      'Archive',
    ]);
  });

  it('is only on a Paid row: not on an approved, a delivered, a failed or a cancelled one', () => {
    for (const id of ['approved-1', 'delivered-1', 'failed-1', 'review-1']) {
      expect(labels(entries(board(id), { paidIds: PAID_IDS })).join('|'), id).not.toContain(
        'Archive all paid',
      );
    }
  });

  it('is not on an archived Paid row, which has Unarchive instead', () => {
    const list = entries(board('archived-paid-1'), { paidIds: PAID_IDS });
    expect(labels(list).join('|')).not.toContain('Archive all paid');
  });
});

describe('the archive group: Unarchive', () => {
  it('takes Archive’s place on an archived job, with the box-with-an-arrow icon', () => {
    const group = archiveGroup(entries(board('archived-paid-1')));
    expect(group.map((item) => item.label)).toEqual(['Unarchive']);
    expect(group[0]?.id).toBe('unarchive');
    expect(group[0]?.icon).toBe(ArchiveRestore);
  });

  it('keeps the rest of the menu of the video’s stage: Download MP4 and Not paid yet on a paid one', () => {
    const list = entries(board('archived-paid-1'));
    expect(labels(list)).toEqual([
      'Add note…',
      'Rename…',
      'Download MP4',
      'Not paid yet',
      'Unarchive',
    ]);
  });

  it('has no Mark paid… on an archived delivered video, and keeps Resume on an archived cancelled one', () => {
    expect(labels(entries(board('archived-delivered')))).toEqual([
      'Add note…',
      'Rename…',
      'Download MP4',
      'Not delivered yet',
      'Unarchive',
    ]);
    expect(labels(entries(board('archived-cancelled')))).toEqual([
      'Add note…',
      'Rename…',
      'Resume',
      'Unarchive',
    ]);
  });

  it('unarchives the row’s job when it is chosen', () => {
    archiveGroup(entries(board('archived-cancelled')))[0]?.onSelect();
    expect(unarchive).toHaveBeenCalledOnce();
    expect(archive).not.toHaveBeenCalled();
  });

  it('is never offered together with Archive', () => {
    for (const job of ARCHIVE_JOBS) {
      const list = labels(entries(job, { paidIds: PAID_IDS }));
      expect(list.includes('Archive') && list.includes('Unarchive'), job.id).toBe(false);
    }
  });

  it('is left out for a caller that cannot unarchive', () => {
    const list = rowMenuEntries(board('archived-cancelled'), { run, busy: false });
    expect(labels(list)).not.toContain('Unarchive');
    expect(list.at(-1)?.type).toBe('item');
  });
});

describe('archiveMenuEntries on its own', () => {
  it('has a key of its own for every entry, and the line first', () => {
    const list = archiveMenuEntries(board('paid-1'), actions, { paidIds: PAID_IDS });
    expect(list.map((entry) => entry.id)).toEqual([
      'archive-separator',
      'archive',
      'archive-all-paid',
    ]);
  });

  it('is empty for a job the engine is working on', () => {
    expect(archiveMenuEntries(board('editing-1'), actions)).toEqual([]);
  });
});
