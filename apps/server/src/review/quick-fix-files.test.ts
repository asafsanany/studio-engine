import { describe, expect, it } from 'vitest';
import {
  FIXES_DIR_PATH,
  fixDirPath,
  quickFixReplySchema,
  snapshotAt,
  snapshotFileName,
} from './quick-fix-files.js';
import { QUICK_FIX_STEP_LABELS, quickFixStepLabel } from './quick-fix-run.js';

describe('where a fix lives', () => {
  it('is one folder per fix under edit/review/fixes/', () => {
    expect(FIXES_DIR_PATH).toBe('edit/review/fixes');
    expect(fixDirPath('abc-1')).toBe('edit/review/fixes/abc-1');
  });
});

describe('the moment of a snapshot', () => {
  // The names `hyperframes snapshot --keep` writes (0.8.197): at-<seconds>s.png, no trailing zeros.
  it.each([
    [0, '0', 'at-0s.png'],
    [3, '3', 'at-3s.png'],
    [3.0, '3', 'at-3s.png'],
    [1.5, '1.5', 'at-1.5s.png'],
    [12.25, '12.25', 'at-12.25s.png'],
    [83.456, '83.46', 'at-83.46s.png'],
    [12.4, '12.4', 'at-12.4s.png'],
    [Number.NaN, '0', 'at-0s.png'],
    [-2, '0', 'at-0s.png'],
  ])('%s s is --at=%s and the file %s', (sec, at, file) => {
    expect(snapshotAt(sec)).toBe(at);
    expect(snapshotFileName(sec)).toBe(file);
  });
});

describe('the reply', () => {
  it('is done with a sentence, or not done with a reason', () => {
    expect(
      quickFixReplySchema.parse({ done: true, said: ' The captions are Heebo Bold now. ' }),
    ).toEqual({
      done: true,
      said: 'The captions are Heebo Bold now.',
    });
    expect(
      quickFixReplySchema.parse({ done: false, why: 'the sign is part of the footage' }),
    ).toEqual({
      done: false,
      why: 'the sign is part of the footage',
    });
  });

  it('keeps no other word of the answer', () => {
    expect(quickFixReplySchema.parse({ done: true, said: 'Done.', note: 'x' })).toEqual({
      done: true,
      said: 'Done.',
    });
  });

  it.each([
    {},
    { done: true },
    { done: true, said: '' },
    { done: false },
    { done: 1, said: 'x' },
    null,
    'done',
  ])('refuses %j', (reply) => {
    expect(quickFixReplySchema.safeParse(reply).success).toBe(false);
  });
});

describe('the words of the steps', () => {
  it('are Reading the edit, Changing …, Checking it, Looking at the frames', () => {
    expect([...QUICK_FIX_STEP_LABELS]).toEqual([
      'Reading the edit',
      'Changing the edit',
      'Checking it',
      'Looking at the frames',
    ]);
  });

  it('say the note’s kind for step 1, and fall back when it has none', () => {
    expect(quickFixStepLabel(1, 'Changing the caption font')).toBe('Changing the caption font');
    expect(quickFixStepLabel(1, '  Changing the caption font ')).toBe('Changing the caption font');
    expect(quickFixStepLabel(1, null)).toBe('Changing the edit');
    expect(quickFixStepLabel(1, undefined)).toBe('Changing the edit');
    expect(quickFixStepLabel(1, '   ')).toBe('Changing the edit');
    expect(quickFixStepLabel(0, 'Changing the caption font')).toBe('Reading the edit');
    expect(quickFixStepLabel(3, null)).toBe('Looking at the frames');
  });
});
