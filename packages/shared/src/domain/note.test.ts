import { describe, expect, it } from 'vitest';
import { canEditNote, NOTE_EDITABLE_STATES, NOTE_MAX_LENGTH, normalizeNote } from './note.ts';
import { JOB_STATES } from './status.ts';
import { hebrewJob, jobsByState } from './test-fixtures.ts';

describe('canEditNote', () => {
  it.each([
    ['arriving', true],
    ['queued', true],
    ['held', true],
    ['editing', false],
    ['review', false],
    ['ready', false],
    ['failed', true],
    ['cancelled', true],
  ] as const)('a %s job: %s', (state, allowed) => {
    expect(canEditNote(jobsByState[state])).toBe(allowed);
  });

  it('covers every state, and lists the editable ones', () => {
    expect(JOB_STATES.filter((state) => canEditNote({ state }))).toEqual(
      JOB_STATES.filter((state) => NOTE_EDITABLE_STATES.includes(state as never)),
    );
    expect(NOTE_EDITABLE_STATES).toEqual(['arriving', 'queued', 'held', 'failed', 'cancelled']);
  });

  it('needs only a state, so a plain Job from the web works', () => {
    expect(canEditNote({ state: 'held' })).toBe(true);
    expect(canEditNote(hebrewJob)).toBe(true);
  });
});

describe('normalizeNote', () => {
  it('trims the ends and leaves the inside alone', () => {
    expect(normalizeNote('  Keep it under 30 seconds.\n')).toBe('Keep it under 30 seconds.');
    expect(normalizeNote('One.\n\n  Two.')).toBe('One.\n\n  Two.');
  });

  it.each(['', ' ', '\n', ' \t\r\n  ', ' ', '　'])('turns %j into null', (text) => {
    expect(normalizeNote(text)).toBeNull();
  });

  it('keeps Hebrew as typed', () => {
    expect(normalizeNote(' תשתמש בטייק השני ')).toBe('תשתמש בטייק השני');
  });
});

describe('NOTE_MAX_LENGTH', () => {
  it('is 4000', () => {
    expect(NOTE_MAX_LENGTH).toBe(4000);
  });
});
