import { describe, expect, it } from 'vitest';
import { compareNotes, NOTES_KEY, notesKey, removeNote, upsertNote } from './notes-cache';
import { makeReviewNote } from './test-utils';

const early = makeReviewNote({ id: 'early', atSec: 1 });
const middle = makeReviewNote({ id: 'middle', atSec: 5 });
const late = makeReviewNote({ id: 'late', atSec: 9 });
const list = [early, middle, late];

describe('the keys', () => {
  it('has its own root, so invalidating the jobs does not match the notes', () => {
    expect(NOTES_KEY).toEqual(['notes']);
    expect(notesKey('a1b2c3d4e5f6')).toEqual(['notes', 'a1b2c3d4e5f6']);
  });
});

describe('compareNotes', () => {
  it('orders by atSec, then createdAt, then id', () => {
    const a = makeReviewNote({ id: 'a', atSec: 3, createdAt: '2026-10-20T14:00:02.000Z' });
    const b = makeReviewNote({ id: 'b', atSec: 3, createdAt: '2026-10-20T14:00:01.000Z' });
    const c = makeReviewNote({ id: 'c', atSec: 3, createdAt: '2026-10-20T14:00:01.000Z' });
    const d = makeReviewNote({ id: 'd', atSec: 2, createdAt: '2026-10-20T15:00:00.000Z' });

    expect([a, b, c, d].sort(compareNotes).map((note) => note.id)).toEqual(['d', 'b', 'c', 'a']);
    expect(compareNotes(a, a)).toBe(0);
  });
});

describe('upsertNote', () => {
  it('replaces the note with the same id where it stands', () => {
    const edited = { ...middle, text: 'Edited', addToStyle: true };
    expect(upsertNote(list, edited)).toEqual([early, edited, late]);
  });

  it('inserts a new note in order: first, between and last', () => {
    const first = makeReviewNote({ id: 'first', atSec: 0.5 });
    const between = makeReviewNote({ id: 'between', atSec: 7 });
    const last = makeReviewNote({ id: 'last', atSec: 20 });

    expect(upsertNote(list, first).map((note) => note.id)).toEqual([
      'first',
      'early',
      'middle',
      'late',
    ]);
    expect(upsertNote(list, between).map((note) => note.id)).toEqual([
      'early',
      'middle',
      'between',
      'late',
    ]);
    expect(upsertNote(list, last).map((note) => note.id)).toEqual([
      'early',
      'middle',
      'late',
      'last',
    ]);
  });

  it('puts a note with the same atSec after the one written earlier, by createdAt then id', () => {
    const same = makeReviewNote({ id: 'same', atSec: 5, createdAt: '2026-10-20T14:00:05.000Z' });
    const sooner = makeReviewNote({ id: 'zzz', atSec: 5, createdAt: '2026-10-20T13:00:00.000Z' });

    expect(upsertNote(list, same).map((note) => note.id)).toEqual([
      'early',
      'middle',
      'same',
      'late',
    ]);
    expect(upsertNote(list, sooner).map((note) => note.id)).toEqual([
      'early',
      'zzz',
      'middle',
      'late',
    ]);
  });

  it('inserts into an empty list and does not change the list it is given', () => {
    expect(upsertNote([], early)).toEqual([early]);
    const frozen = Object.freeze([...list]);
    expect(() => upsertNote(frozen, makeReviewNote({ id: 'x', atSec: 2 }))).not.toThrow();
    expect(frozen).toEqual(list);
  });

  it('removes a note that was sent (it has a round): sent notes are not in the list', () => {
    const sent = { ...middle, round: 1, sentAt: '2026-10-20T14:30:00.000Z' };
    expect(upsertNote(list, sent)).toEqual([early, late]);
    expect(upsertNote(list, { ...makeReviewNote({ id: 'new' }), round: 2 })).toEqual(list);
  });
});

describe('removeNote', () => {
  it('drops the note', () => {
    expect(removeNote(list, 'middle')).toEqual([early, late]);
  });

  it('returns a new array even when the note is not there', () => {
    const next = removeNote(list, 'nope');
    expect(next).toEqual(list);
    expect(next).not.toBe(list);
  });
});
