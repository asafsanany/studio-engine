import type { FixStatus } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { fixLanding, playerRev } from './fix-landing';
import { endedAfter, makeFix } from './test-fixtures';

// Where the player lands when a quick fix lands: at the note's moment, paused. And when it must not
// (the fixes were only read when Review opened). And the rev that makes the player load again.

const notes = [
  { id: 'n1', atSec: 12.4 },
  { id: 'n2', atSec: 30 },
];

const first = makeFix({ id: 'f1', noteId: 'n1', endedAt: endedAfter(28) });
const second = makeFix({ id: 'f2', noteId: 'n2', endedAt: endedAfter(70) });
const REV = Date.parse(endedAfter(70));

const seen = (...entries: [string, FixStatus][]) => new Map(entries);

describe('playerRev', () => {
  it('is the shared rev, and moves at every Undo although no `endedAt` does', () => {
    const rev = Date.parse(endedAfter(70));
    expect(playerRev([first, second], rev)).toBe(rev);
    expect(playerRev([first, { ...second, status: 'undone' }], rev)).toBe(rev + 1);
    expect(
      playerRev(
        [
          { ...first, status: 'undone' },
          { ...second, status: 'undone' },
        ],
        rev,
      ),
    ).toBe(rev + 2);
  });

  it('is null while no fix has landed', () => {
    expect(playerRev([], null)).toBeNull();
    expect(playerRev([makeFix({ status: 'running', endedAt: null })], null)).toBeNull();
  });

  it('does not count fixes that did not land', () => {
    const failed = makeFix({ id: 'x', status: 'failed' });
    expect(playerRev([first, failed], 5)).toBe(5);
  });
});

describe('fixLanding', () => {
  it('lands at the note’s time when a fix this page saw running is fixed', () => {
    expect(
      fixLanding({
        rev: REV,
        fixes: [first, second],
        seen: seen(['f1', 'fixed'], ['f2', 'running']),
        notes,
      }),
    ).toEqual({ rev: REV, sec: 30 });
  });

  it('lands for a fix that was queued when the page last looked', () => {
    expect(fixLanding({ rev: REV, fixes: [second], seen: seen(['f2', 'queued']), notes })).toEqual({
      rev: REV,
      sec: 30,
    });
  });

  it('does not land on a fix it only read: Review opened with a fix already made', () => {
    expect(fixLanding({ rev: REV, fixes: [first], seen: seen(), notes })).toBeNull();
    expect(fixLanding({ rev: REV, fixes: [first], seen: seen(['f1', 'fixed']), notes })).toBeNull();
  });

  it('lands on the undone fix’s note when an Undo comes', () => {
    const undone = { ...second, status: 'undone' as const };
    expect(
      fixLanding({
        rev: REV + 1,
        fixes: [first, undone],
        seen: seen(['f1', 'fixed'], ['f2', 'fixed']),
        notes,
      }),
    ).toEqual({ rev: REV + 1, sec: 30 });
  });

  it('lands on the one that ended last when two changed at once', () => {
    expect(
      fixLanding({
        rev: REV,
        fixes: [first, second],
        seen: seen(['f1', 'running'], ['f2', 'running']),
        notes,
      })?.sec,
    ).toBe(30);
  });

  it('does not land for a fix that did not land (failed, escalated, cancelled)', () => {
    for (const status of ['failed', 'escalated', 'cancelled'] as const) {
      const ended = makeFix({ id: 'f5', status });
      expect(
        fixLanding({ rev: 1, fixes: [ended], seen: seen(['f5', 'running']), notes }),
      ).toBeNull();
    }
  });

  it('does not land when there is no rev, the note is gone, or the notes are not in', () => {
    const base = { fixes: [second], seen: seen(['f2', 'running']) };
    expect(fixLanding({ ...base, rev: null, notes })).toBeNull();
    expect(fixLanding({ ...base, rev: REV, notes: [{ id: 'n1', atSec: 12.4 }] })).toBeNull();
    expect(fixLanding({ ...base, rev: REV, notes: undefined })).toBeNull();
  });
});
