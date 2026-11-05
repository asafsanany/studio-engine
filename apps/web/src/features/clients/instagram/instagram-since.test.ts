import { describe, expect, it } from 'vitest';
import { readSinceText, sinceDayText } from './instagram-since';

describe('sinceDayText', () => {
  it('writes a day as day, short month and year, as the board does', () => {
    expect(sinceDayText('2026-08-01')).toBe('1 Aug 2026');
    expect(sinceDayText('2025-12-31')).toBe('31 Dec 2025');
    expect(sinceDayText('2024-02-29')).toBe('29 Feb 2024');
  });

  it('writes nothing for what is no day', () => {
    expect(sinceDayText('')).toBe('');
    expect(sinceDayText('2026-02-30')).toBe('');
    expect(sinceDayText('1 Aug 2026')).toBe('');
  });
});

describe('readSinceText', () => {
  const day = (value: string) => ({ kind: 'day', day: value });

  it('reads nothing as empty', () => {
    expect(readSinceText('')).toEqual({ kind: 'empty' });
    expect(readSinceText('   ')).toEqual({ kind: 'empty' });
  });

  it('reads the words the field writes, with any month spelling and case', () => {
    expect(readSinceText('1 Aug 2026')).toEqual(day('2026-08-01'));
    expect(readSinceText('1 August 2026')).toEqual(day('2026-08-01'));
    expect(readSinceText('31 dec 2025')).toEqual(day('2025-12-31'));
    expect(readSinceText('  9   SEPT  2026 ')).toEqual(day('2026-09-09'));
    expect(readSinceText('1 Aug, 2026')).toEqual(day('2026-08-01'));
  });

  it('reads YYYY-MM-DD', () => {
    expect(readSinceText('2026-08-01')).toEqual(day('2026-08-01'));
    expect(readSinceText('2026-8-1')).toEqual(day('2026-08-01'));
  });

  it('reads day first with slashes, dots or dashes, as the Mac writes it', () => {
    expect(readSinceText('1/8/2026')).toEqual(day('2026-08-01'));
    expect(readSinceText('01/08/2026')).toEqual(day('2026-08-01'));
    expect(readSinceText('1.8.2026')).toEqual(day('2026-08-01'));
    expect(readSinceText('1-8-2026')).toEqual(day('2026-08-01'));
    expect(readSinceText('13/1/2026')).toEqual(day('2026-01-13'));
  });

  it('refuses a day that does not exist, a month that is none, and a day with no year', () => {
    for (const typed of [
      '30 Feb 2026',
      '2026-02-30',
      '1/13/2026',
      '32 Aug 2026',
      '1 Augtober 2026',
      '1 Au 2026',
      '1 Aug',
      'Aug 2026',
      'last summer',
      '29 Feb 2026',
    ]) {
      expect(readSinceText(typed), typed).toEqual({ kind: 'invalid' });
    }
  });

  it('accepts a leap day in a leap year', () => {
    expect(readSinceText('29 Feb 2024')).toEqual(day('2024-02-29'));
  });
});
