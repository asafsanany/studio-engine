// CVP-197: archived jobs and the filters. Off, they are out of every tab and every count; on, they
// sit in their usual tab and the counts include them.

import { describe, expect, it } from 'vitest';
import {
  archivedCount,
  archivedMatchCount,
  filterJobs,
  hasSearchWords,
  tabCounts,
  visibleJobs,
} from './filtering';
import { ARCHIVE_JOBS, ARCHIVED_IDS, LIVE_IDS } from './test-archive-jobs';

const ids = (jobs: readonly { id: string }[]) => jobs.map((job) => job.id);

describe('visibleJobs', () => {
  it('drops the archived jobs with the switch off, and keeps the order of the rest', () => {
    expect(ids(visibleJobs(ARCHIVE_JOBS, false))).toEqual(LIVE_IDS);
  });

  it('keeps every job with the switch on', () => {
    expect(ids(visibleJobs(ARCHIVE_JOBS, true))).toEqual(ids(ARCHIVE_JOBS));
  });
});

describe('filterJobs: Show archived', () => {
  it('leaves archived jobs out of every tab while the switch is off', () => {
    for (const tab of [
      'all',
      'progress',
      'review',
      'approved',
      'delivered',
      'paid',
      'attention',
    ] as const) {
      const shown = filterJobs(ARCHIVE_JOBS, { tab, search: '', showArchived: false });
      expect(
        shown.filter((job) => job.archivedAt !== null),
        tab,
      ).toEqual([]);
    }
  });

  it('puts them in their usual tab once the switch is on: a paid one under Paid, a cancelled one under Needs attention', () => {
    const on = (tab: Parameters<typeof filterJobs>[1]['tab']) =>
      ids(filterJobs(ARCHIVE_JOBS, { tab, search: '', showArchived: true }));
    expect(on('paid')).toEqual([
      'paid-1',
      'paid-2',
      'archived-paid-1',
      'archived-paid-2',
      'archived-paid-3',
    ]);
    expect(on('delivered')).toEqual(['delivered-1', 'archived-delivered']);
    expect(on('attention')).toEqual(['failed-1', 'archived-cancelled']);
    expect(on('all')).toHaveLength(ARCHIVE_JOBS.length);
  });

  it('applies the search to archived jobs like to any other, in either position of the switch', () => {
    expect(
      ids(filterJobs(ARCHIVE_JOBS, { tab: 'all', search: 'rgm', showArchived: false })),
    ).toEqual(['approved-1', 'delivered-1', 'paid-1']);
    expect(
      ids(filterJobs(ARCHIVE_JOBS, { tab: 'all', search: 'rgm', showArchived: true })),
    ).toEqual(['approved-1', 'delivered-1', 'paid-1', 'archived-cancelled', 'archived-paid-2']);
  });
});

describe('tabCounts: Show archived', () => {
  it('counts only the jobs on the list while the switch is off: 7 in all', () => {
    expect(tabCounts(ARCHIVE_JOBS, false)).toEqual({
      all: 7,
      progress: 1,
      review: 1,
      approved: 1,
      delivered: 1,
      uploaded: 0,
      paid: 2,
      attention: 1,
    });
  });

  it('counts the archived ones in their usual tab and in All once the switch is on: 12 in all', () => {
    expect(tabCounts(ARCHIVE_JOBS, true)).toEqual({
      all: 12,
      progress: 1,
      review: 1,
      approved: 1,
      delivered: 2,
      uploaded: 0,
      paid: 5,
      attention: 2,
    });
  });

  it('adds up: All is the other tabs together, in either position of the switch', () => {
    for (const showArchived of [false, true]) {
      const { all, ...groups } = tabCounts(ARCHIVE_JOBS, showArchived);
      expect(Object.values(groups).reduce((sum, n) => sum + n, 0)).toBe(all);
    }
  });
});

describe('archivedCount', () => {
  it('counts the archived jobs of every tab: the number at the end of Show archived', () => {
    expect(archivedCount(ARCHIVE_JOBS)).toBe(ARCHIVED_IDS.length);
    expect(archivedCount(ARCHIVE_JOBS)).toBe(5);
  });

  it('is 0 for a list with nothing archived, and for no list', () => {
    expect(archivedCount(ARCHIVE_JOBS.filter((job) => job.archivedAt === null))).toBe(0);
    expect(archivedCount([])).toBe(0);
  });
});

describe('hasSearchWords', () => {
  it('is false for an empty or blank search, and for one of only marks that are ignored', () => {
    expect(hasSearchWords('')).toBe(false);
    expect(hasSearchWords('   ')).toBe(false);
    expect(hasSearchWords('‏')).toBe(false);
  });

  it('is true when a word is typed', () => {
    expect(hasSearchWords('rgm')).toBe(true);
    expect(hasSearchWords('  מיתוס ')).toBe(true);
  });
});

describe('archivedMatchCount: the "N more archived" under a search', () => {
  it('counts the archived jobs of the tab that match the search', () => {
    expect(archivedMatchCount(ARCHIVE_JOBS, { tab: 'all', search: 'rgm' })).toBe(2);
    expect(archivedMatchCount(ARCHIVE_JOBS, { tab: 'paid', search: 'rgm' })).toBe(1);
    expect(archivedMatchCount(ARCHIVE_JOBS, { tab: 'delivered', search: 'rgm' })).toBe(0);
  });

  it('follows the tab: an archived paid job is not an answer on the Review tab', () => {
    expect(archivedMatchCount(ARCHIVE_JOBS, { tab: 'review', search: 'מיתוס' })).toBe(0);
    expect(archivedMatchCount(ARCHIVE_JOBS, { tab: 'delivered', search: 'מיתוס' })).toBe(1);
  });

  it('is 0 without a word typed: the archive is only offered as an answer to a search', () => {
    expect(archivedMatchCount(ARCHIVE_JOBS, { tab: 'all', search: '' })).toBe(0);
    expect(archivedMatchCount(ARCHIVE_JOBS, { tab: 'all', search: '  ' })).toBe(0);
  });

  it('does not count jobs that are not archived', () => {
    expect(archivedMatchCount(ARCHIVE_JOBS, { tab: 'all', search: 'סיור' })).toBe(0);
  });
});
