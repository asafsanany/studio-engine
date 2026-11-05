import { VERSION_MESSAGES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeJobVersion } from '@/data/test-utils';
import {
  cutName,
  goBackBlock,
  goBackQuestion,
  SHEET_VERSIONS_TEXT,
  versionRows,
  versionWhen,
} from './sheet-versions';

// 22 Oct 2026, 15:30 UTC.
const NOW = '2026-10-22T15:30:00.000Z';

describe('cutName', () => {
  it('is Cut n', () => {
    expect(cutName(3)).toBe('Cut 3');
  });
});

describe('versionWhen', () => {
  it('says today, yesterday and the day, with the time', () => {
    expect(versionWhen('2026-10-22T14:58:00.000Z', NOW, 'UTC')).toBe('today 14:58');
    expect(versionWhen('2026-10-21T16:19:00.000Z', NOW, 'UTC')).toBe('yesterday 16:19');
    expect(versionWhen('2026-10-12T10:01:00.000Z', NOW, 'UTC')).toBe('12 Oct 10:01');
  });

  it('is empty for a time that cannot be read', () => {
    expect(versionWhen('not a time', NOW, 'UTC')).toBe('');
  });
});

describe('goBackBlock', () => {
  const other = { current: false };

  it('lets a job in Review go back to a cut it is not on', () => {
    expect(goBackBlock({ state: 'review', archivedAt: null }, other)).toBeNull();
  });

  it('says why in the server’s words for every other state', () => {
    for (const state of [
      'arriving',
      'queued',
      'held',
      'editing',
      'failed',
      'cancelled',
      'ready',
    ] as const) {
      expect(goBackBlock({ state, archivedAt: null }, other)).toBe(VERSION_MESSAGES.notInReview);
    }
  });

  it('says an archived job cannot, in Review or not', () => {
    expect(goBackBlock({ state: 'review', archivedAt: '2026-10-22T10:00:00.000Z' }, other)).toBe(
      VERSION_MESSAGES.archived,
    );
  });

  it('has nothing to go back to on the cut the job is on', () => {
    expect(goBackBlock({ state: 'review', archivedAt: null }, { current: true })).toBe(
      SHEET_VERSIONS_TEXT.isCurrent,
    );
  });
});

describe('versionRows', () => {
  const versions = [
    makeJobVersion(3, {
      current: true,
      createdAt: '2026-10-22T14:58:00.000Z',
      durationSec: 42,
    }),
    makeJobVersion(2, { createdAt: '2026-10-21T16:19:00.000Z', durationSec: 61 }),
    makeJobVersion(1, { createdAt: '2026-10-12T10:01:00.000Z', durationSec: 38 }),
  ];

  it('is one row per version, in the order given: "Cut 3 · today 14:58 · 0:42"', () => {
    const rows = versionRows(makeJob({ state: 'review' }), versions, NOW, 'UTC');
    expect(rows.map((row) => [row.name, row.detail])).toEqual([
      ['Cut 3', 'today 14:58 · 0:42'],
      ['Cut 2', 'yesterday 16:19 · 1:01'],
      ['Cut 1', '12 Oct 10:01 · 0:38'],
    ]);
    expect(rows.map((row) => row.n)).toEqual([3, 2, 1]);
  });

  it('marks the current row, and the offer to go back on the others', () => {
    const rows = versionRows(makeJob({ state: 'review' }), versions, NOW, 'UTC');
    expect(rows.map((row) => row.current)).toEqual([true, false, false]);
    expect(rows.map((row) => row.blocked)).toEqual([SHEET_VERSIONS_TEXT.isCurrent, null, null]);
  });

  it('puts Approved on the current row only, once the job is approved', () => {
    const approved = makeJob({ state: 'ready', approvedAt: '2026-10-22T15:00:00.000Z' });
    expect(versionRows(approved, versions, NOW, 'UTC').map((row) => row.approved)).toEqual([
      true,
      false,
      false,
    ]);
    const unapproved = makeJob({ state: 'review', approvedAt: null });
    expect(versionRows(unapproved, versions, NOW, 'UTC').some((row) => row.approved)).toBe(false);
  });

  it('blocks every row of a job that is not in Review (view only)', () => {
    const rows = versionRows(makeJob({ state: 'editing' }), versions, NOW, 'UTC');
    expect(rows.every((row) => row.blocked === VERSION_MESSAGES.notInReview)).toBe(true);
  });

  it('is no rows for no versions', () => {
    expect(versionRows(makeJob({ state: 'review' }), [], NOW, 'UTC')).toEqual([]);
  });
});

describe('goBackQuestion', () => {
  it('names the cut to go back to and the one that stays', () => {
    expect(goBackQuestion(2, 4)).toEqual({
      title: 'Go back to Cut 2?',
      description: 'Cut 4 stays in Versions, so you can return to it.',
    });
  });

  it('still reassures when the current cut is not known', () => {
    expect(goBackQuestion(2, null).description).toBe(
      'The cut you leave stays in Versions, so you can return to it.',
    );
  });
});
